#!/usr/bin/env node
/**
 * CLI front-end. The REPL is deliberately thin: all policy lives in the core.
 * Rendering is event-driven, which is why the loop can stream.
 */
import { createInterface } from "node:readline";
import { paint, Logger } from "../util/log.ts";
import { describeSandbox } from "../sandbox/paths.ts";
import type { HarnessEvent } from "../core/query.ts";
import type { PermissionDecision } from "../permissions/engine.ts";
import { formatRule } from "../permissions/rules.ts";
import { parseArgs, createRuntime, HELP } from "./bootstrap.ts";

class Prompter {
  private rl;
  private pending: ((line: string) => void) | null = null;
  private queue: string[] = [];
  private closed = false;

  constructor() {
    this.rl = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
    this.rl.on("line", (line) => {
      if (this.pending) {
        const resolve = this.pending;
        this.pending = null;
        resolve(line);
      } else {
        this.queue.push(line);
      }
    });
    this.rl.on("close", () => {
      this.closed = true;
      if (this.pending) {
        const resolve = this.pending;
        this.pending = null;
        resolve("");
      }
    });
  }

  ask(question: string): Promise<string> {
    if (this.closed) return Promise.resolve("");
    process.stdout.write(question);
    return new Promise<string>((resolve) => {
      this.pending = resolve;
    });
  }

  nextLine(promptText: string): Promise<string | null> {
    if (this.queue.length) {
      process.stdout.write(promptText + this.queue[0] + "\n");
      return Promise.resolve(this.queue.shift() ?? null);
    }
    if (this.closed) return Promise.resolve(null);
    process.stdout.write(promptText);
    return new Promise<string | null>((resolve) => {
      this.pending = (line) => resolve(this.closed && line === "" ? null : line);
    });
  }

  close(): void {
    this.rl.close();
  }
}

function renderToolResult(name: string, body: string, isError: boolean | undefined, durationMs: number): void {
  const head = "  " + (isError ? paint.red("x") : paint.green("+")) + " " + paint.bold(name) + paint.dim(" (" + durationMs + "ms)");
  process.stdout.write("\n" + head + "\n");
  const lines = body.split("\n").slice(0, 12);
  for (const line of lines) {
    process.stdout.write(paint.dim("    " + line.slice(0, 200)) + "\n");
  }
  const total = body.split("\n").length;
  if (total > lines.length) process.stdout.write(paint.dim("    ... " + (total - lines.length) + " more lines") + "\n");
}

async function main(): Promise<void> {
  // Sub-commands that reuse the same runtime but a different front-end.
  //
  // The token can appear anywhere: launchers prepend flags\, e.g.
  //   main.ts --workspace <dir> serve --port 4317
  // Looking only at argv[2] silently turned "serve" into a one-shot prompt.
  const argv = process.argv.slice(2);
  const SUBCOMMANDS = new Set(["serve", "desktop", "repl", "chat", "plugin"]);
  const subIndex = argv.findIndex((a) => SUBCOMMANDS.has(a));
  const sub = subIndex >= 0 ? argv[subIndex] : undefined;
  const rest = subIndex >= 0 ? argv.filter((_, i) => i !== subIndex) : argv;

  if (sub === "serve" || sub === "desktop") {
    const { runServe } = await import("./serve.ts");
    await runServe(rest, sub === "desktop");
    return;
  }

  if (sub === "plugin") {
    const { runPlugin } = await import("./plugin.ts");
    await runPlugin(rest);
    return;
  }

  const args = parseArgs(rest);
  if (args.mode === "help") {
    console.log(HELP);
    return;
  }

  // No prompt => this is a launcher double-click: open the app window.
  // (Checking argv.length does not work: launchers prepend --workspace.)
  // The terminal stays available through "jys repl".
  if (!args.prompt && sub !== "repl" && sub !== "chat") {
    const { runServe } = await import("./serve.ts");
    await runServe(rest, true);
    return;
  }

  const logger = new Logger(args.debug ? "debug" : "warn");
  const prompter = new Prompter();
  const interactive = !args.print && !args.prompt;

  const approve = async (request: {
    toolName: string;
    input: Record<string, unknown>;
    decision: PermissionDecision;
  }) => {
    if (args.yes) return "allow" as const;
    if (!process.stdin.isTTY) return "deny" as const;
    const preview = JSON.stringify(request.input).slice(0, 300);
    console.log("");
    console.log(paint.yellow("  permission required: ") + paint.bold(request.toolName));
    console.log(paint.dim("  " + preview));
    console.log(paint.dim("  reason: " + request.decision.message + " [" + request.decision.reason + "]"));
    if (request.decision.suggestedRule) {
      console.log(paint.dim("  tip: add rule \"" + request.decision.suggestedRule + "\" to always allow this"));
    }
    const answer = (await prompter.ask("  allow? [y]es / [n]o / [a]lways > ")).trim().toLowerCase();
    if (answer === "a" || answer === "always") return "always" as const;
    if (answer === "y" || answer === "yes") return "allow" as const;
    return "deny" as const;
  };

  let runtime;
  try {
    runtime = await createRuntime({
      args,
      logger,
      approve,
      onAlwaysAllow: (toolName, input) => {
        const content =
          typeof input.command === "string" ? input.command
          : typeof input.file_path === "string" ? input.file_path
          : "*";
        const rule = toolName + "(" + content + ")";
        console.log(paint.dim("  added session rule: " + rule + " (not persisted; put it in .jysharness/settings.json)"));
        runtime.loaded.rules.allow.push({
          source: "session",
          ruleBehavior: "allow",
          ruleValue: { toolName, ruleContent: content },
        });
      },
    });
  } catch (err) {
    console.error(paint.red(err instanceof Error ? err.message : String(err)));
    process.exitCode = 1;
    prompter.close();
    return;
  }

  const session = runtime.session;
  const resolved = runtime.resolved;
  if (args.resume) {
    console.log(paint.dim("resumed " + args.resume + " (" + session.messages.length + " messages)"));
  }

  const runPrompt = async (text: string): Promise<void> => {
    const controller = new AbortController();
    const onSigint = () => controller.abort();
    process.on("SIGINT", onSigint);
    let printedText = false;
    try {
      for await (const ev of session.send(text, controller.signal)) {
        handleEvent(ev);
      }
    } finally {
      process.off("SIGINT", onSigint);
    }

    function handleEvent(ev: HarnessEvent): void {
      switch (ev.type) {
        case "text_delta":
          process.stdout.write(ev.text);
          printedText = true;
          break;
        case "assistant_message":
          if (printedText) process.stdout.write("\n");
          printedText = false;
          break;
        case "tool_end":
          renderToolResult(ev.name, ev.result.content, ev.result.isError, ev.durationMs);
          break;
        case "compaction":
          console.log(paint.dim("  [compaction] " + ev.applied.join("+") + " " + ev.tokensBefore + " -> " + ev.tokensAfter + " tokens"));
          break;
        case "notice":
          console.log(paint.dim("  [" + ev.level + "] " + ev.text));
          break;
        case "usage":
          logger.debug("usage in=" + ev.usage.inputTokens + " out=" + ev.usage.outputTokens);
          break;
        case "done":
          if (ev.reason !== "completed") {
            console.log(paint.yellow("  [stopped: " + ev.reason + "]" + (ev.error ? " " + ev.error.slice(0, 300) : "")));
          }
          break;
        default:
          break;
      }
    }
  };

  if (args.prompt) {
    await runPrompt(args.prompt);
    prompter.close();
    return;
  }

  banner();

  while (true) {
    const line = await prompter.nextLine(paint.cyan("\n> "));
    if (line === null) break;
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith("/")) {
      const done = await handleSlash(t, session, prompter, resolved, interactive);
      if (done) break;
      continue;
    }
    await runPrompt(t);
  }
  prompter.close();

  function banner(): void {
    console.log("");
    console.log(paint.bold("  JYSHarness") + paint.dim("  v0.2.0"));
    console.log(paint.dim("  model: " + resolved.model + " (" + resolved.provider.id + ")"));
    console.log(paint.dim("  " + describeSandbox({ mode: session.sandboxMode, workspaceRoot: session.workspaceRoot })));
    console.log(paint.dim("  permissions: " + session.mode + "  session: " + session.sessionId));
    console.log(paint.dim("  type /help for commands, /exit to quit"));
  }
}

async function handleSlash(
  text: string,
  session: Session,
  prompter: Prompter,
  resolved: { provider: { id: string }; model: string; note: string },
  interactive: boolean,
): Promise<boolean> {
  const [cmd, ...rest] = text.slice(1).split(/\s+/);
  const arg = rest.join(" ");
  switch (cmd) {
    case "exit":
    case "quit":
      return true;
    case "help":
      console.log(HELP);
      return false;
    case "status":
      console.log(paint.dim("  provider : " + resolved.provider.id + " (" + resolved.note + ")"));
      console.log(paint.dim("  model    : " + resolved.model));
      console.log(paint.dim("  session  : " + session.sessionId));
      console.log(paint.dim("  mode     : " + session.mode + " | sandbox: " + session.sandboxMode));
      console.log(paint.dim("  messages : " + session.messages.length + " | context ~" + session.contextTokens() + " tokens"));
      console.log(paint.dim("  tools    : " + session.tools.map((t) => t.name).join(", ")));
      return false;
    case "mode":
      if (!arg) {
        console.log("  mode = " + session.mode + " (options: default, acceptEdits, plan, bypassPermissions, dontAsk, auto)");
      } else {
        session.setMode(arg as never);
        console.log(paint.dim("  mode -> " + session.mode));
      }
      return false;
    case "sandbox":
      if (!arg) console.log("  sandbox = " + session.sandboxMode + " (options: read-only, workspace-write, danger-full-access)");
      else {
        session.setSandbox(arg as never);
        console.log(paint.dim("  sandbox -> " + session.sandboxMode));
      }
      return false;
    case "compact": {
      const r = session.compactNow();
      console.log(paint.dim("  compacted " + r.applied.join("+") + ": " + r.before + " -> " + r.after + " tokens"));
      return false;
    }
    case "context":
      console.log(paint.dim("  system prompt: " + session.systemPromptText.length + " chars"));
      console.log(paint.dim("  transcript   : ~" + session.contextTokens() + " tokens across " + session.messages.length + " messages"));
      return false;
    case "cost":
      console.log(paint.dim("  turns: " + session.stats.turns + " | tools: " + session.stats.toolCalls));
      console.log(paint.dim("  tokens in/out: " + session.stats.inputTokens + "/" + session.stats.outputTokens));
      return false;
    case "clear":
      session.clear();
      console.log(paint.dim("  transcript cleared (session file kept)"));
      return false;
    case "rules": {
      const all = [...session.rules.deny, ...session.rules.ask, ...session.rules.allow];
      if (!all.length) console.log(paint.dim("  no permission rules configured"));
      for (const r of all) console.log(paint.dim("  " + r.ruleBehavior.padEnd(5) + " " + formatRule(r) + "  <- " + r.source));
      return false;
    }
    case "sessions": {
      const list = await session.store.list();
      if (!list.length) console.log(paint.dim("  no stored sessions"));
      for (const s of list.slice(0, 15)) {
        console.log(paint.dim("  " + s.id + "  " + (s.preview || "").slice(0, 60)));
      }
      return false;
    }
    case "resume":
      console.log(paint.dim("  resume requires a fresh process: jys --resume <id>"));
      return false;
    default:
      console.log(paint.dim("  unknown command: /" + cmd + " (try /help)"));
      return false;
  }
}

main().catch((err) => {
  console.error(paint.red("fatal: " + (err instanceof Error ? err.stack ?? err.message : String(err))));
  process.exitCode = 1;
});
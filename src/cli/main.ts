#!/usr/bin/env node
/**
 * CLI front-end. The REPL is deliberately thin: all policy lives in the core.
 * Rendering is event-driven, which is why the loop can stream.
 */
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { paint, Logger } from "../util/log.ts";
import { describeSandbox, describeSandboxBackend } from "../sandbox/paths.ts";
import type { HarnessEvent } from "../core/query.ts";
import type { Session } from "../core/session.ts";
import { describeDecision, type PermissionDecision } from "../permissions/engine.ts";
import { formatRule } from "../permissions/rules.ts";
import { describeHooks } from "../hooks/hooks.ts";
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
  const SUBCOMMANDS = new Set(["serve", "desktop", "repl", "chat", "plugin", "check"]);
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

  if (sub === "check") {
    const { runCheck } = await import("./check.ts");
    await runCheck(rest);
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
    // 统一的决策文本（ALLOW/DENY/ASK + reason），并在子 Agent 发起时标出来
    const from = (request as { origin?: string }).origin === "subagent" ? paint.yellow(" · 子 Agent 发起") : "";
    console.log(paint.dim("  " + describeDecision(request.decision)) + from);
    if (request.decision.suggestedRule) {
      console.log(paint.dim("  tip: add rule \"" + request.decision.suggestedRule + "\" to always allow this"));
    }
    const answer = (await prompter.ask("  allow? [y]es / [n]o / [a]lways > ")).trim().toLowerCase();
    if (answer === "a" || answer === "always") return "always" as const;
    if (answer === "y" || answer === "yes") return "allow" as const;
    return "deny" as const;
  };

  let runtime: Awaited<ReturnType<typeof createRuntime>>;
  try {
    runtime = await createRuntime({
      args,
      logger,
      approve,
      onAlwaysAllow: (toolName: string, input: Record<string, unknown>) => {
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
      // 子 Agent 的进度走旁路，实时打印一行（每步一行，CLI 里够用了）。
      const live = (ev: unknown) => {
        const e = ev as { type: string; label?: string; tool?: string; step?: number; agentType?: string };
        if (e.type === "subagent_progress") {
          process.stdout.write(paint.dim("\n    [" + e.label + " · " + e.step + "] " + e.tool));
        } else if (e.type === "subagent_start") {
          process.stdout.write(paint.dim("\n    sub-agent " + e.label + " (" + e.agentType + ")"));
        }
      };
      for await (const ev of session.send(text, controller.signal, undefined, live)) {
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
    console.log(paint.dim("  " + describeSandboxBackend(session.sandboxMode)));
    console.log(paint.dim("  permissions: " + session.mode + "  session: " + session.sessionId));
    console.log(paint.dim("  type /help for commands, /exit to quit"));
  }
}

/** 斜杠命令分发。导出是为了让测试能逐个命令调用 —— 这层以前完全没有覆盖。 */
export async function handleSlash(
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
      // /compact 可选关注点：/compact 保留 API 改动
      // 这里原来写的是 line（不存在的变量）——REPL 里一敲 /compact 就 ReferenceError。
      const focus = text.slice(text.indexOf("compact") + "compact".length).trim();
      const r = await session.compactNow(focus || undefined);
      if (!r.applied.length) {
        console.log(paint.dim("  nothing to compact: context is already small (" + r.before + " tokens)"));
      } else {
        console.log(paint.dim("  compacted " + r.applied.join("+") + ": " + r.before + " -> " + r.after + " tokens"));
      }
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
    case "agents": {
      if (!session.agentTypes.length) console.log(paint.dim("  no agent types"));
      for (const t of session.agentTypes) {
        const scope = t.tools ? t.tools.join(",") : "all tools";
        console.log(paint.dim("  " + t.name.padEnd(10) + " " + t.source.padEnd(8) + " " + scope));
      }
      return false;
    }
    case "skills": {
      if (!session.skills.length) console.log(paint.dim("  no skills installed"));
      for (const s of session.skills) {
        const tools = s.allowedTools?.length ? "  [allowed: " + s.allowedTools.join(",") + "]" : "";
        console.log(paint.dim("  " + s.name.padEnd(18) + " " + s.source.padEnd(8) + " " + s.description + tools));
      }
      // 告警不能吞掉：重复名/缺简介是"改了没生效"的头号原因
      for (const w of session.skillWarnings) console.log(paint.yellow("  ! " + w));
      if (session.droppedTools.length) {
        console.log(paint.yellow("  ! 工具名被内置工具挡住：" + session.droppedTools.join(", ")));
      }
      return false;
    }
    case "hooks": {
      const lines = describeHooks(session.hooks);
      if (!lines.length) console.log(paint.dim("  no hooks configured (settings.json 的 hooks 或插件注册)"));
      for (const line of lines) console.log(paint.dim("  " + line));
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

// 只有"被当作程序执行"时才启动 CLI。
// 之前这里是裸的 main()：任何 import 这个模块的代码（比如测试）都会真的把 REPL
// 跑起来并挂在 stdin 上 —— 界面上表现为"测试永远不结束"。
const invokedPath = process.argv[1];
const isEntryPoint = Boolean(invokedPath) && pathToFileURL(invokedPath).href === import.meta.url;

if (isEntryPoint) {
  main().catch((err) => {
    console.error(paint.red("fatal: " + (err instanceof Error ? err.stack ?? err.message : String(err))));
    process.exitCode = 1;
  });
}
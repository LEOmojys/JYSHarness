/** Shared CLI bootstrap: argument parsing and session construction. */
import path from "node:path";
import { loadSettings, defaultSettings, type HarnessSettings } from "../core/config.ts";
import { Session } from "../core/session.ts";
import { createProvider, loadMockScript } from "../providers/index.ts";
import { SessionStore } from "../session/store.ts";
import { Logger } from "../util/log.ts";
import { loadPlugins } from "../plugins/loader.ts";
import type { PluginLoadResult } from "../plugins/types.ts";
import type { ApprovalOutcome } from "../core/query.ts";
import type { PermissionDecision } from "../permissions/engine.ts";

export interface Args {
  prompt?: string;
  provider?: string;
  model?: string;
  script?: string;
  mode?: string;
  sandbox?: string;
  workspace: string;
  resume?: string;
  yes: boolean;
  print: boolean;
  maxTurns?: number;
  noSubagent: boolean;
  debug: boolean;
  agentMode?: string;
  port?: number;
  open: boolean;
}

export function parseArgs(argv: string[]): Args {
  const args: Args = { workspace: process.cwd(), yes: false, print: false, noSubagent: false, debug: false, open: false };
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case "-p":
      case "--print":
        args.print = true;
        if (argv[i + 1] && !argv[i + 1].startsWith("-")) args.prompt = next();
        break;
      case "--provider": args.provider = next(); break;
      case "--model": args.model = next(); break;
      case "--script": args.script = next(); break;
      case "--mode": args.mode = next(); break;
      case "--sandbox": args.sandbox = next(); break;
      case "--workspace": args.workspace = path.resolve(next()); break;
      case "--resume": args.resume = next(); break;
      case "--max-turns": args.maxTurns = Number(next()); break;
      case "--agent-mode": args.agentMode = next(); break;
      case "--port": args.port = Number(next()); break;
      case "--open": args.open = true; break;
      case "-y":
      case "--yes": args.yes = true; break;
      case "--no-subagent": args.noSubagent = true; break;
      case "--debug": args.debug = true; break;
      case "-h":
      case "--help": args.print = true; args.mode = "help"; break;
      default:
        if (a.startsWith("-")) console.error("unknown flag: " + a);
        else rest.push(a);
    }
  }
  if (!args.prompt && rest.length) args.prompt = rest.join(" ");
  return args;
}

export const HELP = [
  "JYSHarness - a Claude-Code-style agent harness",
  "",
  "Usage:",
  "  jys                         open the desktop app (same as double-click)",
  "  jys desktop                  desktop app window",
  "  jys serve [--port 4317]      web UI in a browser (--open to launch it)",
  "  jys repl                     interactive terminal session",
  "  jys plugin <new|list|test>   project plugins (tools / hooks / skills)",
  "  jys \"fix the failing test\"   one-shot prompt, then exit",
  "",
  "Options:",
  "  --provider <anthropic|openai|deepseek|mock>   default: settings or anthropic",
  "  --model <id>                 model id",
  "  --script <file>              mock provider script (JSON turns)",
  "  --mode <mode>                default|acceptEdits|plan|bypassPermissions|dontAsk",
  "  --sandbox <mode>             read-only|workspace-write|danger-full-access",
  "  --workspace <dir>            workspace root (default: cwd)",
  "  --resume <session-id>        resume a stored session",
  "  --agent-mode <mode>          default|makePlugin (plugin authoring guidance)",
  "  --port <n>                   server port for serve/desktop (default 4317)",
  "  --open                       open a browser/app window automatically",
  "  -y, --yes                    auto-approve permission prompts (demos/tests)",
  "  --max-turns <n>              hard cap on loop iterations",
  "  --no-subagent                disable the Agent tool",
  "",
  "Slash commands: /help /status /mode /sandbox /compact /context /cost /clear /sessions /resume /rules /exit",
].join("\n");

export interface Runtime {
  settings: HarnessSettings;
  loaded: ReturnType<typeof loadSettings>;
  resolved: ReturnType<typeof createProvider>;
  session: Session;
  store: SessionStore;
  plugins: PluginLoadResult;
}

export interface RuntimeOptions {
  args: Args;
  logger: Logger;
  /** Keep running without credentials so the UI can be used to configure them. */
  allowUnconfigured?: boolean;
  approve: (req: { toolName: string; input: Record<string, unknown>; decision: PermissionDecision }) => Promise<ApprovalOutcome>;
  onAlwaysAllow?: (toolName: string, input: Record<string, unknown>) => void;
}

export async function createRuntime(opts: RuntimeOptions): Promise<Runtime> {
  const { args, logger } = opts;
  const cliSettings: HarnessSettings = {};
  if (args.maxTurns) cliSettings.maxTurns = args.maxTurns;
  if (args.mode && args.mode !== "help") cliSettings.permissionMode = args.mode as never;
  if (args.sandbox) cliSettings.sandboxMode = args.sandbox as never;

  const loaded = loadSettings(args.workspace, cliSettings);
  const settings: HarnessSettings = { ...defaultSettings(), ...loaded.settings };

  const mockTurns = args.script
    ? loadMockScript(path.resolve(args.script))
    : args.provider === "mock"
      ? [{ text: "mock provider ready (no script supplied)" }]
      : undefined;

  let resolved;
  try {
    resolved = createProvider({ settings, providerName: args.provider, model: args.model, mockTurns });
  } catch (err) {
    if (!opts.allowUnconfigured) throw err;
    const { UnconfiguredProvider } = await import("../providers/unconfigured.ts");
    const reason = err instanceof Error ? err.message : String(err);
    resolved = {
      provider: new UnconfiguredProvider(reason),
      model: "未配置",
      note: "未配置模型：" + reason,
    } as ReturnType<typeof createProvider>;
  }

  const store = new SessionStore(path.join(args.workspace, ".harness", "sessions"));
  let resumeMessages = undefined;
  if (args.resume) {
    const prev = await store.load(args.resume);
    resumeMessages = prev.messages;
  }

  const session = new Session({
    workspaceRoot: args.workspace,
    settings,
    rules: loaded.rules,
    provider: resolved.provider,
    model: resolved.model,
    logger,
    approve: opts.approve,
    onAlwaysAllow: opts.onAlwaysAllow,
    hooks: settings.hooks,
    compaction: settings.compaction,
    contextWindow: settings.contextWindow,
    sessionId: args.resume,
    resumeMessages,
    enableSubagent: settings.enableSubagent !== false && !args.noSubagent,
  });
  // Project plugins: tools / prompt sections / hooks / skills, isolated per plugin.
  const plugins = await loadPlugins(args.workspace, logger);
  for (const err of plugins.errors) logger.warn("plugin " + err.plugin + " 加载失败：" + err.message);
  if (plugins.plugins.length) {
    logger.info(
      "plugins: " +
        plugins.plugins.map((p) => p.name + "(" + p.tools + " tools)").join(", "),
    );
    session.applyPlugins(plugins);
  }

  if (args.agentMode === "makePlugin" || args.agentMode === "default") {
    session.setAgentMode(args.agentMode);
  }

  await session.init();
  return { settings, loaded, resolved, session, store, plugins };
}

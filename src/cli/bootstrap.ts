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

/**
 * 带一个值的全局 flag —— 单一事实来源。
 *
 * 子命令（plugin/skill/worktree）需要自己剥离全局参数。如果每个子命令维护一份
 * 私有列表，迟早会漏：`jys --script x plugin new demo` 里一旦漏登记 `--script`，
 * `x` 就会被当成子命令（真实故障：报"未知子命令：config.json"）。
 * 所以这里导出一份，dispatch、parseArgs、子命令全部复用同一张表。
 */
export const GLOBAL_VALUE_FLAGS: ReadonlySet<string> = new Set([
  "--provider", "--model", "--script", "--mode", "--sandbox", "--resume",
  "--workspace", "--max-turns", "--agent-mode", "--port",
]);

/** Shared by dispatch and argument parsing so both consume the same tokens. */
export function readGlobalOption(argv: readonly string[], index: number): { size: number; values: Partial<Args> } | undefined {
  const flag = argv[index];
  const next = argv[index + 1];
  const required = () => {
    if (next === undefined || next.startsWith("--")) throw new TypeError("missing value for " + flag);
    return next;
  };
  switch (flag) {
    case "-p": case "--print":
      return next && !next.startsWith("-")
        ? { size: 2, values: { print: true, prompt: next } }
        : { size: 1, values: { print: true } };
    case "--open": return { size: 1, values: { open: true } };
    case "-y": case "--yes": return { size: 1, values: { yes: true } };
    case "--no-subagent": return { size: 1, values: { noSubagent: true } };
    case "--debug": return { size: 1, values: { debug: true } };
    case "-h": case "--help": return { size: 1, values: { print: true, mode: "help" } };
  }
  if (!GLOBAL_VALUE_FLAGS.has(flag)) return undefined;
  const value = required();
  switch (flag) {
    case "--workspace": return { size: 2, values: { workspace: path.resolve(value) } };
    case "--max-turns": return { size: 2, values: { maxTurns: Number(value) } };
    case "--port": return { size: 2, values: { port: Number(value) } };
    // 连字符名与字段名不同，必须显式映射（`agent-mode`.slice(2) 是 "agent-mode"）
    case "--agent-mode": return { size: 2, values: { agentMode: value } };
    default: return { size: 2, values: { [flag.slice(2)]: value } as Partial<Args> };
  }
}

export function parseArgs(argv: string[]): Args {
  const args: Args = { workspace: process.cwd(), yes: false, print: false, noSubagent: false, debug: false, open: false };
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const option = readGlobalOption(argv, i);
    if (option) {
      Object.assign(args, option.values);
      i += option.size - 1;
    } else if (argv[i].startsWith("-")) console.error("unknown flag: " + argv[i]);
    else rest.push(argv[i]);
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
  "  jys plugin <command>         manage plugins (jys plugin --help)",
  "  jys skill <list|import-dsh>  list skills or import a directory of skills",
  "  jys worktree <command>       manage project worktrees",
  "  jys check [--entropy]        architecture + entropy checks (--json, --install-hook)",
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
  "Slash commands: /help /status /mode /sandbox /compact /context /cost /clear /sessions /resume /rules /hooks /agents /skills /exit",
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

export function loadRuntimeSettings(args: Args, workspaceRoot: string, logger: Logger) {
  const cliSettings: HarnessSettings = {};
  if (args.maxTurns) cliSettings.maxTurns = args.maxTurns;
  if (args.mode && args.mode !== "help") cliSettings.permissionMode = args.mode as never;
  if (args.sandbox) cliSettings.sandboxMode = args.sandbox as never;

  const loaded = loadSettings(workspaceRoot, cliSettings);
  // 配置里的问题（写错的 hook 等）在启动时就告诉用户，而不是运行时才炸。
  for (const warning of loaded.warnings ?? []) logger.warn("settings: " + warning);
  const settings: HarnessSettings = { ...defaultSettings(), ...loaded.settings };
  return { loaded, settings };
}

export async function createRuntime(opts: RuntimeOptions): Promise<Runtime> {
  const { args, logger } = opts;
  const { loaded, settings } = loadRuntimeSettings(args, args.workspace, logger);
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

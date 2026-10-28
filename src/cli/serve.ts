/** `jys serve` / `jys desktop` — expose the session over HTTP and open a shell. */
import path from "node:path";
import { parseArgs, createRuntime, HELP } from "./bootstrap.ts";
import { Session } from "../core/session.ts";
import { connectMcpServers } from "../mcp/index.ts";
import { createProvider } from "../providers/index.ts";
import type { HarnessSettings } from "../core/config.ts";
import type { McpServerView } from "../core/configStore.ts";
import { startServer } from "../server/app.ts";
import { launchAppWindow, openInBrowser, findBrowser } from "../desktop/launch.ts";
import { Logger, paint } from "../util/log.ts";

export async function runServe(argv: string[], desktop: boolean): Promise<void> {
  const args = parseArgs(argv);
  args.workspace = path.resolve(args.workspace);

  if (args.mode === "help") {
    console.log(HELP);
    return;
  }

  const logger = new Logger(args.debug ? "debug" : "warn");

  let runtime;
  try {
    runtime = await createRuntime({
      args,
      logger,
      // 服务端永远容忍"还没配置密钥"：设置界面本身就是配置入口。
      allowUnconfigured: true,
      // Placeholder: the HTTP server installs the real browser-backed approver.
      approve: async () => "deny",
    });
  } catch (err) {
    console.error(paint.red(err instanceof Error ? err.message : String(err)));
    process.exitCode = 1;
    return;
  }

  // MCP: connect configured servers once, then share the tools across sessions.
  const mcp = await connectMcpServers(runtime.settings, logger, args.workspace);
  if (mcp.tools.length) runtime.session.setExtensionTools(mcp.tools);

  const makeSession = async (
    workspaceRoot?: string,
    resume?: { sessionId: string; resumeMessages: import("../core/types.ts").Message[] },
  ): Promise<Session> => {
    const fresh = new Session({
      workspaceRoot: workspaceRoot ?? runtime.session.workspaceRoot,
      sessionId: resume?.sessionId,
      resumeMessages: resume?.resumeMessages,
      settings: runtime.settings,
      rules: runtime.loaded.rules,
      provider: runtime.resolved.provider,
      model: runtime.resolved.model,
      logger,
      approve: async () => "deny",
      hooks: runtime.settings.hooks,
      compaction: runtime.settings.compaction,
      contextWindow: runtime.settings.contextWindow,
      enableSubagent: runtime.settings.enableSubagent !== false && !args.noSubagent,
    });
    // Plugins are per-workspace behavior; apply them to every new session too.
    if (runtime.plugins.plugins.length) fresh.applyPlugins(runtime.plugins);
    if (mcp.tools.length) fresh.setExtensionTools(mcp.tools);
    return fresh;
  };

  // Hot reload: the settings UI can swap the model or MCP servers without a restart.
  const buildProvider = (cfg: { provider: string; model: string; baseUrl?: string; apiKeyEnv?: string }) => {
    const settings: HarnessSettings = {
      ...runtime.settings,
      provider: cfg.provider as HarnessSettings["provider"],
      model: cfg.model,
      // 没传就不要覆盖：否则 baseUrl 会被写成 undefined，再遇上 ?? 回退就跳到
      // 另一个厂商的默认地址（deepseek 的配置被当成 openai）。
      baseUrl: cfg.baseUrl ?? runtime.settings.baseUrl,
      apiKeyEnv: cfg.apiKeyEnv ?? runtime.settings.apiKeyEnv,
    };
    const resolved = createProvider({ settings, providerName: cfg.provider, model: cfg.model });
    return { provider: resolved.provider, model: resolved.model, note: resolved.note };
  };

  let liveMcp = mcp;
  const reloadMcp = async (servers: McpServerView[]) => {
    // 关宿主而不是关初始 client：重连后 client 已经换过，关旧的会漏掉新的进程。
    for (const h of liveMcp.hosts) h.close();
    const map: Record<string, { command: string; args?: string[]; env?: Record<string, string> }> = {};
    for (const server of servers) {
      if (!server.name || !server.command) continue;
      map[server.name] = { command: server.command, args: server.args, env: server.env };
    }
    liveMcp = await connectMcpServers({ ...runtime.settings, mcpServers: map }, logger, args.workspace);
    return { tools: liveMcp.tools, errors: liveMcp.errors };
  };

  const server = await startServer({
    session: runtime.session,
    makeSession,
    buildProvider,
    reloadMcp,
    logger,
    port: args.port ?? 4317,
    providerId: runtime.resolved.provider.id,
    providerNote: runtime.resolved.note,
    autoApprove: args.yes,
  });

  console.log("");
  console.log(paint.bold("  JYSHarness") + paint.dim("  " + (desktop ? "desktop" : "serve")));
  console.log(paint.dim("  url      ") + server.url);
  console.log(paint.dim("  model    ") + runtime.resolved.model + paint.dim(" (" + runtime.resolved.provider.id + ")"));
  console.log(paint.dim("  workspace") + " " + runtime.session.workspaceRoot);
  console.log(paint.dim("  session  ") + runtime.session.sessionId);
  console.log(paint.dim("  approval ") + (args.yes ? "auto-approve (-y)" : "interactive (in the UI)"));
  if (runtime.resolved.provider.id === "unconfigured") {
    console.log(paint.yellow("  未配置模型：打开窗口右上角【设置】填写服务商与 API Key 即可开始，无需重启。"));
  }
  if (mcp.clients.length || mcp.errors.length) {
    console.log(paint.dim("  mcp      ") + mcp.clients.length + " server(s), " + mcp.tools.length + " tool(s)");
    for (const e of mcp.errors) console.log(paint.yellow("  mcp " + e.server + " failed: " + e.message));
  }
  console.log("");

  let child: ReturnType<typeof launchAppWindow> = null;
  if (desktop) {
    child = launchAppWindow({
      url: server.url,
      profileDir: path.join(args.workspace, ".harness", "window-profile"),
    });
    if (!child) {
      console.log(paint.yellow("  no Chromium-based browser found; falling back to the default browser."));
      console.log(paint.dim("  set HARNESS_BROWSER=/path/to/chrome to pick one explicitly."));
      openInBrowser(server.url);
    } else {
      console.log(paint.dim("  window opened (" + (findBrowser() ?? "browser") + ")"));
      console.log(paint.dim("  close the window to stop the server, or press Ctrl+C here."));
    }
  } else if (args.open) {
    openInBrowser(server.url);
  }

  await new Promise<void>((resolve) => {
    let closing = false;
    const shutdown = async (code = 0) => {
      if (closing) return;
      closing = true;
      await server.close();
      process.exitCode = code;
      resolve();
    };
    process.once("SIGINT", () => void shutdown(0));
    process.once("SIGTERM", () => void shutdown(0));
    // A dedicated app window owns the lifetime of this process.
    child?.once("exit", () => void shutdown(0));
  });
}

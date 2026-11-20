/**
 * Local HTTP + SSE server. Multi-session: every session gets its own loop,
 * approval queue and event namespace; the UI subscribes once and filters.
 *
 * Security: loopback bind, Origin check, workspace-contained file API.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { HttpError, json, readJson, serveStatic, text } from "./http.ts";
import { readFile, readdir, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { Session } from "../core/session.ts";
import type { ApprovalOutcome, HarnessEvent } from "../core/query.ts";
import type { PermissionDecision } from "../permissions/engine.ts";
import { formatRule } from "../permissions/rules.ts";
import { realResolve, isInside, sandboxEnforcement } from "../sandbox/paths.ts";
import { loadSettings } from "../core/config.ts";
import { isValidRule, readRuleArrays, writeRuleArrays, type RuleArrays } from "../core/ruleStore.ts";
import { describeHooks } from "../hooks/hooks.ts";
import { describeConfig, readAppConfig, resolveApiKey, saveAppConfig, type ConfigPatch, type McpServerView } from "../core/configStore.ts";
import type { ModelProvider } from "../providers/types.ts";
import type { Tool } from "../tools/types.ts";
import { inspectPlugins, loadPlugins, setPluginEnabled } from "../plugins/loader.ts";
import { shutdownHost, shutdownHosts } from "../plugins/host/client.ts";
import type { PluginLoadResult } from "../plugins/types.ts";
import { createWorktree, listWorktrees, mainRepositoryRoot, removeWorktree } from "../core/worktrees.ts";
import { parsePluginAsset, parsePluginRoute, pipeAsset, resolveAssetPath } from "../plugins/http.ts";
import { pluginPanelDirs, type PanelDecl } from "../plugins/panels.ts";
import { findPluginCommand } from "../plugins/commands.ts";
import { spawn } from "node:child_process";
import {
  browseDirectories,
  listFavoriteEntries,
  listRecentEntries,
  rememberWorkspace,
  setFavorite,
  validateWorkspace,
} from "../core/workspaces.ts";
import type { Logger } from "../util/log.ts";

const CLI_MAIN = fileURLToPath(new URL("../cli/main.ts", import.meta.url));

/** Run the CLI in-process-equivalent (separate node) and resolve with its exit code. */
function runCli(argv: string[]): Promise<number> {
  return new Promise((resolve) => {
    try {
      const child = spawn(process.execPath, [CLI_MAIN, ...argv], { stdio: "ignore", windowsHide: true });
      child.on("error", () => resolve(1));
      child.on("close", (code) => resolve(code ?? 1));
    } catch {
      resolve(1);
    }
  });
}

const APPROVAL_TIMEOUT_MS = 10 * 60_000;
const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", ".next", ".harness", "target", "__pycache__"]);

export interface ServerOptions {
  session: Session;
  initialPlugins?: PluginLoadResult;
  /** Factory for additional sessions (new tab / fork / another workspace). */
  makeSession?: (
    workspaceRoot?: string,
    resume?: { sessionId: string; resumeMessages: import("../core/types.ts").Message[] },
  ) => Promise<Session>;
  logger: Logger;
  host?: string;
  port?: number;
  providerId: string;
  providerNote?: string;
  autoApprove?: boolean;
  /** Build a provider from saved config (hot swap from the settings UI). */
  buildProvider?: (cfg: {
    provider: string; model: string; baseUrl?: string; apiKeyEnv?: string; reasoningEffort?: string;
  }) => { provider: ModelProvider; model: string; note: string };
  /** Reconnect MCP servers after the config changes. */
  reloadMcp?: (servers: McpServerView[]) => Promise<{
    tools: Tool[];
    errors: { server: string; message: string }[];
  }>;
}

export interface RunningServer {
  url: string;
  port: number;
  close: () => Promise<void>;
}

/**
 * 带 HTTP 状态码的错误：catch 里据此回不同状态码。
 * 以前所有客户端错误（坏 JSON、超限、坏 URL）都统一变成 500 + "internal error"，
/** 权限模式与沙箱模式的合法取值：模式是安全边界，不能接受任意字符串。 */
const PERMISSION_MODES = new Set(["default", "acceptEdits", "plan", "bypassPermissions", "dontAsk", "auto"]);
const SANDBOX_MODES = new Set(["read-only", "workspace-write", "danger-full-access"]);
const REASONING_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "ultra", "max"]);

interface PendingApproval {
  resolve: (outcome: ApprovalOutcome) => void;
  timer: NodeJS.Timeout;
}

interface Hosted {
  session: Session;
  running: boolean;
  abort: AbortController | null;
  pending: Map<string, PendingApproval>;
  /** Recent file changes, so diffs survive a reload. */
  changes: { path: string; created: boolean; diff: unknown[]; at: number }[];
}

export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  const { logger } = opts;
  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? 4317;

  const clients = new Set<ServerResponse>();
  const sessions = new Map<string, Hosted>();
  let activeId = "";
  let approvalSeq = 0;
  /**
   * 自己的 origin / Host 白名单，listen 之后才知道真实端口。
   *
   * 以前只校验 `http://127.0.0.1|localhost`（端口任意）且 origin 缺失直接放行 ——
   * 本机任何其他端口上的页面（dev server、Jupyter、被 XSS 的本地工具）都能打到
   * /api/config 把 sandbox 改成 danger-full-access，等于远程 RCE。
   * 这里收紧成"精确到自己监听的端口"，并补上 Host 头校验（DNS rebinding）。
   */
  const selfOrigins = new Set<string>();
  const selfHosts = new Set<string>();

  /**
   * 转录存储。**不能**通过 current().session.store 去拿：
   * 删掉最后那个活动会话后 sessions 会变空，current() 就返回 undefined，
   * 于是删除接口自己 500（实测就是这个）。
   */
  // 按目标会话解析 store：别的 workspace 各有 sessions 目录，用错会"点开却没有"。
  const storeOf = (id: string) => sessions.get(id)?.session.store ?? current().session.store;
  const workspacePlugins = new Map<string, Promise<PluginLoadResult>>();
  if (opts.initialPlugins) workspacePlugins.set(opts.session.workspaceRoot, Promise.resolve(opts.initialPlugins));

  function pluginsFor(root: string): Promise<PluginLoadResult> {
    const existing = workspacePlugins.get(root);
    if (existing) return existing;
    const loading = loadPlugins(root, logger).catch((err: unknown) => {
      if (workspacePlugins.get(root) === loading) workspacePlugins.delete(root);
      throw err;
    });
    workspacePlugins.set(root, loading);
    return loading;
  }

  async function register(session: Session): Promise<Hosted> {
    session.applyPlugins(await pluginsFor(session.workspaceRoot));
    const hosted: Hosted = { session, running: false, abort: null, pending: new Map(), changes: [] };
    sessions.set(session.sessionId, hosted);
    session.setApprover((req) => askApproval(hosted, req));
    if (!activeId) activeId = session.sessionId;
    return hosted;
  }

  function current(): Hosted {
    return sessions.get(activeId) ?? sessions.values().next().value!;
  }

  function writeAll(payload: string): void {
    for (const res of clients) {
      try {
        res.write(payload);
      } catch {
        clients.delete(res);
      }
    }
  }

  // 流式增量按帧合并：一轮可能上万个 delta，逐个广播会把 SSE 与浏览器主线程压满
  // （表现为界面卡顿甚至无响应）。同类增量攒到下一次 tick 再发，事件语义不变。
  let pendingDelta: { type: string; text: string } | null = null;
  let deltaTimer: ReturnType<typeof setTimeout> | null = null;
  function flushDelta(): void {
    if (deltaTimer) { clearTimeout(deltaTimer); deltaTimer = null; }
    const pending = pendingDelta;
    pendingDelta = null;
    if (pending) writeAll("data: " + JSON.stringify(pending) + "\n\n");
  }
  function broadcast(event: unknown): void {
    const kind = (event as { type?: string }).type;
    if (kind === "text_delta" || kind === "thinking_delta") {
      const text = String((event as { text?: string }).text ?? "");
      if (pendingDelta && pendingDelta.type !== kind) flushDelta();
      pendingDelta = { type: kind, text: (pendingDelta?.text ?? "") + text };
      if (!deltaTimer) deltaTimer = setTimeout(flushDelta, 50);
      return;
    }
    flushDelta();
    writeAll("data: " + JSON.stringify(event) + "\n\n");
  }

  /** 还没开始过的会话用目录名区分，否则侧栏会堆一排"新会话"。 */
  function displayTitle(s: Session): string {
    const t = s.title();
    return t === "新会话" ? path.basename(s.workspaceRoot) + "（未开始）" : t;
  }

  async function buildState(h: Hosted) {
    const s = h.session;
    const stored = await s.store.list().catch(() => []);
    const live = [...sessions.values()].map((x) => ({
      id: x.session.sessionId,
      title: displayTitle(x.session),
      createdAt: "",
      running: x.running,
    }));
    const merged = [...live];
    for (const rec of stored) {
      if (!merged.some((m) => m.id === rec.id)) {
        merged.push({ id: rec.id, title: rec.preview || "(empty)", createdAt: rec.createdAt, running: false });
      }
    }
    return {
      sessionId: s.sessionId,
      activeSession: activeId,
      provider: opts.providerId,
      providerNote: opts.providerNote ?? "",
      model: s.model,
      mode: s.mode,
      agentMode: s.agentMode,
      sandbox: s.sandboxMode,
      // 模式只是"我想要什么"，这里给的是"实际有什么"：
      // 沙箱不可用时会退化成纯路径/命令检查，用户必须看得见。
      sandboxEnforcement: sandboxEnforcement(s.sandboxMode),
      workspace: s.workspaceRoot,
      // 还没开始过的会话用目录名区分，否则侧栏会堆一排"新会话"。
      title: displayTitle(s),
      messages: s.messages,
      tools: s.tools.map((t) => ({ name: t.name, description: t.description, readOnly: t.isReadOnly })),
      stats: s.stats,
      cost: s.cost(),
      contextTokens: s.contextTokens(),
      contextWindow: s.contextWindow,
      contextUsage: s.contextUsage(),
      context: s.contextBreakdown(),
      cache: s.cost(),
      running: h.running,
      hooks: describeHooks(s.hooks),
      // 技能/插件的问题必须可见：静默跳过会让人以为配置生效了
      skillWarnings: s.skillWarnings,
      persistWarnings: s.persistWarnings,
      droppedTools: s.droppedTools,
      agentTypes: s.agentTypes.map((t) => ({ name: t.name, description: t.description, tools: t.tools ?? null })),
      todos: s.todos.items,
      changes: h.changes.slice(-40),
      jobs: jobsFor(s),
      skills: s.skills.map((k) => ({ name: k.name, description: k.description, source: k.source })),
      checkpoints: s.checkpoints.depth(),
      ruleArrays: readRuleArrays(s.workspaceRoot),
      rules: [...s.rules.deny, ...s.rules.ask, ...s.rules.allow].map((r) => ({
        behavior: r.ruleBehavior,
        text: formatRule(r),
        source: r.source,
      })),
      sessions: merged,
    };
  }

  function jobsFor(s: Session) {
    return s.jobs.list().map((j) => ({
      id: j.id,
      command: j.command,
      status: j.status,
      startedAt: j.startedAt,
      exitCode: j.exitCode,
      outputTail: j.output.slice(-4000),
    }));
  }

  async function emitState(h: Hosted): Promise<void> {
    broadcast({ type: "state", sessionId: h.session.sessionId, state: await buildState(h) });
  }

  /**
   * 配置的对外形状：GET /api/config 与 POST 的 config 字段共用。
   *
   * 分开构造过一次，直接导致"设置里填了 API 却保存不了"：POST 少返回 active，
   * 前端 renderSettings 抛错并清空表单。一个构造函数，两端不会再分叉。
   */
  /**
   * 插件面板清单（同步读取，不抛错）。
   *
   * 为什么在这里做而不是缓存：面板注册发生在插件 activate 时，而 activate 可能有副作用，
   * 缓存要处理失效；面板数量很小，每次读一遍 manifest 的代价可以忽略。
   */
  function panelsOf(workspaceRoot: string): PanelDecl[] {
    try {
      return pluginPanelDirs(workspaceRoot).flatMap((p) => p.panels);
    } catch {
      return [];
    }
  }

  function configPayload(h: Hosted) {
    const cfg = describeConfig(h.session.workspaceRoot, {
      provider: h.session.provider.id,
      model: h.session.model,
    });
    return {
      ...cfg,
      active: { provider: h.session.provider.id, model: h.session.model },
      workspace: h.session.workspaceRoot,
      // 插件面板清单：UI 据此在侧栏加按钮，并动态 import() 插件自己的浏览器侧资产。
      // 这里只给"有什么"，不含任何插件代码 —— 代码走 /plugin-assets/<id>/index.js。
      panels: panelsOf(h.session.workspaceRoot),
    };
  }

  function askApproval(
    h: Hosted,
    request: {
      toolName: string;
      input: Record<string, unknown>;
      decision: PermissionDecision;
      origin?: "subagent";
    },
  ): Promise<ApprovalOutcome> {
    if (opts.autoApprove) return Promise.resolve("allow");
    const id = "perm_" + ++approvalSeq;
    return new Promise<ApprovalOutcome>((resolve) => {
      const timer = setTimeout(() => {
        if (h.pending.delete(id)) resolve("deny");
      }, APPROVAL_TIMEOUT_MS);
      h.pending.set(id, { resolve, timer });
      broadcast({
        type: "permission_request",
        sessionId: h.session.sessionId,
        id,
        toolName: request.toolName,
        input: request.input,
        decision: request.decision,
        // 子 Agent 的审批必须能看出来源，否则用户不知道自己在替谁批准
        origin: request.origin,
      });
    });
  }

  /** Activate (or create) the session bound to a workspace path. */
  async function switchTo(target: string) {
    const existing = [...sessions.values()].find((h) => h.session.workspaceRoot === target);
    if (existing) {
      activeId = existing.session.sessionId;
      rememberWorkspace(target);
      return buildState(existing);
    }
    const fresh = await opts.makeSession!(target);
    await fresh.init();
    const hosted = await register(fresh);
    activeId = fresh.sessionId;
    rememberWorkspace(target);
    return buildState(hosted);
  }

  async function runTurn(
    h: Hosted,
    text: string,
    images?: { mediaType: string; data: string; name?: string }[],
  ): Promise<void> {
    if (h.running) return;
    h.running = true;
    const controller = new AbortController();
    h.abort = controller;
    const sessionId = h.session.sessionId;
    broadcast({ type: "turn_start", sessionId });
    try {
      // 旁路：子 Agent 的进度在运行中就能到前端，不必等这一轮结束。
      const live = (ev: unknown) => broadcast({ ...(ev as Record<string, unknown>), sessionId });
      for await (const ev of h.session.send(text, controller.signal, images, live)) {
        broadcast({ ...ev, sessionId });
        if (ev.type === "tool_end") {
          const meta = (ev.result.metadata ?? {}) as { todos?: unknown; changes?: { path: string; created: boolean; diff: unknown[] }[] };
          if (meta.todos) broadcast({ type: "todos", sessionId, todos: meta.todos });
          for (const c of meta.changes ?? []) {
            h.changes.push({ ...c, path: relativeTo(h.session.workspaceRoot, c.path), at: Date.now() });
          }
          if (h.changes.length > 80) h.changes = h.changes.slice(-80);
          if ((meta.changes ?? []).length) broadcast({ type: "changes", sessionId, changes: h.changes.slice(-40) });
          broadcast({ type: "jobs", sessionId, jobs: jobsFor(h.session) });
        }
      }
    } catch (err) {
      broadcast({
        type: "notice",
        sessionId,
        level: "warn",
        code: "turn_failed",
        params: { message: err instanceof Error ? err.message : String(err) },
        text: "turn failed: " + (err instanceof Error ? err.message : String(err)),
      });
    } finally {
      for (const [id, p] of h.pending) {
        clearTimeout(p.timer);
        p.resolve("deny");
        h.pending.delete(id);
      }
      h.running = false;
      h.abort = null;
      broadcast({ type: "turn_end", sessionId, state: await buildState(h) });
    }
  }

  await register(opts.session);

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://" + host + ":" + port);
    const route = url.pathname;
    const origin = req.headers.origin;
    // 精确匹配自己的 origin：只放行本服务实际监听的端口。
    if (origin && selfOrigins.size && !selfOrigins.has(origin)) {
      res.writeHead(403).end("forbidden origin");
      return;
    }
    // Host 头也要认：没有这条，DNS rebinding 能让外部域名解析到 127.0.0.1 后
    // 用同源的 GET 读走 /api/file 里的密钥（浏览器同源 GET 不发 Origin）。
    const hostHeader = String(req.headers.host ?? "").toLowerCase();
    if (selfHosts.size && hostHeader && !selfHosts.has(hostHeader)) {
      res.writeHead(421).end("misdirected request (bad host)");
      return;
    }
    if (req.headers["sec-fetch-site"] === "cross-site") {
      res.writeHead(403).end("forbidden cross-site request");
      return;
    }

    try {
      if (route === "/api/state" && req.method === "GET") {
        const id = url.searchParams.get("session");
        const h = id ? sessions.get(id) : current();
        if (!h) return json(res, 404, { error: "no such session" });
        return json(res, 200, await buildState(h));
      }

      if (route === "/api/events" && req.method === "GET") {
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          "x-accel-buffering": "no",
        });
        res.write(": connected\n\n");
        clients.add(res);
        const keepAlive = setInterval(() => {
          try {
            res.write(": ping\n\n");
          } catch {
            clearInterval(keepAlive);
          }
        }, 15_000);
        req.on("close", () => {
          clearInterval(keepAlive);
          clients.delete(res);
        });
        res.write("data: " + JSON.stringify({ type: "state", state: await buildState(current()) }) + "\n\n");
        return;
      }

      if (route === "/api/message" && req.method === "POST") {
        const body = (await readJson(req)) as {
          text?: string;
          session?: string;
          images?: { mediaType?: string; data?: string; name?: string }[];
        };
        const text = String(body.text ?? "").trim();
        const images = (body.images ?? []).slice(0, 6).map((img) => ({
          mediaType: String(img.mediaType ?? "image/png"),
          data: String(img.data ?? ""),
          name: img.name ? String(img.name) : undefined,
        }));
        const ALLOWED_IMAGE = /^image\/(png|jpeg|webp|gif)$/;
        for (const img of images) {
          if (!ALLOWED_IMAGE.test(img.mediaType)) return json(res, 400, { error: "unsupported image type " + img.mediaType });
          if (!img.data || img.data.length > 8_000_000) return json(res, 400, { error: "image payload missing or too large" });
        }
        if (!text && !images.length) return json(res, 400, { error: "empty message" });
        const h = body.session ? sessions.get(body.session) : current();
        if (!h) return json(res, 404, { error: "no such session" });
        if (h.running) return json(res, 409, { error: "a turn is already running in this session" });
        json(res, 202, { ok: true });
        void runTurn(h, text, images);
        return;
      }

      if (route === "/api/sessions" && req.method === "GET") {
        return json(res, 200, (await buildState(current())).sessions);
      }

      if (route === "/api/sessions" && req.method === "POST") {
        const body = (await readJson(req)) as { action?: string; id?: string };
        const action = body.action ?? "";
        if (action === "activate" && body.id) {
          const h = sessions.get(body.id);
          if (h) {
            activeId = body.id;
            return json(res, 200, await buildState(h));
          }
          // 只在磁盘上的历史会话：现场恢复并注册（早先直接 404，列表点不动）。
          if (!opts.makeSession) return json(res, 404, { error: "not loaded; restart with --resume " + body.id });
          const loaded = await storeOf(body.id).load(body.id);
          if (!loaded.meta) return json(res, 404, { error: "no such session: " + body.id });
          const fresh = await opts.makeSession(loaded.meta.workspaceRoot, {
            sessionId: body.id,
            resumeMessages: loaded.messages,
          });
          await fresh.init();
          const hosted = await register(fresh);
          activeId = body.id;
          return json(res, 200, await buildState(hosted));
        }
        if (action === "new" || action === "fork") {
          if (!opts.makeSession) return json(res, 400, { error: "session factory not configured" });
          if (sessions.size >= 50) return json(res, 400, { error: "活动会话过多（上限 50），请先删除一些" });
          const source = current().session;
          const fresh = await opts.makeSession(source.workspaceRoot);
          await fresh.init();
          if (action === "fork") {
            // 继承来的历史必须一起落盘：只赋 fresh.messages 的话，重启后 fork
            // 会话只剩 fork 之后的两条消息，上下文全丢。
            await fresh.replaceMessages(JSON.parse(JSON.stringify(source.messages)));
          }
          await register(fresh);
          activeId = fresh.sessionId;
          return json(res, 200, await buildState(sessions.get(fresh.sessionId)!));
        }
        if (action === "delete" && body.id) {
          const live = sessions.get(body.id);
          // 判据是"活动 + 磁盘"之和，只数活动会话会误判成最后一个。
          const onDisk = await storeOf(body.id).ids();
          const all = new Set<string>([...sessions.keys(), ...onDisk]);
          if (all.size <= 1 && all.has(body.id)) {
            return json(res, 400, { error: "不能删除最后一个会话" });
          }
          const wasActive = activeId === body.id;
          if (live) {
            live.abort?.abort();
            // 等回合真退出：abort 是协作式的，落盘队列里可能还有 append；不等就删文件，
            // 队列里的写会把转录重新创建出来（删了又复活）。
            for (const deadline = Date.now() + 5000; live.running && Date.now() < deadline; ) await new Promise((r) => setTimeout(r, 10));
            live.session.jobs.killAll();
            for (const [id, pending] of live.pending) {
              clearTimeout(pending.timer);
              pending.resolve("deny");
              live.pending.delete(id);
            }
            await live.session.flushPersist().catch(() => {});
            sessions.delete(body.id);
            if (activeId === body.id) activeId = sessions.keys().next().value!;
          }
          // 历史会话（只存在于磁盘）也要能删，否则重启后又会冒出来。
          const removed = await storeOf(body.id).remove(body.id);
          if (!live && !removed) return json(res, 404, { error: "会话不存在" });
          // 删掉最后一个活动会话后自动补一个空的，界面不会停在"没有会话"。
          if (sessions.size === 0 && opts.makeSession) {
            const fresh = await opts.makeSession(undefined);
            await fresh.init();
            await register(fresh);
          }
          if (wasActive || !sessions.has(activeId)) {
            activeId = sessions.keys().next().value ?? activeId;
          }
          return json(res, 200, await buildState(current()));
        }
        return json(res, 400, { error: "unknown action" });
      }

      if (route === "/api/permission" && req.method === "POST") {
        const body = (await readJson(req)) as { id?: string; decision?: ApprovalOutcome };
        for (const h of sessions.values()) {
          const p = body.id ? h.pending.get(body.id) : undefined;
          if (!p || !body.id) continue;
          clearTimeout(p.timer);
          h.pending.delete(body.id);
          const decision: ApprovalOutcome =
            body.decision === "allow" || body.decision === "always" ? body.decision : "deny";
          p.resolve(decision);
          broadcast({ type: "permission_resolved", sessionId: h.session.sessionId, id: body.id, decision });
          return json(res, 200, { ok: true });
        }
        return json(res, 404, { error: "no such approval" });
      }

      if (route === "/api/cancel" && req.method === "POST") {
        const body = (await readJson(req)) as { session?: string };
        const h = body.session ? sessions.get(body.session) : current();
        h?.abort?.abort();
        return json(res, 200, { ok: true });
      }

      if (route === "/api/settings" && req.method === "POST") {
        const body = (await readJson(req)) as {
          mode?: string;
          sandbox?: string;
          agentMode?: string;
          session?: string;
        };
        const h = body.session ? sessions.get(body.session) : current();
        if (!h) return json(res, 404, { error: "no such session" });
        // 枚举白名单：模式是安全边界，"随便传个字符串"不该被当成合法的权限模式。
        if (body.mode !== undefined && !PERMISSION_MODES.has(body.mode)) return json(res, 400, { error: "unknown permission mode: " + body.mode });
        if (body.sandbox !== undefined && !SANDBOX_MODES.has(body.sandbox)) return json(res, 400, { error: "unknown sandbox mode: " + body.sandbox });
        if (body.mode) h.session.setMode(body.mode as never);
        if (body.sandbox) h.session.setSandbox(body.sandbox as never);
        if (body.agentMode === "default" || body.agentMode === "makePlugin") {
          h.session.setAgentMode(body.agentMode);
        }
        await emitState(h);
        return json(res, 200, { ok: true });
      }

      if (route === "/api/command" && req.method === "POST") {
        const body = (await readJson(req)) as { command?: string; session?: string };
        const h = body.session ? sessions.get(body.session) : current();
        if (!h) return json(res, 404, { error: "no such session" });
        const cmd = (body.command ?? "").trim();
        // /compact 可以带关注点：只切第一段当命令，剩下的原样传给摘要器。
        const [name, ...args] = cmd.split(/\s+/);
        if (name === "compact") {
          const r = await h.session.compactNow(args.join(" ").trim() || undefined);
          broadcast({
            type: "compaction",
            sessionId: h.session.sessionId,
            applied: r.applied,
            tokensBefore: r.before,
            tokensAfter: r.after,
          });
        } else if (name === "clear") {
          h.session.clear();
          h.changes = [];
        } else if (name === "undo") {
          const undone = h.session.undoLast();
          broadcast({
            type: "notice",
            sessionId: h.session.sessionId,
            level: undone ? "info" : "warn",
            code: undone ? "undo_done" : "undo_none",
            params: undone ? { id: undone.id, count: undone.restored.length, skipped: undone.skipped?.length ?? 0 } : {},
            text: undone
              ? "undid " + undone.id + ": restored " + undone.restored.length + " file(s)" + (undone.skipped?.length ? "; " + undone.skipped.length + " file(s) remain for retry" : "")
              : "nothing to undo",
          });
        } else if (name === "skills") {
          h.session.refreshSkills();
        } else if (name === "jobs") {
          return json(res, 200, jobsFor(h.session));
        } else {
          // 插件命令：和 REPL 共用同一套查找（不用记哪些是内置、哪些是插件）。
          // 用 plugins/commands.ts 而不是 import("../cli/main.ts")：避免服务端反向依赖 CLI。
          const root = h.session.workspaceRoot;
          const hit = await findPluginCommand(root, name, args.join(" "), (await pluginsFor(root)).runtimes);
          if (!hit) return json(res, 400, { error: "unknown command" });
          broadcast({
            type: "notice",
            sessionId: h.session.sessionId,
            level: "info",
            code: "plugin_command",
            params: { name, plugin: hit.plugin },
            text: hit.output,
          });
          await emitState(h);
          return json(res, 200, { ok: true, output: hit.output });
        }
        await emitState(h);
        return json(res, 200, { ok: true });
      }

      if (route === "/api/config" && req.method === "GET") {
        return json(res, 200, configPayload(current()));
      }

      if (route === "/api/config" && req.method === "POST") {
        const h0 = current();
        const body = (await readJson(req)) as ConfigPatch;
        if (body.provider === "compatible" && !body.baseUrl) {
          return json(res, 400, { error: "自定义兼容端点需要填写 Base URL" });
        }
        if (body.maxTurns !== undefined && (body.maxTurns < 1 || body.maxTurns > 500)) {
          return json(res, 400, { error: "最大轮次需要在 1 到 500 之间" });
        }
        if (body.temperature !== undefined && (body.temperature < 0 || body.temperature > 2)) {
          return json(res, 400, { error: "temperature 需要在 0 到 2 之间" });
        }
        if (body.permissionMode !== undefined && !PERMISSION_MODES.has(body.permissionMode)) {
          return json(res, 400, { error: "unknown permission mode: " + body.permissionMode });
        }
        if (body.sandboxMode !== undefined && !SANDBOX_MODES.has(body.sandboxMode)) {
          return json(res, 400, { error: "unknown sandbox mode: " + body.sandboxMode });
        }
        // 空串 = "用端点默认"，是合法输入；其余必须是已知档位。
        const effortInput = body.reasoningEffort as string | undefined;
        if (effortInput && !REASONING_EFFORTS.has(effortInput)) return json(res, 400, { error: "unknown reasoning effort: " + effortInput });

        // Fail before writing anything: a saved config with no usable key would
        // brick the next start.
        const targetProvider = body.provider ?? h0.session.provider.id;
        if (targetProvider !== "mock") {
          const existing = resolveApiKey(targetProvider, body.apiKeyEnv);
          const willHaveKey = Boolean(body.apiKey && body.apiKey.trim()) || Boolean(existing.key);
          if (!willHaveKey) {
            return json(res, 400, { error: "缺少 API Key：请先填写密钥再保存" });
          }
        }
        const savedConfig = saveAppConfig(h0.session.workspaceRoot, body);
        for (const h of sessions.values()) {
          const sameWorkspace = h.session.workspaceRoot === h0.session.workspaceRoot;
          if (!sameWorkspace && body.scope !== "user") continue;
          const behavior = sameWorkspace ? savedConfig.behavior : readAppConfig({ workspaceRoot: h.session.workspaceRoot }).behavior;
          h.session.applyBehavior({
            permissionMode: body.permissionMode === undefined ? undefined : behavior.permissionMode,
            sandboxMode: body.sandboxMode === undefined ? undefined : behavior.sandboxMode,
            maxTurns: body.maxTurns === undefined ? undefined : behavior.maxTurns,
            maxTokens: body.maxTokens === undefined ? undefined : behavior.maxTokens,
            temperature: body.temperature === undefined ? undefined : behavior.temperature,
            fallbackModel: body.fallbackModel === undefined ? undefined : behavior.fallbackModel,
          });
        }

        let swapError: string | null = null;
        if (opts.buildProvider && (body.provider || body.model || body.baseUrl || body.reasoningEffort !== undefined || body.apiKey !== undefined)) {
          try {
            const built = opts.buildProvider({
              provider: body.provider ?? h0.session.provider.id,
              model: body.model ?? h0.session.model,
              baseUrl: body.baseUrl,
              apiKeyEnv: body.apiKeyEnv,
              reasoningEffort: body.reasoningEffort ?? readAppConfig({ workspaceRoot: h0.session.workspaceRoot }).behavior.reasoningEffort,
            });
            for (const h of sessions.values()) {
              // 只改同一工作区的会话（user scope 才是全局）：
              // 以前无条件遍历，在 A 项目保存设置会把 B 会话的 provider/model/baseUrl
              // 一起换掉 —— B 的转录从此发往 A 的端点。
              const sameWorkspace = h.session.workspaceRoot === h0.session.workspaceRoot;
              if (!sameWorkspace && body.scope !== "user") continue;
              h.session.setProvider(built.provider, built.model);
            }
            opts.providerId = built.provider.id;
            opts.providerNote = built.note;
          } catch (err) {
            swapError = err instanceof Error ? err.message : String(err);
          }
        }

        if (opts.reloadMcp && body.mcpServers) {
          try {
            const mcp = await opts.reloadMcp(body.mcpServers);
            for (const h of sessions.values()) h.session.setExtensionTools(mcp.tools);
          } catch (err) {
            swapError = swapError ?? (err instanceof Error ? err.message : String(err));
          }
        }

        // Window pinning happens last: swapping the provider may re-infer it.
        if (body.contextWindow !== undefined) {
          for (const h of sessions.values()) {
            if (body.contextWindow > 0) h.session.setContextWindow(body.contextWindow);
          }
        }

        for (const h of sessions.values()) await emitState(h);
        // POST 也要返回**和 GET 完全一样**的形状：前端保存后会拿它直接重渲染，
        // 少了 active/workspace 就会在 renderSettings 里抛错，把表单炸成空白。
        const cfg = configPayload(h0);
        if (swapError) return json(res, 400, { error: swapError, config: cfg });
        return json(res, 200, { ok: true, config: cfg });
      }

      if (route === "/api/config/test" && req.method === "POST") {
        if (!opts.buildProvider) return json(res, 400, { error: "当前进程不支持测试连接" });
        const body = (await readJson(req)) as ConfigPatch;
        const h = current();
        let built;
        try {
          built = opts.buildProvider({
            provider: body.provider ?? h.session.provider.id,
            model: body.model ?? h.session.model,
            baseUrl: body.baseUrl,
            apiKeyEnv: body.apiKeyEnv,
          });
        } catch (err) {
          return json(res, 200, { ok: false, error: err instanceof Error ? err.message : String(err) });
        }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 20_000);
        const started = Date.now();
        let sample = "";
        try {
          for await (const ev of built.provider.stream({
            model: built.model,
            system: "Reply with the single word: pong",
            messages: [{ role: "user", content: [{ type: "text", text: "ping" }] }],
            tools: [],
            maxTokens: 16,
            signal: controller.signal,
          })) {
            if (ev.type === "text_delta") sample += ev.text;
          }
          clearTimeout(timer);
          return json(res, 200, {
            ok: true,
            ms: Date.now() - started,
            model: built.model,
            sample: sample.slice(0, 60) || "(空响应)",
          });
        } catch (err) {
          clearTimeout(timer);
          return json(res, 200, {
            ok: false,
            ms: Date.now() - started,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // ---- 插件能力面：/plugin/<id>/<path> 与 /plugin-assets/<id>/<file> ----
      // 放在 /api/* 之前：这两类是"插件拥有的路由"，不参与内核路由表。
      const pluginRoute = parsePluginRoute(route);
      if (pluginRoute) {
        const workspaceRoot = current().session.workspaceRoot;
        const loadedPlugins = await pluginsFor(workspaceRoot);
        const runtime = loadedPlugins.runtimes.find((r) => r.pluginId === pluginRoute.id);
        if (!runtime) return json(res, 404, { error: "plugin not found: " + pluginRoute.id });
        const hit = runtime.routes.find((r) => r.method === req.method && r.path === pluginRoute.rest);
        if (!hit) return json(res, 404, { error: "no route " + req.method + " /" + pluginRoute.rest + " in plugin " + pluginRoute.id });
        try {
          let body: unknown;
          if (req.method === "POST") {
            try { body = await readJson(req); }
            catch { return json(res, 400, { error: "invalid request body" }); }
          }
          const query: Record<string, string> = {};
          url.searchParams.forEach((v, k) => (query[k] = v));
          const out = await hit.handler({
            pluginId: runtime.pluginId,
            method: req.method ?? "GET",
            path: pluginRoute.rest,
            query,
            body,
            workspaceRoot,
          });
          if (out?.text !== undefined) return text(res, out.status ?? 200, out.text);
          return json(res, out?.status ?? 200, out?.json ?? {});
        } catch (err) {
          return json(res, 500, { error: err instanceof Error ? err.message : String(err) });
        }
      }

      const assetReq = parsePluginAsset(route);
      if (assetReq) {
        const loadedPlugins = await pluginsFor(current().session.workspaceRoot);
        const runtime = loadedPlugins.runtimes.find((r) => r.pluginId === assetReq.id);
        const abs = resolveAssetPath(runtime, assetReq.file);
        // 目录穿越、插件不存在、文件不存在都走同一个 404：不泄露"哪个路径存在"
        if (!abs) return json(res, 404, { error: "asset not found" });
        return pipeAsset(abs, res);
      }

      if (route === "/api/plugins" && req.method === "GET") {
        const ws = current().session.workspaceRoot;
        const infos = inspectPlugins(ws);
        const loaded = await pluginsFor(ws);
        const byDir = new Map(loaded.plugins.map((p) => [p.dir, p]));
        return json(res, 200, {
          workspace: ws,
          plugins: infos.map((info) => {
            const hit = byDir.get(info.dir);
            return {
              ...info,
              tools: hit?.tools ?? 0,
              skills: hit?.skills ?? 0,
              hooks: hit?.hooks ?? 0,
            };
          }),
          errors: loaded.errors,
        });
      }

      if (route === "/api/plugins" && req.method === "POST") {
        const ws = current().session.workspaceRoot;
        const body = (await readJson(req)) as { action?: string; dir?: string; enabled?: boolean; name?: string };
        const target = typeof body.dir === "string" ? inspectPlugins(ws).find((p) => p.dir === body.dir) : undefined;
        if ((body.action === "setEnabled" || body.action === "open") && !target) {
          return json(res, 400, { error: "unknown plugin directory" });
        }

        if (body.action === "setEnabled" && target) {
          setPluginEnabled(target.dir, body.enabled !== false);
          shutdownHost(target.dir);
        } else if (body.action === "open" && body.dir) {
          try {
            if (process.platform === "win32") spawn("explorer.exe", [body.dir], { detached: true }).unref();
            else if (process.platform === "darwin") spawn("open", [body.dir], { detached: true }).unref();
            else spawn("xdg-open", [body.dir], { detached: true }).unref();
          } catch {
            return json(res, 400, { error: "无法打开文件管理器" });
          }
          return json(res, 200, { ok: true });
        } else if (body.action === "scaffold" && body.name) {
          const name = String(body.name).trim();
          if (!/^[a-zA-Z0-9._-]+$/.test(name)) {
            return json(res, 400, { error: "插件名只能包含字母、数字、点、下划线、连字符" });
          }
          const code = await runCli(["plugin", "new", name, "--workspace", ws]);
          if (code !== 0) return json(res, 400, { error: "脚手架创建失败（见控制台）" });
        } else if (body.action !== "reload" && body.action !== "setEnabled") {
          return json(res, 400, { error: "unknown action" });
        }

        const roots = target?.source === "user" ? [...workspacePlugins.keys()] : [ws];
        for (const root of roots) {
          if (body.action === "reload") shutdownHosts(root);
          workspacePlugins.delete(root);
        }
        await Promise.all(roots.map(async (root) => {
          const pending = pluginsFor(root);
          const loaded = await pending;
          if (workspacePlugins.get(root) !== pending) return;
          const affected = [...sessions.values()].filter((h) => h.session.workspaceRoot === root);
          for (const h of affected) h.session.applyPlugins(loaded);
          await Promise.all(affected.map(emitState));
        }));
        const loaded = await pluginsFor(ws);
        return json(res, 200, {
          ok: true,
          loaded: loaded.plugins.length,
          tools: loaded.tools.length,
          errors: loaded.errors,
        });
      }

      if (route === "/api/rules" && req.method === "GET") {
        return json(res, 200, readRuleArrays(current().session.workspaceRoot));
      }

      if (route === "/api/rules" && req.method === "POST") {
        const workspace = current().session.workspaceRoot;
        const body = (await readJson(req)) as Partial<RuleArrays>;
        const incoming: RuleArrays = {
          allow: body.allow ?? [],
          deny: body.deny ?? [],
          ask: body.ask ?? [],
        };
        for (const [behavior, list] of Object.entries(incoming) as [string, string[]][]) {
          for (const rule of list) {
            const problem = isValidRule(rule);
            if (problem) return json(res, 400, { error: behavior + ": " + problem });
          }
        }
        const saved = writeRuleArrays(workspace, incoming);
        const reloaded = loadSettings(workspace);
        const affected = [...sessions.values()].filter((h) => h.session.workspaceRoot === workspace);
        for (const h of affected) {
          for (const kind of ["allow", "ask", "deny"] as const) {
            h.session.rules[kind] = [
              ...h.session.rules[kind].filter((r) => r.source !== "project"),
              ...reloaded.rules[kind].filter((r) => r.source === "project"),
            ];
          }
        }
        await Promise.all(affected.map(emitState));
        return json(res, 200, saved);
      }

      if (route === "/api/workspaces" && req.method === "GET") {
        return json(res, 200, {
          current: current().session.workspaceRoot,
          recent: listRecentEntries(),
          favorites: listFavoriteEntries(),
        });
      }

      if (route === "/api/workspaces/favorite" && req.method === "POST") {
        const body = (await readJson(req)) as { path?: string; favorite?: boolean };
        const check = validateWorkspace(String(body.path ?? ""));
        if (!check.ok) return json(res, 400, { error: check.error || "无效路径" });
        const favorite = setFavorite(check.path, body.favorite !== false);
        return json(res, 200, {
          ok: true,
          favorite,
          recent: listRecentEntries(),
          favorites: listFavoriteEntries(),
        });
      }

      if (route === "/api/workspace" && req.method === "POST") {
        if (!opts.makeSession) return json(res, 400, { error: "当前进程不支持切换工作区" });
        const body = (await readJson(req)) as { path?: string };
        const check = validateWorkspace(String(body.path ?? ""));
        if (!check.ok) return json(res, 400, { error: check.error || "无效路径" });

        return json(res, 200, await switchTo(realResolve(check.path)));
      }

      if (route === "/api/worktrees" && req.method === "GET") {
        const workspace = current().session.workspaceRoot;
        const repo = await mainRepositoryRoot(workspace);
        if (!repo) return json(res, 200, { repo: null, workspace, worktrees: [] });
        const wt = await listWorktrees(repo);
        return json(res, 200, {
          repo,
          workspace,
          worktrees: wt.map((w) => ({
            ...w,
            sessions: [...sessions.values()].filter((h) => h.session.workspaceRoot === w.path).length,
          })),
        });
      }

      if (route === "/api/worktrees" && req.method === "POST") {
        if (!opts.makeSession) return json(res, 400, { error: "当前进程不支持切换工作区" });
        const body = (await readJson(req)) as {
          action?: string;
          name?: string;
          base?: string;
          path?: string;
          force?: boolean;
        };
        const repo = await mainRepositoryRoot(current().session.workspaceRoot);
        if (!repo) return json(res, 400, { error: "当前工作区不是 git 仓库" });

        if (body.action === "create") {
          const created = await createWorktree(repo, String(body.name ?? ""), body.base);
          if (!created.ok) return json(res, 400, { error: created.error });
          const state = await switchTo(realResolve(created.path));
          const fresh = await listWorktrees(repo);
          return json(res, 200, {
            ok: true,
            branch: created.branch,
            path: created.path,
            copied: created.copied,
            state,
            worktrees: fresh.map((w) => ({
              ...w,
              sessions: [...sessions.values()].filter((h) => h.session.workspaceRoot === w.path).length,
            })),
          });
        }

        if (body.action === "remove" && body.path) {
          const target = realResolve(body.path);
          // 先离开要删的工作树，再清掉绑定它的会话，最后删目录。
          if (current().session.workspaceRoot === target) await switchTo(repo);
          for (const [id, h] of [...sessions.entries()]) {
            if (h.session.workspaceRoot !== target) continue;
            h.abort?.abort();
            h.session.jobs.killAll();
            sessions.delete(id);
          }
          const removed = await removeWorktree(repo, target, body.force === true);
          if (!removed.ok) return json(res, 400, { error: removed.error });
          const left = await listWorktrees(repo);
          return json(res, 200, { ok: true, state: await buildState(current()), worktrees: left });
        }

        return json(res, 400, { error: "unknown action" });
      }

      if (route === "/api/browse" && req.method === "GET") {
        return json(res, 200, browseDirectories(url.searchParams.get("path") ?? ""));
      }

      if (route === "/api/files" && req.method === "GET") {
        const h = current();
        return json(res, 200, await listDir(h.session.workspaceRoot, url.searchParams.get("path") ?? ""));
      }

      if (route === "/api/file" && req.method === "GET") {
        const h = current();
        const rel = url.searchParams.get("path") ?? "";
        return json(res, 200, await readWorkspaceFile(h.session.workspaceRoot, rel));
      }

      if (route === "/api/jobs" && req.method === "GET") {
        return json(res, 200, jobsFor(current().session));
      }

      if (route === "/api/jobs" && req.method === "POST") {
        const body = (await readJson(req)) as { action?: string; id?: string };
        const h = current();
        if (body.action === "kill" && body.id) {
          const ok = h.session.jobs.kill(body.id);
          broadcast({ type: "jobs", sessionId: h.session.sessionId, jobs: jobsFor(h.session) });
          return json(res, 200, { ok });
        }
        return json(res, 400, { error: "unknown action" });
      }

      if (req.method === "GET") {
        return serveStatic(res, route === "/" ? "/index.html" : route);
      }

      return json(res, 404, { error: "not found" });
    } catch (err) {
      // 客户端错误（坏 JSON / 超限 / 坏 URL）是 4xx，不是 500：
      // 前端据此提示"你发的东西有问题"，而不是"服务端崩了"。
      const status =
        err instanceof HttpError ? err.status : err instanceof URIError ? 400 : 500;
      if (status >= 500) logger.error("http error on " + route + ": " + (err instanceof Error ? err.message : String(err)));
      if (!res.headersSent) {
        json(res, status, { error: status >= 500 ? "internal error" : (err instanceof Error ? err.message : "bad request") });
      } else {
        res.end();
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });

  const actualPort = (server.address() as { port: number }).port;

  // 端口只有 listen 之后才知道，所以白名单在这里填。
  const openToLan = host === "0.0.0.0" || host === "::";
  const hostNames = openToLan ? [] : [...new Set([host, "127.0.0.1", "localhost", "[::1]"])];
  for (const name of hostNames) {
    selfHosts.add((name + ":" + actualPort).toLowerCase());
    if (!name.startsWith("[")) selfOrigins.add("http://" + name + ":" + actualPort);
  }

  return {
    url: "http://" + host + ":" + actualPort + "/",
    port: actualPort,
    close: async () => {
      for (const h of sessions.values()) {
        h.abort?.abort();
        h.session.jobs.killAll();
        // 未决审批各挂 10 分钟 Timeout，不清掉进程会被句柄钉住。
        for (const [id, pending] of h.pending) { clearTimeout(pending.timer); pending.resolve("deny"); h.pending.delete(id); }
      }
      // 关窗口/ Ctrl+C 时进程马上要走：先等回合退出再排空落盘队列，
      // 否则最后几条消息还在 append 队列里，进程已经没了（"关掉就少一轮"）。
      await Promise.all([...sessions.values()].map(async (h) => {
        for (const deadline = Date.now() + 3000; h.running && Date.now() < deadline; ) await new Promise((r) => setTimeout(r, 10));
        await h.session.flushPersist().catch(() => {});
        h.running = false;
        h.abort = null;
      }));
      for (const res of clients) {
        try {
          res.end();
        } catch {
          /* already closed */
        }
      }
      clients.clear();
      // 插件宿主是独立子进程，关闭时必须一起收掉，否则残留孤儿进程
      for (const root of workspacePlugins.keys()) shutdownHosts(root);
      // SSE / keep-alive 会把 close 拖住几秒：先掐空闲连接，再给 1s 兜底。
      server.closeIdleConnections?.();
      const timer = setTimeout(() => server.closeAllConnections?.(), 1000);
      await new Promise<void>((resolve) => server.close(() => resolve()));
      clearTimeout(timer);
      server.closeAllConnections?.();
    },
  };
}

function relativeTo(root: string, p: string): string {
  const rel = path.relative(root, p);
  return rel && !rel.startsWith("..") ? rel.split(path.sep).join("/") : p;
}

async function listDir(root: string, rel: string) {
  const base = realResolve(root);
  const target = realResolve(path.join(base, rel || "."));
  if (!isInside(base, target)) throw new Error("path escapes the workspace");
  const entries = await readdir(target, { withFileTypes: true });
  const out = entries
    .filter((e) => !SKIP_DIRS.has(e.name))
    .map((e) => ({ name: e.name, type: e.isDirectory() ? "dir" : "file", path: path.relative(base, path.join(target, e.name)).split(path.sep).join("/") }))
    .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
  return { path: rel, entries: out };
}

async function readWorkspaceFile(root: string, rel: string) {
  const base = realResolve(root);
  const target = realResolve(path.join(base, rel));
  if (!isInside(base, target)) throw new Error("path escapes the workspace");
  const info = await stat(target);
  if (info.isDirectory()) throw new Error("is a directory");
  if (info.size > 2_000_000) return { path: rel, content: "", truncated: true, size: info.size };
  const buf = await readFile(target);
  const binary = buf.includes(0);
  return {
    path: rel,
    content: binary ? "" : buf.toString("utf8"),
    binary,
    size: info.size,
    truncated: false,
  };
}

export type { HarnessEvent };

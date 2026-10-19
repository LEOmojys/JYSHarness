/**
 * Local HTTP + SSE server. Multi-session: every session gets its own loop,
 * approval queue and event namespace; the UI subscribes once and filters.
 *
 * Security: loopback bind, Origin check, workspace-contained file API.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile, readdir, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { Session } from "../core/session.ts";
import type { ApprovalOutcome, HarnessEvent } from "../core/query.ts";
import type { PermissionDecision } from "../permissions/engine.ts";
import { formatRule } from "../permissions/rules.ts";
import { realResolve, isInside } from "../sandbox/paths.ts";
import { loadSettings } from "../core/config.ts";
import { isValidRule, readRuleArrays, writeRuleArrays, type RuleArrays } from "../core/ruleStore.ts";
import { describeConfig, resolveApiKey, saveAppConfig, type ConfigPatch, type McpServerView } from "../core/configStore.ts";
import type { ModelProvider } from "../providers/types.ts";
import type { Tool } from "../tools/types.ts";
import { inspectPlugins, loadPlugins, setPluginEnabled } from "../plugins/loader.ts";
import { createWorktree, listWorktrees, mainRepositoryRoot, removeWorktree } from "../core/worktrees.ts";
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

const UI_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "ui");
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

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
  /** Factory for additional sessions (new tab / fork / another workspace). */
  makeSession?: (workspaceRoot?: string) => Promise<Session>;
  logger: Logger;
  host?: string;
  port?: number;
  providerId: string;
  providerNote?: string;
  autoApprove?: boolean;
  /** Build a provider from saved config (hot swap from the settings UI). */
  buildProvider?: (cfg: {
    provider: string;
    model: string;
    baseUrl?: string;
    apiKeyEnv?: string;
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

  function register(session: Session): Hosted {
    const hosted: Hosted = { session, running: false, abort: null, pending: new Map(), changes: [] };
    sessions.set(session.sessionId, hosted);
    session.setApprover((req) => askApproval(hosted, req));
    if (!activeId) activeId = session.sessionId;
    return hosted;
  }

  function current(): Hosted {
    return sessions.get(activeId) ?? sessions.values().next().value!;
  }

  function broadcast(event: unknown): void {
    const payload = "data: " + JSON.stringify(event) + "\n\n";
    for (const res of clients) {
      try {
        res.write(payload);
      } catch {
        clients.delete(res);
      }
    }
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
      running: h.running,
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

  function askApproval(
    h: Hosted,
    request: { toolName: string; input: Record<string, unknown>; decision: PermissionDecision },
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
    const hosted = register(fresh);
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
      for await (const ev of h.session.send(text, controller.signal, images)) {
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

  register(opts.session);

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://" + host + ":" + port);
    const route = url.pathname;
    const origin = req.headers.origin;
    if (origin && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) {
      res.writeHead(403).end("forbidden origin");
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
          if (!h) return json(res, 404, { error: "not loaded; restart with --resume " + body.id });
          activeId = body.id;
          return json(res, 200, await buildState(h));
        }
        if (action === "new" || action === "fork") {
          if (!opts.makeSession) return json(res, 400, { error: "session factory not configured" });
          const fresh = await opts.makeSession(current().session.workspaceRoot);
          if (action === "fork") {
            fresh.messages = JSON.parse(JSON.stringify(current().session.messages));
          }
          await fresh.init();
          register(fresh);
          activeId = fresh.sessionId;
          return json(res, 200, await buildState(sessions.get(fresh.sessionId)!));
        }
        if (action === "delete" && body.id) {
          const live = sessions.get(body.id);
          if (live) {
            if (sessions.size === 1) return json(res, 400, { error: "不能删除最后一个会话" });
            live.abort?.abort();
            live.session.jobs.killAll();
            for (const [id, pending] of live.pending) {
              clearTimeout(pending.timer);
              pending.resolve("deny");
              live.pending.delete(id);
            }
            sessions.delete(body.id);
            if (activeId === body.id) activeId = sessions.keys().next().value!;
          }
          // 历史会话（只存在于磁盘）也要能删，否则重启后又会冒出来。
          const removed = await current().session.store.remove(body.id);
          if (!live && !removed) return json(res, 404, { error: "会话不存在" });
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
        const cmd = body.command ?? "";
        if (cmd === "compact") {
          const r = h.session.compactNow();
          broadcast({
            type: "compaction",
            sessionId: h.session.sessionId,
            applied: r.applied,
            tokensBefore: r.before,
            tokensAfter: r.after,
          });
        } else if (cmd === "clear") {
          h.session.clear();
          h.changes = [];
        } else if (cmd === "undo") {
          const undone = h.session.undoLast();
          broadcast({
            type: "notice",
            sessionId: h.session.sessionId,
            level: undone ? "info" : "warn",
            code: undone ? "undo_done" : "undo_none",
            params: undone ? { id: undone.id, count: undone.restored.length } : {},
            text: undone
              ? "undid " + undone.id + ": restored " + undone.restored.length + " file(s)"
              : "nothing to undo",
          });
        } else if (cmd === "skills") {
          h.session.refreshSkills();
        } else if (cmd === "jobs") {
          return json(res, 200, jobsFor(h.session));
        } else {
          return json(res, 400, { error: "unknown command" });
        }
        await emitState(h);
        return json(res, 200, { ok: true });
      }

      if (route === "/api/config" && req.method === "GET") {
        const h = current();
        const cfg = describeConfig(h.session.workspaceRoot, {
          provider: h.session.provider.id,
          model: h.session.model,
        });
        return json(res, 200, {
          ...cfg,
          active: { provider: h.session.provider.id, model: h.session.model },
          workspace: h.session.workspaceRoot,
        });
      }

      if (route === "/api/config" && req.method === "POST") {
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

        const h0 = current();
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
        saveAppConfig(h0.session.workspaceRoot, body);
        for (const h of sessions.values()) {
          h.session.applyBehavior({
            permissionMode: body.permissionMode,
            sandboxMode: body.sandboxMode,
            maxTurns: body.maxTurns,
            maxTokens: body.maxTokens,
            temperature: body.temperature,
          });
        }

        let swapError: string | null = null;
        if (opts.buildProvider && (body.provider || body.model || body.baseUrl || body.apiKey !== undefined)) {
          try {
            const built = opts.buildProvider({
              provider: body.provider ?? h0.session.provider.id,
              model: body.model ?? h0.session.model,
              baseUrl: body.baseUrl,
              apiKeyEnv: body.apiKeyEnv,
            });
            for (const h of sessions.values()) h.session.setProvider(built.provider, built.model);
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
        const cfg = describeConfig(h0.session.workspaceRoot);
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

      if (route === "/api/plugins" && req.method === "GET") {
        const ws = current().session.workspaceRoot;
        const infos = inspectPlugins(ws);
        const loaded = await loadPlugins(ws, logger);
        const byName = new Map(loaded.plugins.map((p) => [p.name, p]));
        return json(res, 200, {
          workspace: ws,
          plugins: infos.map((info) => {
            const hit = byName.get(info.name);
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
        const body = (await readJson(req)) as { action?: string; dir?: string; enabled?: boolean; name?: string };
        const ws = current().session.workspaceRoot;

        if (body.action === "setEnabled" && body.dir) {
          setPluginEnabled(body.dir, body.enabled !== false);
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

        const loaded = await loadPlugins(ws, logger);
        for (const h of sessions.values()) h.session.applyPlugins(loaded);
        for (const h of sessions.values()) await emitState(h);
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
        const saved = writeRuleArrays(current().session.workspaceRoot, incoming);
        // Reload from disk so every live session sees the new rules immediately.
        const reloaded = loadSettings(current().session.workspaceRoot, {});
        for (const h of sessions.values()) {
          h.session.rules = reloaded.rules;
        }
        for (const h of sessions.values()) await emitState(h);
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
      logger.error("http error on " + route + ": " + (err instanceof Error ? err.message : String(err)));
      if (!res.headersSent) json(res, 500, { error: "internal error" });
      else res.end();
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });

  const actualPort = (server.address() as { port: number }).port;

  return {
    url: "http://" + host + ":" + actualPort + "/",
    port: actualPort,
    close: async () => {
      for (const h of sessions.values()) {
        h.abort?.abort();
        h.session.jobs.killAll();
      }
      for (const res of clients) {
        try {
          res.end();
        } catch {
          /* already closed */
        }
      }
      clients.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
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

async function serveStatic(res: ServerResponse, rel: string): Promise<void> {
  const safe = path.normalize(rel).replace(/^([.][.][\\/])+/, "");
  const abs = path.join(UI_DIR, safe);
  if (!abs.startsWith(UI_DIR)) {
    res.writeHead(403).end("forbidden");
    return;
  }
  try {
    const data = await readFile(abs);
    res.writeHead(200, {
      "content-type": MIME[path.extname(abs)] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(data);
  } catch {
    res.writeHead(404).end("not found");
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let buf = "";
    req.on("data", (d: Buffer) => {
      buf += d.toString("utf8");
      if (buf.length > 2_000_000) {
        reject(new Error("payload too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!buf.trim()) return resolve({});
      try {
        resolve(JSON.parse(buf));
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

export type { HarnessEvent };

/**
 * 插件宿主的父进程侧。
 *
 * 职责：为声明了 isolation: process 的插件拉起一个子进程，把它的贡献
 * 包成**普通工具/路由/命令/hook**交给上层 —— 这样 Session 与 HTTP 服务完全不用改。
 *
 * 关键取舍：
 *   - 按插件目录缓存宿主：服务端每个请求都会调 loadPlugins，每次重拉子进程会漏进程；
 *   - 崩溃不致命：子进程死了，它贡献的调用一律返回错误，其它插件照常；
 *   - 调用超时：插件卡死不能把整个会话拖死，超时后返回明确错误。
 */
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Tool, ToolContext, ToolResult } from "../../tools/types.ts";
import type { PluginCommand, PluginPanel, PluginRoute } from "../types.ts";
import type { HostReady, HostRequest, HostResponse, PluginDescriptor } from "./rpc.ts";
import { encodeLine, parseLine } from "./rpc.ts";

const HOST_ENTRY = path.join(path.dirname(fileURLToPath(import.meta.url)), "child.ts");

/**
 * 各类调用默认超时（毫秒）。插件卡死不该拖死会话。
 *
 * 可用环境变量覆盖（测试与"插件本来就很慢"的场景都需要）：
 *   HARNESS_PLUGIN_TOOL_TIMEOUT_MS / _ROUTE_ / _COMMAND_ / _HOOK_
 */
function envMs(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}
/**
 * 每次调用时读环境变量，而不是模块加载时定死。
 * 定死的话，测试或程序在 import 之后再设 HARNESS_PLUGIN_*_TIMEOUT_MS 就不生效 ——
 * 实测踩过：超时用例里设了 300ms，仍按默认 120s 跑完，用例假失败。
 */
function timeoutFor(kind: "tool" | "route" | "command" | "hook"): number {
  if (kind === "tool") return envMs("HARNESS_PLUGIN_TOOL_TIMEOUT_MS", 120_000);
  if (kind === "route") return envMs("HARNESS_PLUGIN_ROUTE_TIMEOUT_MS", 30_000);
  if (kind === "command") return envMs("HARNESS_PLUGIN_COMMAND_TIMEOUT_MS", 30_000);
  return envMs("HARNESS_PLUGIN_HOOK_TIMEOUT_MS", 10_000);
}

export interface HostContributions {
  descriptors: PluginDescriptor[];
  tools: Tool[];
  routes: PluginRoute[];
  panels: PluginPanel[];
  commands: PluginCommand[];
  hooks: { pluginId: string; event: string; handler: (payload: unknown) => Promise<unknown> }[];
  skills: { name: string; description: string; content: string }[];
  promptSections: string[];
  errors: { plugin: string; message: string }[];
  warnings: { plugin: string; message: string }[];
}

export class PluginHost {
  private child: ChildProcess | null = null;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private seq = 0;
  private readyPromise: Promise<HostContributions> | null = null;
  private dead = false;
  private lastError = "";

  readonly pluginDir: string;
  readonly workspaceRoot: string;
  private readonly onLog: (level: string, message: string) => void;

  constructor(pluginDir: string, workspaceRoot: string, onLog: (level: string, message: string) => void) {
    this.pluginDir = pluginDir;
    this.workspaceRoot = workspaceRoot;
    this.onLog = onLog;
  }

  /** 启动子进程并等到 ready；失败时 reject（调用方负责转成 error 记录）。 */
  async start(): Promise<HostContributions> {
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = this.spawnAndWait();
    return this.readyPromise;
  }

  private spawnAndWait(): Promise<HostContributions> {
    return new Promise((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = spawn(process.execPath, [HOST_ENTRY, "--workspace", this.workspaceRoot, "--only", this.pluginDir], {
          stdio: ["pipe", "pipe", "pipe"],
          env: { ...process.env },
          windowsHide: true,
        });
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      this.child = child;
      this.dead = false;

      const bootTimer = setTimeout(() => {
        this.kill();
        reject(new Error("宿主启动超时（10s）：插件初始化太慢或卡住"));
      }, 10_000);

      child.stdout?.setEncoding("utf8");
      let buf = "";
      child.stdout?.on("data", (chunk: string) => {
        buf += chunk;
        for (;;) {
          const nl = buf.indexOf(String.fromCharCode(10));
          if (nl < 0) break;
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          const msg = parseLine(line) as (HostReady | HostResponse | { type: "log"; level: string; message: string }) | null;
          if (!msg) continue;
          if ("type" in msg && msg.type === "log") {
            this.onLog(msg.level, msg.message);
            continue;
          }
          if ("type" in msg && msg.type === "ready") {
            clearTimeout(bootTimer);
            resolve(this.toContributions(msg));
            continue;
          }
          const resp = msg as HostResponse;
          const waiter = this.pending.get(resp.id);
          if (!waiter) continue;
          this.pending.delete(resp.id);
          clearTimeout(waiter.timer);
          if (resp.ok) waiter.resolve(resp.result);
          else waiter.reject(new Error(resp.error ?? "plugin host error"));
        }
      });

      // 子进程的 stderr 是插件日志，原样转发（不塞进协议通道）
      child.stderr?.on("data", (chunk: Buffer) => this.onLog("warn", String(chunk).trimEnd()));

      const onDie = (code: number | null, signal: string | null) => {
        this.dead = true;
        this.lastError = "插件宿主已退出（code=" + String(code) + " signal=" + String(signal) + "）";
        clearTimeout(bootTimer);
        // 所有挂起调用立即失败，避免调用方永久等待
        for (const [, w] of this.pending) {
          clearTimeout(w.timer);
          w.reject(new Error(this.lastError));
        }
        this.pending.clear();
        this.child = null;
        this.readyPromise = null;
        reject(new Error(this.lastError));
      };
      child.on("exit", onDie);
      child.on("error", (err) => onDie(null, err.message));
    });
  }

  private toContributions(ready: HostReady): HostContributions {
    const tools: Tool[] = [];
    const routes: PluginRoute[] = [];
    const panels: PluginPanel[] = [];
    const commands: PluginCommand[] = [];
    const hooks: HostContributions["hooks"] = [];
    const skills: HostContributions["skills"] = [];
    const promptSections: string[] = [];

    for (const d of ready.plugins) {
      for (const t of d.tools) tools.push(this.proxyTool(d.pluginId, t));

      for (const r of d.routes) {
        routes.push({
          method: r.method,
          path: r.path,
          handler: async (ctx) => {
            const out = await this.request(
              "route",
              { pluginId: d.pluginId, httpMethod: r.method, path: r.path, query: ctx.query, body: ctx.body, workspaceRoot: ctx.workspaceRoot },
              timeoutFor("route"),
            );
            return out as { status?: number; json?: unknown; text?: string };
          },
        });
      }

      for (const p of d.panels) {
        panels.push({ id: p.id, title: p.title, icon: p.icon, slot: p.slot as PluginPanel["slot"] });
      }

      for (const c of d.commands) {
        commands.push({
          name: c.name,
          description: c.description,
          run: async (arg, ctx) => {
            const out = await this.request(
              "command",
              { pluginId: d.pluginId, commandName: c.name, arg, workspaceRoot: ctx.workspaceRoot },
              timeoutFor("command"),
            );
            return (out as { output?: string }).output ?? "";
          },
        });
      }

      for (const h of d.hooks) {
        hooks.push({
          pluginId: d.pluginId,
          event: h.event,
          handler: async (payload) => {
            const out = await this.request("hook", { pluginId: d.pluginId, event: h.event, payload }, timeoutFor("hook"));
            return (out as { result?: unknown }).result ?? {};
          },
        });
      }

      skills.push(...d.skills);
      promptSections.push(...d.promptSections);
    }

    return {
      descriptors: ready.plugins,
      tools,
      routes,
      panels,
      commands,
      hooks,
      skills,
      promptSections,
      errors: ready.errors,
      warnings: ready.warnings,
    };
  }

  /** 工具代理：名字/描述/schema 来自子进程，真正执行仍走子进程。 */
  private proxyTool(pluginId: string, t: PluginDescriptor["tools"][number]): Tool {
    return {
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema as Tool["inputSchema"],
      isReadOnly: t.isReadOnly,
      isDestructive: t.isDestructive,
      isConcurrencySafe: () => true,
      call: async (input: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> => {
        try {
          const out = await this.request("tool.call", { toolName: t.name, input }, timeoutFor("tool"));
          const r = out as { content?: string; isError?: boolean; metadata?: Record<string, unknown> };
          return { content: r.content ?? "", isError: Boolean(r.isError), metadata: r.metadata };
        } catch (err) {
          // 进程隔离的好处：插件崩了只有它的工具失败，会话继续
          return {
            content: "[插件 " + pluginId + " 执行失败] " + (err instanceof Error ? err.message : String(err)),
            isError: true,
          };
        }
      },
    };
  }

  private async request(method: HostRequest["method"], payload: Partial<HostRequest>, timeoutMs: number): Promise<unknown> {
    if (this.dead || !this.child) {
      // 发现已死时尝试重启一次（插件自己退出后的自愈）
      try {
        await this.start();
      } catch (err) {
        throw new Error(this.lastError || (err instanceof Error ? err.message : String(err)));
      }
      if (this.dead || !this.child) throw new Error(this.lastError || "插件宿主不可用");
    }
    const child = this.child;
    if (!child || !child.stdin) throw new Error("插件宿主不可用");
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("插件调用超时（" + timeoutMs + "ms）：" + method));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      child.stdin?.write(encodeLine({ id, method, ...payload }));
    });
  }

  kill(): void {
    try {
      this.child?.kill();
    } catch {
      /* 已经死了就算了 */
    }
    this.child = null;
    this.dead = true;
    this.readyPromise = null;
  }

  get alive(): boolean {
    return Boolean(this.child) && !this.dead;
  }
}

// ---- 宿主缓存：同一个插件目录只拉一次子进程 ----
const hosts = new Map<string, PluginHost>();

export function hostFor(pluginDir: string, workspaceRoot: string, onLog: (level: string, message: string) => void): PluginHost {
  const key = path.resolve(pluginDir).toLowerCase();
  const existing = hosts.get(key);
  if (existing && existing.alive) return existing;
  const host = new PluginHost(path.resolve(pluginDir), workspaceRoot, onLog);
  hosts.set(key, host);
  return host;
}

/** 关掉所有宿主（插件重载/进程退出时调用）。 */
export function shutdownHosts(): void {
  for (const h of hosts.values()) h.kill();
  hosts.clear();
}

export function hostCount(): number {
  return hosts.size;
}

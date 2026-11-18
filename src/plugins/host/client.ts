/**
 * 插件宿主的父进程侧。
 *
 * 职责：为声明了 isolation: process 的插件拉起一个子进程，把它的贡献
 * 包成**普通工具/路由/命令/hook**交给上层 —— 这样 Session 与 HTTP 服务完全不用改。
 *
 * 关键取舍：
 *   - 按工作区与插件目录缓存宿主，避免同一用户插件在不同项目间共享运行状态；
 *   - 崩溃不致命：子进程死了，它贡献的调用一律返回错误，其它插件照常；
 *   - 调用超时：插件卡死不能把整个会话拖死，超时后返回明确错误。
 */
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { realResolve } from "../../sandbox/paths.ts";
import type { Tool, ToolContext, ToolResult } from "../../tools/types.ts";
import type { PluginCommand, PluginPanel, PluginRoute } from "../types.ts";
import type { HostReady, HostRequest, HostResponse, PluginDescriptor } from "./rpc.ts";
import { encodeLine, parseLine, MAX_HOST_FRAME_BYTES, MAX_HOST_QUEUED_BYTES } from "./rpc.ts";

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
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private seq = 0;
  private outboundBytes = 0;
  private readyPromise: Promise<HostContributions> | null = null;
  private dead = false;
  private disposed = false;
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
    if (this.disposed) throw new Error("插件宿主已关闭");
    if (this.readyPromise) return this.readyPromise;
    const boot = this.spawnAndWait();
    this.readyPromise = boot;
    try {
      return await boot;
    } catch (err) {
      if (this.readyPromise === boot) this.readyPromise = null;
      throw err;
    }
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

      // 关键：不让孩子占住父进程的事件循环。
      // 否则一次性命令（jys plugin list / jys check / REPL 退出）会**挂住不退出** ——
      // 实测：带进程隔离插件时 `timeout 8 node main.ts plugin list` 退出码 124（被杀），
      // 只有本进程插件时正常返回 0。unref 之后父进程可以正常结束，
      // 而挂起中的 RPC 仍有 setTimeout 定时器兜着，不会提前退出。
      // 类型上 Readable/Writable 没有 unref（只有 net.Socket 有），
      // 但 Windows 上子进程的 stdio 底层确实是 Socket，所以运行时探测后再调。
      const maybeUnref = (s: unknown) => {
        const fn = (s as { unref?: () => void } | undefined)?.unref;
        if (typeof fn === "function") fn.call(s);
      };
      child.unref();
      maybeUnref(child.stdin);
      maybeUnref(child.stdout);
      maybeUnref(child.stderr);

      const bootTimer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("宿主启动超时（10s）：插件初始化太慢或卡住"));
      }, 10_000);

      child.stdout?.setEncoding("utf8");
      let buf = "";
      let bufBytes = 0;
      child.stdout?.on("data", (chunk: string) => {
        buf += chunk;
        bufBytes += Buffer.byteLength(chunk, "utf8");
        for (;;) {
          const nl = buf.indexOf(String.fromCharCode(10));
          if (nl < 0) break;
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          const frameBytes = Buffer.byteLength(line, "utf8") + 1;
          bufBytes = Math.max(0, bufBytes - frameBytes);
          if (frameBytes > MAX_HOST_FRAME_BYTES) {
            this.onLog("error", "plugin host frame exceeds " + MAX_HOST_FRAME_BYTES + " bytes; terminating host");
            child.kill("SIGKILL");
            return;
          }
          const msg = parseLine(line) as (HostReady | HostResponse | { type: "log"; level: string; message: string }) | null;
          if (!msg || typeof msg !== "object") {
            if (line.trim()) {
              this.onLog("error", "plugin host emitted an invalid protocol frame; terminating host");
              child.kill("SIGKILL");
              return;
            }
            continue;
          }
          if ("type" in msg && msg.type === "log") {
            this.onLog(msg.level, msg.message);
            continue;
          }
          if ("type" in msg && msg.type === "ready") {
            clearTimeout(bootTimer);
            if (!this.disposed) resolve(this.toContributions(msg));
            continue;
          }
          const resp = msg as HostResponse;
          const waiter = this.pending.get(resp.id);
          if (!waiter) continue;
          if (resp.ok) waiter.resolve(resp.result);
          else waiter.reject(new Error(resp.error ?? "plugin host error"));
        }
        if (bufBytes > MAX_HOST_FRAME_BYTES) {
          this.onLog("error", "plugin host sent an unterminated oversized frame; terminating host");
          child.kill("SIGKILL");
        }
      });

      // 子进程的 stderr 是插件日志，原样转发（不塞进协议通道）
      child.stderr?.on("data", (chunk: Buffer) => this.onLog("warn", String(chunk).trimEnd()));

      const onDie = (code: number | null, signal: string | null) => {
        if (this.child !== child) return;
        this.dead = true;
        this.lastError = "插件宿主已退出（code=" + String(code) + " signal=" + String(signal) + "）";
        clearTimeout(bootTimer);
        // 所有挂起调用立即失败，避免调用方永久等待
        for (const [, w] of this.pending) {
          w.reject(new Error(this.lastError));
        }
        this.pending.clear();
        this.child = null;
        this.readyPromise = null;
        reject(new Error(this.lastError));
      };
      child.on("exit", onDie);
      child.on("error", (err) => onDie(null, err.message));
      child.stdin?.on("error", () => child.kill("SIGKILL"));
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
              ctx.signal,
            );
            return out as { status?: number; json?: unknown; text?: string };
          },
        });
      }

      for (const p of d.panels) {
        panels.push({ id: p.id, title: p.title, icon: p.icon, slot: p.slot as PluginPanel["slot"], order: p.order });
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
              ctx.signal,
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
            try {
              const out = await this.request("hook", { pluginId: d.pluginId, event: h.event, hookIndex: h.index, payload }, timeoutFor("hook"));
              return (out as { result?: unknown }).result ?? {};
            } catch (err) {
              // 隔离插件挂了/超时了，安全检查就"没有结论"。hooks.ts 会把异常吞成
              // combined.error，而 gate.ts 只认 decision === "deny" —— 于是 deny 钩子
              // 失效后工具照样执行（fail-open）。控制类事件必须显式拒绝。
              const message = err instanceof Error ? err.message : String(err);
              if (h.event === "PreToolUse" || h.event === "UserPromptSubmit" || h.event === "Stop") {
                return { decision: "deny", reason: "plugin host unavailable: " + message };
              }
              throw err;
            }
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
      // The plugin's input-dependent predicate is synchronous and lives in the child.
      isConcurrencySafe: () => false,
      timeoutMs: t.timeoutMs,
      retries: t.retries,
      maxOutputChars: t.maxOutputChars,
      call: async (input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> => {
        try {
          // ctx.signal 是会话的取消信号：用户点停止时，子进程里的插件也会一起停
          const context = { cwd: ctx.cwd, workspaceRoot: ctx.workspaceRoot, sandbox: ctx.sandbox, depth: ctx.depth };
          const out = await this.request("tool.call", { toolName: t.name, input, context }, timeoutFor("tool"), ctx.signal);
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

  /**
   * 父到子写入有界：Node stdin.write(false) 代表内部缓冲积压，忽略它会让并发调用
   * 把请求无限排进 Writable。每个 frame 有单独上限，排队总字节也有硬上限。
   */
  private writeFrame(child: ChildProcess, message: string): Promise<void> {
    const bytes = Buffer.byteLength(message, "utf8");
    if (bytes > MAX_HOST_FRAME_BYTES) return Promise.reject(new RangeError("plugin host frame exceeds size limit"));
    if (this.outboundBytes + bytes > MAX_HOST_QUEUED_BYTES) {
      return Promise.reject(new Error("plugin host outbound queue is full"));
    }
    const stdin = child.stdin;
    if (!stdin || stdin.destroyed) return Promise.reject(new Error("plugin host stdin is closed"));
    this.outboundBytes += bytes;
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (err?: Error | null) => {
        if (settled) return;
        settled = true;
        this.outboundBytes = Math.max(0, this.outboundBytes - bytes);
        if (err) reject(err);
        else resolve();
      };
      try {
        stdin.write(message, (err) => finish(err));
      } catch (err) {
        finish(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /** 父 → 子：告诉它这次调用已经没人等了，请停掉。 */
  private sendAbort(id: number, reason: string): void {
    const child = this.child;
    if (!child) return;
    try {
      void this.writeFrame(child, encodeLine({ type: "abort", id, reason })).catch(() => child.kill("SIGKILL"));
    } catch {
      child.kill("SIGKILL");
    }
  }

  private async request(
    method: HostRequest["method"],
    payload: Partial<HostRequest>,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (this.disposed) throw new Error("插件宿主已关闭");
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
    if (this.disposed || !child || !child.stdin) throw new Error("插件宿主不可用");
    const id = ++this.seq;
    const message = encodeLine({ id, method, ...payload });
    return new Promise((resolve, reject) => {
      const finish = (fn: () => void) => {
        cleanup();
        this.pending.delete(id);
        fn();
      };
      const onAbort = () => {
        // 会话被取消（用户按了停止 / 上游 abort）：立刻拒绝，并让子进程停掉
        this.sendAbort(id, "父进程取消了调用");
        finish(() => reject(new Error("插件调用被取消：" + method)));
      };
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      const timer = setTimeout(() => {
        // 超时也要通知子进程：否则那边会继续算下去（幽灵计算）
        this.sendAbort(id, "父进程等待超时（" + timeoutMs + "ms）");
        finish(() => reject(new Error("插件调用超时（" + timeoutMs + "ms）：" + method)));
      }, timeoutMs);

      if (signal) {
        if (signal.aborted) {
          finish(() => reject(new Error("插件调用被取消：" + method)));
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      }

      this.pending.set(id, {
        resolve: (value) => finish(() => resolve(value)),
        reject: (error) => finish(() => reject(error)),
      });
      void this.writeFrame(child, message).catch((err) => {
        this.pending.get(id)?.reject(err instanceof Error ? err : new Error(String(err)));
      });
    });
  }

  kill(): void {
    this.disposed = true;
    // 先让子进程停掉进行中的调用，再杀进程：被杀时至少它收到过取消通知
    for (const id of this.pending.keys()) this.sendAbort(id, "宿主正在关闭");
    try {
      this.child?.kill("SIGKILL");
    } catch {
      /* 已经死了就算了 */
    }
    for (const waiter of this.pending.values()) waiter.reject(new Error("插件宿主已关闭"));
  }

  get alive(): boolean {
    return Boolean(this.child) && !this.dead && !this.disposed;
  }
}

const hosts = new Map<string, PluginHost>();

function pathKey(dir: string): string {
  const resolved = realResolve(dir);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

// 进程退出兜底：无论从哪条路径退出（CLI 一次性命令、REPL、服务端、异常），
// 都不把宿主留成孤儿进程。unref 之后事件循环能正常排空，这里才有机会执行。
process.once("exit", () => {
  for (const h of hosts.values()) {
    try {
      h.kill();
    } catch {
      /* 已经死了 */
    }
  }
  hosts.clear();
});

export function hostFor(pluginDir: string, workspaceRoot: string, onLog: (level: string, message: string) => void): PluginHost {
  const key = JSON.stringify([pathKey(workspaceRoot), pathKey(pluginDir)]);
  const existing = hosts.get(key);
  if (existing) return existing;
  const host = new PluginHost(path.resolve(pluginDir), path.resolve(workspaceRoot), onLog);
  hosts.set(key, host);
  return host;
}

/**
 * 关掉**单个**插件的宿主。
 *
 * 为什么必须有：子进程里已经加载过插件模块，代码改动不会自动生效。
 * 升级/覆盖安装/编辑插件后如果不杀宿主，就会继续跑旧代码 —— 实测复现过：
 * 把 index.ts 改成 v2，工具仍返回 v1。
 */
export function shutdownHost(pluginDir: string): boolean {
  const target = pathKey(pluginDir);
  let removed = false;
  for (const [key, host] of hosts) {
    if (pathKey(host.pluginDir) !== target) continue;
    host.kill();
    hosts.delete(key);
    removed = true;
  }
  return removed;
}

/** 关闭指定工作区的宿主，省略工作区时关闭全部。 */
export function shutdownHosts(workspaceRoot?: string): void {
  const target = workspaceRoot === undefined ? undefined : pathKey(workspaceRoot);
  for (const [key, host] of hosts) {
    if (target !== undefined && pathKey(host.workspaceRoot) !== target) continue;
    host.kill();
    hosts.delete(key);
  }
}

export function hostCount(): number {
  return hosts.size;
}

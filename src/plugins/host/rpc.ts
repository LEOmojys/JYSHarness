/**
 * 插件宿主 RPC 协议（父进程 ⇄ 子进程，换行分隔的 JSON）。
 *
 * 为什么要有协议而不是"直接叫函数"：插件跑在独立进程里，函数不能跨进程传递。
 * 能传的只有数据：工具描述、路由表、命令名、hook 事件、技能正文。
 * 调用发生时再走一次往返（tool.call / route / command / hook）。
 *
 * 设计取舍：
 *   - 用 stdio + JSON 而不是 Unix socket：Windows 上跨平台最简单，无需端口；
 *   - 每个请求带 id，响应带同一个 id：避免并发调用串台；
 *   - 子进程崩溃 = 贡献全部失效，父进程必须**继续工作**，所以调用侧一律返回错误而不是抛。
 */

import type { Tool, ToolContext } from "../../tools/types.ts";
import type { PluginPanel } from "../types.ts";

export interface PluginDescriptor {
  pluginId: string;
  dir: string;
  tools: Pick<Tool, "name" | "description" | "inputSchema" | "isReadOnly" | "isDestructive" | "timeoutMs" | "maxOutputChars" | "retries">[];
  routes: { pluginId: string; method: "GET" | "POST"; path: string }[];
  panels: PluginPanel[];
  commands: { pluginId: string; name: string; description: string }[];
  hooks: { pluginId: string; event: string; index: number }[];
  skills: { name: string; description: string; content: string }[];
  promptSections: string[];
}

export interface HostReady {
  type: "ready";
  plugins: PluginDescriptor[];
  errors: { plugin: string; message: string }[];
  warnings: { plugin: string; message: string }[];
}

export interface HostLog {
  type: "log";
  level: "info" | "warn" | "error";
  pluginId?: string;
  message: string;
}

export interface HostRequest {
  id: number;
  method: "tool.call" | "route" | "command" | "hook";
  pluginId?: string;
  /** tool.call */
  toolName?: string;
  input?: Record<string, unknown>;
  context?: Pick<ToolContext, "workspaceRoot" | "cwd" | "sandbox" | "depth">;
  /** route */
  httpMethod?: string;
  path?: string;
  query?: Record<string, string>;
  body?: unknown;
  /** command */
  commandName?: string;
  arg?: string;
  /** hook */
  event?: string;
  hookIndex?: number;
  payload?: unknown;
  workspaceRoot?: string;
}

export interface HostResponse {
  id: number;
  ok: boolean;
  /** tool.call → {content, isError}；route → {status, json|text}；command → {output}；hook → {result} */
  result?: unknown;
  error?: string;
}

/**
 * 父 → 子：取消某个进行中的调用。
 *
 * 为什么需要：父进程超时后只是"不再等待"，子进程里那个函数还在跑 —— 也就是幽灵计算。
 * 发 abort 之后，子进程会把对应 AbortController 停掉，插件代码可以通过 signal 感知并提前退出。
 *
 * 注意：**这依赖插件配合**。插件完全不看 signal 的话，JS 层面没有强制终止的手段
 * （不像线程能 kill），所以文档里要写清楚这是"协作式取消"。
 */
export interface HostAbort {
  type: "abort";
  id: number;
  reason?: string;
}

export type HostOutbound = HostReady | HostLog | HostResponse;

export const MAX_HOST_FRAME_BYTES = 8 * 1024 * 1024;
export const MAX_HOST_QUEUED_BYTES = 16 * 1024 * 1024;

export function encodeLine(obj: unknown): string {
  const line = JSON.stringify(obj) + "\n";
  if (Buffer.byteLength(line, "utf8") > MAX_HOST_FRAME_BYTES) {
    throw new RangeError("plugin host frame exceeds " + MAX_HOST_FRAME_BYTES + " bytes");
  }
  return line;
}

export function parseLine(line: string): unknown | null {
  const t = line.trim();
  if (!t) return null;
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

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

export interface PluginDescriptor {
  pluginId: string;
  dir: string;
  tools: { name: string; description: string; inputSchema: unknown; isReadOnly: boolean; isDestructive: boolean; concurrencySafe: boolean }[];
  routes: { pluginId: string; method: "GET" | "POST"; path: string }[];
  panels: { id: string; title: string; icon?: string; slot?: string }[];
  commands: { pluginId: string; name: string; description: string }[];
  hooks: { pluginId: string; event: string }[];
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

export type HostOutbound = HostReady | HostLog | HostResponse;

export function encodeLine(obj: unknown): string {
  return JSON.stringify(obj) + "\n";
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

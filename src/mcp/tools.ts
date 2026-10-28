/** Adapt MCP tools to the harness Tool interface, with auto-reconnect. */
import type { Tool, ToolResult } from "../tools/types.ts";
import type { McpClient, McpToolDefinition } from "./client.ts";
import type { Logger } from "../util/log.ts";

export function toolNameFor(server: string, tool: string): string {
  return "mcp__" + server + "__" + tool;
}

/**
 * 重连包装：调用失败时，如果进程已死就重启一次再试。
 *
 * 为什么不无条件重试：MCP server 正常返回的错误（工具自己的业务失败）重试
 * 只会得到同样的错误；只有"进程没了"才值得重启。判断依据是 alive()，
 * 不是错误信息里的关键字。
 */
export async function callWithReconnect<T>(
  opts: { call: () => Promise<T>; alive: () => boolean; restart: () => Promise<void>; onRestart?: () => void },
): Promise<T> {
  try {
    return await opts.call();
  } catch (err) {
    if (opts.alive()) throw err;
    await opts.restart();
    opts.onRestart?.();
    return await opts.call();
  }
}

/**
 * 一个 MCP server 的宿主：拥有客户端、能在崩溃后重建。
 * 工具只持有宿主，不直接持有进程 —— 这样重连对外是透明的。
 */
export class McpHost {
  readonly name: string;
  private client: McpClient;
  private reconnect: () => Promise<McpClient>;
  private logger: Logger;
  restarts = 0;

  // 注意：Node 的类型剥离不支持参数属性（constructor(readonly x)），
  // 所以这里必须显式声明字段再赋值。
  constructor(name: string, client: McpClient, reconnect: () => Promise<McpClient>, logger: Logger) {
    this.name = name;
    this.client = client;
    this.reconnect = reconnect;
    this.logger = logger;
  }

  get current(): McpClient {
    return this.client;
  }

  get tools(): McpToolDefinition[] {
    return this.client.tools;
  }

  get serverInfo(): { name?: string; version?: string } {
    return this.client.serverInfo;
  }

  async ensureFresh(): Promise<void> {
    if (this.client.alive) return;
    await this.restart();
  }

  async restart(): Promise<void> {
    this.restarts++;
    this.logger.warn("mcp " + this.name + ": restarting after crash (attempt " + this.restarts + ")");
    try {
      const previous = this.client;
      this.client = await this.reconnect();
      previous.close();
    } catch (err) {
      this.logger.warn("mcp " + this.name + ": restart failed: " + (err instanceof Error ? err.message : String(err)));
      throw err;
    }
  }

  async callTool(
    toolName: string,
    args: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<{ content: string; isError?: boolean }> {
    return callWithReconnect({
      // 超时必须传下去：client 默认 20s 会把工具层声明的 120s 架空
      call: () => this.client.callTool(toolName, args, timeoutMs),
      alive: () => this.client.alive,
      restart: () => this.restart(),
    });
  }

  close(): void {
    this.client.close();
  }
}

export function mcpToolsFor(host: McpHost, defs?: McpToolDefinition[]): Tool[] {
  return (defs ?? host.tools).map((def) => {
    const readOnly = def.annotations?.readOnlyHint === true;
    const tool: Tool = {
      name: toolNameFor(host.name, def.name),
      description:
        (def.description || def.name) +
        "\n(MCP server: " +
        host.name +
        (host.serverInfo.name ? ", " + host.serverInfo.name : "") +
        ")",
      inputSchema: (def.inputSchema ?? { type: "object", properties: {} }) as Tool["inputSchema"],
      isReadOnly: readOnly,
      isDestructive: def.annotations?.destructiveHint === true,
      isConcurrencySafe: () => readOnly,
      // MCP server 可能永远不响应（进程活着但卡住）：给它一个硬上限，
      // 否则一个坏 server 会拖死整轮会话。输出也走统一截断。
      timeoutMs: 120_000,
      maxOutputChars: 50_000,
      // 只读工具允许一次自动重试（重试写操作会重复副作用）
      retries: readOnly ? 1 : 0,
      async call(input): Promise<ToolResult> {
        try {
          const result = await host.callTool(def.name, input, tool.timeoutMs);
          return { content: result.content, isError: result.isError };
        } catch (err) {
          return {
            content: "MCP call failed: " + (err instanceof Error ? err.message : String(err)),
            isError: true,
          };
        }
      },
    };
    return tool;
  });
}

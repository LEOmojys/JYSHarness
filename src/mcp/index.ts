/** Connect every configured MCP server; failures degrade instead of crashing. */
import type { HarnessSettings } from "../core/config.ts";
import type { Tool } from "../tools/types.ts";
import type { Logger } from "../util/log.ts";
import { McpClient, type McpServerConfig } from "./client.ts";
import { McpHost, mcpToolsFor } from "./tools.ts";

export interface McpRuntime {
  clients: McpClient[];
  /** 每个 server 的宿主：工具通过它调用，崩溃后自动重启。 */
  hosts: McpHost[];
  tools: Tool[];
  errors: { server: string; message: string }[];
}

export async function connectMcpServers(
  settings: HarnessSettings,
  logger: Logger,
  cwd: string,
): Promise<McpRuntime> {
  const servers = settings.mcpServers ?? {};
  const clients: McpClient[] = [];
  const hosts: McpHost[] = [];
  const tools: Tool[] = [];
  const errors: { server: string; message: string }[] = [];

  for (const [name, rawConfig] of Object.entries(servers)) {
    const cfg = rawConfig as McpServerConfig;
    if (!cfg?.command) {
      errors.push({ server: name, message: "missing command" });
      continue;
    }
    const resolved: McpServerConfig = { ...cfg, cwd: cfg.cwd ?? cwd };
    try {
      const client = await McpClient.connect(name, resolved, logger);
      clients.push(client);
      // 重连用同一份配置重新拉起进程；工具定义沿用首次列出的集合。
      const host = new McpHost(name, client, () => McpClient.connect(name, resolved, logger), logger);
      hosts.push(host);
      tools.push(...mcpToolsFor(host));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push({ server: name, message });
      logger.warn("mcp " + name + " failed: " + message);
    }
  }

  return { clients, hosts, tools, errors };
}

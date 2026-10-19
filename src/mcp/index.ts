/** Connect every configured MCP server; failures degrade instead of crashing. */
import type { HarnessSettings } from "../core/config.ts";
import type { Tool } from "../tools/types.ts";
import type { Logger } from "../util/log.ts";
import { McpClient, type McpServerConfig } from "./client.ts";
import { mcpToolsFor } from "./tools.ts";

export interface McpRuntime {
  clients: McpClient[];
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
  const tools: Tool[] = [];
  const errors: { server: string; message: string }[] = [];

  for (const [name, rawConfig] of Object.entries(servers)) {
    const cfg = rawConfig as McpServerConfig;
    if (!cfg?.command) {
      errors.push({ server: name, message: "missing command" });
      continue;
    }
    try {
      const client = await McpClient.connect(name, { ...cfg, cwd: cfg.cwd ?? cwd }, logger);
      clients.push(client);
      tools.push(...mcpToolsFor(client));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push({ server: name, message });
      logger.warn("mcp " + name + " failed: " + message);
    }
  }

  return { clients, tools, errors };
}

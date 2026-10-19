/** Adapt MCP tools to the harness Tool interface. */
import type { Tool, ToolResult } from "../tools/types.ts";
import type { McpClient, McpToolDefinition } from "./client.ts";

export function toolNameFor(server: string, tool: string): string {
  return "mcp__" + server + "__" + tool;
}

export function mcpToolsFor(client: McpClient, defs?: McpToolDefinition[]): Tool[] {
  return (defs ?? client.tools).map((def) => {
    const readOnly = def.annotations?.readOnlyHint === true;
    const tool: Tool = {
      name: toolNameFor(client.name, def.name),
      description:
        (def.description || def.name) + "\n(MCP server: " + client.name + (client.serverInfo.name ? ", " + client.serverInfo.name : "") + ")",
      inputSchema: (def.inputSchema ?? { type: "object", properties: {} }) as Tool["inputSchema"],
      isReadOnly: readOnly,
      isDestructive: def.annotations?.destructiveHint === true,
      isConcurrencySafe: () => readOnly,
      async call(input): Promise<ToolResult> {
        try {
          const result = await client.callTool(def.name, input);
          return { content: result.content, isError: result.isError };
        } catch (err) {
          return { content: "MCP call failed: " + (err instanceof Error ? err.message : String(err)), isError: true };
        }
      },
    };
    return tool;
  });
}

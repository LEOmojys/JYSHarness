import { ToolRegistry } from "./registry.ts";
import { fsTools } from "./fsTools.ts";
import { shellTools } from "./shell.ts";
import { agentTools } from "./agent.ts";
import { extraTools } from "./extra.ts";
import type { Tool } from "./types.ts";

export * from "./types.ts";
export { ToolRegistry, prepareCall, partitionCalls, executeCall } from "./registry.ts";
export type { PreparedCall, CallBatch, ToolCallRequest } from "./registry.ts";

export function buildDefaultRegistry(opts: { enableSubagent?: boolean } = {}): ToolRegistry {
  const registry = new ToolRegistry();
  registry.registerAll(fsTools);
  registry.registerAll(shellTools);
  registry.registerAll(extraTools);
  if (opts.enableSubagent !== false) registry.registerAll(agentTools);
  return registry;
}

export function builtinTools(): Tool[] {
  return [...fsTools, ...shellTools, ...extraTools, ...agentTools];
}

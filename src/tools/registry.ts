/**
 * Tool registry & pool assembly (ch.4.2 / 4.3).
 *
 * Built-in tools are sorted by name and placed first so the serialised tool
 * block is a stable prefix — that is what keeps prompt caching effective when
 * MCP/extension tools are added or removed.
 */
import type { Tool, ToolResult, ToolContext } from "./types.ts";
import { validateAgainstSchema } from "./types.ts";

export class ToolRegistry {
  private tools = new Map<string, Tool>();

  register(tool: Tool): this {
    if (this.tools.has(tool.name)) throw new Error("duplicate tool name: " + tool.name);
    this.tools.set(tool.name, tool);
    return this;
  }

  registerAll(tools: Tool[]): this {
    for (const t of tools) this.register(t);
    return this;
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  names(): string[] {
    return [...this.tools.keys()];
  }

  /** Built-ins first (sorted), extension tools appended (sorted), deduped. */
  assemble(extensionTools: Tool[] = []): Tool[] {
    const builtin = [...this.tools.values()].sort((a, b) => a.name.localeCompare(b.name));
    const ext = [...extensionTools].sort((a, b) => a.name.localeCompare(b.name));
    const seen = new Set<string>();
    const out: Tool[] = [];
    for (const t of [...builtin, ...ext]) {
      if (seen.has(t.name)) continue;
      seen.add(t.name);
      out.push(t);
    }
    return out;
  }
}

export interface ToolCallRequest {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** A resolved call: either executable or a pre-baked error result. */
export interface PreparedCall {
  request: ToolCallRequest;
  tool?: Tool;
  errorResult?: ToolResult;
  concurrencySafe: boolean;
  validationError?: string;
}

export interface ToolLookup {
  get(name: string): Tool | undefined;
  names(): string[];
}

export function prepareCall(registry: ToolLookup, request: ToolCallRequest): PreparedCall {
  const tool = registry.get(request.name);
  if (!tool) {
    return {
      request,
      concurrencySafe: true,
      errorResult: {
        content:
          "<tool_use_error>No such tool: " +
          request.name +
          ". Available tools: " +
          registry.names().join(", ") +
          "</tool_use_error>",
        isError: true,
      },
    };
  }
  const schemaError = validateAgainstSchema(tool.inputSchema, request.input);
  if (schemaError) {
    return { request, tool, concurrencySafe: true, validationError: schemaError };
  }
  const custom = tool.validate?.(request.input) ?? null;
  if (custom) {
    return { request, tool, concurrencySafe: true, validationError: custom };
  }
  return { request, tool, concurrencySafe: tool.isConcurrencySafe(request.input) };
}

export interface CallBatch {
  concurrencySafe: boolean;
  calls: PreparedCall[];
}

/**
 * Partition a tool-use batch into runs: consecutive concurrency-safe calls are
 * grouped (executed in parallel), everything else becomes a serial run of one.
 * Input: [Read a, Read b, Write c, Read d]
 * Output: [[Read a, Read b], [Write c], [Read d]]
 */
export function partitionCalls(calls: PreparedCall[]): CallBatch[] {
  const batches: CallBatch[] = [];
  for (const call of calls) {
    const safe = call.concurrencySafe && !call.errorResult && !call.validationError;
    const last = batches[batches.length - 1];
    if (safe && last && last.concurrencySafe) last.calls.push(call);
    else batches.push({ concurrencySafe: safe, calls: [call] });
  }
  return batches;
}

export async function executeCall(
  call: PreparedCall,
  ctx: ToolContext,
): Promise<ToolResult> {
  if (call.errorResult) return call.errorResult;
  if (call.validationError) {
    return {
      content: "<tool_use_error>" + call.validationError + "</tool_use_error>",
      isError: true,
    };
  }
  const tool = call.tool!;
  const checkpoints = ctx.checkpoints;
  checkpoints?.beginCall();
  try {
    const result = await tool.call(call.request.input, ctx);
    const changes = checkpoints?.commitCall() ?? [];
    if (changes.length) {
      // Tag with the call id so the UI can re-attach diffs after a reload.
      const tagged = changes.map((c) => ({ ...c, toolUseId: call.request.id }));
      result.metadata = { ...(result.metadata ?? {}), changes: tagged };
    }
    return result;
  } catch (err) {
    checkpoints?.commitCall();
    const message = err instanceof Error ? err.message : String(err);
    if (message.toLowerCase().includes("abort")) {
      return { content: "Tool execution aborted by user.", isError: true };
    }
    return { content: "Tool threw an error: " + message, isError: true };
  }
}

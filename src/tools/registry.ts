/**
 * Tool registry & pool assembly (ch.4.2 / 4.3).
 *
 * Built-in tools are sorted by name and placed first so the serialised tool
 * block is a stable prefix — that is what keeps prompt caching effective when
 * MCP/extension tools are added or removed.
 */
import type { Tool, ToolResult, ToolContext } from "./types.ts";
import { DEFAULT_MAX_OUTPUT_CHARS, truncateOutput, validateAgainstSchema } from "./types.ts";

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

/**
 * 只给"可能永远不返回"的工具加超时（WebFetch、MCP）。
 * 到点先 abort 让它自己收尾，再兜底 reject —— 尊重 signal 的工具会干净退出，
 * 不尊重的也不会把整个循环挂死。
 */
async function runWithTimeout(tool: Tool, input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  if (!tool.timeoutMs || tool.timeoutMs <= 0) return tool.call(input, ctx);
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  ctx.signal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), tool.timeoutMs);
  try {
    return await Promise.race([
      tool.call(input, { ...ctx, signal: controller.signal }),
      new Promise<ToolResult>((resolve) => {
        setTimeout(
          () => resolve({ content: "timed out after " + tool.timeoutMs + "ms: " + tool.name, isError: true }),
          tool.timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
    ctx.signal.removeEventListener("abort", onAbort);
  }
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
  // 检查点帧跟着这次调用走：并发（比如两个子 Agent 同时写文件）各自一帧，
  // 不会互相清空。修复前这里是实例级单帧，会导致某个文件的改动直接不可 undo。
  const frame = checkpoints?.beginCall();
  // 只读工具允许自动重试：超时 / 抛错都是一次就放弃太脆。
  const attempts = 1 + (tool.isReadOnly ? Math.max(0, tool.retries ?? 0) : 0);
  const runTool = () => runWithTimeout(tool, call.request.input, ctx);
  const runInFrame = frame && checkpoints ? () => checkpoints.track(frame, runTool) : runTool;
  try {
    let attempt = 0;
    let result: ToolResult = await runInFrame().catch((err: unknown): ToolResult => ({
      content: "Tool threw an error: " + (err instanceof Error ? err.message : String(err)),
      isError: true,
    }));
    while (result.isError && attempt + 1 < attempts) {
      attempt++;
      await new Promise((r) => setTimeout(r, 120 * attempt));
      result = await runInFrame().catch((err: unknown): ToolResult => ({
        content: "Tool threw an error: " + (err instanceof Error ? err.message : String(err)),
        isError: true,
      }));
    }
    if (attempt > 0 && !result.isError) {
      result = { ...result, metadata: { ...(result.metadata ?? {}), retriedAfterError: attempt } };
    }
    const changes = checkpoints?.commitCall(frame) ?? [];
    if (changes.length) {
      // Tag with the call id so the UI can re-attach diffs after a reload.
      const tagged = changes.map((c) => ({ ...c, toolUseId: call.request.id }));
      result.metadata = { ...(result.metadata ?? {}), changes: tagged };
    }
    // 单一出口做输出截断：任何工具（含 MCP、插件）都逃不掉。
    const cap = tool.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
    const clipped = truncateOutput(result.content, cap);
    if (clipped.truncated) {
      return {
        ...result,
        content: clipped.content,
        metadata: { ...(result.metadata ?? {}), truncated: { limit: cap, original: result.content.length } },
      };
    }
    return result;
  } catch (err) {
    checkpoints?.commitCall(frame);
    const message = err instanceof Error ? err.message : String(err);
    if (message.toLowerCase().includes("abort")) {
      return { content: "Tool execution aborted by user.", isError: true };
    }
    return { content: "Tool threw an error: " + message, isError: true };
  }
}

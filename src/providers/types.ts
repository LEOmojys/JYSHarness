import type { AssistantMessage, Message } from "../core/types.ts";

/** Minimal JSON-Schema subset sufficient for tool inputs. */
export interface JSONSchema {
  type: "object";
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: JSONSchema;
}

export interface ModelRequest {
  model: string;
  system: string;
  messages: Message[];
  tools: ToolSpec[];
  maxTokens: number;
  temperature?: number;
  signal?: AbortSignal;
}

export type StreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "done"; message: AssistantMessage };

/**
 * Anything that can turn a request into a stream of events.
 * Swapping a provider must not require touching the agent loop — that is the
 * whole point of this seam (see ch.2 "model is pluggable, harness is not").
 */
export interface ModelProvider {
  readonly id: string;
  readonly model: string;
  stream(req: ModelRequest): AsyncGenerator<StreamEvent>;
  /** True when the provider ignores `model` (mock). */
  readonly resumable?: boolean;
}

export type ProviderErrorKind =
  | "prompt_too_long"
  | "rate_limit"
  | "overloaded"
  | "auth"
  | "max_output_tokens"
  | "model_error";

export class ProviderError extends Error {
  kind: ProviderErrorKind;
  status?: number;
  constructor(kind: ProviderErrorKind, message: string, status?: number) {
    super(message);
    this.name = "ProviderError";
    this.kind = kind;
    this.status = status;
  }
}

export function classifyHttpError(status: number, body: string): ProviderError {
  const lower = body.toLowerCase();
  if (
    status === 413 ||
    lower.includes("context length") ||
    lower.includes("prompt is too long") ||
    lower.includes("maximum context") ||
    lower.includes("too many tokens")
  )
    return new ProviderError("prompt_too_long", body.slice(0, 600), status);
  if (status === 401 || status === 403)
    return new ProviderError("auth", body.slice(0, 600), status);
  if (status === 429) return new ProviderError("rate_limit", body.slice(0, 600), status);
  if (status >= 500) return new ProviderError("overloaded", body.slice(0, 600), status);
  return new ProviderError("model_error", `HTTP ${status}: ${body.slice(0, 600)}`, status);
}

/** Streaming SSE line decoder shared by the HTTP adapters. */
export async function* sseLines(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).replace(/\r$/, "");
      buffer = buffer.slice(idx + 1);
      if (line.length) yield line;
    }
  }
  if (buffer.trim().length) yield buffer.trim();
}

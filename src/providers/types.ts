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
  /**
   * 推理流（DeepSeek 的 reasoning_content / Anthropic 的 thinking_delta）。
   *
   * 只是**展示用**：它不进 transcript、不进下一轮请求、也不计入上下文估算。
   * 以前这类内容被直接丢弃，用户看到的是"模型沉默了几秒就出结果"。
   */
  | { type: "thinking_delta"; text: string }
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
  /**
   * 服务商的**精确** token 计数（可选）。
   *
   * 为什么是"问服务商"而不是本地 tokenizer：本地 BPE 需要引依赖或塞一份
   * ~2MB 的词表，而这个项目的硬约束是零运行时依赖；而且 Claude / GPT / DeepSeek
   * 三家用的分词器互不相同，本地算哪家都不准。服务商自己给的数才是真的。
   *
   * 约定：**不抛异常**。不支持或调用失败时返回 null，调用方回退到估算。
   */
  countTokens?(req: ModelRequest): Promise<number | null>;
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
  /** 服务端用 Retry-After 明确要求等多久（毫秒）；没有就是 undefined。 */
  retryAfterMs?: number;
  constructor(kind: ProviderErrorKind, message: string, status?: number, retryAfterMs?: number) {
    super(message);
    this.name = "ProviderError";
    this.kind = kind;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

/** 上限定在 2 分钟：服务端让你等一小时时，重试已经没有意义，交给调用方决定。 */
export const MAX_RETRY_AFTER_MS = 120_000;

/**
 * 解析 Retry-After：既可能是秒数（"30"），也可能是 HTTP 日期。
 * 解析不出来就返回 undefined —— 不要拿 0 或 NaN 去退避。
 */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const raw = value.trim();
  if (!raw) return undefined;
  if (/^[0-9]+$/.test(raw)) {
    const seconds = Number(raw);
    return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, seconds * 1000));
  }
  const when = Date.parse(raw);
  if (Number.isNaN(when)) return undefined;
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, when - now));
}

export function classifyHttpError(status: number, body: string, retryAfterMs?: number): ProviderError {
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
  if (status === 429) return new ProviderError("rate_limit", body.slice(0, 600), status, retryAfterMs);
  if (status >= 500) return new ProviderError("overloaded", body.slice(0, 600), status, retryAfterMs);
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

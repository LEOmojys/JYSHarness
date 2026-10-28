import type {
  AssistantMessage,
  ContentBlock,
  ImageBlock,
  Message,
  TextBlock,
  ToolResultBlock,
  ToolUseBlock,
  Usage,
} from "../core/types.ts";
import {
  classifyHttpError,
  parseRetryAfter,
  ProviderError,
  sseLines,
  type ModelProvider,
  type ModelRequest,
  type StreamEvent,
} from "./types.ts";

export interface OpenAIProviderOptions {
  apiKey: string;
  /** Any OpenAI-compatible endpoint: OpenAI, DeepSeek, Moonshot, vLLM, Ollama… */
  baseUrl?: string;
  model?: string;
  extraHeaders?: Record<string, string>;
  /**
   * 逻辑上的 provider 名（openai / deepseek / compatible）。
   *
   * 以前 id 写死 "openai"，于是"deepseek" 这类配置一旦经过热重载或测连，
   * 就被当成 openai 处理：baseUrl 回落到 api.openai.com，请求直接失败。
   */
  id?: string;
}

type WireMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: WireToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

interface WireToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export class OpenAIProvider implements ModelProvider {
  readonly id: string;
  readonly model: string;
  private apiKey: string;
  private baseUrl: string;
  private extraHeaders: Record<string, string>;

  constructor(opts: OpenAIProviderOptions) {
    this.id = opts.id ?? "openai";
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
    this.model = opts.model ?? "gpt-4.1";
    this.extraHeaders = opts.extraHeaders ?? {};
  }

  async *stream(req: ModelRequest): AsyncGenerator<StreamEvent> {
    const body = {
      model: req.model || this.model,
      messages: toWire(req.messages, req.system),
      tools: req.tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.inputSchema },
      })),
      tool_choice: "auto",
      max_tokens: req.maxTokens,
      temperature: req.temperature,
      stream: true,
      stream_options: { include_usage: true },
    };

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
        ...this.extraHeaders,
      },
      body: JSON.stringify(body),
      signal: req.signal,
    });

    if (!res.ok || !res.body) {
      const body = await res.text().catch(() => "");
      const retryAfter = parseRetryAfter(res.headers.get("retry-after"));
      throw classifyHttpError(res.status, body, retryAfter);
    }

    const textParts: string[] = [];
    let reasoningText = "";
    const calls = new Map<number, { id: string; name: string; args: string }>();
    let finish: string | null = null;
    let usage: Usage = { inputTokens: 0, outputTokens: 0 };

    for await (const line of sseLines(res.body)) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") break;
      let chunk: any;
      try {
        chunk = JSON.parse(payload);
      } catch {
        continue;
      }
      if (chunk.error) throw classifyHttpError(400, JSON.stringify(chunk.error));
      if (chunk.usage) {
        usage = {
          inputTokens: chunk.usage.prompt_tokens ?? 0,
          outputTokens: chunk.usage.completion_tokens ?? 0,
          // OpenAI 的前缀缓存是自动的，只回报命中量，没有 cache_control 标记。
          cacheReadTokens: chunk.usage.prompt_tokens_details?.cached_tokens ?? 0,
        };
      }
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta ?? {};
      // 推理流：deepseek-v3.x / r1 这类模型把它放在 reasoning_content 里
      const reasoning =
        typeof delta.reasoning_content === "string" ? delta.reasoning_content : typeof delta.reasoning === "string" ? delta.reasoning : "";
      if (reasoning.length) {
        reasoningText += reasoning;
        yield { type: "thinking_delta", text: reasoning };
      }
      if (typeof delta.content === "string" && delta.content.length) {
        textParts.push(delta.content);
        yield { type: "text_delta", text: delta.content };
      }
      for (const tc of delta.tool_calls ?? []) {
        const idx = tc.index ?? 0;
        const cur = calls.get(idx) ?? { id: "", name: "", args: "" };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.name += tc.function.name;
        if (tc.function?.arguments) cur.args += tc.function.arguments;
        calls.set(idx, cur);
      }
      if (choice.finish_reason) finish = choice.finish_reason;
    }

    const content: ContentBlock[] = [];
    // 推理内容放在消息最前面：UI 折叠展示；toWire 只映射 text/tool_use，不会发给模型
    if (reasoningText.trim()) content.push({ type: "thinking", text: reasoningText.trim() });
    const text = textParts.join("");
    if (text.trim().length) content.push({ type: "text", text });
    for (const [idx, call] of [...calls.entries()].sort((a, b) => a[0] - b[0])) {
      let input: Record<string, unknown> = {};
      try {
        input = call.args ? JSON.parse(call.args) : {};
      } catch {
        input = { __raw: call.args };
      }
      const block: ToolUseBlock = {
        type: "tool_use",
        id: call.id || `call_${idx}`,
        name: call.name,
        input,
      };
      content.push(block);
    }

    const stopReason =
      finish === "tool_calls" || calls.size > 0
        ? "tool_use"
        : finish === "length"
          ? "max_tokens"
          : "end_turn";

    const message: AssistantMessage = {
      role: "assistant",
      content,
      stopReason,
      usage,
    };
    yield { type: "done", message };
  }
}

/** Exported for tests: the wire format is a contract with the API. */
export function toWire(messages: Message[], system: string): WireMessage[] {
  const out: WireMessage[] = [];
  if (system) out.push({ role: "system", content: system });
  for (const m of messages) {
    if (m.role === "assistant") {
      const text = m.content.filter((b) => b.type === "text").map((b: any) => b.text).join("");
      const toolCalls: WireToolCall[] = m.content
        .filter((b) => b.type === "tool_use")
        .map((b: any) => ({
          id: b.id,
          type: "function" as const,
          function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
        }));
      out.push({
        role: "assistant",
        content: text.length ? text : null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }
    const results = m.content.filter((b): b is ToolResultBlock => b.type === "tool_result");
    for (const r of results) {
      out.push({ role: "tool", tool_call_id: r.tool_use_id, content: r.content });
    }
    const text = m.content
      .filter((b): b is TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    const images = m.content.filter((b): b is ImageBlock => b.type === "image");
    if (images.length) {
      // Multimodal content must use the array form.
      const parts: unknown[] = [];
      if (text.length) parts.push({ type: "text", text });
      for (const img of images) {
        parts.push({
          type: "image_url",
          image_url: { url: "data:" + img.mediaType + ";base64," + img.data },
        });
      }
      out.push({ role: "user", content: parts as never });
    } else if (text.length) {
      out.push({ role: "user", content: text });
    }
  }
  return out;
}

import type { AssistantMessage, ContentBlock, Message, ToolUseBlock } from "../core/types.ts";
import {
  classifyHttpError,
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
  readonly id = "openai";
  readonly model: string;
  private apiKey: string;
  private baseUrl: string;
  private extraHeaders: Record<string, string>;

  constructor(opts: OpenAIProviderOptions) {
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
      throw classifyHttpError(res.status, await res.text().catch(() => ""));
    }

    const textParts: string[] = [];
    const calls = new Map<number, { id: string; name: string; args: string }>();
    let finish: string | null = null;
    let usage = { inputTokens: 0, outputTokens: 0 };

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
        };
      }
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta ?? {};
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

function toWire(messages: Message[], system: string): WireMessage[] {
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
    const results = m.content.filter((b) => b.type === "tool_result");
    for (const r of results as any[]) {
      out.push({ role: "tool", tool_call_id: r.tool_use_id, content: r.content });
    }
    const text = m.content.filter((b) => b.type === "text").map((b: any) => b.text).join("");
    const images = m.content.filter((b: any) => b.type === "image") as { mediaType: string; data: string }[];
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

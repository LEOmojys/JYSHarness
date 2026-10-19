import type { AssistantMessage, ContentBlock, Message, ToolUseBlock } from "../core/types.ts";
import {
  classifyHttpError,
  ProviderError,
  sseLines,
  type ModelProvider,
  type ModelRequest,
  type StreamEvent,
} from "./types.ts";

export interface AnthropicProviderOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  anthropicVersion?: string;
}

export class AnthropicProvider implements ModelProvider {
  readonly id = "anthropic";
  readonly model: string;
  private apiKey: string;
  private baseUrl: string;
  private version: string;

  constructor(opts: AnthropicProviderOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? "https://api.anthropic.com").replace(/\/$/, "");
    this.model = opts.model ?? "claude-sonnet-4-5";
    this.version = opts.anthropicVersion ?? "2023-06-01";
  }

  async *stream(req: ModelRequest): AsyncGenerator<StreamEvent> {
    const body = {
      model: req.model || this.model,
      max_tokens: req.maxTokens,
      system: req.system,
      messages: toWire(req.messages),
      tools: req.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema,
      })),
      stream: true,
    };

    const res = await fetch(`${this.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": this.version,
      },
      body: JSON.stringify(body),
      signal: req.signal,
    });

    if (!res.ok || !res.body) {
      throw classifyHttpError(res.status, await res.text().catch(() => ""));
    }

    const content: ContentBlock[] = [];
    const toolBuffers = new Map<number, { id: string; name: string; json: string }>();
    let stopReason: AssistantMessage["stopReason"] = "end_turn";
    let usage = { inputTokens: 0, outputTokens: 0 };

    for await (const line of sseLines(res.body)) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload) continue;
      let ev: any;
      try {
        ev = JSON.parse(payload);
      } catch {
        continue;
      }
      switch (ev.type) {
        case "message_start":
          usage.inputTokens = ev.message?.usage?.input_tokens ?? 0;
          break;
        case "content_block_start":
          if (ev.content_block?.type === "tool_use") {
            toolBuffers.set(ev.index, {
              id: ev.content_block.id,
              name: ev.content_block.name,
              json: "",
            });
          } else if (ev.content_block?.type === "text") {
            content.push({ type: "text", text: ev.content_block.text ?? "" });
          }
          break;
        case "content_block_delta":
          if (ev.delta?.type === "text_delta") {
            const last = content[content.length - 1];
            if (last && last.type === "text") last.text += ev.delta.text;
            else content.push({ type: "text", text: ev.delta.text });
            yield { type: "text_delta", text: ev.delta.text };
          } else if (ev.delta?.type === "input_json_delta") {
            const buf = toolBuffers.get(ev.index);
            if (buf) buf.json += ev.delta.partial_json ?? "";
          }
          break;
        case "content_block_stop": {
          const buf = toolBuffers.get(ev.index);
          if (buf) {
            let input: Record<string, unknown> = {};
            try {
              input = buf.json ? JSON.parse(buf.json) : {};
            } catch {
              input = { __raw: buf.json };
            }
            const block: ToolUseBlock = { type: "tool_use", id: buf.id, name: buf.name, input };
            content.push(block);
            toolBuffers.delete(ev.index);
          }
          break;
        }
        case "message_delta":
          usage.outputTokens = ev.usage?.output_tokens ?? usage.outputTokens;
          if (ev.delta?.stop_reason) {
            const sr = ev.delta.stop_reason;
            stopReason = sr === "tool_use" ? "tool_use" : sr === "max_tokens" ? "max_tokens" : "end_turn";
          }
          break;
        case "error":
          throw new ProviderError(
            ev.error?.type === "overloaded_error" ? "overloaded" : "model_error",
            JSON.stringify(ev.error ?? {}),
          );
        default:
          break;
      }
    }

    const message: AssistantMessage = { role: "assistant", content, stopReason, usage };
    yield { type: "done", message };
  }
}

function toWire(messages: Message[]): { role: "user" | "assistant"; content: unknown[] }[] {
  const out: { role: "user" | "assistant"; content: unknown[] }[] = [];
  for (const m of messages) {
    if (m.role === "assistant") {
      const content = m.content.map((b) =>
        b.type === "text"
          ? { type: "text", text: b.text }
          : { type: "tool_use", id: (b as any).id, name: (b as any).name, input: (b as any).input },
      );
      out.push({ role: "assistant", content });
      continue;
    }
    const content = m.content.map((b) => {
      if (b.type === "tool_result") {
        return {
          type: "tool_result",
          tool_use_id: b.tool_use_id,
          content: b.content,
          is_error: b.is_error ?? false,
        };
      }
      if (b.type === "image") {
        return { type: "image", source: { type: "base64", media_type: b.mediaType, data: b.data } };
      }
      return { type: "text", text: (b as { text: string }).text };
    });
    out.push({ role: "user", content });
  }
  return out;
}

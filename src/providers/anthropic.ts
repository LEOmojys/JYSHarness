import type { AssistantMessage, ContentBlock, Message, ToolUseBlock } from "../core/types.ts";
import {
  classifyHttpError,
  parseRetryAfter,
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

  /**
   * 请求体 + 提示缓存断点。
   *
   * Anthropic 的缓存是**前缀缓存**：断点之前的全部内容（system、tools、历史
   * 消息）会被写入缓存，下一轮只要前缀一致就能命中。这里放三个断点：
   *   1. system  —— 每轮完全相同
   *   2. 最后一个 tool 定义 —— 连带缓存住全部 tools
   *   3. 当前最后一条消息 —— 缓存住"到目前为止的整段对话"
   * 于是第 N 轮请求的绝大部分在第 N-1 轮就已经写进缓存了。
   */
  buildBody(req: ModelRequest): Record<string, unknown> {
    const wire = toWire(req.messages);
    const tools = req.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema,
    }));
    if (tools.length) {
      (tools[tools.length - 1] as Record<string, unknown>).cache_control = { type: "ephemeral" };
    }
    const last = wire[wire.length - 1];
    if (last && last.content.length) {
      const tail = last.content[last.content.length - 1] as Record<string, unknown>;
      tail.cache_control = { type: "ephemeral" };
    }
    return {
      model: req.model || this.model,
      max_tokens: req.maxTokens,
      system: req.system
        ? [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }]
        : undefined,
      messages: wire,
      tools,
      stream: true,
    };
  }

  /**
   * 精确计数：Anthropic 官方 /v1/messages/count_tokens。
   * 用官方端点而不是自建分词器 —— 分词器不公开、版本还会变，问它自己最准。
   * 失败一律返回 null（调用方回退估算），计数不该成为新的故障点。
   */
  async countTokens(req: ModelRequest): Promise<number | null> {
    const body = this.buildBody(req) as Record<string, unknown>;
    // count_tokens 不接受 max_tokens / stream
    delete body.max_tokens;
    delete body.stream;
    try {
      const res = await fetch(`${this.baseUrl}/v1/messages/count_tokens`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": this.version,
        },
        body: JSON.stringify(body),
        signal: req.signal,
      });
      if (!res.ok) return null;
      const data = (await res.json()) as { input_tokens?: number };
      return typeof data.input_tokens === "number" && data.input_tokens > 0 ? data.input_tokens : null;
    } catch {
      return null;
    }
  }

  async *stream(req: ModelRequest): AsyncGenerator<StreamEvent> {
    const body = this.buildBody(req);

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
      const body = await res.text().catch(() => "");
      // 服务端说了等多久就等多久（429/503 常带这个头），别用自己的固定退避。
      const retryAfter = parseRetryAfter(res.headers.get("retry-after"));
      throw classifyHttpError(res.status, body, retryAfter);
    }

    const content: ContentBlock[] = [];
    const toolBuffers = new Map<number, { id: string; name: string; json: string }>();
    let stopReason: AssistantMessage["stopReason"] = "end_turn";
    let usage: {
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens?: number;
      cacheCreationTokens?: number;
    } = { inputTokens: 0, outputTokens: 0 };

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
          usage.cacheReadTokens = ev.message?.usage?.cache_read_input_tokens ?? 0;
          usage.cacheCreationTokens = ev.message?.usage?.cache_creation_input_tokens ?? 0;
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
          } else if (ev.delta?.type === "thinking_delta") {
            // 扩展思考（extended thinking）：同样只用于展示，不写进 content
            yield { type: "thinking_delta", text: ev.delta.thinking ?? "" };
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
          if (typeof ev.usage?.cache_read_input_tokens === "number") {
            usage.cacheReadTokens = ev.usage.cache_read_input_tokens;
          }
          if (typeof ev.usage?.cache_creation_input_tokens === "number") {
            usage.cacheCreationTokens = ev.usage.cache_creation_input_tokens;
          }
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

/** Exported for tests: the wire format is a contract with the API. */
export function toWire(messages: Message[]): { role: "user" | "assistant"; content: unknown[] }[] {
  const out: { role: "user" | "assistant"; content: unknown[] }[] = [];
  // Anthropic 要求 user/assistant 严格交替。会话里完全可能出现连续两条 user
  // （工具结果 + hook 提示、恢复提示等），必须先合并，否则请求直接 400。
  const push = (role: "user" | "assistant", content: unknown[]) => {
    if (content.length === 0) return;
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(...content);
    else out.push({ role, content });
  };
  // 上一次 assistant 的 tool_use 若没等到结果（用户中断、进程被杀），
  // 下一轮请求会直接 400。这里补一条 is_error 的占位结果把契约补齐。
  let pendingUses: string[] = [];
  for (const m of messages) {
    if (m.role === "assistant") {
      // 只映射真正能上行到 wire 的两类块。
      // 以前是三元 + 强转：任何非 text 块都会被拼成一个 id/name 为 undefined 的 tool_use，
      // 那是**非法请求体**，而类型强转恰好掩盖了它。
      type AssistantWireBlock =
        | { type: "text"; text: string }
        | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };
      const content = m.content.flatMap<AssistantWireBlock>((b) => {
        if (b.type === "text") return [{ type: "text", text: b.text }];
        if (b.type === "tool_use") return [{ type: "tool_use", id: b.id, name: b.name, input: b.input }];
        return [];
      });
      push("assistant", content);
      pendingUses = content.filter((b) => b.type === "tool_use").map((b) => b.id);
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
    for (const id of pendingUses) {
      const answered = content.some((c) => (c as { type: string; tool_use_id?: string }).type === "tool_result" && (c as { tool_use_id?: string }).tool_use_id === id);
      if (!answered) {
        content.push({
          type: "tool_result",
          tool_use_id: id,
          content: "[no result recorded: the tool call was interrupted before it returned]",
          is_error: true,
        });
      }
    }
    pendingUses = [];
    push("user", content);
  }
  // 第一条必须是 user：某些恢复路径会先塞一条 assistant 副本。
  while (out.length > 0 && out[0].role !== "user") out.shift();
  return out;
}

import type { ContentBlock, ToolUseBlock } from "../core/types.ts";
import type { ModelProvider, ModelRequest, StreamEvent } from "./types.ts";

export interface MockToolCall {
  name: string;
  input: Record<string, unknown>;
}

export interface MockTurn {
  /** Assistant text emitted for this turn. */
  text?: string;
  /** Tool calls emitted for this turn (forces stopReason "tool_use"). */
  toolCalls?: MockToolCall[];
  stopReason?: "end_turn" | "tool_use" | "max_tokens";
  /** Simulate a provider failure instead of a message. */
  error?: { kind: import("./types.ts").ProviderErrorKind; message?: string };
  /** Artificial delay between deltas, ms (for UI demos). */
  delayMs?: number;
}

let seq = 0;

/**
 * Scripted provider: replays a fixed list of turns. This exists so the harness
 * is testable end-to-end with zero API keys and deterministic output — a
 * harness you cannot test is a harness you cannot trust.
 */
export class MockProvider implements ModelProvider {
  readonly id = "mock";
  readonly model: string;
  private turns: MockTurn[];
  private cursor = 0;
  /** Recorded requests, for assertions in tests. */
  readonly requests: ModelRequest[] = [];

  /** 测试用：让 countTokens 返回固定值（模拟服务商精确计数）。 */
  tokensPerRequest?: number;
  /** 测试用：模拟计数端点失败。 */
  countTokensFails = false;

  constructor(turns: MockTurn[], model = "mock-1") {
    this.turns = turns;
    this.model = model;
  }

  async countTokens(req: ModelRequest): Promise<number | null> {
    if (this.countTokensFails) return null;
    if (typeof this.tokensPerRequest === "number") return this.tokensPerRequest;
    const text = JSON.stringify(req.messages) + req.system;
    return Math.max(1, Math.round(text.length / 3));
  }

  async *stream(req: ModelRequest): AsyncGenerator<StreamEvent> {
    this.requests.push(req);
    const turn = this.turns[this.cursor++];
    if (!turn) {
      yield {
        type: "done",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "(mock script exhausted)" }],
          stopReason: "end_turn",
        },
      };
      return;
    }
    if (turn.error) {
      const { ProviderError } = await import("./types.ts");
      throw new ProviderError(turn.error.kind, turn.error.message ?? "mock failure");
    }

    const content: ContentBlock[] = [];
    if (turn.text) {
      for (const chunk of chunkText(turn.text)) {
        if (turn.delayMs) await new Promise((r) => setTimeout(r, turn.delayMs));
        yield { type: "text_delta", text: chunk };
      }
      content.push({ type: "text", text: turn.text });
    }
    for (const call of turn.toolCalls ?? []) {
      const block: ToolUseBlock = {
        type: "tool_use",
        id: `toolu_mock_${++seq}`,
        name: call.name,
        input: call.input,
      };
      content.push(block);
    }
    const hasTools = (turn.toolCalls ?? []).length > 0;
    yield {
      type: "done",
      message: {
        role: "assistant",
        content,
        stopReason: turn.stopReason ?? (hasTools ? "tool_use" : "end_turn"),
        usage: { inputTokens: 1200, outputTokens: 90 },
      },
    };
  }
}

function chunkText(text: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += 24) out.push(text.slice(i, i + 24));
  return out.length ? out : [text];
}

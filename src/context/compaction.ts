/**
 * Context compaction (ch.3.3 / ch.8.4). Progressive: cheapest release first,
 * LLM summarisation only as the last resort.
 *
 *   L1 snip        drop the oldest turns (keep head + recent window)
 *   L2 microcompact replace old tool output with a stub
 *   L3 summarise   LLM-compress the transcript into a handoff message
 *
 * Order matters: run the level that loses the least information first.
 */
import type { Message, ToolResultBlock } from "../core/types.ts";
import { estimateMessagesTokens } from "../util/tokens.ts";
import type { ModelProvider, StreamEvent } from "../providers/types.ts";

export interface CompactionConfig {
  /** Compact once the estimate exceeds this. */
  softLimit: number;
  /** Below this we stop compacting. */
  targetTokens: number;
  /** Messages always kept intact at the tail. */
  keepRecentMessages: number;
  /** Tool results older than this many messages may be stubbed. */
  microcompactAge: number;
}

export const DEFAULT_COMPACTION: CompactionConfig = {
  softLimit: 60_000,
  targetTokens: 30_000,
  keepRecentMessages: 12,
  microcompactAge: 8,
};

/**
 * Thresholds derived from the model context window instead of magic numbers.
 * 75% triggers compaction (leaves room for the reply), 40% is the target after
 * compaction (leaves room to keep working).
 */
export function deriveCompaction(contextWindow: number): CompactionConfig {
  const w = Math.max(2_000, Math.floor(contextWindow));
  return {
    softLimit: Math.floor(w * 0.75),
    targetTokens: Math.floor(w * 0.4),
    keepRecentMessages: w < 16_000 ? 6 : 12,
    microcompactAge: w < 16_000 ? 4 : 8,
  };
}

export interface CompactionOutcome {
  messages: Message[];
  applied: string[];
  tokensBefore: number;
  tokensAfter: number;
}

export function contextTokens(messages: Message[]): number {
  return estimateMessagesTokens(messages as never);
}

/** L1: stub out tool results older than the recent window. */
export function microcompact(messages: Message[], age = DEFAULT_COMPACTION.microcompactAge): {
  messages: Message[];
  stubbed: number;
} {
  const cutoff = Math.max(0, messages.length - age);
  let stubbed = 0;
  const next = messages.map((m, i) => {
    if (i >= cutoff) return m;
    let changed = false;
    const content = m.content.map((b) => {
      if (b.type === "tool_result" && b.content.length > 600) {
        changed = true;
        const stub: ToolResultBlock = {
          type: "tool_result",
          tool_use_id: b.tool_use_id,
          content: "[earlier tool output elided: " + b.content.length + " chars]",
          is_error: b.is_error,
        };
        return stub;
      }
      return b;
    });
    if (!changed) return m;
    stubbed++;
    return { ...m, content };
  });
  return { messages: next, stubbed };
}

/** L2: drop the oldest turns, keeping the first user message and a recent tail. */
export function snip(messages: Message[], keepRecent: number): { messages: Message[]; dropped: number } {
  if (messages.length <= keepRecent + 2) return { messages, dropped: 0 };
  const head = messages[0];
  let start = messages.length - keepRecent;
  // Never start on a tool_result-only message: it would orphan the tool_use.
  while (start < messages.length && messages[start].content.every((b) => b.type === "tool_result")) start++;
  const kept = messages.slice(start);
  const dropped = start - 1;
  const marker: Message = {
    role: "user",
    isMeta: true,
    content: [{ type: "text", text: "[snip] " + dropped + " earlier messages were dropped to save context." }],
  };
  return { messages: [head, marker, ...kept], dropped };
}

/** Heuristic-only pass: no model calls. Returns the compacted view. */
export function compactLocally(
  messages: Message[],
  config: CompactionConfig = DEFAULT_COMPACTION,
): CompactionOutcome {
  const tokensBefore = contextTokens(messages);
  const applied: string[] = [];
  let current = messages;

  if (tokensBefore <= config.softLimit) {
    return { messages, applied, tokensBefore, tokensAfter: tokensBefore };
  }

  const micro = microcompact(current, config.microcompactAge);
  if (micro.stubbed > 0) {
    current = micro.messages;
    applied.push("microcompact(" + micro.stubbed + ")");
  }
  if (contextTokens(current) <= config.targetTokens) {
    return { messages: current, applied, tokensBefore, tokensAfter: contextTokens(current) };
  }

  const snipped = snip(current, config.keepRecentMessages);
  if (snipped.dropped > 0) {
    current = snipped.messages;
    applied.push("snip(" + snipped.dropped + ")");
  }

  return { messages: current, applied, tokensBefore, tokensAfter: contextTokens(current) };
}

/** True when even the cheap passes leave us above target. */
export function needsSummary(messages: Message[], config: CompactionConfig = DEFAULT_COMPACTION): boolean {
  return contextTokens(messages) > config.targetTokens;
}

export function buildSummaryPrompt(messages: Message[]): string {
  const transcript = messages
    .map((m) => {
      const body = m.content
        .map((b) => {
          if (b.type === "text") return b.text;
          if (b.type === "tool_use") return "[tool_use " + b.name + " " + JSON.stringify(b.input).slice(0, 400) + "]";
          return "[tool_result] " + b.content.slice(0, 800);
        })
        .join("\n");
      return m.role.toUpperCase() + ": " + body;
    })
    .join("\n\n");

  return [
    "Compress the conversation below into a handoff note for your future self.",
    "Keep, in this order: (1) the user goal and constraints, (2) decisions already made",
    "and why, (3) files touched with their current state, (4) what remains to do,",
    "(5) exact identifiers the next step needs. Drop pleasantries and dead ends.",
    "Output only the note, max 800 words.",
    "",
    "<transcript>",
    transcript.slice(0, 120_000),
    "</transcript>",
  ].join("\n");
}

/** L3: LLM summarisation. Returns a single handoff message, or null on failure. */
export async function summarizeTranscript(
  provider: ModelProvider,
  model: string,
  messages: Message[],
  signal?: AbortSignal,
): Promise<Message | null> {
  const request = {
    model,
    system: "You compress agent transcripts into dense engineering handoff notes.",
    messages: [{ role: "user" as const, content: [{ type: "text" as const, text: buildSummaryPrompt(messages) }] }],
    tools: [],
    maxTokens: 2048,
    signal,
  };
  let summary = "";
  try {
    for await (const ev of provider.stream(request) as AsyncGenerator<StreamEvent>) {
      if (ev.type === "text_delta") summary += ev.text;
    }
  } catch {
    return null;
  }
  if (!summary.trim()) return null;
  return {
    role: "user",
    isMeta: true,
    content: [
      {
        type: "text",
        text: "[context compacted] Summary of the earlier conversation:\n\n" + summary.trim(),
      },
    ],
  };
}

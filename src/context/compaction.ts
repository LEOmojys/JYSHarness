/**
 * Context compaction (ch.3.3 / ch.8.4). Progressive: cheapest release first,
 * LLM summarisation only as the last resort.
 *
 *   L1 microcompact  stub old tool output (and oversized tool input)
 *   L2 snip          drop the oldest turns (keep head + recent window)
 *   L3 summarise     LLM-compress the *old prefix* into a handoff note
 *
 * 三条用测试换来的规则，写在这里免得下次又踩：
 *   1. 摘要只压缩"老前缀"，最近几条原样留在后面。整段替换成一条摘要，等于把
 *      用户刚说的话也压掉了 —— 模型看不到原始指令，只能靠摘要复述。
 *   2. 摘要 prompt 的截断必须是 head+tail。slice(0, N) 会把对话最新的部分丢掉，
 *      而那里才是"现在在做什么"，摘要会精确地记住开头、忘掉当前任务。
 *   3. tool_use / tool_result 必须成对。任何裁剪之后都要过 repairToolPairs，
 *      否则一个孤立的 tool_result 就是 400。
 */
import type { Message, TextBlock, ToolResultBlock } from "../core/types.ts";
import { textBlock } from "../core/types.ts";
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

function isToolResultOnly(m: Message): boolean {
  return m.content.length > 0 && m.content.every((b) => b.type === "tool_result");
}

export interface PairRepair {
  messages: Message[];
  droppedResults: number;
  stubbedUses: number;
  droppedMessages: number;
}

/**
 * 唯一的"配对守门人"。
 *
 * 两个方向都会错：
 *   - 留下了 tool_result，但它的 tool_use 被裁掉了  -> API 报 unexpected tool_use_id
 *   - 留下了 tool_use，但结果没留下（中断 / 被裁）  -> API 报 tool_use without tool_result
 * 所以两头都得修：孤儿结果直接删，没结果的调用降级成一段文字。
 */
export function repairToolPairs(messages: Message[]): PairRepair {
  const useIds = new Set<string>();
  const answered = new Set<string>();
  for (const m of messages) {
    for (const b of m.content) {
      if (b.type === "tool_use") useIds.add(b.id);
      else if (b.type === "tool_result") answered.add(b.tool_use_id);
    }
  }

  let droppedResults = 0;
  let stubbedUses = 0;
  let droppedMessages = 0;
  const out: Message[] = [];
  for (const m of messages) {
    let changed = false;
    const content = m.content
      .filter((b) => {
        if (b.type !== "tool_result") return true;
        if (useIds.has(b.tool_use_id)) return true;
        droppedResults++;
        changed = true;
        return false;
      })
      .map((b) => {
        if (b.type !== "tool_use") return b;
        if (answered.has(b.id)) return b;
        stubbedUses++;
        changed = true;
        const stub: TextBlock = {
          type: "text",
          text: "[tool call " + b.name + " has no result in this conversation: it was interrupted or dropped by compaction]",
        };
        return stub;
      });
    if (content.length === 0) {
      droppedMessages++;
      continue;
    }
    // 未改动的消息保持原对象：调用方（测试、UI diff）依赖这个身份。
    out.push(changed ? { ...m, content } : m);
  }
  return { messages: out, droppedResults, stubbedUses, droppedMessages };
}

export interface MicrocompactOptions {
  /** Tool result text longer than this becomes a stub. */
  maxResultChars?: number;
  /** Tool *input* JSON longer than this becomes a stub (old Write calls carry whole files). */
  maxInputChars?: number;
}

export interface MicrocompactResult {
  messages: Message[];
  stubbed: number;
  stubbedInputs: number;
}

/** L1: stub out tool results (and huge tool inputs) older than the recent window. */
export function microcompact(
  messages: Message[],
  age = DEFAULT_COMPACTION.microcompactAge,
  opts: MicrocompactOptions = {},
): MicrocompactResult {
  const maxResult = opts.maxResultChars ?? 600;
  const maxInput = opts.maxInputChars ?? 4_000;
  const cutoff = Math.max(0, messages.length - age);
  let stubbed = 0;
  let stubbedInputs = 0;
  const next = messages.map((m, i) => {
    if (i >= cutoff) return m;
    let changed = false;
    const content = m.content.map((b) => {
      if (b.type === "tool_result" && b.content.length > maxResult) {
        changed = true;
        stubbed++;
        const stub: ToolResultBlock = {
          type: "tool_result",
          tool_use_id: b.tool_use_id,
          content: "[earlier tool output elided by compaction: " + b.content.length + " chars]",
          is_error: b.is_error,
        };
        return stub;
      }
      if (b.type === "tool_use") {
        const size = JSON.stringify(b.input ?? {}).length;
        if (size > maxInput) {
          changed = true;
          stubbedInputs++;
          return { ...b, input: { _elided: "tool input elided by compaction (" + size + " chars)" } };
        }
      }
      return b;
    });
    if (!changed) return m;
    return { ...m, content };
  });
  return { messages: next, stubbed, stubbedInputs };
}

/** L2: drop the oldest turns, keeping the first user message and a recent tail. */
export function snip(messages: Message[], keepRecent: number): { messages: Message[]; dropped: number } {
  if (messages.length <= keepRecent + 2) return { messages, dropped: 0 };
  const first = messages[0];
  const keepHead = first.role === "user" && !isToolResultOnly(first);
  const head = keepHead ? [first] : [];
  let start = Math.max(head.length, messages.length - keepRecent);
  // Never start on a tool_result-only message: it would orphan the tool_use.
  while (start < messages.length && isToolResultOnly(messages[start])) start++;
  if (start >= messages.length) return { messages, dropped: 0 };
  const kept = messages.slice(start);
  const dropped = start - head.length;
  const marker: Message = {
    role: "user",
    isMeta: true,
    content: [{ type: "text", text: "[snip] " + dropped + " earlier messages were dropped to save context." }],
  };
  const repaired = repairToolPairs([...head, marker, ...kept]);
  return { messages: repaired.messages, dropped };
}

/**
 * L1 only: no model calls, no information loss beyond tool noise.
 *
 * 这是"先免费减重"的一步，必须和 snip 分开。之前把它们串在一条链上，
 * 结果是：大上下文先被 snip 砍到 target 以下，于是 needsSummary() 永远是 false，
 * 摘要这一步根本不会执行 —— 对话中段被静默丢掉，只留一行"[snip] N messages dropped"。
 * 记一笔：**snip 是摘要的兜底，不是摘要的前置**。
 */
export function compactCheap(
  messages: Message[],
  config: CompactionConfig = DEFAULT_COMPACTION,
): CompactionOutcome {
  const tokensBefore = contextTokens(messages);
  const applied: string[] = [];
  if (tokensBefore <= config.softLimit) {
    return { messages, applied, tokensBefore, tokensAfter: tokensBefore };
  }
  const micro = microcompact(messages, config.microcompactAge);
  if (micro.stubbed > 0 || micro.stubbedInputs > 0) {
    applied.push("microcompact(" + micro.stubbed + " results, " + micro.stubbedInputs + " inputs)");
  }
  return { messages: micro.messages, applied, tokensBefore, tokensAfter: contextTokens(micro.messages) };
}

/** Heuristic-only full pass (micro + snip). The fallback when summarising is unavailable. */
export function compactLocally(
  messages: Message[],
  config: CompactionConfig = DEFAULT_COMPACTION,
): CompactionOutcome {
  const cheap = compactCheap(messages, config);
  const applied = [...cheap.applied];
  let current = cheap.messages;

  if (cheap.tokensBefore <= config.softLimit || cheap.tokensAfter <= config.targetTokens) {
    return cheap;
  }

  const snipped = snip(current, config.keepRecentMessages);
  if (snipped.dropped > 0) {
    current = snipped.messages;
    applied.push("snip(" + snipped.dropped + ")");
  }

  return { messages: current, applied, tokensBefore: cheap.tokensBefore, tokensAfter: contextTokens(current) };
}

/** True when even the cheap passes leave us above target. */
export function needsSummary(messages: Message[], config: CompactionConfig = DEFAULT_COMPACTION): boolean {
  return contextTokens(messages) > config.targetTokens;
}

export interface SummarySplit {
  /** 永远保留的第一条用户消息（原始任务锚点），不参与摘要。 */
  anchor: Message | null;
  /** 要被摘要掉的老前缀。 */
  older: Message[];
  /** 原样保留的最近若干条。 */
  tail: Message[];
}

/**
 * 决定"摘要哪一段、保留哪一段"。
 * tail 必须从一条安全边界开始：不能停在孤立的 tool_result 上。
 */
export function splitForSummary(messages: Message[], keepRecent: number): SummarySplit {
  const first = messages[0];
  const keepHead = !!first && first.role === "user" && !isToolResultOnly(first);
  const floor = keepHead ? 1 : 0;
  if (messages.length <= keepRecent + floor) return { anchor: null, older: [], tail: messages };
  let start = Math.max(floor, messages.length - keepRecent);
  while (start < messages.length && isToolResultOnly(messages[start])) start++;
  if (start <= floor || start >= messages.length) return { anchor: null, older: [], tail: messages };
  return {
    anchor: keepHead ? first : null,
    older: messages.slice(floor, start),
    tail: messages.slice(start),
  };
}

export interface SummaryOptions {
  /** Character budget for the transcript block. Defaults to 120k chars (~30k tokens). */
  maxChars?: number;
  /** Extra instruction from /compact <focus>. */
  focus?: string;
  signal?: AbortSignal;
  maxTokens?: number;
}

export const SUMMARY_SYSTEM =
  "You compress agent transcripts into dense engineering handoff notes. Nothing else.";

/** Render one message as plain text for the summariser. */
export function renderMessage(m: Message, perBlock = 800): string {
  const body = m.content
    .map((b) => {
      if (b.type === "text") return b.text;
      if (b.type === "tool_use") return "[tool_use " + b.name + " " + JSON.stringify(b.input).slice(0, 500) + "]";
      if (b.type === "image") return "[image " + b.mediaType + "]";
      // 推理段落不进摘要：它是模型的草稿，不是结论
      if (b.type === "thinking") return "";
      return "[tool_result] " + b.content.slice(0, perBlock);
    })
    .join("\n");
  return (m.isMeta ? "SYSTEM_NOTE" : m.role.toUpperCase()) + ": " + body;
}

/**
 * 截断也要保住"最新"。
 * 按 25% 头 + 75% 尾分配预算：头是原始目标，尾是当前正在做的事，中间的死路最不重要 ——
 * 而 slice(0, N) 恰好留下了最不重要的那一段。
 */
export function fitTranscript(text: string, maxChars: number): string {
  if (maxChars <= 0 || text.length <= maxChars) return text;
  const headChars = Math.floor(maxChars * 0.25);
  const tailChars = Math.max(0, maxChars - headChars - 64);
  const omitted = Math.max(0, text.length - headChars - tailChars);
  return (
    text.slice(0, headChars) +
    "\n\n[... " + omitted + " chars omitted by compaction ...]\n\n" +
    text.slice(text.length - tailChars)
  );
}

export function buildSummaryPrompt(messages: Message[], opts: SummaryOptions = {}): string {
  const transcript = messages.map((m) => renderMessage(m)).join("\n\n");
  const body = fitTranscript(transcript, opts.maxChars ?? 120_000);
  const lines = [
    "Compress the conversation below into a handoff note for your future self.",
    "Your future self sees ONLY this note plus the last few messages verbatim, so",
    "anything you omit is gone. Prefer exact identifiers over prose.",
    "",
    "Use these headings, in this order:",
    "## Goal and constraints",
    "## Decisions made (and why)",
    "## Files touched (path, what changed, current state)",
    "## Errors hit and how they were fixed",
    "## Remaining work (ordered)",
    "## Exact values the next step needs (paths, commands, ids, versions)",
    "",
    "Rules: no pleasantries, no dead ends, keep code identifiers verbatim, max 800 words.",
    "Output only the note.",
  ];
  if (opts.focus && opts.focus.trim()) {
    lines.push("", "Extra focus requested by the user: " + opts.focus.trim());
  }
  return lines.join("\n") + "\n\n<transcript>\n" + body + "\n</transcript>";
}

/** L3: LLM summarisation. Returns a single handoff message, or null on failure. */
export async function summarizeTranscript(
  provider: ModelProvider,
  model: string,
  messages: Message[],
  opts: SummaryOptions = {},
): Promise<Message | null> {
  const request = {
    model,
    system: SUMMARY_SYSTEM,
    messages: [
      { role: "user" as const, content: [{ type: "text" as const, text: buildSummaryPrompt(messages, opts) }] },
    ],
    tools: [],
    maxTokens: opts.maxTokens ?? 2048,
    signal: opts.signal,
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

/** Wire the summary + anchor + tail back together, always through the pair repairer. */
export function applySummary(split: SummarySplit, summary: Message): Message[] {
  const rebuilt = [...(split.anchor ? [split.anchor] : []), summary, ...split.tail];
  return repairToolPairs(rebuilt).messages;
}


/**
 * 摘要请求自己的字符预算。
 * 取值要同时满足两件事：装得进模型窗口（否则摘要调用自己就 413），
 * 以及足够长到不丢关键信息。上限 120k 字符 ≈ 30k tokens。
 */
export function summaryBudgetChars(contextWindow = 200_000): number {
  const w = Math.max(2_000, Math.floor(contextWindow));
  const chars = Math.floor(w * 0.45 * 3.5);
  return Math.max(4_000, Math.min(120_000, chars));
}

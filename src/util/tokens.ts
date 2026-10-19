/**
 * Token estimation. We intentionally avoid a tokenizer dependency: a coarse
 * estimator is enough for compaction thresholds, and CJK-aware counting keeps
 * it usable for Chinese sessions (Latin ≈ 4 chars/token, CJK ≈ 1 char/token).
 */
export function estimateTokens(text: string): number {
  let cjk = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (
      (cp >= 0x3040 && cp <= 0x30ff) ||
      (cp >= 0x4e00 && cp <= 0x9fff) ||
      (cp >= 0xac00 && cp <= 0xd7af) ||
      (cp >= 0xf900 && cp <= 0xfaff)
    ) cjk++;
  }
  const rest = text.length - cjk;
  return Math.ceil(cjk * 1.0 + rest / 3.6) + 4;
}

export function estimateMessagesTokens(
  messages: { content: { type: string; text?: string; content?: string; input?: unknown; name?: string }[] }[],
): number {
  let total = 0;
  for (const m of messages) {
    for (const b of m.content) {
      if (b.type === "text") total += estimateTokens(b.text ?? "");
      else if (b.type === "tool_result") total += estimateTokens(b.content ?? "");
      else if (b.type === "tool_use")
        total += estimateTokens((b.name ?? "") + JSON.stringify(b.input ?? {}));
      else if (b.type === "image") total += 1200; // provider-side image cost, roughly
    }
    total += 4;
  }
  return total;
}

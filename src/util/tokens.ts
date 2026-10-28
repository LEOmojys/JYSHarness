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
      // thinking 不会发给模型，所以不计入上下文占用
      if (b.type === "thinking") continue;
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

/**
 * 估算器校准。
 *
 * 我们的估算永远是启发式的（Latin 3.6 字符/token、CJK 1 字符/token），而
 * 服务端每次都会回报**真实** inputTokens。两者的比值就是这台机器 + 这个模型
 * 的实际偏差 —— 用它修正阈值，压缩时机才会准。
 *
 * 设计上刻意保守：
 *   - 指数滑动平均（EMA），单次异常不会把系数带飞；
 *   - 夹在 0.5–2.0，避免"估算偏小 10 倍"这种异常让压缩疯狂触发；
 *   - 至少 3 个样本才生效，冷启动不猜。
 */
export class TokenCalibrator {
  private ema: number | null = null;
  private samples = 0;

  record(estimated: number, actual: number): void {
    if (estimated <= 0 || actual <= 0) return;
    const ratio = actual / estimated;
    if (!Number.isFinite(ratio) || ratio <= 0) return;
    this.samples++;
    this.ema = this.ema === null ? ratio : this.ema * 0.7 + ratio * 0.3;
  }

  /** 用于"把估算往上/下修正"的系数；样本不足时返回 1。 */
  factor(): number {
    if (this.samples < 3 || this.ema === null) return 1;
    return Math.min(2, Math.max(0.5, this.ema));
  }

  stats(): { samples: number; factor: number } {
    return { samples: this.samples, factor: this.factor() };
  }

  reset(): void {
    this.ema = null;
    this.samples = 0;
  }
}

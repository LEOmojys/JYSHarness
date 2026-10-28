/** Rough cost estimation. Prices are per 1M tokens and only used for display. */
export interface Pricing {
  input: number;
  output: number;
}

const TABLE: { match: RegExp; price: Pricing }[] = [
  { match: /opus/i, price: { input: 15, output: 75 } },
  { match: /sonnet/i, price: { input: 3, output: 15 } },
  { match: /haiku/i, price: { input: 0.8, output: 4 } },
  { match: /deepseek-reasoner/i, price: { input: 0.55, output: 2.19 } },
  { match: /deepseek/i, price: { input: 0.27, output: 1.1 } },
  { match: /gpt-4o/i, price: { input: 2.5, output: 10 } },
  { match: /gpt-4/i, price: { input: 2.5, output: 10 } },
  { match: /qwen|moonshot|kimi|glm/i, price: { input: 0.5, output: 1.5 } },
];

const FALLBACK: Pricing = { input: 1, output: 3 };

export function pricingFor(model: string): Pricing {
  for (const row of TABLE) if (row.match.test(model)) return row.price;
  return FALLBACK;
}

/**
 * 缓存计价（Anthropic 公开价）：读缓存 0.1x，写缓存 1.25x，普通输入 1x。
 * inputTokens 按"未命中缓存"的部分计；cacheRead/cacheCreation 单独计。
 */
export interface CostInput {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

/** 成本分项。session.cost() 以前只有总额、分项写死 0 —— 暴露出去的 API 在撒谎。 */
export interface CostBreakdown {
  inputUsd: number;
  outputUsd: number;
  cacheReadUsd: number;
  cacheCreationUsd: number;
  totalUsd: number;
}

export function costBreakdown(model: string, input: number | CostInput, outputTokens?: number): CostBreakdown {
  const p = pricingFor(model);
  const c: CostInput =
    typeof input === "number" ? { inputTokens: input, outputTokens: outputTokens ?? 0 } : input;
  const perM = (n: number, price: number) => (n / 1_000_000) * price;
  const inputUsd = perM(c.inputTokens, p.input);
  const cacheReadUsd = perM(c.cacheReadTokens ?? 0, p.input * 0.1);
  const cacheCreationUsd = perM(c.cacheCreationTokens ?? 0, p.input * 1.25);
  const outputUsd = perM(c.outputTokens, p.output);
  return { inputUsd, outputUsd, cacheReadUsd, cacheCreationUsd, totalUsd: inputUsd + cacheReadUsd + cacheCreationUsd + outputUsd };
}

export function estimateCost(model: string, input: number | CostInput, outputTokens?: number): number {
  const p = pricingFor(model);
  const c: CostInput =
    typeof input === "number" ? { inputTokens: input, outputTokens: outputTokens ?? 0 } : input;
  const perM = (n: number, price: number) => (n / 1_000_000) * price;
  return (
    perM(c.inputTokens, p.input) +
    perM(c.cacheReadTokens ?? 0, p.input * 0.1) +
    perM(c.cacheCreationTokens ?? 0, p.input * 1.25) +
    perM(c.outputTokens, p.output)
  );
}

/** 命中率 = 缓存读 / (普通输入 + 缓存读 + 缓存写)。 */
export function cacheHitRate(c: CostInput): number {
  const cached = c.cacheReadTokens ?? 0;
  const total = c.inputTokens + cached + (c.cacheCreationTokens ?? 0);
  return total > 0 ? cached / total : 0;
}

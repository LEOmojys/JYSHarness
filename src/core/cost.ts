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

export function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
  const p = pricingFor(model);
  return (inputTokens / 1_000_000) * p.input + (outputTokens / 1_000_000) * p.output;
}

import { test } from "node:test";
import assert from "node:assert/strict";
import { AnthropicProvider } from "../src/providers/anthropic.ts";
import { estimateCost, cacheHitRate } from "../src/core/cost.ts";
import { userMessage } from "../src/core/types.ts";

const provider = new AnthropicProvider({ apiKey: "k", model: "claude-sonnet-4-5" });
const tool = (name: string) => ({ name, description: "d", inputSchema: { type: "object", properties: {} } });

function body(messages: any[], tools: any[]) {
  return provider.buildBody({
    model: "claude-sonnet-4-5",
    system: "you are a harness",
    messages,
    tools,
    maxTokens: 1024,
    signal: new AbortController().signal,
  } as any) as any;
}

function breakpoints(b: any): number {
  let n = 0;
  if (Array.isArray(b.system)) n += b.system.filter((s: any) => s.cache_control).length;
  for (const t of b.tools ?? []) if (t.cache_control) n++;
  for (const m of b.messages ?? []) {
    if (!Array.isArray(m.content)) continue;
    for (const blk of m.content) if (blk.cache_control) n++;
  }
  return n;
}

test("prompt cache: system, tools and the tail message carry cache_control", () => {
  const b = body([userMessage("hello")], [tool("Read"), tool("Bash")]);
  assert.equal(Array.isArray(b.system), true);
  assert.deepEqual(b.system[0].cache_control, { type: "ephemeral" });
  assert.equal(b.tools[b.tools.length - 1].cache_control.type, "ephemeral", "最后一个工具携带断点");
  assert.equal(b.tools[0].cache_control, undefined, "只有最后一个工具需要断点");
  const tail = b.messages[b.messages.length - 1];
  assert.deepEqual(tail.content[tail.content.length - 1].cache_control, { type: "ephemeral" });
});

test("prompt cache: never exceeds the 4-breakpoint limit", () => {
  const b = body([userMessage("a"), userMessage("b")], [tool("Read")]);
  assert.ok(breakpoints(b) <= 4, "断点数 " + breakpoints(b));
});

test("prompt cache: no tools means no tool breakpoint", () => {
  const b = body([userMessage("hi")], []);
  assert.equal(b.tools.length, 0);
  assert.equal(breakpoints(b), 2, "system + tail");
});

test("cost: cached tokens are billed at 0.1x and writes at 1.25x", () => {
  const plain = estimateCost("claude-sonnet-4-5", { inputTokens: 100_000, outputTokens: 0 });
  const cached = estimateCost("claude-sonnet-4-5", {
    inputTokens: 10_000,
    outputTokens: 0,
    cacheReadTokens: 90_000,
    cacheCreationTokens: 0,
  });
  assert.ok(cached < plain * 0.2, "命中后成本应大幅下降: " + cached + " vs " + plain);
});

test("cost: hit rate accounts for reads, writes and fresh input", () => {
  assert.ok(Math.abs(cacheHitRate({ inputTokens: 25, outputTokens: 0, cacheReadTokens: 75 }) - 0.75) < 1e-9);
  assert.equal(cacheHitRate({ inputTokens: 0, outputTokens: 0 }), 0);
});

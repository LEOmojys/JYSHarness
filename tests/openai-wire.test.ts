import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { OpenAIProvider } from "../src/providers/openai.ts";
import { textBlock, userMessage } from "../src/core/types.ts";
import { ProviderError } from "../src/providers/types.ts";

/** 起一个只会吐 SSE 的假 /chat/completions，块按真实实现的分片方式切。 */
async function withServer(
  chunks: string[],
  handler: (chunks: string[]) => Promise<void>,
  opts: { status?: number; headers?: Record<string, string>; body?: string } = {},
): Promise<void> {
  const server = createServer((req, res) => {
    if (opts.body !== undefined) {
      res.writeHead(opts.status ?? 200, { "content-type": "application/json", ...(opts.headers ?? {}) });
      res.end(opts.body);
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const c of chunks) res.write(c);
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  try {
    await handler([String(port)]);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

function providerFor(port: string) {
  return new OpenAIProvider({ apiKey: "test-key", baseUrl: "http://127.0.0.1:" + port, model: "gpt-test" });
}

async function collect(p: OpenAIProvider) {
  const events: { type: string; text?: string; message?: { content: unknown[]; stopReason?: string } }[] = [];
  for await (const ev of p.stream({
    model: "gpt-test",
    system: "be brief",
    messages: [userMessage("hi")],
    tools: [{ name: "Read", description: "read", inputSchema: { type: "object", properties: {} } }],
    maxTokens: 100,
  })) {
    events.push(ev as never);
  }
  return events;
}

test("openai wire: text deltas stream and end with one assistant message", async () => {
  const chunks = [
    'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
    "data: [DONE]\n\n",
  ];
  await withServer(chunks, async ([port]) => {
    const events = await collect(providerFor(port));
    const deltas = events.filter((e) => e.type === "text_delta").map((e) => e.text).join("");
    assert.equal(deltas, "Hello");
    const done = events[events.length - 1];
    assert.equal(done.type, "done");
    assert.equal(done.message?.stopReason, "end_turn");
    assert.deepEqual((done.message?.content[0] as { text: string }).text, "Hello");
  });
});

test("openai wire: tool_calls are assembled from split deltas", async () => {
  const chunks = [
    'data: {"choices":[{"delta":{"content":"checking"}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_a","function":{"name":"Read","arguments":"{\\"file"}}]}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"_path\\":\\"a.ts\\"}"}}]}}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
    "data: [DONE]\n\n",
  ];
  await withServer(chunks, async ([port]) => {
    const events = await collect(providerFor(port));
    const done = events[events.length - 1];
    assert.equal(done.message?.stopReason, "tool_use");
    const call = (done.message?.content as { type: string; id: string; name: string; input: Record<string, unknown> }[])[1];
    assert.equal(call.type, "tool_use");
    assert.equal(call.id, "call_a");
    assert.equal(call.name, "Read");
    assert.deepEqual(call.input, { file_path: "a.ts" });
  });
});

test("openai wire: usage is carried through (including cached tokens)", async () => {
  const chunks = [
    'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":12,"completion_tokens":3,"prompt_tokens_details":{"cached_tokens":8}}}\n\n',
    "data: [DONE]\n\n",
  ];
  await withServer(chunks, async ([port]) => {
    const events = await collect(providerFor(port));
    const done = events[events.length - 1] as never as { message: { usage: Record<string, number>; stopReason: string } };
    assert.equal(done.message.usage.inputTokens, 12);
    assert.equal(done.message.usage.outputTokens, 3);
    assert.equal(done.message.usage.cacheReadTokens, 8);
    assert.equal(done.message.stopReason, "end_turn");
  });
});

test("openai wire: max_tokens finish maps to the max_tokens stop reason", async () => {
  const chunks = [
    'data: {"choices":[{"delta":{"content":"cut"}}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n',
    "data: [DONE]\n\n",
  ];
  await withServer(chunks, async ([port]) => {
    const events = await collect(providerFor(port));
    const done = events[events.length - 1];
    assert.equal(done.message?.stopReason, "max_tokens");
  });
});

test("openai wire: a rate limit surfaces a retryable ProviderError", async () => {
  await withServer(
    [],
    async ([port]) => {
      const p = providerFor(port);
      await assert.rejects(
        () => collect(p),
        (err: unknown) => {
          assert.ok(err instanceof ProviderError);
          // 是否可重试由 kind 决定（循环那边按 kind 判断），错误对象本身没有 retryable 字段
          assert.equal(err.kind, "rate_limit");
          assert.equal(err.status, 429);
          assert.equal(err.retryAfterMs, 7000, "Retry-After 头要换算成毫秒");
          return true;
        },
      );
    },
    { status: 429, headers: { "retry-after": "7" }, body: JSON.stringify({ error: { message: "slow down" } }) },
  );
});

test("openai wire: multimodal user content uses the array form", async () => {
  const chunks = ["data: [DONE]\n\n"];
  let seen = "";
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => {
      raw += d;
    });
    req.on("end", () => {
      seen = raw;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(chunks.join(""));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  try {
    const p = providerFor(String(port));
    for await (const _ev of p.stream({
      model: "gpt-test",
      system: "",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "look" },
            { type: "image", mediaType: "image/png", data: "AAA" },
          ],
        } as never,
      ],
      tools: [],
      maxTokens: 10,
    })) {
      /* drain */
    }
    const body = JSON.parse(seen) as { messages: { role: string; content: unknown }[] };
    const user = body.messages.find((m) => m.role === "user")!;
    assert.ok(Array.isArray(user.content), "image content must be an array");
    const parts = user.content as { type: string }[];
    assert.equal(parts[0].type, "text");
    assert.equal(parts[1].type, "image_url");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("openai wire: reasoning_content becomes thinking_delta, not answer text", async () => {
  const chunks = [
    'data: {"choices":[{"delta":{"reasoning_content":"先想一下"}}]}\n\n',
    'data: {"choices":[{"delta":{"reasoning_content":"再算一下"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"答案"}}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
    "data: [DONE]\n\n",
  ];
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const c of chunks) res.write(c);
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  try {
    const p = new OpenAIProvider({ apiKey: "k", baseUrl: "http://127.0.0.1:" + port, model: "m" });
    const events: { type: string; text?: string; message?: { content: unknown[] } }[] = [];
    for await (const ev of p.stream({
      model: "m",
      system: "",
      messages: [userMessage("hi")],
      tools: [],
      maxTokens: 64,
    })) {
      events.push(ev as never);
    }
    const thinking = events.filter((e) => e.type === "thinking_delta").map((e) => e.text).join("");
    assert.equal(thinking, "先想一下再算一下", "reasoning must arrive as thinking_delta");
    const done = events[events.length - 1];
    const blocks = done.message?.content as { type: string; text: string }[];
    // 推理作为独立的 thinking 块保留在消息里（UI 折叠展示），
    // 但**不能**混进正文 text 块 —— 否则用户会把模型的自言自语当答案。
    assert.deepEqual(blocks.map((b) => b.type), ["thinking", "text"]);
    assert.equal(blocks[0].text, "先想一下再算一下");
    assert.deepEqual(blocks.filter((b) => b.type === "text").map((b) => b.text), ["答案"]);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});


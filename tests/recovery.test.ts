import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { queryLoop, type HarnessEvent } from "../src/core/query.ts";
import { MAX_RETRY_AFTER_MS, parseRetryAfter, ProviderError } from "../src/providers/types.ts";
import { emptyRuleSet } from "../src/permissions/rules.ts";
import { Logger } from "../src/util/log.ts";
import type { Tool } from "../src/tools/types.ts";

const logger = new Logger("error");

interface Step {
  throw?: "rate_limit" | "overloaded" | "auth" | "prompt_too_long" | "model_error";
  message?: string;
  text?: string;
  content?: unknown[];
  stopReason?: string;
}

function fakeProvider(script: Step[]) {
  let i = 0;
  return {
    id: "fake",
    model: "fake-1",
    requests: [] as unknown[],
    async *stream(req: { messages: unknown[] }) {
      this.requests.push(req);
      const step = script[Math.min(i, script.length - 1)];
      i++;
      if (step.throw) throw new ProviderError(step.throw, step.message ?? step.throw);
      const content = step.text ? [{ type: "text", text: step.text }] : (step.content ?? []);
      yield {
        type: "done" as const,
        message: { role: "assistant" as const, content, stopReason: step.stopReason ?? "end_turn" },
      };
    },
  };
}

function params(over: Record<string, unknown> = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "jys-recov-"));
  return {
    // 这些用例只走"错误恢复"分支，不会真的向模型发请求；但类型上它必须是 provider。
    // 传 null 能跑是因为没人调用它 —— 那正是类型系统该拦住的写法。
    provider: { id: "fake", model: "fake-1", async *stream() {} },
    model: "fake-1",
    systemPrompt: "sys",
    messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
    tools: [] as Tool[],
    preloadedToolMap: new Map(),
    permission: { mode: "default", rules: emptyRuleSet(), sandboxMode: "workspace-write", workspaceRoot: root },
    toolContext: { workspaceRoot: root, cwd: root, sandbox: { mode: "workspace-write", workspaceRoot: root }, signal: new AbortController().signal, logger, depth: 0 },
    hooks: {},
    logger,
    sessionId: "recov",
    maxTurns: 8,
    maxTokens: 100,
    signal: new AbortController().signal,
    approve: async () => "allow",
    ...over,
  } as Parameters<typeof queryLoop>[0];
}

async function drain(p: Parameters<typeof queryLoop>[0]) {
  const events: HarnessEvent[] = [];
  let terminal = "unknown";
  const it = queryLoop(p);
  for (;;) {
    const r = await it.next();
    if (r.done) {
      terminal = String(r.value);
      break;
    }
    events.push(r.value);
  }
  return { events, terminal };
}

test("recovery: exhausted max_tokens ends as max_output_tokens, not success", async () => {
  const provider = fakeProvider([{ text: "part", stopReason: "max_tokens" }]);
  const { events, terminal } = await drain(params({ provider }));
  assert.equal(terminal, "max_output_tokens", "truncated output must not be reported as completed");
  const done = events.find((e) => e.type === "done");
  assert.equal(done?.type === "done" ? done.reason : null, "max_output_tokens");
  assert.ok(events.some((e) => e.type === "notice" && e.text.includes("truncated")));
  assert.equal(provider.requests.length, 5, "1 try + 1 escalation + 3 resumes");
});

test("recovery: an empty assistant message is retried, not treated as a final answer", async () => {
  const provider = fakeProvider([{ content: [] }, { text: "real answer" }]);
  const { events, terminal } = await drain(params({ provider }));
  assert.equal(terminal, "completed");
  assert.equal(provider.requests.length, 2);
  assert.ok(events.some((e) => e.type === "notice" && e.text.includes("empty message")));
  const assistant = events.find((e) => e.type === "assistant_message");
  assert.ok(assistant && JSON.stringify(assistant).includes("real answer"));
});

test("recovery: two empty messages in a row fail loudly", async () => {
  const provider = fakeProvider([{ content: [] }]);
  const { terminal } = await drain(params({ provider }));
  assert.equal(terminal, "model_error");
});

test("recovery: a Stop hook that never approves stops with stop_hook_prevented", async () => {
  const provider = fakeProvider([{ text: "final" }]);
  const { events, terminal } = await drain(
    params({ provider, hooks: { Stop: [{ handler: () => ({ decision: "deny" as const, reason: "not done yet" }) }] } }),
  );
  assert.equal(terminal, "stop_hook_prevented");
  assert.ok(provider.requests.length <= 4, "must not burn every turn, got " + provider.requests.length);
  assert.ok(events.some((e) => e.type === "done" && e.reason === "stop_hook_prevented"));
});

test("recovery: a failing persist callback is reported, not fatal", async () => {
  const provider = fakeProvider([{ text: "final" }]);
  const { events, terminal } = await drain(
    params({
      provider,
      persist: () => {
        throw new Error("disk full");
      },
    }),
  );
  assert.equal(terminal, "completed", "a failed write must not kill the turn");
  assert.ok(events.some((e) => e.type === "notice" && e.text.includes("persist failed")));
});

test("recovery: a tool that throws becomes an error result and the loop continues", async () => {
  const boom: Tool = {
    name: "Boom",
    description: "throws",
    inputSchema: { type: "object", properties: {} },
    isReadOnly: true,
    isConcurrencySafe: () => true,
    async call() {
      throw new Error("tool blew up");
    },
  };
  const provider = fakeProvider([
    { content: [{ type: "tool_use", id: "t1", name: "Boom", input: {} }], stopReason: "tool_use" },
    { text: "recovered" },
  ]);
  const root = mkdtempSync(path.join(os.tmpdir(), "jys-recov2-"));
  const { events, terminal } = await drain(
    params({
      provider,
      tools: [boom],
      preloadedToolMap: new Map([["Boom", boom]]),
      permission: { mode: "bypassPermissions", rules: emptyRuleSet(), sandboxMode: "danger-full-access", workspaceRoot: root },
    }),
  );
  assert.equal(terminal, "completed");
  const end = events.find((e) => e.type === "tool_end");
  assert.ok(end && end.type === "tool_end" && end.result.isError);
  assert.match(end && end.type === "tool_end" ? end.result.content : "", /Tool threw an error/);
});

test("recovery: auth failures carry an actionable hint", async () => {
  const provider = fakeProvider([{ throw: "auth", message: "401 unauthorized" }]);
  const { events, terminal } = await drain(params({ provider }));
  assert.equal(terminal, "model_error");
  const done = events.find((e) => e.type === "done");
  const error = done && done.type === "done" ? String(done.error ?? "") : "";
  assert.match(error, /401/);
  assert.match(error, /API Key/);
});

test("recovery: rate limits are retried and then abandoned", async () => {
  const provider = fakeProvider([{ throw: "rate_limit" }]);
  const { terminal } = await drain(params({ provider }));
  assert.equal(terminal, "model_error");
  assert.equal(provider.requests.length, 4, "3 retries + the original call");
});

test("recovery: 413 gets exactly one reactive compaction attempt", async () => {
  const provider = fakeProvider([{ throw: "prompt_too_long" }, { text: "summary" }, { text: "answer" }]);
  const { events, terminal } = await drain(params({ provider }));
  assert.equal(terminal, "completed");
  assert.ok(events.some((e) => e.type === "compaction" && e.applied.includes("reactive_compact")));
});

test("recovery: a network blip is retried instead of ending the turn", async () => {
  let calls = 0;
  const provider = {
    id: "flaky",
    model: "f",
    async *stream() {
      calls++;
      if (calls === 1) throw new TypeError("fetch failed: ECONNRESET");
      yield { type: "done" as const, message: { role: "assistant" as const, content: [{ type: "text", text: "after the blip" }], stopReason: "end_turn" } };
    },
  };
  const { events, terminal } = await drain(params({ provider }));
  assert.equal(terminal, "completed", "a transient socket error must not kill the turn");
  assert.equal(calls, 2);
  assert.ok(events.some((e) => e.type === "notice" && e.text.includes("network error")));
});

test("recovery: a non-network TypeError is still fatal", async () => {
  const provider = {
    id: "broken",
    model: "f",
    async *stream(): AsyncGenerator<never> {
      throw new TypeError("cannot read properties of undefined");
    },
  };
  const { terminal } = await drain(params({ provider }));
  assert.equal(terminal, "model_error");
});

test("retry-after: the server-specified delay is honoured instead of the local backoff", async () => {
  let calls = 0;
  const provider = {
    id: "limited",
    model: "f",
    async *stream() {
      calls++;
      // 40ms，远小于本地退避的首轮 1000ms
      if (calls === 1) throw new ProviderError("rate_limit", "slow down", 429, 40);
      yield { type: "done" as const, message: { role: "assistant" as const, content: [{ type: "text", text: "ok" }], stopReason: "end_turn" } };
    },
  };
  const started = Date.now();
  const { events, terminal } = await drain(params({ provider }));
  const elapsed = Date.now() - started;
  assert.equal(terminal, "completed");
  assert.ok(elapsed < 800, "must not fall back to the 1000ms default, waited " + elapsed + "ms");
  assert.ok(events.some((e) => e.type === "notice" && e.text.includes("Retry-After")));
});

test("retry-after: parsing tolerates seconds, HTTP dates, junk and absurd values", () => {
  assert.equal(parseRetryAfter("30"), 30_000);
  assert.equal(parseRetryAfter("0"), 0);
  assert.equal(parseRetryAfter("soon"), undefined);
  assert.equal(parseRetryAfter(""), undefined);
  assert.equal(parseRetryAfter(null), undefined);
  assert.equal(parseRetryAfter("999999"), MAX_RETRY_AFTER_MS);
  const now = Date.UTC(2026, 0, 1, 0, 0, 0);
  const date = new Date(now + 5000).toUTCString();
  assert.equal(parseRetryAfter(date, now), 5000);
  // 过去的时间不能变成负数
  assert.equal(parseRetryAfter(new Date(now - 5000).toUTCString(), now), 0);
});

test("fallback: the secondary model takes over when the primary rejects auth", async () => {
  const primary = fakeProvider([{ throw: "auth", message: "401" }]);
  const secondary = fakeProvider([{ text: "from the fallback" }]);
  const { events, terminal } = await drain(
    params({ provider: primary, fallback: { provider: secondary, model: "fallback-1" } }),
  );
  assert.equal(terminal, "completed", "a configured fallback must rescue the turn");
  assert.ok(events.some((e) => e.type === "notice" && e.text.includes("fallback")));
  assert.equal(secondary.requests.length, 1);
  const assistant = events.find((e) => e.type === "assistant_message");
  assert.ok(assistant && JSON.stringify(assistant).includes("from the fallback"));
});

test("fallback: switched at most once, no ping-pong", async () => {
  const primary = fakeProvider([{ throw: "auth", message: "401" }]);
  const secondary = fakeProvider([{ throw: "auth", message: "401 too" }]);
  const { terminal } = await drain(params({ provider: primary, fallback: { provider: secondary, model: "fallback-1" } }));
  assert.equal(terminal, "model_error");
  assert.equal(primary.requests.length, 1);
  assert.equal(secondary.requests.length, 1, "must not bounce back and forth");
});

test("fallback: 413 is not a fallback case (the model cannot help a too-long prompt)", async () => {
  const primary = fakeProvider([{ throw: "prompt_too_long" }, { text: "summary" }, { throw: "prompt_too_long" }]);
  const secondary = fakeProvider([{ text: "should not be used" }]);
  const { terminal } = await drain(params({ provider: primary, fallback: { provider: secondary, model: "fallback-1" } }));
  assert.equal(terminal, "prompt_too_long");
  assert.equal(secondary.requests.length, 0);
});

test("fallback: no fallback configured keeps the old behaviour", async () => {
  const primary = fakeProvider([{ throw: "auth", message: "401" }]);
  const { terminal, events } = await drain(params({ provider: primary }));
  assert.equal(terminal, "model_error");
  assert.ok(!events.some((e) => e.type === "notice" && e.text.includes("fallback")));
});
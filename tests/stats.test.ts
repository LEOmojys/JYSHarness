import { test } from "node:test";
import assert from "node:assert/strict";
import { Session } from "../src/core/session.ts";
import { MockProvider } from "../src/providers/mock.ts";
import { emptyRuleSet } from "../src/permissions/rules.ts";
import { Logger } from "../src/util/log.ts";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const logger = new Logger("error");

function makeSession(): Session {
  const ws = mkdtempSync(path.join(os.tmpdir(), "jys-timing-"));
  return new Session({
    workspaceRoot: ws,
    settings: { permissionMode: "default", sandboxMode: "workspace-write", maxTurns: 5 },
    rules: emptyRuleSet(),
    provider: new MockProvider([{ text: "hello there", stopReason: "end_turn" }]),
    model: "mock-1",
    logger,
    approve: async () => "allow",
  });
}

test("timing: a turn records model time, tool time and steps", async () => {
  const session = makeSession();
  await session.init();
  for await (const _ev of session.send("hi", new AbortController().signal)) {
    /* drain */
  }
  const stats = session.stats as any;
  assert.equal(typeof stats.modelMs, "number");
  assert.ok(stats.modelMs >= 0, "modelMs recorded: " + stats.modelMs);
  assert.equal(typeof stats.toolMs, "number");
  assert.equal(stats.steps, 0, "no tool calls in this turn");
  assert.equal(stats.turns, 1);
});

test("timing: tps is derived from output tokens and model time", async () => {
  const ws = mkdtempSync(path.join(os.tmpdir(), "jys-tps-"));
  // mock provider 不上报 usage，这里用一个会上报、且有真实耗时的假 provider。
  const slowProvider = {
    id: "fake",
    model: "mock-1",
    async *stream() {
      await new Promise((r) => setTimeout(r, 30));
      yield { type: "text_delta", text: "hello" };
      yield {
        type: "done",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "hello" }],
          stopReason: "end_turn",
          usage: { inputTokens: 100, outputTokens: 60 },
        },
      };
    },
  };
  const session = new Session({
    workspaceRoot: ws,
    settings: { permissionMode: "default", sandboxMode: "workspace-write", maxTurns: 5 },
    rules: emptyRuleSet(),
    provider: slowProvider as never,
    model: "mock-1",
    logger,
    approve: async () => "allow",
  });
  await session.init();
  for await (const _ev of session.send("hi", new AbortController().signal)) {
    /* drain */
  }
  const stats = session.stats as any;
  const cost = session.cost();
  assert.ok(stats.modelMs >= 25, "model time measured: " + stats.modelMs);
  assert.equal(stats.ttftAvgMs >= 25, true, "ttft measured: " + stats.ttftAvgMs);
  assert.ok(cost.tps > 0, "tps computed: " + cost.tps);
  const expected = Math.round(60 / (stats.modelMs / 1000));
  assert.ok(Math.abs(cost.tps - expected) <= 1, "tps=" + cost.tps + " expected=" + expected);
});

test("timing: context breakdown splits system, tools and messages", async () => {
  const session = makeSession();
  await session.init();
  const c = session.contextBreakdown();
  assert.ok(c.system > 0, "system prompt counted");
  assert.ok(c.tools > 0, "tool schemas counted");
  assert.equal(c.used, c.system + c.tools + c.messages);
  assert.ok(c.max > 0, "context window known");
});

test("stats: resuming a session rebuilds counters from assistant usage", async () => {
  const { statsFromMessages } = await import("../src/core/stats.ts");
  const rebuilt = statsFromMessages([
    { role: "user", content: [{ type: "text", text: "go" }] },
    {
      role: "assistant",
      content: [
        { type: "text", text: "reading" },
        { type: "tool_use", id: "t1", name: "Read", input: { file_path: "a" } },
      ],
      stopReason: "tool_use",
      usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 900, cacheCreationTokens: 0 },
    } as never,
    {
      role: "assistant",
      content: [{ type: "text", text: "done" }],
      stopReason: "end_turn",
      usage: { inputTokens: 120, outputTokens: 30, cacheReadTokens: 1000, cacheCreationTokens: 5 },
    } as never,
  ]);
  assert.equal(rebuilt.turns, 2);
  assert.equal(rebuilt.toolCalls, 1);
  assert.equal(rebuilt.steps, 1);
  assert.equal(rebuilt.inputTokens, 220);
  assert.equal(rebuilt.outputTokens, 50);
  assert.equal(rebuilt.cacheReadTokens, 1900);
  assert.equal(rebuilt.cacheCreationTokens, 5);
});


test("stats: tool execution time is accumulated, not left at zero", async () => {
  const ws = mkdtempSync(path.join(os.tmpdir(), "jys-toolms-"));
  const session = new Session({
    workspaceRoot: ws,
    settings: { permissionMode: "bypassPermissions", sandboxMode: "danger-full-access", maxTurns: 3 },
    rules: emptyRuleSet(),
    provider: new MockProvider([
      { text: "sleep", toolCalls: [{ name: "Bash", input: { command: "Start-Sleep -Milliseconds 250" } }] },
      { text: "done", stopReason: "end_turn" },
    ]),
    model: "mock-1",
    logger,
    approve: async () => "allow",
  });
  await session.init();
  for await (const _ of session.send("go", new AbortController().signal)) { /* drain */ }
  assert.ok((session.stats.toolMs ?? 0) >= 150, "toolMs should reflect real tool time: " + session.stats.toolMs);
});

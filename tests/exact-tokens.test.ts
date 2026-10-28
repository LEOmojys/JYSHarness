import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { queryLoop, type HarnessEvent } from "../src/core/query.ts";
import { MockProvider } from "../src/providers/mock.ts";
import { emptyRuleSet } from "../src/permissions/rules.ts";
import { Logger } from "../src/util/log.ts";

const logger = new Logger("error");


test("tokens: the provider's exact count decides the compaction trigger", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "jys-exact-"));
  const provider = new MockProvider([{ text: "SUMMARY-NOTE" }, { text: "done" }]);
  // 让 countTokens 报一个远超阈值的大数，而本地估算很小
  provider.tokensPerRequest = 99_999;
  const events: HarnessEvent[] = [];
  const it = queryLoop({
    provider,
    model: "mock-1",
    systemPrompt: "short",
    // 估算 ~1800 token：正好落在"60% 阈值以上"的区间，才会去问精确值
    messages: [{ role: "user", content: [{ type: "text", text: "T".repeat(6500) }] }],
    tools: [],
    preloadedToolMap: new Map(),
    permission: { mode: "bypassPermissions", rules: emptyRuleSet(), sandboxMode: "workspace-write", workspaceRoot: root },
    toolContext: { workspaceRoot: root, cwd: root, sandbox: { mode: "workspace-write", workspaceRoot: root }, signal: new AbortController().signal, logger, depth: 0 },
    hooks: {},
    logger,
    sessionId: "exact",
    maxTurns: 2,
    maxTokens: 100,
    contextWindow: 4000,
    compaction: { softLimit: 3000, targetTokens: 1600, keepRecentMessages: 6, microcompactAge: 4 },
    countTokens: "auto",
    signal: new AbortController().signal,
    approve: async () => "allow",
  } as never);
  for (;;) {
    const r = await it.next();
    if (r.done) break;
    events.push(r.value);
  }
  assert.ok(
    events.some((e) => e.type === "compaction"),
    "an exact count above the limit must trigger compaction even when the estimate says otherwise",
  );
});

test("tokens: a failing count endpoint falls back to the estimate instead of breaking", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "jys-exact-fail-"));
  const provider = new MockProvider([{ text: "done" }]);
  provider.countTokensFails = true;
  const events: HarnessEvent[] = [];
  const it = queryLoop({
    provider,
    model: "mock-1",
    systemPrompt: "short",
    messages: [{ role: "user", content: [{ type: "text", text: "small" }] }],
    tools: [],
    preloadedToolMap: new Map(),
    permission: { mode: "bypassPermissions", rules: emptyRuleSet(), sandboxMode: "workspace-write", workspaceRoot: root },
    toolContext: { workspaceRoot: root, cwd: root, sandbox: { mode: "workspace-write", workspaceRoot: root }, signal: new AbortController().signal, logger, depth: 0 },
    hooks: {},
    logger,
    sessionId: "exact-fail",
    maxTurns: 2,
    maxTokens: 100,
    contextWindow: 4000,
    compaction: { softLimit: 3000, targetTokens: 1600, keepRecentMessages: 6, microcompactAge: 4 },
    countTokens: "auto",
    signal: new AbortController().signal,
    approve: async () => "allow",
  } as never);
  for (;;) {
    const r = await it.next();
    if (r.done) break;
    events.push(r.value);
  }
  assert.ok(!events.some((e) => e.type === "compaction"), "small context must not compact");
  assert.equal(provider.requests.length, 1, "the turn still completes");
});

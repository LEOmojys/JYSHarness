import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Session } from "../src/core/session.ts";
import { SessionStore } from "../src/session/store.ts";
import { MockProvider, type MockTurn } from "../src/providers/mock.ts";
import { emptyRuleSet } from "../src/permissions/rules.ts";
import { Logger } from "../src/util/log.ts";
import type { Message } from "../src/core/types.ts";
import type { HarnessEvent } from "../src/core/query.ts";
import {
  buildSummaryPrompt,
  compactCheap,
  contextTokens,
  deriveCompaction,
  fitTranscript,
  repairToolPairs,
  snip,
  splitForSummary,
  summarizeTranscript,
  summaryBudgetChars,
} from "../src/context/compaction.ts";

const logger = new Logger("error");
const txt = (t: string) => ({ type: "text" as const, text: t });
const use = (id: string, name = "Read") => ({ type: "tool_use" as const, id, name, input: { file: "a.ts" } });
const res = (id: string, c = "ok") => ({ type: "tool_result" as const, tool_use_id: id, content: c });
const msg = (role: "user" | "assistant", content: unknown[]): Message => ({ role, content: content as Message["content"] });

async function tempWorkspace(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "jys-compact-"));
}

async function makeSession(root: string, turns: MockTurn[], window = 4000) {
  const provider = new MockProvider(turns);
  const session = new Session({
    workspaceRoot: root,
    settings: { permissionMode: "default", sandboxMode: "workspace-write", maxTurns: 10, maxTokens: 4096 },
    rules: emptyRuleSet(),
    provider,
    model: "mock-1",
    logger,
    approve: async () => "allow",
    enableSubagent: false,
  });
  await session.init();
  session.setContextWindow(window);
  return { session, provider };
}

async function collect(gen: AsyncGenerator<HarnessEvent>): Promise<HarnessEvent[]> {
  const out: HarnessEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

/** A history that is over the threshold and has real tool pairs in it. */
function bigHistory(): Message[] {
  const h: Message[] = [msg("user", [txt("TASK: refactor the login flow")])];
  for (let i = 0; i < 14; i++) {
    h.push(msg("assistant", [use("t" + i), txt("step " + i + " " + "x".repeat(900))]));
    h.push(msg("user", [res("t" + i, "output " + i + " " + "y".repeat(900))]));
  }
  return h;
}

test("compaction: thresholds scale with the context window", () => {
  const small = deriveCompaction(8000);
  assert.equal(small.softLimit, 6000);
  assert.equal(small.targetTokens, 3200);
  assert.ok(small.keepRecentMessages < deriveCompaction(200000).keepRecentMessages);
  // 摘要预算必须装得进窗口，否则摘要调用自己就 413。
  assert.ok(summaryBudgetChars(8000) < 14000);
  assert.ok(summaryBudgetChars(200000) <= 120000);
});

test("compaction: pair repair drops orphan results and stubs unanswered calls", () => {
  const broken = [
    msg("user", [txt("hi")]),
    msg("user", [res("ghost")]),
    msg("assistant", [use("n1")]),
    msg("user", [txt("carry on")]),
  ];
  const fixed = repairToolPairs(broken);
  assert.equal(fixed.droppedResults, 1);
  assert.equal(fixed.stubbedUses, 1);
  const flat = fixed.messages.flatMap((m) => m.content.map((b) => b.type));
  assert.ok(!flat.includes("tool_result"), "orphan result must be gone");
  assert.ok(!flat.includes("tool_use"), "unanswered call must be downgraded to text");
  // 没改动的消息保持原对象
  const clean = [msg("user", [txt("a")]), msg("assistant", [txt("b")])];
  assert.equal(repairToolPairs(clean).messages[0], clean[0]);
});

test("compaction: snip keeps the head and never leaves a broken pair", () => {
  const history: Message[] = [msg("user", [txt("TASK")])];
  for (let i = 0; i < 4; i++) {
    history.push(msg("assistant", [use("A" + i)]));
    history.push(msg("user", [txt("out " + i), res("A" + i)]));
  }
  history.push(msg("assistant", [txt("ok")]));
  history.push(msg("user", [txt("next task")]));
  const s = snip(history, 3);
  assert.ok(s.dropped > 0);
  assert.equal(s.messages[0], history[0]);
  const ids = new Set<string>();
  for (const m of s.messages) {
    for (const b of m.content) {
      if (b.type === "tool_use") ids.add(b.id);
      if (b.type === "tool_result") assert.ok(ids.has(b.tool_use_id), "tool_result without its tool_use: " + b.tool_use_id);
    }
  }
});

test("compaction: the summary prompt keeps the newest turns, not just the oldest", () => {
  const huge: Message[] = [msg("user", [txt("OLDEST-INSTRUCTION")])];
  for (let i = 0; i < 60; i++) {
    huge.push(msg("assistant", [txt("step " + i + " " + "y".repeat(3000))]));
    huge.push(msg("user", [txt("result " + i)]));
  }
  huge.push(msg("user", [txt("NEWEST-REQUEST-MARKER")]));
  const prompt = buildSummaryPrompt(huge);
  assert.ok(prompt.includes("OLDEST-INSTRUCTION"));
  assert.ok(prompt.includes("NEWEST-REQUEST-MARKER"), "the current task must survive truncation");
  assert.ok(prompt.includes("step 59"));
  // 预算之外的内容必须有显式省略标记，而不是悄悄消失
  assert.match(prompt, /chars omitted by compaction/);
  const fitted = fitTranscript("A".repeat(1000) + "TAIL-MARKER", 200);
  assert.ok(fitted.endsWith("TAIL-MARKER"));
  assert.ok(fitted.startsWith("AAA"));
});

test("compaction: summary target keeps the recent tail verbatim", () => {
  const history = bigHistory();
  const split = splitForSummary(history, 4);
  assert.ok(split.anchor, "the original task is pinned");
  assert.ok(split.older.length > 0);
  assert.equal(split.tail.length, 4);
  assert.equal(split.older.at(-1), history[split.older.length]);
});

test("compaction: cheap pass only stubs tool noise, keeps everything else", () => {
  const history = bigHistory();
  const cfg = { softLimit: 10, targetTokens: 10, keepRecentMessages: 2, microcompactAge: 2 };
  const cheap = compactCheap(history, cfg);
  assert.ok(cheap.applied[0].startsWith("microcompact"));
  assert.equal(cheap.messages.length, history.length, "L1 must not drop messages");
  // 低于阈值时什么都不做
  const idle = compactCheap(history, { ...cfg, softLimit: 1_000_000 });
  assert.deepEqual(idle.applied, []);
  assert.equal(idle.messages, history);
});

test("loop: live user request survives compaction verbatim", async () => {
  // 触发器是 75% 窗口：fixture 必须先越过它，否则这条测试永远测不到压缩。
  assert.ok(contextTokens(bigHistory()) > 3000, "fixture must exceed softLimit(4000*0.75)");
  const root = await tempWorkspace();
  const { session, provider } = await makeSession(root, [{ text: "SUMMARY-NOTE" }, { text: "final answer" }]);
  session.messages = bigHistory();
  const events = await collect(session.send("LIVE-REQUEST: fix auth.ts timeout now", new AbortController().signal));

  // 阶梯是分开上报的：micro 一条、summarize 一条。
  const compactions = events.filter((e) => e.type === "compaction");
  assert.ok(
    compactions.some((c) => c.applied.some((a) => a.startsWith("summarize"))),
    "should summarise, got " + compactions.map((c) => c.applied.join("+")).join(" / "),
  );

  const real = provider.requests[provider.requests.length - 1];
  const text = JSON.stringify(real.messages);
  assert.ok(text.includes("LIVE-REQUEST"), "the newest user message must reach the model verbatim");
  assert.ok(text.includes("SUMMARY-NOTE"), "the handoff note must be attached");
  assert.ok(text.includes("TASK: refactor the login flow"), "the original goal is pinned");

  // 线上格式不能有孤儿配对
  const ids = new Set<string>();
  for (const m of real.messages) {
    for (const b of m.content) {
      if (b.type === "tool_use") ids.add(b.id);
      if (b.type === "tool_result") assert.ok(ids.has(b.tool_use_id), "orphan tool_result " + b.tool_use_id);
    }
  }
});

test("loop: a summary failure falls back to dropping turns instead of dying", async () => {
  const root = await tempWorkspace();
  const { session, provider } = await makeSession(root, [
    { error: { kind: "model_error", message: "synthetic" } },
    { text: "final answer" },
  ]);
  session.messages = bigHistory();
  const events = await collect(session.send("go", new AbortController().signal));
  const done = events.find((e) => e.type === "done");
  assert.equal(done?.type === "done" ? done.reason : null, "completed");
  assert.ok(events.some((e) => e.type === "notice" && e.text.includes("summary failed")));
  assert.ok(events.some((e) => e.type === "compaction" && e.applied[0].startsWith("snip")));
  assert.ok(provider.requests.length >= 2);
});

test("compactNow: /compact really summarises, persists, and resumes compacted", async () => {
  const root = await tempWorkspace();
  const { session } = await makeSession(root, [{ text: "HANDOFF-NOTE" }]);
  session.messages = bigHistory();
  const before = session.contextTokens();
  const result = await session.compactNow("keep the API details");
  assert.ok(result.applied.some((a) => a.startsWith("summarize")), result.applied.join(","));
  assert.ok(result.after < before);
  assert.ok(JSON.stringify(session.messages).includes("HANDOFF-NOTE"));

  // 落盘：最后一行是 compact 检查点
  const store = new SessionStore(path.join(root, ".harness", "sessions"));
  const loaded = await store.load(session.sessionId);
  assert.ok(JSON.stringify(loaded.messages).includes("HANDOFF-NOTE"), "resume must use the compacted view");
  assert.equal(loaded.messages.length, session.messages.length);
});

test("compactNow: a small conversation is left alone instead of being destroyed", async () => {
  const root = await tempWorkspace();
  const { session, provider } = await makeSession(root, [{ text: "unused" }]);
  session.messages = [msg("user", [txt("hi")]), msg("assistant", [txt("hello")])];
  const result = await session.compactNow();
  assert.deepEqual(result.applied, []);
  assert.equal(provider.requests.length, 0, "no model call for nothing");
  assert.equal(session.messages.length, 2);
});

test("summarizeTranscript: returns null when the provider fails", async () => {
  const provider = new MockProvider([{ error: { kind: "auth", message: "no key" } }]);
  const out = await summarizeTranscript(provider, "mock-1", [msg("user", [txt("x")])]);
  assert.equal(out, null);
});

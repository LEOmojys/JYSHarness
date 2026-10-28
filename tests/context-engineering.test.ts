import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { Session } from "../src/core/session.ts";
import { queryLoop, type HarnessEvent } from "../src/core/query.ts";
import { MockProvider } from "../src/providers/mock.ts";
import { emptyRuleSet } from "../src/permissions/rules.ts";
import { Logger } from "../src/util/log.ts";
import { addMemory, readMemoryEntries } from "../src/core/memory.ts";
import { buildSystemPrompt } from "../src/context/systemPrompt.ts";
import { buildDefaultRegistry } from "../src/tools/index.ts";

const logger = new Logger("error");

async function makeSession(root: string, turns: { text: string }[]) {
  const provider = new MockProvider(turns);
  const session = new Session({
    workspaceRoot: root,
    settings: { permissionMode: "bypassPermissions", sandboxMode: "workspace-write", maxTurns: 4, maxTokens: 256 },
    rules: emptyRuleSet(),
    provider,
    model: "mock-1",
    logger,
    approve: async () => "allow",
    enableSubagent: false,
  });
  await session.init();
  return { session, provider };
}

async function drain(gen: AsyncGenerator<HarnessEvent, void>) {
  for await (const _ev of gen) {
    /* drain */
  }
}

test("context: project rules and memory edited mid-session take effect on the next turn", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "jys-ctx-refresh-"));
  const { session, provider } = await makeSession(root, [{ text: "a" }, { text: "b" }]);

  await drain(session.send("first", new AbortController().signal));
  assert.ok(!provider.requests[0].system.includes("MID-SESSION-RULE"), "not written yet");

  writeFileSync(path.join(root, "AGENTS.md"), "MID-SESSION-RULE: always run tests", "utf8");
  addMemory(root, "MID-SESSION-MEMORY: deploy via package.ps1");
  await drain(session.send("second", new AbortController().signal));

  const second = provider.requests[1].system;
  assert.ok(second.includes("MID-SESSION-RULE"), "AGENTS.md must be picked up without a restart");
  assert.ok(second.includes("MID-SESSION-MEMORY"), "memory must be picked up without a restart");
});

test("context: volatile state sits at the very end so the cache prefix stays stable", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "jys-ctx-order-"));
  mkdirSync(path.join(root, ".harness"), { recursive: true });
  writeFileSync(path.join(root, "AGENTS.md"), "RULES", "utf8");
  addMemory(root, "a remembered fact");
  const prompt = buildSystemPrompt({
    workspaceRoot: root,
    cwd: root,
    model: "mock-1",
    toolNames: ["Read"],
    sandboxMode: "workspace-write",
    permissionMode: "default",
  });
  const iEnv = prompt.indexOf("<environment>");
  const iDocs = prompt.indexOf("<project_instructions");
  const iMemory = prompt.indexOf("<memory>");
  assert.ok(iEnv > 0 && iDocs > iEnv && iMemory > iDocs, [iEnv, iDocs, iMemory].join(","));
  // 关键：系统提示里**不能有任何每轮会变的东西**（日期、git）——
  // 它带着 cache_control，一变就把整条前缀（tools+system+全部消息）的缓存冲掉。
  assert.ok(!prompt.includes("<runtime>"), "volatile state must not live in the system prompt");
  assert.ok(!/git: branch=/.test(prompt), "git status must not live in the system prompt");
  assert.ok(!/date: \d{4}-/.test(prompt), "date must not live in the system prompt");
});

test("context: volatile runtime travels with the newest message, not the system prompt", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "jys-ctx-runtime-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "t@e.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "T"], { cwd: root });
  writeFileSync(path.join(root, "a.txt"), "x", "utf8");
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: root });

  const { session, provider } = await makeSession(root, [{ text: "a" }, { text: "b" }]);
  await drain(session.send("first", new AbortController().signal));
  writeFileSync(path.join(root, "b.txt"), "y", "utf8"); // git 变脏
  await drain(session.send("second", new AbortController().signal));

  const [r1, r2] = provider.requests;
  assert.equal(r1.system, r2.system, "the system prompt must stay byte-identical across turns");
  assert.ok(!r2.system.includes("<runtime>"));
  // 易变部分出现在最后一条消息里
  const last = r2.messages[r2.messages.length - 1];
  const text = JSON.stringify(last);
  assert.match(text, /<runtime>/);
  assert.match(text, /modified file/);
  // 但没有污染转录
  assert.ok(!JSON.stringify(session.messages).includes("<runtime>"), "ephemeral context must not be persisted");
});

function compactionCount(events: HarnessEvent[]): number {
  return events.filter((e) => e.type === "compaction").length;
}

async function runLoop(opts: { messageChars: number; tools: boolean; lastInput?: number }) {
  const root = mkdtempSync(path.join(os.tmpdir(), "jys-ctx-budget-"));
  const all = buildDefaultRegistry({ enableSubagent: false }).assemble();
  const tools = opts.tools ? all : [];
  const provider = new MockProvider([{ text: "SUMMARY-NOTE" }, { text: "done" }]);
  const events: HarnessEvent[] = [];
  const it = queryLoop({
    provider,
    model: "mock-1",
    systemPrompt: "S".repeat(2000),
    messages: [{ role: "user", content: [{ type: "text", text: "T".repeat(opts.messageChars) }] }],
    tools,
    preloadedToolMap: new Map(tools.map((t) => [t.name, t])),
    permission: { mode: "bypassPermissions", rules: emptyRuleSet(), sandboxMode: "workspace-write", workspaceRoot: root },
    toolContext: { workspaceRoot: root, cwd: root, sandbox: { mode: "workspace-write", workspaceRoot: root }, signal: new AbortController().signal, logger, depth: 0 },
    hooks: {},
    logger,
    sessionId: "budget",
    maxTurns: 2,
    maxTokens: 100,
    contextWindow: 4000,
    compaction: { softLimit: 3000, targetTokens: 1600, keepRecentMessages: 6, microcompactAge: 4 },
    // 这条用例只验证"估算是否计入 system+tools"，把精确计数关掉，
    // 否则服务商计数会覆盖估算、测的就不是同一件事了。
    countTokens: "off",
    signal: new AbortController().signal,
    approve: async () => "allow",
  } as never);
  for (;;) {
    const r = await it.next();
    if (r.done) break;
    events.push(r.value);
  }
  return events;
}

test("compaction: the trigger counts the system prompt and tool schemas, not just messages", async () => {
  // 消息本身 ~1900 token（低于 softLimit 3000），但 system+tools 再占 ~1850
  const withTools = await runLoop({ messageChars: 7000, tools: true });
  assert.ok(compactionCount(withTools) > 0, "overhead must push it over the limit");
  // 同样消息，没有工具定义时应低于阈值
  const withoutTools = await runLoop({ messageChars: 7000, tools: false });
  assert.equal(compactionCount(withoutTools), 0, "without tool overhead the same history fits");
});

test("context: memory is deduped, bounded and forgettable", async () => {
  const { forgetMemory, MAX_MEMORY_CHARS, memorySection } = await import("../src/core/memory.ts");
  const root = mkdtempSync(path.join(os.tmpdir(), "jys-ctx-mem-"));
  addMemory(root, "same fact");
  addMemory(root, "same fact");
  assert.equal(readMemoryEntries(root).length, 1, "duplicates collapse");

  assert.equal(forgetMemory(root, "same").removed, 1, "forget removes by substring");
  assert.equal(forgetMemory(root, "nothing-matches-this").removed, 0, "no false success");

  // 预算：灌满之后必须淘汰最旧的，且总量受控
  for (let i = 0; i < 40; i++) addMemory(root, "fact " + i + " " + "x".repeat(300));
  assert.ok((memorySection(root)?.length ?? 0) <= MAX_MEMORY_CHARS + 400, "memory stays within budget");
  const kept = readMemoryEntries(root);
  assert.ok(kept.length < 40, "old entries get evicted");
  assert.ok(kept[kept.length - 1].text.startsWith("fact 39"), "the newest entry survives");
});

test("calibration: the estimator learns from real usage and drives the trigger", async () => {
  const { TokenCalibrator } = await import("../src/util/tokens.ts");
  const c = new TokenCalibrator();
  assert.equal(c.factor(), 1, "no samples -> neutral");
  c.record(1000, 3000);
  c.record(1000, 3000);
  assert.equal(c.factor(), 1, "two samples are not enough");
  c.record(1000, 3000);
  assert.equal(c.factor(), 2, "clamped at 2x");
  // 夹取：估算偏 10 倍也不能让压缩疯狂触发
  const wild = new TokenCalibrator();
  for (let i = 0; i < 5; i++) wild.record(100, 10_000);
  assert.equal(wild.factor(), 2);
  // 低估方向同样夹取
  const cheap = new TokenCalibrator();
  for (let i = 0; i < 5; i++) cheap.record(10_000, 1);
  assert.equal(cheap.factor(), 0.5);
  assert.equal(c.stats().samples, 3);
});

test("calibration: the session feeds real usage back into the calibrator", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "jys-cal-"));
  const provider = new MockProvider([{ text: "a" }, { text: "b" }, { text: "c" }, { text: "d" }]);
  const session = new Session({
    workspaceRoot: root,
    settings: { permissionMode: "bypassPermissions", sandboxMode: "workspace-write", maxTurns: 3, maxTokens: 256 },
    rules: emptyRuleSet(),
    provider,
    model: "mock-1",
    logger,
    approve: async () => "allow",
    enableSubagent: false,
  });
  await session.init();
  for (let i = 0; i < 4; i++) await drain(session.send("turn " + i, new AbortController().signal));
  const stats = session.calibrator.stats();
  assert.ok(stats.samples >= 3, "each response with usage must feed the calibrator: " + JSON.stringify(stats));
  assert.ok(stats.factor >= 0.5 && stats.factor <= 2, "factor is clamped: " + stats.factor);
});

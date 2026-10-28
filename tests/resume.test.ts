import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, appendFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionStore } from "../src/session/store.ts";
import type { ContentBlock } from "../src/core/types.ts";
import { Session } from "../src/core/session.ts";
import { MockProvider } from "../src/providers/mock.ts";
import { emptyRuleSet } from "../src/permissions/rules.ts";
import { Logger } from "../src/util/log.ts";

const logger = new Logger("error");

/** 取一条消息里的纯文本：只有 text 块有 text 字段，必须收窄（不是强转）。 */
function textOf(message: { content: ContentBlock[] }, index = 0): string {
  const block = message.content[index];
  return block && block.type === "text" ? block.text : "";
}

function metaFor(id: string, root: string) {
  return {
    id,
    createdAt: new Date().toISOString(),
    cwd: root,
    workspaceRoot: root,
    model: "mock-1",
    provider: "mock",
    permissionMode: "bypassPermissions",
    sandboxMode: "workspace-write",
  };
}

function makeSession(root: string, turns: unknown[], opts: Record<string, unknown> = {}) {
  const store = new SessionStore(path.join(root, ".harness", "sessions"));
  const session = new Session({
    workspaceRoot: root,
    settings: { permissionMode: "bypassPermissions", sandboxMode: "workspace-write", maxTurns: 6, maxTokens: 256 },
    rules: emptyRuleSet(),
    provider: new MockProvider(turns as never),
    model: "mock-1",
    logger,
    approve: async () => "allow",
    enableSubagent: false,
    store,
    ...opts,
  });
  return { session, store };
}

async function drain(gen: AsyncGenerator<unknown, void>) {
  for await (const _ev of gen) {
    /* drain */
  }
}

test("resume: the transcript round-trips through the JSONL file", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "jys-resume-rt-"));
  const first = makeSession(root, [{ text: "hello from turn one" }, { text: "turn two" }]);
  await first.session.init();
  await drain(first.session.send("first", new AbortController().signal));
  await drain(first.session.send("second", new AbortController().signal));
  const id = first.session.sessionId;

  const loaded = await first.store.load(id);
  assert.ok(loaded.meta, "meta is written");
  assert.equal(loaded.messages.length, 4, "2 user + 2 assistant");

  // 新会话用同一份历史恢复，并**复用同一个 session id**（bootstrap 就是这么做的，
  // 否则恢复出来的对话会写到新文件里，老会话看起来没变化）
  const resumed = makeSession(root, [{ text: "after resume" }], { resumeMessages: loaded.messages, sessionId: id });
  await resumed.session.init();
  assert.deepEqual(
    resumed.session.messages.map((m) => m.role),
    ["user", "assistant", "user", "assistant"],
    "history is restored verbatim",
  );
  await drain(resumed.session.send("third", new AbortController().signal));
  const after = await resumed.store.load(id);
  assert.equal(textOf(after.messages[after.messages.length - 2]), "third");
  assert.equal(textOf(after.messages[after.messages.length - 1]), "after resume");
});

test("resume: a compaction checkpoint replaces the prefix, later messages append", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "jys-resume-compact-"));
  const store = new SessionStore(path.join(root, ".harness", "sessions"));
  const id = "compact-case";
  await store.init();
  await store.create(metaFor(id, root));
  const user = (t: string) => ({ role: "user" as const, content: [{ type: "text" as const, text: t }] });
  const assistant = (t: string) => ({ role: "assistant" as const, content: [{ type: "text" as const, text: t }] });

  await store.append(id, user("old-1"));
  await store.append(id, assistant("old-2"));
  await store.appendCompact(id, [user("[summary of old work]"), assistant("ack")], 2);
  await store.append(id, user("new-1"));

  const loaded = await store.load(id);
  const texts = loaded.messages.map((m) => textOf(m));
  assert.deepEqual(texts, ["[summary of old work]", "ack", "new-1"]);
  assert.ok(!texts.includes("old-1"), "the pre-compaction prefix is not replayed");

  // 第二次压缩同样以最新的检查点为准
  await store.appendCompact(id, [user("[second summary]")], 3);
  const twice = await store.load(id);
  assert.deepEqual(twice.messages.map((m) => textOf(m)), ["[second summary]"]);
});

test("resume: torn and corrupt lines are skipped, valid history survives", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "jys-resume-torn-"));
  const store = new SessionStore(path.join(root, ".harness", "sessions"));
  const id = "torn";
  await store.init();
  await store.create(metaFor(id, root));
  await store.append(id, { role: "user", content: [{ type: "text", text: "keep me" }] });
  const file = path.join(root, ".harness", "sessions", id + ".jsonl");
  appendFileSync(file, '{"type":"message","message":{"role":"user","content":[{"type":"te', "utf8");
  assert.equal((await store.load(id)).messages.length, 1, "a torn tail is dropped");

  // 中间插入坏行
  const NL = String.fromCharCode(10);
  const lines = readFileSync(file, "utf8").split(NL);
  lines.splice(1, 0, "}{ not json");
  writeFileSync(file, lines.join(NL), "utf8");
  assert.equal((await store.load(id)).messages.length, 1, "a corrupt middle line is skipped");
});

test("resume: a failing disk does not kill the turn", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "jys-resume-badstore-"));
  const { session, store } = makeSession(root, [{ text: "answer one" }, { text: "answer two" }]);
  await session.init();
  // 让之后的每次 append 都失败（模拟磁盘满 / 目录被删）
  const original = store.append.bind(store);
  (store as unknown as { append: unknown }).append = async () => {
    throw new Error("ENOSPC: no space left on device");
  };

  await drain(session.send("turn", new AbortController().signal));
  assert.ok(session.messages.length >= 2, "the turn still produced messages");
  assert.equal(session.persistWarnings.length, 1, "one deduplicated warning");
  assert.match(session.persistWarnings[0], /没有落盘/);

  // 第二轮继续可用，且告警不再重复堆积
  await drain(session.send("again", new AbortController().signal));
  assert.equal(session.persistWarnings.length, 1);

  (store as unknown as { append: unknown }).append = original;
});

test("resume: the session list skips empty sessions and orders by creation", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "jys-resume-list-"));
  const store = new SessionStore(path.join(root, ".harness", "sessions"));
  await store.init();
  await store.create(metaFor("empty-one", root)); // 只有 meta，没有 prompt
  await store.create({ ...metaFor("with-prompt", root), createdAt: "2030-01-01T00:00:00.000Z" });
  await store.append("with-prompt", { role: "user", content: [{ type: "text", text: "hello there" }] });

  const list = await store.list();
  assert.equal(list.length, 1, "sessions without a prompt are noise");
  assert.equal(list[0].id, "with-prompt");
  assert.match(list[0].preview, /hello there/);
});

test("resume: a deleted session leaves nothing behind", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "jys-resume-del-"));
  const store = new SessionStore(path.join(root, ".harness", "sessions"));
  await store.init();
  await store.create(metaFor("gone", root));
  await store.append("gone", { role: "user", content: [{ type: "text", text: "x" }] });
  await store.saveTranscript("gone", []);
  const dir = path.join(root, ".harness", "sessions");
  assert.ok(existsSync(path.join(dir, "gone.jsonl")));

  assert.equal(await store.remove("gone"), true);
  assert.equal(existsSync(path.join(dir, "gone.jsonl")), false);
  assert.ok(!(await import("node:fs")).readdirSync(dir).some((f) => f.startsWith("gone.transcript-")));
  assert.equal(await store.remove("gone"), false, "removing twice reports honestly");
});

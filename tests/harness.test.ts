import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Session } from "../src/core/session.ts";
import { MockProvider, type MockTurn } from "../src/providers/mock.ts";
import { decidePermission } from "../src/permissions/engine.ts";
import { emptyRuleSet, parseRule, addRules } from "../src/permissions/rules.ts";
import { guardPath, isInside, realResolve } from "../src/sandbox/paths.ts";
import { compactLocally, microcompact, snip } from "../src/context/compaction.ts";
import { partitionCalls, prepareCall } from "../src/tools/registry.ts";
import { buildDefaultRegistry } from "../src/tools/index.ts";
import { Logger } from "../src/util/log.ts";
import type { Message } from "../src/core/types.ts";
import type { HarnessEvent } from "../src/core/query.ts";

const logger = new Logger("error");

async function tempWorkspace(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "mh-test-"));
}

function ctx(overrides: Partial<Parameters<typeof decidePermission>[1]> = {}) {
  return {
    mode: "default" as const,
    rules: emptyRuleSet(),
    sandboxMode: "workspace-write" as const,
    workspaceRoot: process.cwd(),
    ...overrides,
  };
}

test("hardcoded denials cannot be allowed by rules", () => {
  const rules = emptyRuleSet();
  addRules(rules, [parseRule("Bash", "allow", "cli")!]);
  const d = decidePermission(
    { toolName: "Bash", input: { command: "rm -rf / --no-preserve-root" }, isReadOnly: false },
    ctx({ rules }),
  );
  assert.equal(d.behavior, "deny");
  assert.equal(d.reason, "hardcoded_deny");
});

test("deny rules beat allow rules regardless of order", () => {
  const rules = emptyRuleSet();
  addRules(rules, [parseRule("Bash(git *)", "allow", "user")!, parseRule("Bash(git push *)", "deny", "project")!]);
  const d = decidePermission(
    { toolName: "Bash", input: { command: "git push origin main" }, isReadOnly: false },
    ctx({ rules }),
  );
  assert.equal(d.behavior, "deny");
  assert.equal(d.matchedRule?.ruleValue.ruleContent, "git push *");
});

test("acceptEdits auto-approves edits but not shell", () => {
  const edit = decidePermission(
    { toolName: "Edit", input: { file_path: "a.ts" }, isReadOnly: false },
    ctx({ mode: "acceptEdits" }),
  );
  assert.equal(edit.behavior, "allow");
  const shell = decidePermission(
    { toolName: "Bash", input: { command: "npm test" }, isReadOnly: false },
    ctx({ mode: "acceptEdits" }),
  );
  assert.equal(shell.behavior, "ask");
});

test("plan mode denies writes, allows reads", () => {
  const write = decidePermission(
    { toolName: "Write", input: { file_path: "a.ts" }, isReadOnly: false },
    ctx({ mode: "plan" }),
  );
  assert.equal(write.behavior, "deny");
  const read = decidePermission(
    { toolName: "Read", input: { file_path: "a.ts" }, isReadOnly: true },
    ctx({ mode: "plan" }),
  );
  assert.equal(read.behavior, "allow");
});

test("read-only sandbox blocks writes and path escape asks", () => {
  const root = realResolve(os.tmpdir());
  const policy = { mode: "read-only" as const, workspaceRoot: root };
  const inside = guardPath(path.join(root, "x.txt"), { access: "write", policy });
  assert.equal(inside.decision?.behavior, "deny");
  const outside = guardPath(path.join(root, "..", "escape.txt"), { access: "read", policy });
  assert.equal(outside.decision?.behavior, "ask");
  assert.ok(isInside(root, path.join(root, "a", "b")));
});

test("tool partitioning groups reads and isolates writes", () => {
  const registry = buildDefaultRegistry();
  const lookup = { get: (n: string) => registry.get(n), names: () => registry.names() };
  const calls = [
    prepareCall(lookup, { id: "1", name: "Read", input: { file_path: "a" } }),
    prepareCall(lookup, { id: "2", name: "Read", input: { file_path: "b" } }),
    prepareCall(lookup, { id: "3", name: "Write", input: { file_path: "c", content: "x" } }),
    prepareCall(lookup, { id: "4", name: "Read", input: { file_path: "d" } }),
  ];
  const batches = partitionCalls(calls);
  assert.equal(batches.length, 3);
  assert.equal(batches[0].concurrencySafe, true);
  assert.equal(batches[0].calls.length, 2);
  assert.equal(batches[1].concurrencySafe, false);
  assert.equal(batches[2].calls.length, 1);
});

test("unknown tool becomes an error result, not a crash", () => {
  const registry = buildDefaultRegistry();
  const call = prepareCall(registry, { id: "x", name: "Nope", input: {} });
  assert.ok(call.errorResult?.isError);
  assert.match(call.errorResult!.content, /No such tool/);
});

test("microcompact stubs old tool output, snip keeps the head", () => {
  const messages: Message[] = [];
  for (let i = 0; i < 10; i++) {
    messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: "t" + i, content: "x".repeat(2000) }] });
  }
  const micro = microcompact(messages, 2);
  assert.ok(micro.stubbed > 0);
  assert.match(String((micro.messages[0].content[0] as { content: string }).content), /elided/);

  const snipped = snip(messages, 3);
  assert.ok(snipped.dropped > 0);
  assert.equal(snipped.messages[0], messages[0]);
  assert.ok(snipped.messages.length < messages.length);

  const outcome = compactLocally(messages, { softLimit: 10, targetTokens: 10, keepRecentMessages: 2, microcompactAge: 2 });
  assert.ok(outcome.tokensAfter < outcome.tokensBefore);
});

async function collect(gen: AsyncGenerator<HarnessEvent>): Promise<HarnessEvent[]> {
  const events: HarnessEvent[] = [];
  for await (const ev of gen) events.push(ev);
  return events;
}

async function makeSession(root: string, turns: MockTurn[], opts: { approve?: boolean; mode?: string } = {}) {
  const provider = new MockProvider(turns);
  const session = new Session({
    workspaceRoot: root,
    settings: {
      permissionMode: (opts.mode as never) ?? "default",
      sandboxMode: "workspace-write",
      maxTurns: 10,
      maxTokens: 4096,
    },
    rules: emptyRuleSet(),
    provider,
    model: "mock-1",
    logger,
    approve: async () => (opts.approve === false ? "deny" : "allow"),
    enableSubagent: true,
  });
  await session.init();
  return { session, provider };
}

test("end-to-end: tool calls execute and final text is produced", async () => {
  const root = await tempWorkspace();
  await writeFile(path.join(root, "README.md"), "# readme", "utf8");
  const turns: MockTurn[] = [
    { text: "reading", toolCalls: [{ name: "Read", input: { file_path: "README.md" } }] },
    {
      text: "writing",
      toolCalls: [{ name: "Write", input: { file_path: "out/result.md", content: "hello harness" } }],
    },
    { text: "all done", stopReason: "end_turn" },
  ];
  const { session } = await makeSession(root, turns);
  const events = await collect(session.send("do the thing", new AbortController().signal));

  const toolEnds = events.filter((e) => e.type === "tool_end");
  assert.equal(toolEnds.length, 2);
  assert.ok(toolEnds.every((e) => !e.result.isError));
  const done = events.find((e) => e.type === "done");
  assert.equal(done?.type === "done" ? done.reason : null, "completed");
  const written = await readFile(path.join(root, "out/result.md"), "utf8");
  assert.equal(written, "hello harness");
  assert.ok(session.messages.length >= 5);
});

test("end-to-end: dangerous command is denied and reported to the model", async () => {
  const root = await tempWorkspace();
  const turns: MockTurn[] = [
    { text: "trying", toolCalls: [{ name: "Bash", input: { command: "rm -rf /" } }] },
    { text: "understood", stopReason: "end_turn" },
  ];
  const { session } = await makeSession(root, turns);
  const events = await collect(session.send("delete everything", new AbortController().signal));
  const toolEnd = events.find((e) => e.type === "tool_end");
  assert.ok(toolEnd && toolEnd.type === "tool_end");
  assert.equal(toolEnd.result.isError, true);
  assert.match(toolEnd.result.content, /denied|Blocked/i);
});

test("end-to-end: user denial produces a tool_result error, not a crash", async () => {
  const root = await tempWorkspace();
  const turns: MockTurn[] = [
    { text: "writing", toolCalls: [{ name: "Write", input: { file_path: "x.txt", content: "nope" } }] },
    { text: "ok", stopReason: "end_turn" },
  ];
  const { session } = await makeSession(root, turns, { approve: false });
  const events = await collect(session.send("write", new AbortController().signal));
  const toolEnd = events.find((e) => e.type === "tool_end");
  assert.ok(toolEnd && toolEnd.type === "tool_end");
  assert.equal(toolEnd.result.isError, true);
  assert.match(toolEnd.result.content, /Permission denied/);
  await assert.rejects(readFile(path.join(root, "x.txt"), "utf8"));
});

test("sessions persist to JSONL and reload", async () => {
  const root = await tempWorkspace();
  const turns: MockTurn[] = [{ text: "hello", stopReason: "end_turn" }];
  const { session } = await makeSession(root, turns);
  await collect(session.send("hi", new AbortController().signal));
  const list = await session.store.list();
  assert.equal(list.length, 1);
  const loaded = await session.store.load(session.sessionId);
  assert.equal(loaded.meta?.model, "mock-1");
  assert.equal(loaded.messages[0].role, "user");
});

test("max_turns terminates a runaway loop", async () => {
  const root = await tempWorkspace();
  const loopTurns: MockTurn[] = Array.from({ length: 5 }, (_, i) => ({
    text: "loop " + i,
    toolCalls: [{ name: "Glob", input: { pattern: "*.none" } }],
  }));
  const { session } = await makeSession(root, loopTurns);
  const events = await collect(session.send("loop forever", new AbortController().signal));
  const done = events.find((e) => e.type === "done");
  assert.ok(done && done.type === "done");
  assert.ok(["completed", "blocking_limit"].includes(done.reason));
});

test("sub-agent runs in an isolated context and returns a summary", async () => {
  const root = await tempWorkspace();
  const turns: MockTurn[] = [
    {
      text: "delegating",
      toolCalls: [{ name: "Agent", input: { description: "explore", prompt: "list markdown files" } }],
    },
    { text: "child: found 1 markdown file", stopReason: "end_turn" },
    { text: "parent done", stopReason: "end_turn" },
  ];
  const { session } = await makeSession(root, turns);
  const events = await collect(session.send("delegate", new AbortController().signal));
  const toolEnd = events.find((e) => e.type === "tool_end" && e.name === "Agent");
  assert.ok(toolEnd && toolEnd.type === "tool_end");
  assert.match(toolEnd.result.content, /subagent_result/);
  assert.match(toolEnd.result.content, /child: found 1 markdown file/);
});

test("read-only sandbox refuses writes at tool level", async () => {
  const root = await tempWorkspace();
  const provider = new MockProvider([
    { text: "w", toolCalls: [{ name: "Write", input: { file_path: "a.txt", content: "x" } }] },
    { text: "done", stopReason: "end_turn" },
  ]);
  const session = new Session({
    workspaceRoot: root,
    settings: { permissionMode: "bypassPermissions", sandboxMode: "read-only", maxTurns: 5 },
    rules: emptyRuleSet(),
    provider,
    model: "mock-1",
    logger,
    approve: async () => "allow",
  });
  await session.init();
  const events = await collect(session.send("write", new AbortController().signal));
  const toolEnd = events.find((e) => e.type === "tool_end");
  assert.ok(toolEnd && toolEnd.type === "tool_end");
  assert.equal(toolEnd.result.isError, true);
  assert.match(toolEnd.result.content, /read-only/i);
});

test("file edit requires unique match unless replace_all", async () => {
  const root = await tempWorkspace();
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src/a.ts"), "const a = 1;\nconst a = 1;\n", "utf8");
  const provider = new MockProvider([
    { text: "e", toolCalls: [{ name: "Edit", input: { file_path: "src/a.ts", old_string: "const a = 1;", new_string: "const a = 2;" } }] },
    { text: "e", toolCalls: [{ name: "Edit", input: { file_path: "src/a.ts", old_string: "const a = 1;", new_string: "const a = 2;", replace_all: true } }] },
    { text: "done", stopReason: "end_turn" },
  ]);
  const session = new Session({
    workspaceRoot: root,
    settings: { permissionMode: "acceptEdits", sandboxMode: "workspace-write", maxTurns: 5 },
    rules: emptyRuleSet(),
    provider,
    model: "mock-1",
    logger,
    approve: async () => "allow",
  });
  await session.init();
  const events = await collect(session.send("edit", new AbortController().signal));
  const ends = events.filter((e) => e.type === "tool_end");
  assert.equal(ends.length, 2);
  const first = ends[0];
  const second = ends[1];
  assert.ok(first.type === "tool_end" && first.result.isError, "ambiguous edit must fail");
  assert.ok(second.type === "tool_end" && !second.result.isError, "replace_all must succeed");
  const content = await readFile(path.join(root, "src/a.ts"), "utf8");
  assert.equal(content, "const a = 2;\nconst a = 2;\n");
});

test("PreToolUse hook can block a call end-to-end", async () => {
  const root = await tempWorkspace();
  const hookPath = path.resolve("examples/hooks/guard-secrets.mjs");
  const provider = new MockProvider([
    { text: "w", toolCalls: [{ name: "Write", input: { file_path: ".env", content: "SECRET=1" } }] },
    { text: "ok", stopReason: "end_turn" },
  ]);
  const session = new Session({
    workspaceRoot: root,
    settings: { permissionMode: "bypassPermissions", sandboxMode: "workspace-write", maxTurns: 5 },
    rules: emptyRuleSet(),
    provider,
    model: "mock-1",
    logger,
    approve: async () => "allow",
    hooks: {
      PreToolUse: [{ matcher: "Write|Edit", command: process.execPath + " " + hookPath, timeoutMs: 10_000 }],
    },
  });
  await session.init();
  const events = await collect(session.send("write secrets", new AbortController().signal));
  const toolEnd = events.find((e) => e.type === "tool_end");
  assert.ok(toolEnd && toolEnd.type === "tool_end");
  assert.equal(toolEnd.result.isError, true);
  assert.match(toolEnd.result.content, /Blocked by PreToolUse hook/);
});

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

test("plan mode is read-only for shell tools too", () => {
  // shell 既不在 WRITE_TOOLS、也没有 isDestructive：旧判据会把它直接放行，
  // 于是 plan 模式下 `echo x > file` 能改文件 —— 只读承诺是假的。
  for (const [toolName, input] of [
    ["Bash", { command: "echo hi > out.txt" }],
    ["PowerShell", { command: "Set-Content out.txt hi" }],
    ["JobKill", { job_id: "j1" }],
  ] as const) {
    const d = decidePermission(
      { toolName, input: input as Record<string, unknown>, isReadOnly: false },
      ctx({ mode: "plan" }),
    );
    assert.equal(d.behavior, "deny", toolName + " -> " + d.behavior);
    assert.equal(d.reason, "mode_plan_deny", toolName);
  }
});

test("dontAsk auto-denies approvals but still allows read-only tools", () => {
  // dontAsk 的语义是"需要问的自动拒绝"，只读工具不需要问。
  const read = decidePermission(
    { toolName: "Read", input: { file_path: "a.ts" }, isReadOnly: true },
    ctx({ mode: "dontAsk" }),
  );
  assert.equal(read.behavior, "allow");
  const shell = decidePermission(
    { toolName: "Bash", input: { command: "ls" }, isReadOnly: false },
    ctx({ mode: "dontAsk" }),
  );
  assert.equal(shell.behavior, "deny");
  assert.equal(shell.reason, "mode_dont_ask");
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
  // 真实形状：一条用户任务 + 若干 (assistant tool_use → user tool_result) 配对。
  const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "TASK: fix login" }] }];
  for (let i = 0; i < 10; i++) {
    messages.push({ role: "assistant", content: [{ type: "tool_use", id: "t" + i, name: "Read", input: { file: "f" + i } }] });
    messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: "t" + i, content: "x".repeat(2000) }] });
  }
  const micro = microcompact(messages, 2);
  assert.ok(micro.stubbed > 0);
  assert.match(String((micro.messages[2].content[0] as { content: string }).content), /elided/);

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

async function makeSession(root: string, turns: MockTurn[], opts: { approve?: boolean; mode?: string; maxTurns?: number } = {}) {
  const provider = new MockProvider(turns);
  const session = new Session({
    workspaceRoot: root,
    settings: {
      permissionMode: (opts.mode as never) ?? "default",
      sandboxMode: "workspace-write",
      maxTurns: opts.maxTurns ?? 10,
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

test("agent loop: unchanged repeated calls and near-budget runs get a convergence nudge", async () => {
  const root = await tempWorkspace();
  await writeFile(path.join(root, "target.txt"), "same result", "utf8");
  const repeatedRead = { name: "Read", input: { file_path: "target.txt" } };
  const turns: MockTurn[] = [
    { text: "inspect", toolCalls: [repeatedRead] },
    { text: "inspect again", toolCalls: [repeatedRead] },
    { text: "inspect once more", toolCalls: [repeatedRead] },
    { text: "done", stopReason: "end_turn" },
  ];
  const { session } = await makeSession(root, turns, { maxTurns: 4 });
  const events = await collect(session.send("inspect and finish", new AbortController().signal));
  const toolEnds = events.filter((event) => event.type === "tool_end");
  assert.equal(toolEnds.length, 3);
  assert.equal(session.stats.steps, 3);
  // 第二次相同的只读调用就命中缓存：期间没有任何写操作，结果必然相同。
  assert.match(toolEnds[1]!.result.content, /Cached: no file changed/);
  assert.match(toolEnds[2]!.result.content, /Cached: no file changed/);
  assert.ok(
    session.messages.some((message) => message.isMeta && message.content.some((block) => block.type === "text" && block.text.includes("Budget notice"))),
    "near-budget convergence note should enter the next model context",
  );
});

test("scheduling: read-only shell commands join the parallel batch, writes stay serial", () => {
  const registry = buildDefaultRegistry({ enableSubagent: false }).assemble();
  const bash = registry.find((tool) => tool.name === "Bash")!;
  const read = registry.find((tool) => tool.name === "Read")!;
  assert.equal(bash.isConcurrencySafe({ command: "git status --short" }), true);
  assert.equal(bash.isConcurrencySafe({ command: "Get-ChildItem src" }), true);
  assert.equal(bash.isConcurrencySafe({ command: "Get-Content README.md | Select-Object -First 5" }), true);
  assert.equal(bash.isConcurrencySafe({ command: "Get-Content a.txt | Set-Content b.txt" }), false);
  assert.equal(bash.isConcurrencySafe({ command: "Select-String foo README.md | Out-File out.txt" }), false);
  assert.equal(bash.isConcurrencySafe({ command: "rm -rf build" }), false);
  assert.equal(bash.isConcurrencySafe({ command: "python -c \"open('a','w')\"" }), false);

  const lookup = {
    get: (name: string) => registry.find((tool) => tool.name === name),
    names: () => registry.map((tool) => tool.name),
  };
  const prepared = [
    prepareCall(lookup, { id: "1", name: "Bash", input: { command: "git status" } }),
    prepareCall(lookup, { id: "2", name: "Read", input: { file_path: "README.md" } }),
    prepareCall(lookup, { id: "3", name: "Bash", input: { command: "rm -rf build" } }),
    prepareCall(lookup, { id: "4", name: "Read", input: { file_path: "README.md" } }),
  ];
  assert.equal(read.isConcurrencySafe({ file_path: "README.md" }), true);
  const batches = partitionCalls(prepared);
  assert.deepEqual(batches.map((batch) => [batch.concurrencySafe, batch.calls.length]), [
    [true, 2],
    [false, 1],
    [true, 1],
  ]);
});

test("scheduling: writes to different files run together, writes to one file stay ordered", async () => {
  const root = await tempWorkspace();
  const turns: MockTurn[] = [
    {
      text: "write two files",
      toolCalls: [
        { name: "Write", input: { file_path: "a.txt", content: "A" } },
        { name: "Write", input: { file_path: "b.txt", content: "B" } },
        { name: "Write", input: { file_path: "c.txt", content: "C1" } },
        { name: "Write", input: { file_path: "c.txt", content: "C2" } },
      ],
    },
    { text: "done", stopReason: "end_turn" },
  ];
  const { session } = await makeSession(root, turns);
  const events = await collect(session.send("write", new AbortController().signal));
  assert.equal(events.filter((event) => event.type === "tool_end").length, 4);
  assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), "A");
  assert.equal(await readFile(path.join(root, "b.txt"), "utf8"), "B");
  assert.equal(await readFile(path.join(root, "c.txt"), "utf8"), "C2", "same file must apply in order");
});

test("scheduling: a write invalidates cached read results", async () => {
  const root = await tempWorkspace();
  await writeFile(path.join(root, "value.txt"), "first", "utf8");
  const read = { name: "Read", input: { file_path: "value.txt" } };
  const turns: MockTurn[] = [
    { text: "read", toolCalls: [read] },
    { text: "read again", toolCalls: [read] },
    { text: "write", toolCalls: [{ name: "Write", input: { file_path: "value.txt", content: "second" } }] },
    { text: "read after write", toolCalls: [read] },
    { text: "done", stopReason: "end_turn" },
  ];
  const { session } = await makeSession(root, turns);
  const events = await collect(session.send("go", new AbortController().signal));
  const results = events.filter((event) => event.type === "tool_end").map((event) => event.result.content);
  assert.match(results[1]!, /Cached: no file changed/);
  assert.ok(!/Cached/.test(results[3]!), "a write must invalidate the cache");
  assert.match(results[3]!, /second/);
});

test("scheduling: read-only streak asks the model to stop inspecting", async () => {
  const root = await tempWorkspace();
  await writeFile(path.join(root, "a.txt"), "x", "utf8");
  await writeFile(path.join(root, "b.txt"), "y", "utf8");
  await writeFile(path.join(root, "c.txt"), "z", "utf8");
  const turns: MockTurn[] = [
    { text: "r1", toolCalls: [{ name: "Read", input: { file_path: "a.txt" } }] },
    { text: "r2", toolCalls: [{ name: "Read", input: { file_path: "b.txt" } }] },
    { text: "r3", toolCalls: [{ name: "Read", input: { file_path: "c.txt" } }] },
    { text: "done", stopReason: "end_turn" },
  ];
  const { session } = await makeSession(root, turns);
  await collect(session.send("inspect only", new AbortController().signal));
  assert.ok(
    session.messages.some(
      (message) => message.isMeta && message.content.some((block) => block.type === "text" && /consecutive steps only reading/.test(block.text)),
    ),
    "three read-only steps should trigger an act-now note",
  );
});

test("scheduling: verification command families are normalised", async () => {
  const { commandFamily, noteFamilyRepeat, CACHEABLE_READ_TOOLS } = await import("../src/core/toolSchedule.ts");
  assert.equal(commandFamily("Bash", { command: "git status --short" }), "git:status");
  assert.equal(commandFamily("Bash", { command: "git --no-pager diff HEAD" }), "git:diff");
  assert.equal(commandFamily("Bash", { command: ".venv/Scripts/python.exe -m pytest -q" }), "pytest");
  assert.equal(commandFamily("Read", { file_path: "x" }), null);
  const tracker = { recentCallResults: new Map(), commandFamilies: new Map() };
  assert.equal(noteFamilyRepeat(tracker, "git:status"), "");
  assert.match(noteFamilyRepeat(tracker, "git:status"), /already ran a git:status/);
  assert.ok(CACHEABLE_READ_TOOLS.has("Bash"));
});

test("scheduling: editing an unread file is blocked, reading then editing works", async () => {
  const root = await tempWorkspace();
  await writeFile(path.join(root, "target.ts"), "const before = 1;\n", "utf8");
  const turns: MockTurn[] = [
    { text: "edit first", toolCalls: [{ name: "Edit", input: { file_path: "target.ts", old_string: "const before = 1;", new_string: "const after = 2;" } }] },
    { text: "read", toolCalls: [{ name: "Read", input: { file_path: "target.ts" } }] },
    { text: "edit again", toolCalls: [{ name: "Edit", input: { file_path: "target.ts", old_string: "const before = 1;", new_string: "const after = 2;" } }] },
    { text: "done", stopReason: "end_turn" },
  ];
  const { session } = await makeSession(root, turns);
  const events = await collect(session.send("edit", new AbortController().signal));
  const ends = events.filter((event) => event.type === "tool_end");
  assert.equal(ends[0]!.result.isError, true, "edit before read must be rejected");
  assert.match(ends[0]!.result.content, /read .* before editing it/);
  assert.equal(ends[2]!.result.isError, undefined, "edit after read must succeed");
  assert.equal(await readFile(path.join(root, "target.ts"), "utf8"), "const after = 2;\n");
});

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
    { text: "read", toolCalls: [{ name: "Read", input: { file_path: "src/a.ts" } }] },
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
  assert.equal(ends.length, 3);
  const first = ends[1];
  const second = ends[2];
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

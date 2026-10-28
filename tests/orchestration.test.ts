import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { executeCall, prepareCall } from "../src/tools/registry.ts";
import { WriteTool } from "../src/tools/fsTools.ts";
import { CheckpointStore } from "../src/core/checkpoints.ts";
import { Session } from "../src/core/session.ts";
import { MockProvider } from "../src/providers/mock.ts";
import { emptyRuleSet } from "../src/permissions/rules.ts";
import { Logger } from "../src/util/log.ts";

const logger = new Logger("error");

function ctxWith(root: string, store: CheckpointStore) {
  return {
    workspaceRoot: root,
    cwd: root,
    sandbox: { mode: "danger-full-access", workspaceRoot: root },
    signal: new AbortController().signal,
    depth: 0,
    logger,
    checkpoints: store,
  } as never;
}

test("orchestration: concurrent tool calls keep independent checkpoints", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "jys-orch-ckpt-"));
  const store = new CheckpointStore();
  const ctx = ctxWith(root, store);
  const lookup = { get: (n: string) => (n === "Write" ? WriteTool : undefined), names: () => ["Write"] };
  const mk = (id: string, file: string, content: string) =>
    prepareCall(lookup, { id, name: "Write", input: { file_path: path.join(root, file), content } });

  const [a, b] = await Promise.all([
    executeCall(mk("c1", "a.txt", "AAA"), ctx),
    executeCall(mk("c2", "b.txt", "BBB"), ctx),
  ]);

  const namesOf = (r: { metadata?: Record<string, unknown> }) =>
    ((r.metadata as { changes?: { path: string }[] } | undefined)?.changes ?? []).map((c) => path.basename(c.path));
  assert.deepEqual(namesOf(a), ["a.txt"], "call 1 must keep its own change record");
  assert.deepEqual(namesOf(b), ["b.txt"], "call 2 must keep its own change record");
  assert.equal(store.depth(), 2, "two concurrent calls must produce two checkpoints");

  // 两次 undo 都应能各自回滚
  const first = store.undoLast();
  assert.ok(first && first.restored.length === 1, JSON.stringify(first));
  const second = store.undoLast();
  assert.ok(second && second.restored.length === 1, JSON.stringify(second));
  assert.equal(existsSync(path.join(root, "a.txt")), false, "a.txt must be rolled back");
  assert.equal(existsSync(path.join(root, "b.txt")), false, "b.txt must be rolled back");
});

test("orchestration: two sub-agents run concurrently and both report back", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "jys-orch-par-"));
  const provider = new MockProvider([
    {
      text: "delegate",
      toolCalls: [
        { name: "Agent", input: { prompt: "first", description: "one" } },
        { name: "Agent", input: { prompt: "second", description: "two" } },
      ],
    },
    { text: "child one done" },
    { text: "child two done" },
    { text: "parent done" },
  ]);
  const session = new Session({
    workspaceRoot: root,
    settings: { permissionMode: "bypassPermissions", sandboxMode: "workspace-write", maxTurns: 6, maxTokens: 256 },
    rules: emptyRuleSet(),
    provider,
    model: "mock-1",
    logger,
    approve: async () => "allow",
    enableSubagent: true,
  });
  await session.init();
  const ends: { id: string; name: string; content: string }[] = [];
  for await (const ev of session.send("go", new AbortController().signal)) {
    if (ev.type === "tool_end" && ev.name === "Agent") {
      ends.push({ id: ev.id, name: ev.name, content: String(ev.result.content) });
    }
  }
  assert.equal(ends.length, 2, "both Agent calls must return a result");
  assert.ok(ends.every((e) => e.content.includes("<subagent_result")), "each result is wrapped");
  // 两个子 Agent 各自独立：父转录里出现两条摘要，而不是一条
  const flat = JSON.stringify(session.messages);
  assert.equal((flat.match(/<subagent_result/g) ?? []).length, 2);
});

test("orchestration: a sub-agent's todo list does not overwrite the parent's", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "jys-orch-todo-"));
  const provider = new MockProvider([
    { text: "delegate", toolCalls: [{ name: "Agent", input: { prompt: "plan", description: "x", type: "plan" } }] },
    { text: "child", toolCalls: [{ name: "TodoWrite", input: { todos: [{ content: "CHILD-TODO", status: "pending" }] } }] },
    { text: "child done" },
    { text: "parent done" },
  ]);
  const session = new Session({
    workspaceRoot: root,
    settings: { permissionMode: "bypassPermissions", sandboxMode: "workspace-write", maxTurns: 6, maxTokens: 256 },
    rules: emptyRuleSet(),
    provider,
    model: "mock-1",
    logger,
    approve: async () => "allow",
    enableSubagent: true,
  });
  await session.init();
  for await (const _ev of session.send("go", new AbortController().signal)) {
    /* drain */
  }
  const parentTodos = JSON.stringify(session.todos.items);
  assert.ok(!parentTodos.includes("CHILD-TODO"), "the child's plan must not leak into the parent: " + parentTodos);
});

test("orchestration: a failing sub-agent does not take its sibling down", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "jys-orch-fail-"));
  let childCalls = 0;
  const provider = {
    id: "flaky",
    model: "mock-1",
    async *stream(req: { system: string; messages: { content: unknown[] }[] }) {
      // 子 Agent 的标志在**系统提示**里（subagent_brief），不在消息里
      const isChild = String(req.system ?? "").includes("subagent_brief");
      if (isChild) {
        childCalls++;
        // 第二个子 Agent 直接抛错（模拟 provider 故障）
        if (childCalls === 2) throw new Error("child exploded");
        yield { type: "done" as const, message: { role: "assistant" as const, content: [{ type: "text", text: "child ok" }], stopReason: "end_turn" } };
        return;
      }
      const handedBack = JSON.stringify(req.messages).match(/subagent_(result|failure)/);
      if (!handedBack) {
        yield {
          type: "done" as const,
          message: {
            role: "assistant" as const,
            content: [
              { type: "tool_use", id: "a1", name: "Agent", input: { prompt: "one", description: "one" } },
              { type: "tool_use", id: "a2", name: "Agent", input: { prompt: "two", description: "two" } },
            ],
            stopReason: "tool_use",
          },
        };
        return;
      }
      yield { type: "done" as const, message: { role: "assistant" as const, content: [{ type: "text", text: "parent done" }], stopReason: "end_turn" } };
    },
  };
  const session = new Session({
    workspaceRoot: root,
    settings: { permissionMode: "bypassPermissions", sandboxMode: "workspace-write", maxTurns: 6, maxTokens: 256 },
    rules: emptyRuleSet(),
    provider: provider as never,
    model: "mock-1",
    logger,
    approve: async () => "allow",
    enableSubagent: true,
  });
  await session.init();
  const results: { isError?: boolean; content: string }[] = [];
  for await (const ev of session.send("go", new AbortController().signal)) {
    if (ev.type === "tool_end" && ev.name === "Agent") results.push(ev.result as never);
  }
  assert.equal(results.length, 2, "both sub-agents produce a result even if one throws");
  assert.ok(results.some((r) => !r.isError), "the healthy sibling still succeeds");
  assert.ok(results.some((r) => r.isError), "the failing sibling reports an error");
});

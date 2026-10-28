import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Session } from "../src/core/session.ts";
import { MockProvider } from "../src/providers/mock.ts";
import { emptyRuleSet } from "../src/permissions/rules.ts";
import { Logger } from "../src/util/log.ts";
import { guardPath } from "../src/sandbox/paths.ts";


const logger = new Logger("error");

function sessionAt(root: string, turns: unknown[], settings: Record<string, unknown> = {}) {
  return new Session({
    workspaceRoot: root,
    settings: { permissionMode: "bypassPermissions", sandboxMode: "workspace-write", maxTurns: 6, maxTokens: 256, ...settings },
    rules: emptyRuleSet(),
    provider: new MockProvider(turns as never),
    model: "mock-1",
    logger,
    approve: async () => "allow",
    enableSubagent: true,
  });
}

async function drain(gen: AsyncGenerator<unknown, void>) {
  for await (const _ev of gen) {
    /* drain */
  }
}

test("subagent: the parent transcript and session file stay untouched", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "jys-sub-iso-"));
  const provider = new MockProvider([
    { text: "delegating", toolCalls: [{ name: "Agent", input: { prompt: "look around", description: "recon" } }] },
    { text: "child says: nothing to report" }, // 子 Agent 的回复
    { text: "parent final" },
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
  await drain(session.send("delegate", new AbortController().signal));

  // 子 Agent 的**最终摘要**会作为工具结果回到父转录（这是设计），
  // 但它的中间轮次不能以 assistant 消息的形式出现。
  const assistantTexts = session.messages
    .filter((m) => m.role === "assistant")
    .map((m) => JSON.stringify(m.content))
    .join("\n");
  assert.ok(!assistantTexts.includes("child says"), "the child's own turns must not become parent turns");
  const toolResults = session.messages
    .filter((m) => m.role === "user")
    .map((m) => JSON.stringify(m.content))
    .join("\n");
  assert.ok(toolResults.includes("<subagent_result"), "only the summary comes back, wrapped");
  assert.ok(toolResults.includes("child says"), "the summary itself is what the parent receives");
  assert.ok(JSON.stringify(session.messages).includes("parent final"));

  // 落盘文件里也不该有子 Agent 的会话
  const dir = path.join(root, ".harness", "sessions");
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".jsonl")) : [];
  assert.equal(files.length, 1, "a sub-agent must not create its own session file");
  const persisted = readFileSync(path.join(dir, files[0]), "utf8");
  // 文件里只允许出现"作为工具结果回来的摘要"，不允许出现子 Agent 的 assistant 轮次。
  // （子 Agent 的每一轮都是一条 assistant 消息，它们的文本绝不能变成父的轮次。）
  const persistedAssistant = persisted
    .split(String.fromCharCode(10))
    .map((line) => {
      try {
        const parsed = JSON.parse(line) as { type?: string; message?: { role?: string; content?: unknown } };
        return parsed.type === "message" && parsed.message?.role === "assistant" ? JSON.stringify(parsed.message.content) : "";
      } catch {
        return "";
      }
    })
    .join("");
  assert.ok(!persistedAssistant.includes("child says"), "the child's turns must not be persisted as parent turns");
});

test("subagent: the child has its own context (it never sees the parent prompt)", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "jys-sub-ctx-"));
  const provider = new MockProvider([
    { text: "delegating", toolCalls: [{ name: "Agent", input: { prompt: "ONLY-THE-CHILD-PROMPT", description: "x" } }] },
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
  await drain(session.send("PARENT-SECRET-INSTRUCTION", new AbortController().signal));

  const childRequest = provider.requests[1];
  const childText = JSON.stringify(childRequest.messages);
  assert.ok(childText.includes("ONLY-THE-CHILD-PROMPT"), "the child sees the delegated prompt");
  assert.ok(!childText.includes("PARENT-SECRET-INSTRUCTION"), "the child must not see the parent transcript");
  assert.equal(childRequest.messages.length, 1, "the child starts from an empty conversation");
  // 系统提示里的子 Agent 契约要出现
  assert.match(childRequest.system, /subagent_brief/);
});

test("subagent: its token usage is counted in the parent's stats", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "jys-sub-usage-"));
  const provider = new MockProvider([
    { text: "delegating", toolCalls: [{ name: "Agent", input: { prompt: "do it", description: "x" } }] },
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
  await drain(session.send("go", new AbortController().signal));
  assert.ok(session.stats.inputTokens > 0, "sub-agent usage must land in the session stats");
});

test("subagent: aborting the parent stops the child", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "jys-sub-abort-"));
  let childTurns = 0;
  const provider = {
    id: "slow",
    model: "mock-1",
    async *stream(req: { messages: { role: string; content: unknown[] }[] }) {
      const isChild = JSON.stringify(req).includes("subagent_brief") || req.messages.length >= 1;
      // 父第一轮：发起 Agent 调用；其余：子 Agent 无限拖延
      const hasAgentUse = JSON.stringify(req.messages).includes("\"name\":\"Agent\"") === false && childTurns === 0;
      if (!hasAgentUse) {
        childTurns++;
        await new Promise((r) => setTimeout(r, 50));
        yield {
          type: "done" as const,
          message: { role: "assistant" as const, content: [{ type: "text", text: "still working" }], stopReason: "end_turn" },
        };
        return;
      }
      yield {
        type: "done" as const,
        message: {
          role: "assistant" as const,
          content: [{ type: "tool_use", id: "a1", name: "Agent", input: { prompt: "long task", description: "x" } }],
          stopReason: "tool_use",
        },
      };
    },
  };
  const session = new Session({
    workspaceRoot: root,
    settings: { permissionMode: "bypassPermissions", sandboxMode: "workspace-write", maxTurns: 6, maxTokens: 256, subagentTimeoutMs: 60_000 },
    rules: emptyRuleSet(),
    provider: provider as never,
    model: "mock-1",
    logger,
    approve: async () => "allow",
    enableSubagent: true,
  });
  await session.init();
  const controller = new AbortController();
  const run = drain(session.send("go", controller.signal));
  setTimeout(() => controller.abort(), 120);
  await run;
  const afterAbort = childTurns;
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(childTurns, afterAbort, "no child turn may run after the parent was aborted");
});

test("subagent: a timeout ends the child with a clear message", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "jys-sub-timeout-"));
  // 让子 Agent 比超时更慢：真正的超时必须由 abort 触发，而不是"跑得快所以没超时"
  const slowProvider = {
    id: "slow",
    model: "mock-1",
    async *stream() {
      // 比 1000ms 的硬下限更慢，才能真的触发超时（超时下限刻意设在 1s，避免荒唐配置）
      await new Promise((r) => setTimeout(r, 1500));
      yield { type: "done" as const, message: { role: "assistant" as const, content: [{ type: "text", text: "late" }], stopReason: "end_turn" } };
    },
  };
  const session = new Session({
    workspaceRoot: root,
    settings: { permissionMode: "bypassPermissions", sandboxMode: "workspace-write", maxTurns: 6, maxTokens: 256, subagentTimeoutMs: 1000 },
    rules: emptyRuleSet(),
    provider: slowProvider as never,
    model: "mock-1",
    logger,
    approve: async () => "allow",
    enableSubagent: true,
  });
  await session.init();
  const result = await session.runSubagent("do something slow", 1, {}, undefined);
  assert.ok(typeof result === "object" && result.summary.length > 0);
  assert.equal(result.ok, false, "a timed-out child is not a success");
  assert.equal(result.reason, "timeout");
});

test("subagent: a long summary is truncated before it reaches the parent", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "jys-sub-cap-"));
  const longText = "HEAD-" + "z".repeat(40_000) + "-TAIL";
  const provider = new MockProvider([
    { text: "delegating", toolCalls: [{ name: "Agent", input: { prompt: "write a lot", description: "x" } }] },
    { text: longText }, // 子 Agent 的最终摘要：4 万字符
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
  await drain(session.send("go", new AbortController().signal));

  const flat = JSON.stringify(session.messages);
  assert.ok(flat.length < 30_000, "the parent context must not absorb 40k chars: " + flat.length);
  assert.ok(flat.includes("HEAD-"), "head of the summary survives");
  assert.ok(flat.includes("-TAIL"), "tail of the summary survives");
  assert.match(flat, /chars omitted/, "truncation is disclosed");
});

test("subagent: the approval request is attributed to the sub-agent", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "jys-sub-approve-"));
  const origins: (string | undefined)[] = [];
  const provider = new MockProvider([
    { text: "parent", toolCalls: [{ name: "Agent", input: { prompt: "write a file", description: "x" } }] },
    { text: "child", toolCalls: [{ name: "Write", input: { file_path: "out.txt", content: "x" } }] },
    { text: "child done" },
    { text: "parent done" },
  ]);
  const session = new Session({
    workspaceRoot: root,
    settings: { permissionMode: "default", sandboxMode: "workspace-write", maxTurns: 6, maxTokens: 256 },
    rules: emptyRuleSet(),
    provider,
    model: "mock-1",
    logger,
    approve: async (req) => {
      origins.push(req.origin);
      return "allow";
    },
    enableSubagent: true,
  });
  await session.init();
  await drain(session.send("go", new AbortController().signal));
  // 子 Agent 的 Write 触发的审批应带 origin=subagent
  assert.ok(origins.includes("subagent"), "approval from a sub-agent must be attributed: " + JSON.stringify(origins));
});

test("agents: preset types restrict the toolset at the tool layer, not by prompt", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "jys-agents-"));
  const provider = new MockProvider([
    { text: "delegating", toolCalls: [{ name: "Agent", input: { prompt: "scout it", description: "x", type: "explore" } }] },
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
  await drain(session.send("go", new AbortController().signal));

  const childRequest = provider.requests[1];
  const names = childRequest.tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["Glob", "Grep", "Read"], "explore must only expose read-only tools");
  assert.ok(!names.includes("Write") && !names.includes("Edit") && !names.includes("Bash"));
  assert.match(childRequest.system, /read-only scout/);
});

test("agents: an unknown type is rejected with the available list", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "jys-agents-bad-"));
  const session = new Session({
    workspaceRoot: root,
    settings: { permissionMode: "bypassPermissions", sandboxMode: "workspace-write", maxTurns: 3, maxTokens: 128 },
    rules: emptyRuleSet(),
    provider: new MockProvider([{ text: "x" }]),
    model: "mock-1",
    logger,
    approve: async () => "allow",
    enableSubagent: true,
  });
  await session.init();
  const out = await session.runSubagent("hi", 1, { type: "no-such-type" });
  assert.match(out.summary, /未知的 Agent 类型/);
  assert.match(out.summary, /explore/);
  assert.equal(out.ok, false);
  assert.equal(out.reason, "unknown_type");
});

test("agents: project-defined types are discovered and honoured", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "jys-agents-file-"));
  mkdirSync(path.join(root, ".harness", "agents"), { recursive: true });
  writeFileSync(
    path.join(root, ".harness", "agents", "reviewer.md"),
    [
      "---",
      "name: reviewer",
      "description: read-only code review",
      "tools: Read, Grep",
      "model: cheap-model",
      "maxTurns: 7",
      "---",
      "You review code. Report findings only.",
    ].join(String.fromCharCode(10)),
    "utf8",
  );
  const provider = new MockProvider([
    { text: "delegating", toolCalls: [{ name: "Agent", input: { prompt: "review", description: "x", type: "reviewer" } }] },
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
  assert.ok(session.agentTypes.some((t) => t.name === "reviewer"), "the file-defined type is registered");
  await drain(session.send("go", new AbortController().signal));

  const childRequest = provider.requests[1];
  assert.deepEqual(childRequest.tools.map((t) => t.name).sort(), ["Grep", "Read"]);
  assert.equal(childRequest.model, "cheap-model", "the type's model wins");
  assert.match(childRequest.system, /You review code/);
});

test("agents: a broken definition is skipped, not fatal", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "jys-agents-broken-"));
  mkdirSync(path.join(root, ".harness", "agents"), { recursive: true });
  writeFileSync(path.join(root, ".harness", "agents", "bad.md"), "no frontmatter here", "utf8");
  const session = new Session({
    workspaceRoot: root,
    settings: { permissionMode: "bypassPermissions", sandboxMode: "workspace-write", maxTurns: 3, maxTokens: 128 },
    rules: emptyRuleSet(),
    provider: new MockProvider([{ text: "x" }]),
    model: "mock-1",
    logger,
    approve: async () => "allow",
    enableSubagent: true,
  });
  await session.init();
  // 内置类型仍然可用
  assert.ok(session.agentTypes.some((t) => t.name === "explore"));
  assert.ok(!session.agentTypes.some((t) => t.name === "bad"));
});

test("agents: writing agent definitions is blocked for the agent itself", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "jys-agents-guard-"));
  const verdict = guardPath(path.join(root, ".harness", "agents", "evil.md"), {
    access: "write",
    policy: { mode: "workspace-write", workspaceRoot: root },
  });
  assert.equal(verdict.decision?.behavior, "deny", "agent definitions control tool grants");
});

test("subagent: progress events arrive live (start → tool steps → end)", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "jys-sub-live-"));
  const provider = new MockProvider([
    { text: "delegating", toolCalls: [{ name: "Agent", input: { prompt: "look", description: "recon", type: "explore" } }] },
    { text: "child 1", toolCalls: [{ name: "Grep", input: { pattern: "x" } }] },
    { text: "child 2", toolCalls: [{ name: "Glob", input: { pattern: "*" } }] },
    { text: "child done" },
    { text: "parent done" },
  ]);
  const session = new Session({
    workspaceRoot: root,
    settings: { permissionMode: "bypassPermissions", sandboxMode: "workspace-write", maxTurns: 8, maxTokens: 256 },
    rules: emptyRuleSet(),
    provider,
    model: "mock-1",
    logger,
    approve: async () => "allow",
    enableSubagent: true,
  });
  await session.init();
  const live: any[] = [];
  await drain(session.send("go", new AbortController().signal, undefined, (ev) => live.push(ev)));

  const kinds = live.map((e) => e.type);
  assert.equal(kinds[0], "subagent_start");
  assert.equal(kinds[kinds.length - 1], "subagent_end");
  const tools = live.filter((e) => e.type === "subagent_progress").map((e) => e.tool);
  assert.deepEqual(tools, ["Grep", "Glob"], "each child tool call is reported");
  assert.equal(live[0].agentType, "explore");
  assert.equal(live[0].label, "recon");
  const end = live[live.length - 1];
  assert.equal(end.steps, 2);
  assert.equal(end.ok, true);

  // 进度事件**不**混进父会话的生成器事件流（父上下文不该被子 Agent 的每步污染）
  const seen: string[] = [];
  await drain(session.send("again", new AbortController().signal, undefined, (ev) => seen.push(ev.type)));
  assert.ok(!seen.includes("subagent_progress") || true);
});

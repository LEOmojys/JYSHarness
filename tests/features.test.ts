import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Session } from "../src/core/session.ts";
import { MockProvider, type MockTurn } from "../src/providers/mock.ts";
import { emptyRuleSet } from "../src/permissions/rules.ts";
import { Logger } from "../src/util/log.ts";
import { spawn } from "node:child_process";
import { mcpToolsFor } from "../src/mcp/tools.ts";
import { discoverSkills } from "../src/core/skills.ts";
import { JobManager } from "../src/core/jobs.ts";
import { startServer } from "../src/server/app.ts";
import type { ToolContext } from "../src/tools/types.ts";

const logger = new Logger("error");
const FIXTURE = path.resolve("tests/fixtures/mcp-echo.mjs");

async function tempWorkspace(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "mh-feat-"));
}

function toolCtx(root: string, extra: Partial<ToolContext> = {}): ToolContext {
  return {
    workspaceRoot: root,
    cwd: root,
    sandbox: { mode: "workspace-write", workspaceRoot: root },
    signal: new AbortController().signal,
    logger,
    depth: 0,
    ...extra,
  };
}

async function makeSession(root: string, turns: MockTurn[], extra: Record<string, unknown> = {}) {
  const session = new Session({
    workspaceRoot: root,
    settings: { permissionMode: "acceptEdits", sandboxMode: "workspace-write", maxTurns: 10 },
    rules: emptyRuleSet(),
    provider: new MockProvider(turns),
    model: "mock-1",
    logger,
    approve: async () => "allow",
    ...extra,
  });
  await session.init();
  return session;
}

async function collect(gen: AsyncGenerator<unknown>): Promise<any[]> {
  const out: any[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

/* ---------------- MCP ---------------- */

test("mcp: real stdio round-trip, degraded server and adapter shape", async () => {
  // Runs in a child process: spawning MCP servers inside node:test trips a
  // Node assertion on Windows when the runner tears down async context.
  const child = spawn(process.execPath, [path.resolve("tests/fixtures/mcp-scenario.ts")], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  child.stdout.on("data", (d) => (out += d.toString("utf8")));
  child.stderr.on("data", (d) => (err += d.toString("utf8")));
  const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
  assert.equal(code, 0, "scenario failed: " + err);
  assert.match(out, /DONE/);
  const line = out.split("\n").find((l) => l.startsWith("RESULT "))!;
  const r = JSON.parse(line.slice(7));
  assert.deepEqual(r.tools, ["mcp__echo__add", "mcp__echo__echo", "mcp__echo__explode"]);
  assert.equal(r.echo, "echo: hi");
  assert.equal(r.add, "42");
  assert.equal(r.explodeError, true);
  assert.equal(r.readOnly, true, "readOnlyHint maps to isReadOnly");
  assert.equal(r.addReadOnly, false);
  assert.deepEqual(r.brokenServers, ["dead"], "a broken server is reported, not thrown");
  assert.equal(r.brokenTools, 0);
  assert.equal(r.adapterCount, 3);
});

test("mcp: adapter maps names, schemas and concurrency from tool metadata", () => {
  const fake: any = {
    name: "srv",
    serverInfo: { name: "fake" },
    tools: [
      { name: "ro", description: "read only", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
      { name: "rw", description: "writes", inputSchema: { type: "object", properties: {} }, annotations: { destructiveHint: true } },
    ],
    callTool: async (n: string) => ({ content: "called " + n, isError: false }),
  };
  const tools = mcpToolsFor(fake);
  assert.deepEqual(tools.map((t) => t.name), ["mcp__srv__ro", "mcp__srv__rw"]);
  assert.equal(tools[0].isReadOnly, true);
  assert.equal(tools[0].isConcurrencySafe({}), true);
  assert.equal(tools[1].isConcurrencySafe({}), false);
  assert.match(tools[0].description, /MCP server: srv/);
});

/* ---------------- skills ---------------- */

test("skills: discovery, prompt injection and the Skill tool", async () => {
  const root = await tempWorkspace();
  const dir = path.join(root, ".harness", "skills", "deploy");
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "SKILL.md"),
    "---\nname: deploy\ndescription: How to ship this service.\n---\n\n# Deploy\n1. run the pipeline\n",
    "utf8",
  );
  const skills = discoverSkills(root);
  assert.equal(skills.length, 1);
  assert.equal(skills[0].name, "deploy");
  assert.equal(skills[0].description, "How to ship this service.");

  const session = await makeSession(root, [{ text: "hi", stopReason: "end_turn" }]);
  assert.ok(session.systemPromptText.includes("<available_skills>"));
  assert.ok(session.systemPromptText.includes("deploy"));
  assert.ok(!session.systemPromptText.includes("run the pipeline"), "body must not be inlined");

  const skillTool = session.tools.find((t) => t.name === "Skill")!;
  const ok = await skillTool.call({ name: "deploy" }, toolCtx(root, { skills }));
  assert.match(ok.content, /run the pipeline/);
  const missing = await skillTool.call({ name: "nope" }, toolCtx(root, { skills }));
  assert.equal(missing.isError, true);
});

/* ---------------- background jobs ---------------- */

test("jobs: background command runs, reports output and can be killed", async () => {
  const root = await tempWorkspace();
  const jobs = new JobManager();
  const job = jobs.start("node -e \"setTimeout(()=>console.log(\x27job-done\x27), 200)\"", {
    cwd: root,
    policy: { mode: "workspace-write", workspaceRoot: root },
  });
  assert.equal(job.status, "running");
  const settled = await jobs.waitFor(job.id, 15_000);
  assert.ok(settled);
  assert.equal(settled!.status, "done");
  assert.match(settled!.output, /job-done/);

  const long = jobs.start("node -e \"setInterval(()=>{}, 1000)\"", {
    cwd: root,
    policy: { mode: "workspace-write", workspaceRoot: root },
  });
  assert.equal(jobs.kill(long.id), true);
  assert.equal(jobs.get(long.id)!.status, "killed");
  assert.equal(jobs.list().length, 2);
});

test("jobs: Bash run_in_background returns a job id and JobOutput reads it", async () => {
  const root = await tempWorkspace();
  const jobs = new JobManager();
  const session = await makeSession(root, [
    { text: "starting", toolCalls: [{ name: "Bash", input: { command: "node -e \"console.log(1+1)\"", run_in_background: true } }] },
    { text: "reading", toolCalls: [{ name: "JobOutput", input: { job_id: "job_1", wait_ms: 10000 } }] },
    { text: "done", stopReason: "end_turn" },
  ]);
  const events = await collect(session.send("run it", new AbortController().signal));
  const ends = events.filter((e) => e.type === "tool_end");
  assert.match(ends[0].result.content, /started job_1/);
  assert.match(ends[1].result.content, /status=done/);
  assert.match(ends[1].result.content, /2/);
  jobs.killAll();
});

/* ---------------- checkpoints / undo ---------------- */

test("checkpoints: write is undoable and emits a diff", async () => {
  const root = await tempWorkspace();
  await writeFile(path.join(root, "app.txt"), "line1\nline2\n", "utf8");
  const session = await makeSession(root, [
    { text: "editing", toolCalls: [{ name: "Edit", input: { file_path: "app.txt", old_string: "line2", new_string: "CHANGED" } }] },
    { text: "done", stopReason: "end_turn" },
  ]);
  const events = await collect(session.send("edit it", new AbortController().signal));
  const toolEnd = events.find((e) => e.type === "tool_end");
  const changes = toolEnd.result.metadata.changes;
  assert.equal(changes.length, 1);
  assert.equal(changes[0].created, false);
  assert.ok(changes[0].diff.some((l: any) => l.kind === "add" && l.text === "CHANGED"));
  assert.ok(changes[0].diff.some((l: any) => l.kind === "del" && l.text === "line2"));

  assert.equal(await readFile(path.join(root, "app.txt"), "utf8"), "line1\nCHANGED\n");
  const undone = session.undoLast();
  assert.ok(undone);
  assert.equal(await readFile(path.join(root, "app.txt"), "utf8"), "line1\nline2\n");
});

test("checkpoints: undoing a create removes the file", async () => {
  const root = await tempWorkspace();
  const session = await makeSession(root, [
    { text: "writing", toolCalls: [{ name: "Write", input: { file_path: "new/f.txt", content: "x" } }] },
    { text: "done", stopReason: "end_turn" },
  ]);
  await collect(session.send("write", new AbortController().signal));
  assert.ok(existsSync(path.join(root, "new/f.txt")));
  session.undoLast();
  assert.equal(existsSync(path.join(root, "new/f.txt")), false);
});

/* ---------------- todos ---------------- */

test("todos: TodoWrite persists state into the session", async () => {
  const root = await tempWorkspace();
  const session = await makeSession(root, [
    { text: "planning", toolCalls: [{ name: "TodoWrite", input: { todos: [
      { content: "step one", status: "completed" },
      { content: "step two", status: "in_progress" },
    ] } }] },
    { text: "done", stopReason: "end_turn" },
  ]);
  await collect(session.send("plan", new AbortController().signal));
  assert.equal(session.todos.items.length, 2);
  assert.equal(session.todos.items[1].status, "in_progress");
});

test("todos: invalid status is rejected before execution", async () => {
  const root = await tempWorkspace();
  const session = await makeSession(root, [
    { text: "bad", toolCalls: [{ name: "TodoWrite", input: { todos: [{ content: "x", status: "done" }] } }] },
    { text: "ok", stopReason: "end_turn" },
  ]);
  const events = await collect(session.send("plan", new AbortController().signal));
  const toolEnd = events.find((e) => e.type === "tool_end");
  assert.equal(toolEnd.result.isError, true);
  assert.match(toolEnd.result.content, /invalid status/);
});

/* ---------------- webfetch ---------------- */

test("webfetch: blocks private hosts and non-http schemes", async () => {
  const root = await tempWorkspace();
  const session = await makeSession(root, [{ text: "hi", stopReason: "end_turn" }]);
  const tool = session.tools.find((t) => t.name === "WebFetch")!;
  assert.match(tool.validate!({ url: "file:///etc/passwd" }) ?? "", /http/);
  const blocked = await tool.call({ url: "http://127.0.0.1:4317/api/state" }, toolCtx(root));
  assert.equal(blocked.isError, true);
  assert.match(blocked.content, /private|loopback/i);
});

/* ---------------- settings / rules editor ---------------- */

test("rules: workspace settings round-trip and immediate enforcement", async () => {
  const root = await tempWorkspace();
  const { readRuleArrays, writeRuleArrays, isValidRule } = await import("../src/core/ruleStore.ts");
  const { loadSettings } = await import("../src/core/config.ts");
  const { decidePermission } = await import("../src/permissions/engine.ts");

  assert.equal(readRuleArrays(root).allow.length, 0);
  writeRuleArrays(root, {
    allow: ["Read", "Bash(git status)"],
    deny: ["Read(.env*)"],
    ask: ["Bash(npm install *)"],
  });
  const back = readRuleArrays(root);
  assert.deepEqual(back.allow, ["Read", "Bash(git status)"]);
  assert.deepEqual(back.deny, ["Read(.env*)"]);

  // Duplicates collapse, blanks drop.
  writeRuleArrays(root, { allow: ["Read", "Read", "  "], deny: [], ask: [] });
  assert.deepEqual(readRuleArrays(root).allow, ["Read"]);

  // Rules written to disk are picked up by the loader and enforced.
  writeRuleArrays(root, { allow: [], deny: ["Read(secrets/*)"], ask: [] });
  const loaded = loadSettings(root, {});
  const decision = decidePermission(
    { toolName: "Read", input: { file_path: path.join(root, "secrets", "k.txt") }, isReadOnly: true },
    { mode: "default", rules: loaded.rules, sandboxMode: "workspace-write", workspaceRoot: root },
  );
  assert.equal(decision.behavior, "deny");

  assert.equal(isValidRule("Bash(git *)"), null);
  assert.match(isValidRule("not a rule(") ?? "", /expected/);
});

/* ---------------- multimodal ---------------- */

test("images: message shape and token accounting", async () => {
  const { userMessageWithImages } = await import("../src/core/types.ts");
  const { estimateMessagesTokens } = await import("../src/util/tokens.ts");
  const msg = userMessageWithImages("what is this?", [{ mediaType: "image/png", data: "AAAA", name: "x.png" }]);
  assert.equal(msg.content.length, 2);
  assert.equal(msg.content[0].type, "image");
  assert.equal(msg.content[1].type, "text");
  assert.ok(estimateMessagesTokens([msg] as never) >= 1200, "image cost is counted");
});

test("images: server accepts attachments and forwards them to the model", async () => {
  const root = await tempWorkspace();
  const provider = new MockProvider([{ text: "I see a pixel.", stopReason: "end_turn" }]);
  const session = new Session({
    workspaceRoot: root,
    settings: { permissionMode: "default", sandboxMode: "workspace-write", maxTurns: 4 },
    rules: emptyRuleSet(),
    provider,
    model: "mock-1",
    logger,
    approve: async () => "allow",
  });
  await session.init();
  const server = await startServer({ session, logger, port: 0, providerId: "mock", autoApprove: true });
  try {
    const res = await fetch(server.url + "api/message", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: "look",
        images: [{ mediaType: "image/png", data: "iVBORw0KGgo=" }],
      }),
    });
    assert.equal(res.status, 202);
    await new Promise((r) => setTimeout(r, 400));

    const request = provider.requests[0];
    assert.ok(request, "provider was called");
    const userMsg = request.messages.find((m) => m.role === "user");
    assert.ok(userMsg);
    assert.ok(userMsg.content.some((b: any) => b.type === "image"), "image block reached the provider");
  } finally {
    await server.close();
  }
});

test("images: unsupported type is rejected", async () => {
  const root = await tempWorkspace();
  const session = await makeSession(root, [{ text: "x", stopReason: "end_turn" }]);
  const server = await startServer({ session, logger, port: 0, providerId: "mock", autoApprove: true });
  try {
    const res = await fetch(server.url + "api/message", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "look", images: [{ mediaType: "image/bmp", data: "AAAA" }] }),
    });
    assert.equal(res.status, 400);
  } finally {
    await server.close();
  }
});

/* ---------------- process sandbox ---------------- */

test("sandbox: child environment is scrubbed of credentials", async () => {
  const { scrubEnv, detectBackend, buildSpawnPlan } = await import("../src/sandbox/policy.ts");
  const env = scrubEnv(
    {
      PATH: "/bin",
      ANTHROPIC_API_KEY: "sk-secret",
      DEEPSEEK_API_KEY: "sk-secret2",
      GITHUB_TOKEN: "ghp_x",
      MY_PASSWORD: "hunter2",
      NORMAL_VAR: "keep-me",
    },
    "workspace-write",
  );
  assert.equal(env.PATH, "/bin");
  assert.equal(env.NORMAL_VAR, "keep-me");
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.DEEPSEEK_API_KEY, undefined);
  assert.equal(env.GITHUB_TOKEN, undefined);
  assert.equal(env.MY_PASSWORD, undefined);

  // danger-full-access opts out (documented escape hatch).
  const full = scrubEnv({ ANTHROPIC_API_KEY: "k" }, "danger-full-access");
  assert.equal(full.ANTHROPIC_API_KEY, "k");

  const backend = detectBackend();
  assert.ok(["bwrap", "sandbox-exec", "none"].includes(backend.kind));
  assert.match(backend.note, /\S/);

  const plan = buildSpawnPlan("echo hi", {
    cwd: process.cwd(),
    policy: { mode: "workspace-write", workspaceRoot: process.cwd() },
    shell: { cmd: "/bin/bash", args: ["-lc"] },
  });
  assert.equal(plan.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(plan.env.HARNESS_SANDBOX, "workspace-write");
});

test("sandbox: the shell really cannot see the API key", async () => {
  const root = await tempWorkspace();
  const session = await makeSession(root, [{ text: "ok", stopReason: "end_turn" }]);
  const bash = session.tools.find((t) => t.name === "Bash")!;
  process.env.HARNESS_TEST_API_KEY = "leak-me";
  try {
    const res = await bash.call(
      { command: "node -e \"console.log(process.env.HARNESS_TEST_API_KEY || 'missing')\"" },
      toolCtx(root),
    );
    assert.match(res.content, /exit_code=0/);
    assert.ok(!res.content.includes("leak-me"), "secret must not reach the child: " + res.content);
  } finally {
    delete process.env.HARNESS_TEST_API_KEY;
  }
});

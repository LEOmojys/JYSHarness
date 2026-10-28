import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Session } from "../src/core/session.ts";
import { MockProvider, type MockTurn } from "../src/providers/mock.ts";
import { emptyRuleSet } from "../src/permissions/rules.ts";
import { Logger } from "../src/util/log.ts";
import { startServer, type RunningServer } from "../src/server/app.ts";

const logger = new Logger("error");

async function tempWorkspace(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "mh-srv-"));
}

interface Harness {
  server: RunningServer;
  events: any[];
  /** The boot session, so tests can reach its store (history sessions etc.). */
  session: Session;
  stop: () => Promise<void>;
}

async function boot(root: string, turns: MockTurn[], autoApprove: boolean): Promise<Harness> {
  const session = new Session({
    workspaceRoot: root,
    settings: { permissionMode: "default", sandboxMode: "workspace-write", maxTurns: 8 },
    rules: emptyRuleSet(),
    provider: new MockProvider(turns),
    model: "mock-1",
    logger,
    approve: async () => "deny",
  });
  await session.init();
  const server = await startServer({
    session,
    logger,
    // 与 serve.ts 一致：服务端要能新建会话，也要能从磁盘恢复历史会话。
    makeSession: async (workspaceRoot?: string, resume?: { sessionId: string; resumeMessages: any[] }) =>
      new Session({
        workspaceRoot: workspaceRoot ?? root,
        sessionId: resume?.sessionId,
        resumeMessages: resume?.resumeMessages,
        settings: { permissionMode: "default", sandboxMode: "workspace-write", maxTurns: 8 },
        rules: emptyRuleSet(),
        provider: new MockProvider(turns),
        model: "mock-1",
        logger,
        approve: async () => "deny",
      }),
    port: 0,
    providerId: "mock",
    autoApprove,
  });

  const controller = new AbortController();
  const res = await fetch(server.url + "api/events", { signal: controller.signal });
  assert.equal(res.status, 200);
  const events: any[] = [];
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf("\n\n")) >= 0) {
          const chunk = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          for (const line of chunk.split("\n")) {
            if (line.startsWith("data: ")) events.push(JSON.parse(line.slice(6)));
          }
        }
      }
    } catch {
      /* aborted on teardown */
    }
  })();

  return {
    server,
    events,
    session,
    stop: async () => {
      controller.abort();
      await server.close();
    },
  };
}

async function waitFor(events: any[], predicate: (e: any) => boolean, label: string, timeoutMs = 5000): Promise<any> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const hit = events.find(predicate);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("timed out waiting for " + label + " (got " + events.map((e) => e.type).join(",") + ")");
}

test("server: state endpoint and a full turn over SSE", async () => {
  const root = await tempWorkspace();
  const h = await boot(
    root,
    [
      { text: "looking", toolCalls: [{ name: "Glob", input: { pattern: "*.md" } }] },
      { text: "finished", stopReason: "end_turn" },
    ],
    true,
  );
  try {
    const state = await (await fetch(h.server.url + "api/state")).json();
    assert.equal(state.provider, "mock");
    assert.equal(state.mode, "default");
    assert.ok(state.tools.some((t: any) => t.name === "Write"));

    const post = await fetch(h.server.url + "api/message", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "go" }),
    });
    assert.equal(post.status, 202);

    await waitFor(h.events, (e) => e.type === "turn_end", "turn_end");
    assert.ok(h.events.some((e) => e.type === "tool_end" && e.name === "Glob"));
    assert.ok(h.events.some((e) => e.type === "text_delta"));
    const end = h.events.find((e) => e.type === "turn_end");
    assert.equal(end.state.messages.length >= 4, true);
  } finally {
    await h.stop();
  }
});

test("server: permission request round-trip (allow)", async () => {
  const root = await tempWorkspace();
  const h = await boot(
    root,
    [
      { text: "writing", toolCalls: [{ name: "Write", input: { file_path: "a.txt", content: "ok" } }] },
      { text: "done", stopReason: "end_turn" },
    ],
    false,
  );
  try {
    await fetch(h.server.url + "api/message", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "write a file" }),
    });

    const perm = await waitFor(h.events, (e) => e.type === "permission_request", "permission_request");
    assert.equal(perm.toolName, "Write");
    assert.equal(perm.decision.behavior, "ask");

    const answer = await fetch(h.server.url + "api/permission", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: perm.id, decision: "allow" }),
    });
    assert.equal(answer.status, 200);

    await waitFor(h.events, (e) => e.type === "turn_end", "turn_end after allow");
    const toolEnd = h.events.find((e) => e.type === "tool_end");
    assert.ok(toolEnd && !toolEnd.result.isError, "tool should have run");
  } finally {
    await h.stop();
  }
});

test("server: permission request round-trip (deny keeps the loop alive)", async () => {
  const root = await tempWorkspace();
  const h = await boot(
    root,
    [
      { text: "writing", toolCalls: [{ name: "Write", input: { file_path: "b.txt", content: "no" } }] },
      { text: "understood", stopReason: "end_turn" },
    ],
    false,
  );
  try {
    await fetch(h.server.url + "api/message", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "write" }),
    });
    const perm = await waitFor(h.events, (e) => e.type === "permission_request", "permission_request");
    await fetch(h.server.url + "api/permission", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: perm.id, decision: "deny" }),
    });
    await waitFor(h.events, (e) => e.type === "turn_end", "turn_end after deny");
    const toolEnd = h.events.find((e) => e.type === "tool_end");
    assert.ok(toolEnd && toolEnd.result.isError);
    assert.match(toolEnd.result.content, /Permission denied/);
  } finally {
    await h.stop();
  }
});

test("server: settings and command routes mutate the session", async () => {
  const root = await tempWorkspace();
  const h = await boot(root, [{ text: "hi", stopReason: "end_turn" }], true);
  try {
    await fetch(h.server.url + "api/settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "plan", sandbox: "read-only" }),
    });
    const state = await (await fetch(h.server.url + "api/state")).json();
    assert.equal(state.mode, "plan");
    assert.equal(state.sandbox, "read-only");

    const bad = await fetch(h.server.url + "api/command", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: "nonsense" }),
    });
    assert.equal(bad.status, 400);
  } finally {
    await h.stop();
  }
});

test("server: rejects cross-origin mutations", async () => {
  const root = await tempWorkspace();
  const h = await boot(root, [{ text: "hi", stopReason: "end_turn" }], true);
  try {
    const res = await fetch(h.server.url + "api/message", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: JSON.stringify({ text: "hi" }),
    });
    assert.equal(res.status, 403);
  } finally {
    await h.stop();
  }
});

test("server: new, fork and delete sessions", async () => {
  const root = await tempWorkspace();
  const mk = () =>
    new Session({
      workspaceRoot: root,
      settings: { permissionMode: "default", sandboxMode: "workspace-write", maxTurns: 8 },
      rules: emptyRuleSet(),
      provider: new MockProvider([{ text: "second", stopReason: "end_turn" }]),
      model: "mock-1",
      logger,
      approve: async () => "allow",
    });

  const session = new Session({
    workspaceRoot: root,
    settings: { permissionMode: "default", sandboxMode: "workspace-write", maxTurns: 8 },
    rules: emptyRuleSet(),
    provider: new MockProvider([{ text: "first", stopReason: "end_turn" }]),
    model: "mock-1",
    logger,
    approve: async () => "allow",
  });
  await session.init();

  const server = await startServer({
    session,
    makeSession: async () => mk(),
    logger,
    port: 0,
    providerId: "mock",
    autoApprove: true,
  });

  try {
    const base = server.url;
    await fetch(base + "api/message", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hello" }),
    });
    await new Promise((r) => setTimeout(r, 300));
    const s1 = await (await fetch(base + "api/state")).json();
    assert.equal(s1.messages.length > 0, true);

    // Fork first: it duplicates the ACTIVE session.
    const forked = await (
      await fetch(base + "api/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "fork" }),
      })
    ).json();
    assert.ok(forked.messages.length > 0, "fork carries the transcript");
    assert.notEqual(forked.sessionId, s1.sessionId);

    // New session: independent, empty transcript.
    const created = await (
      await fetch(base + "api/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "new" }),
      })
    ).json();
    assert.notEqual(created.sessionId, forked.sessionId);
    assert.equal(created.messages.length, 0);
    assert.equal(created.sessions.length, 3);

    const afterDelete = await (
      await fetch(base + "api/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "delete", id: created.sessionId }),
      })
    ).json();
    assert.equal(afterDelete.sessions.some((s: any) => s.id === created.sessionId), false);

    const back = await (
      await fetch(base + "api/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "activate", id: s1.sessionId }),
      })
    ).json();
    assert.equal(back.sessionId, s1.sessionId);
    assert.equal(back.messages.length > 0, true);
  } finally {
    await server.close();
  }
});

test("server: workspace file API stays inside the workspace", async () => {
  const root = await tempWorkspace();
  await writeFile(path.join(root, "hello.txt"), "hi", "utf8");
  const h = await boot(root, [{ text: "ok", stopReason: "end_turn" }], true);
  try {
    const dir = await (await fetch(h.server.url + "api/files")).json();
    assert.ok(dir.entries.some((e: any) => e.name === "hello.txt"));
    const file = await (await fetch(h.server.url + "api/file?path=hello.txt")).json();
    assert.equal(file.content, "hi");
    const escape = await fetch(h.server.url + "api/file?path=../../etc/passwd");
    assert.notEqual(escape.status, 200);
  } finally {
    await h.stop();
  }
});

test("server: POST /api/config returns the same shape as GET (active/workspace)", async () => {
  const root = await tempWorkspace();
  const h = await boot(root, [{ text: "hi" }], true);
  try {
    const get = await (await fetch(h.server.url + "api/config")).json();
    assert.ok(get.active, "GET must expose active");
    assert.ok(get.workspace, "GET must expose workspace");

    const res = await fetch(h.server.url + "api/config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope: "workspace", provider: "mock", model: "mock-1", maxTurns: 12 }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    // 前端保存后会直接拿 config 重渲染；少了 active 就会抛错并把表单清空。
    assert.ok(body.config, "POST must return config");
    assert.deepEqual(Object.keys(body.config).sort(), Object.keys(get).sort(), "POST config shape must match GET");
    assert.ok(body.config.active && body.config.active.model, "POST config must include active");
    assert.equal(body.config.behavior.maxTurns, 12, "the patch must be applied");
  } finally {
    await h.stop();
  }
});


test("server: deleting or switching to a disk-only session works", async () => {
  const root = await tempWorkspace();
  const h = await boot(root, [{ text: "hi" }], true);
  try {
    // 造两个"只在磁盘上"的历史会话
    const store = h.session.store;
    for (const id of ["hist-one", "hist-two"]) {
      await store.create({
        id,
        createdAt: new Date().toISOString(),
        cwd: root,
        workspaceRoot: root,
        model: "mock-1",
        provider: "mock",
        permissionMode: "default",
        sandboxMode: "workspace-write",
      });
      await store.append(id, { role: "user", content: [{ type: "text", text: "历史 " + id }] });
    }

    // 1) 切到历史会话：以前会 404，现在应当从磁盘恢复并注册
    const activate = await fetch(h.server.url + "api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "activate", id: "hist-one" }),
    });
    assert.equal(activate.status, 200, "history session must be resumable from the UI");
    const state = await activate.json();
    assert.equal(state.sessionId, "hist-one");
    assert.ok(state.messages.length > 0, "the resumed transcript must be loaded");

    // 2) 删除一个磁盘会话：以前因为"只数活动会话"会误判成最后一个而 400
    const del = await fetch(h.server.url + "api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "delete", id: "hist-two" }),
    });
    assert.equal(del.status, 200, "deleting a disk-only session must work");
    assert.equal((await (await fetch(h.server.url + "api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "activate", id: "hist-two" }),
    })).json()).error !== undefined, true, "the deleted one is gone");
  } finally {
    await h.stop();
  }
});


import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Session } from "../src/core/session.ts";
import { MockProvider } from "../src/providers/mock.ts";
import { emptyRuleSet } from "../src/permissions/rules.ts";
import { Logger } from "../src/util/log.ts";
import { startServer } from "../src/server/app.ts";
import { SessionStore } from "../src/session/store.ts";

const logger = new Logger("error");

async function tempWorkspace(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "mh-del-"));
}

function makeSession(root: string): Session {
  return new Session({
    workspaceRoot: root,
    settings: { permissionMode: "default", sandboxMode: "workspace-write", maxTurns: 4 },
    rules: emptyRuleSet(),
    provider: new MockProvider([{ text: "ok", stopReason: "end_turn" }]),
    model: "mock-1",
    logger,
    approve: async () => "allow",
  });
}

function sessionsDir(root: string): string {
  return path.join(root, ".harness", "sessions");
}

async function boot(root: string) {
  const session = makeSession(root);
  await session.init();
  const server = await startServer({
    session,
    makeSession: async () => makeSession(root),
    logger,
    port: 0,
    providerId: "mock",
    autoApprove: true,
  });
  return { server, session };
}

async function post(base: string, body: unknown) {
  const res = await fetch(base + "api/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

test("store: remove deletes the transcript and its backups", async () => {
  const root = await tempWorkspace();
  const store = new SessionStore(sessionsDir(root));
  await store.init();
  const id = "20260101-000000-abc123";
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
  await store.saveTranscript(id, []);

  assert.equal(existsSync(path.join(sessionsDir(root), id + ".jsonl")), true);
  assert.equal(await store.remove(id), true);
  assert.equal(existsSync(path.join(sessionsDir(root), id + ".jsonl")), false);

  const leftovers = (await readdir(sessionsDir(root))).filter((f) => f.startsWith(id));
  assert.deepEqual(leftovers, [], "transcript backups are removed too");

  assert.equal(await store.remove(id), false, "removing twice reports nothing removed");
});

test("server: deleting a session removes it from the list and from disk", async () => {
  const root = await tempWorkspace();
  const { server, session } = await boot(root);
  try {
    const original = session.sessionId;
    const created = await post(server.url, { action: "new" });
    assert.equal(created.status, 200);
    assert.equal(created.data.sessions.length, 2);

    assert.equal(existsSync(path.join(sessionsDir(root), original + ".jsonl")), true);

    const deleted = await post(server.url, { action: "delete", id: original });
    assert.equal(deleted.status, 200);
    assert.equal(deleted.data.sessions.some((s: any) => s.id === original), false);
    assert.equal(existsSync(path.join(sessionsDir(root), original + ".jsonl")), false, "会话文件必须一起删掉");
  } finally {
    await server.close();
  }
});

test("server: the last remaining session cannot be deleted", async () => {
  const root = await tempWorkspace();
  const { server, session } = await boot(root);
  try {
    const res = await post(server.url, { action: "delete", id: session.sessionId });
    assert.equal(res.status, 400);
    assert.match(String(res.data.error), /最后一个会话/);
    assert.equal(existsSync(path.join(sessionsDir(root), session.sessionId + ".jsonl")), true);
  } finally {
    await server.close();
  }
});

test("server: historical (not loaded) sessions can be deleted", async () => {
  const root = await tempWorkspace();
  const { server } = await boot(root);
  try {
    const id = "20250101-120000-oldone";
    const file = path.join(sessionsDir(root), id + ".jsonl");
    await writeFile(
      file,
      JSON.stringify({
        type: "meta",
        id,
        createdAt: new Date().toISOString(),
        cwd: root,
        workspaceRoot: root,
        model: "mock-1",
        provider: "mock",
        permissionMode: "default",
        sandboxMode: "workspace-write",
      }) +
        "\n" +
        JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "历史对话" }] } }) +
        "\n",
      "utf8",
    );
    assert.equal(existsSync(file), true);

    const res = await post(server.url, { action: "delete", id });
    assert.equal(res.status, 200);
    assert.equal(existsSync(file), false, "磁盘上的历史会话同样被删除");
  } finally {
    await server.close();
  }
});

test("server: deleting an unknown session is a 404", async () => {
  const root = await tempWorkspace();
  const { server } = await boot(root);
  try {
    const res = await post(server.url, { action: "delete", id: "does-not-exist" });
    assert.equal(res.status, 404);
  } finally {
    await server.close();
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Session } from "../src/core/session.ts";
import { MockProvider } from "../src/providers/mock.ts";
import { emptyRuleSet } from "../src/permissions/rules.ts";
import { Logger } from "../src/util/log.ts";
import { startServer } from "../src/server/app.ts";
import { createWorktree, listWorktrees, removeWorktree, repositoryRoot, validateWorktreeName } from "../src/core/worktrees.ts";

const logger = new Logger("error");

/** Windows 8.3 短路径：两边都规范化后再比。 */
const real = (p: string) => realpathSync.native(p);

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString("utf8");
}

async function makeRepo(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "jys-wt-"));
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Test"]);
  await writeFile(path.join(root, "README.md"), "# demo\n", "utf8");
  git(root, ["add", "."]);
  git(root, ["commit", "-q", "-m", "init"]);
  return root;
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

test("worktree: repository detection and name validation", async () => {
  const repo = await makeRepo();
  assert.equal(real(await repositoryRoot(repo)!), real(repo));

  const plain = await mkdtemp(path.join(os.tmpdir(), "jys-wt-plain-"));
  assert.equal(await repositoryRoot(plain), null);

  assert.equal(validateWorktreeName("fix-login"), null);
  assert.match(validateWorktreeName("a b") ?? "", /只能包含/);
  assert.match(validateWorktreeName("") ?? "", /不能为空/);
});

test("worktree: create, list and remove", async () => {
  const repo = await makeRepo();
  const initial = await listWorktrees(repo);
  assert.equal(initial.length, 1);
  assert.equal(initial[0].isMain, true);

  const created = await createWorktree(repo, "task-a");
  assert.equal(created.ok, true, created.ok ? "" : created.error);
  if (!created.ok) return;
  assert.equal(created.branch, "jys/task-a");
  assert.ok(existsSync(created.path));
  assert.ok(existsSync(path.join(created.path, "README.md")), "worktree has the repo content");

  const after = await listWorktrees(repo);
  assert.equal(after.length, 2);
  const task = after.find((w) => real(w.path) === real(created.path));
  assert.ok(task);
  assert.equal(task!.branch, "jys/task-a");
  assert.equal(task!.isMain, false);

  // 同名重复创建被拒绝
  const again = await createWorktree(repo, "task-a");
  assert.equal(again.ok, false);

  const removed = await removeWorktree(repo, created.path, true);
  assert.equal(removed.ok, true, removed.ok ? "" : removed.error);
  assert.equal(existsSync(created.path), false);
  assert.equal((await listWorktrees(repo)).length, 1);
});

test("worktree: the main worktree cannot be removed", async () => {
  const repo = await makeRepo();
  const res = await removeWorktree(repo, repo);
  assert.equal(res.ok, false);
  assert.match(res.ok ? "" : res.error, /主工作树/);
});

test("server: worktree endpoints create an isolated session", async () => {
  const repo = await makeRepo();
  const session = makeSession(repo);
  await session.init();
  const mainSessionId = session.sessionId;

  const server = await startServer({
    session,
    makeSession: async (root?: string) => makeSession(root ?? repo),
    logger,
    port: 0,
    providerId: "mock",
    autoApprove: true,
  });

  try {
    const listed = await (await fetch(server.url + "api/worktrees")).json();
    assert.equal(real(listed.repo), real(repo));
    assert.equal(listed.worktrees.length, 1);

    const created = await (
      await fetch(server.url + "api/worktrees", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "create", name: "task-b" }),
      })
    ).json();
    assert.equal(created.ok, true, created.error);
    assert.ok(created.state, "state returned");
    assert.equal(real(created.state.workspace), real(created.path));
    assert.equal(created.state.messages.length, 0, "fresh session in the new worktree");
    assert.notEqual(created.state.sessionId, mainSessionId, "sessions are per-worktree");

    const bad = await fetch(server.url + "api/worktrees", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "create", name: "bad name" }),
    });
    assert.equal(bad.status, 400);

    const removed = await (
      await fetch(server.url + "api/worktrees", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "remove", path: created.path, force: true }),
      })
    ).json();
    assert.equal(removed.ok, true, JSON.stringify(removed));
    assert.equal(removed.state.sessionId, mainSessionId, "falls back to the main worktree");
    assert.equal(existsSync(created.path), false);
  } finally {
    await server.close();
  }
});

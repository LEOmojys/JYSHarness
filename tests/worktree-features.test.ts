import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createWorktree, listWorktrees } from "../src/core/worktrees.ts";
import { guardPath } from "../src/sandbox/paths.ts";
import type { SandboxPolicy } from "../src/sandbox/paths.ts";

const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd }).toString("utf8").trim();

async function repo() {
  const root = await mkdtemp(path.join(os.tmpdir(), "jys-wt2-"));
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "t@e.com"]);
  git(root, ["config", "user.name", "T"]);
  await writeFile(path.join(root, "a.txt"), "x\n", "utf8");
  git(root, ["add", "."]);
  git(root, ["commit", "-q", "-m", "init"]);
  return root;
}

test("worktree: local config files are carried into the new worktree", async () => {
  const root = await repo();
  await writeFile(path.join(root, ".env"), "TOKEN=x\n", "utf8");
  const created = await createWorktree(root, "with-env");
  assert.equal(created.ok, true, created.ok ? "" : created.error);
  if (!created.ok) return;
  assert.deepEqual(created.copied, [".env"]);
  assert.ok(existsSync(path.join(created.path, ".env")));
});

test("worktree: a chosen base branch is used", async () => {
  const root = await repo();
  git(root, ["checkout", "-q", "-b", "release"]);
  await writeFile(path.join(root, "b.txt"), "b\n", "utf8");
  git(root, ["add", "."]);
  git(root, ["commit", "-q", "-m", "release"]);
  git(root, ["checkout", "-q", "master"]);
  const created = await createWorktree(root, "from-release", "release");
  assert.equal(created.ok, true);
  if (!created.ok) return;
  assert.ok(existsSync(path.join(created.path, "b.txt")), "based on release branch");
});

test("worktree: list reports uncommitted change counts", async () => {
  const root = await repo();
  const created = await createWorktree(root, "dirty-task");
  if (!created.ok) return assert.fail(created.error);
  await writeFile(path.join(created.path, "a.txt"), "changed\n", "utf8");
  const list = await listWorktrees(root);
  const found = list.find((w) => w.branch === "jys/dirty-task");
  assert.ok(found);
  assert.ok((found.dirty || 0) >= 1, "dirty=" + found.dirty);
});

test("sandbox: another task worktree is not writable from this workspace", async () => {
  const root = await repo();
  const created = await createWorktree(root, "other-task");
  if (!created.ok) return assert.fail(created.error);
  const policy: SandboxPolicy = { mode: "workspace-write", workspaceRoot: root };
  const blocked = guardPath(path.join(created.path, "a.txt"), { access: "write", policy });
  assert.equal(blocked.decision && blocked.decision.behavior, "deny");
  const ok = guardPath(path.join(root, "a.txt"), { access: "write", policy });
  assert.notEqual(ok.decision && ok.decision.behavior, "deny");
});
test("worktree: an old narrow exclude rule is migrated on first listing", async () => {
  const root = await repo();
  // 模拟老版本写下的窄规则：只排除 .harness/worktrees/，sessions 会漏出去。
  await writeFile(path.join(root, ".git", "info", "exclude"), ".harness/worktrees/\n", "utf8");
  await mkdir(path.join(root, ".harness", "sessions"), { recursive: true });
  await writeFile(path.join(root, ".harness", "sessions", "s.json"), "{}\n", "utf8");
  assert.match(git(root, ["status", "--porcelain"]), /\?\? \.harness\//);
  await listWorktrees(root);
  const exclude = readFileSync(path.join(root, ".git", "info", "exclude"), "utf8");
  assert.match(exclude, /^\.harness\/$/m, "narrow rule replaced");
  assert.equal(git(root, ["status", "--porcelain"]), "", "git status is clean after migration");
});


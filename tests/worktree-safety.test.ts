import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createWorktree, removeWorktree } from "../src/core/worktrees.ts";

const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd }).toString("utf8").trim();

async function repo(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "jys-wt-fix-"));
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "t@e.com"]);
  git(root, ["config", "user.name", "T"]);
  await writeFile(path.join(root, "a.txt"), "x\n", "utf8");
  git(root, ["add", "."]);
  git(root, ["commit", "-q", "-m", "init"]);
  return root;
}

test("worktree: .harness/ is excluded so git status stays clean", async () => {
  const root = await repo();
  const created = await createWorktree(root, "task-a");
  assert.equal(created.ok, true, created.ok ? "" : created.error);
  if (!created.ok) return;

  await mkdir(path.join(root, ".harness", "sessions"), { recursive: true });
  await writeFile(path.join(root, ".harness", "sessions", "s1.jsonl"), "{}\n", "utf8");

  const status = git(root, ["status", "--porcelain"]);
  assert.equal(status, "", "git status 应为空，实际: " + status);

  const exclude = await readFile(path.join(root, ".git", "info", "exclude"), "utf8");
  assert.match(exclude, /^\.harness\/$/m, "exclude 里应写入 .harness/");
  assert.doesNotMatch(exclude, /^\.harness\/worktrees\/?$/m, "旧规则应被清掉");
});

test("worktree: removal refuses to discard uncommitted work unless forced", async () => {
  const root = await repo();
  const created = await createWorktree(root, "task-b");
  assert.equal(created.ok, true);
  if (!created.ok) return;

  // 制造一个未提交的改动
  await writeFile(path.join(created.path, "a.txt"), "changed\n", "utf8");

  const refused = await removeWorktree(root, created.path, false);
  assert.equal(refused.ok, false, "干净删除应被 git 拒绝");
  assert.ok(existsSync(created.path), "目录仍在，改动没丢");

  const forced = await removeWorktree(root, created.path, true);
  assert.equal(forced.ok, true, forced.ok ? "" : forced.error);
  assert.equal(existsSync(created.path), false);
});

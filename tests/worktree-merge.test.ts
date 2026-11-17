import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { alreadyMerged, currentBranch, isClean, mergeBranches, parseMergeTreeConflicts, preflight, preflightAll } from "../src/core/worktreeMerge.ts";
import { createWorktree } from "../src/core/worktrees.ts";

const git = (cwd: string, args: string[]) => spawnSync("git", args, { cwd, encoding: "utf8" });

function repo(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "jys-merge-"));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "t@example.com"]);
  git(dir, ["config", "user.name", "tester"]);
  writeFileSync(path.join(dir, "README.md"), "base" + String.fromCharCode(10), "utf8");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-qm", "base"]);
  return dir;
}

test("merge: two worktrees with disjoint changes both merge in", async () => {
  const dir = repo();
  const a = await createWorktree(dir, "task-a");
  const b = await createWorktree(dir, "task-b");
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  if (!a.ok || !b.ok) return;

  writeFileSync(path.join(a.path, "a.txt"), "from a" + String.fromCharCode(10), "utf8");
  git(a.path, ["add", "."]);
  git(a.path, ["commit", "-qm", "a"]);
  writeFileSync(path.join(b.path, "b.txt"), "from b" + String.fromCharCode(10), "utf8");
  git(b.path, ["add", "."]);
  git(b.path, ["commit", "-qm", "b"]);

  const res = mergeBranches(dir, { into: "main", branches: ["jys/task-a", "jys/task-b"] });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(res.merged, ["jys/task-a", "jys/task-b"]);
  assert.ok(existsSync(path.join(dir, "a.txt")), "a.txt 应合入主仓库");
  assert.ok(existsSync(path.join(dir, "b.txt")), "b.txt 应合入主仓库");
});

test("merge: preflight flags a real conflict without touching the worktree", async () => {
  const dir = repo();
  const a = await createWorktree(dir, "conf-a");
  const b = await createWorktree(dir, "conf-b");
  if (!a.ok || !b.ok) return;
  // 两边改同一行 → 必冲突
  writeFileSync(path.join(a.path, "README.md"), "from a" + String.fromCharCode(10), "utf8");
  git(a.path, ["add", "."]);
  git(a.path, ["commit", "-qm", "a"]);
  writeFileSync(path.join(b.path, "README.md"), "from b" + String.fromCharCode(10), "utf8");
  git(b.path, ["add", "."]);
  git(b.path, ["commit", "-qm", "b"]);

  const before = readFileSync(path.join(dir, "README.md"), "utf8");
  const pf = preflightAll(dir, "main", ["jys/conf-a", "jys/conf-b"]);
  assert.equal(preflight(dir, "main", "jys/conf-a").conflicts, false, "第一个分支可以干净合并");
  const second = pf.find((x) => x.branch === "jys/conf-b");
  assert.equal(second?.conflicts, true, "第二个分支与已合并的第一个冲突");
  assert.deepEqual(second?.files, ["README.md"], "要能指出冲突文件");
  assert.equal(readFileSync(path.join(dir, "README.md"), "utf8"), before, "预检不能改动工作区");
});

test("merge: stops at the first conflict and leaves a clean repo", async () => {
  const dir = repo();
  const a = await createWorktree(dir, "seq-a");
  const b = await createWorktree(dir, "seq-b");
  if (!a.ok || !b.ok) return;
  writeFileSync(path.join(a.path, "README.md"), "from a" + String.fromCharCode(10), "utf8");
  git(a.path, ["add", "."]);
  git(a.path, ["commit", "-qm", "a"]);
  writeFileSync(path.join(b.path, "README.md"), "from b" + String.fromCharCode(10), "utf8");
  git(b.path, ["add", "."]);
  git(b.path, ["commit", "-qm", "b"]);

  const res = mergeBranches(dir, { into: "main", branches: ["jys/seq-a", "jys/seq-b"] });
  assert.equal(res.ok, false);
  assert.deepEqual(res.merged, ["jys/seq-a"], "冲突前的分支已合并");
  assert.deepEqual(res.blocked?.files, ["README.md"]);
  // 只看已跟踪文件：未跟踪的 .harness/ 与锁文件跟"有没有留下半合并状态"无关，
  // 拿裸 porcelain 断言会因未跟踪产物偶发失败。
  const st = git(dir, ["status", "--porcelain", "--untracked-files=no"]);
  assert.equal(String(st.stdout).trim(), "", "冲突后必须回到干净状态（不能留下 MERGING）");
});

test("merge: refuses when the main worktree has uncommitted changes", () => {
  const dir = repo();
  writeFileSync(path.join(dir, "README.md"), "dirty" + String.fromCharCode(10), "utf8");
  const res = mergeBranches(dir, { into: "main", branches: ["jys/whatever"] });
  assert.equal(res.ok, false);
  assert.match(res.error ?? "", /未提交改动/, "必须拒绝而不是把脏改动卷进合并提交");
});

test("merge: already-merged branches are skipped", async () => {
  const dir = repo();
  const a = await createWorktree(dir, "skip-a");
  if (!a.ok) return;
  writeFileSync(path.join(a.path, "x.txt"), "x" + String.fromCharCode(10), "utf8");
  git(a.path, ["add", "."]);
  git(a.path, ["commit", "-qm", "x"]);
  assert.equal(mergeBranches(dir, { into: "main", branches: ["jys/skip-a"] }).ok, true);
  assert.equal(alreadyMerged(dir, "main", "jys/skip-a"), true);
  const again = mergeBranches(dir, { into: "main", branches: ["jys/skip-a"] });
  assert.equal(again.ok, true);
  assert.deepEqual(again.merged, [], "重复合并应跳过");
});

test("merge: current branch and cleanliness helpers", () => {
  const dir = repo();
  assert.equal(currentBranch(dir), "main");
  assert.equal(isClean(dir).clean, true);
  writeFileSync(path.join(dir, "n.txt"), "n" + String.fromCharCode(10), "utf8");
  assert.equal(isClean(dir).clean, false, "未跟踪文件也算脏");
});

test("merge: conflict parser extracts file paths", () => {
  const out = ["100644 abc 1\tREADME.md", "CONFLICT (content): Merge conflict in README.md", "CONFLICT (modify/delete): src/x.ts deleted in a and modified in b"].join(String.fromCharCode(10));
  const files = parseMergeTreeConflicts(out);
  assert.ok(files.includes("README.md"));
  assert.ok(files.some((f) => f.startsWith("src/x.ts")));
});

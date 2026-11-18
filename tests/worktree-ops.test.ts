import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { branchPaths, conflictedFiles, linkDependencies, rebaseWorktree, resolveAndCommit, runVerify, verifyBranches, withRepoLock } from "../src/core/worktreeOps.ts";
import { createWorktree } from "../src/core/worktrees.ts";
import { mergeBranches, mergeBranchesAsync } from "../src/core/worktreeMerge.ts";

const git = (cwd: string, args: string[]) => spawnSync("git", args, { cwd, encoding: "utf8" });
const NL = String.fromCharCode(10);

/**
 * 只看**已跟踪文件**是否干净。
 *
 * 为什么不用裸 git status --porcelain：它会顺带报告未跟踪文件（.harness/、锁文件、
 * 临时产物），这些和"合并是否留下半成品状态"无关，却会让断言在并行/时序下偶发失败。
 * 我们要判定的是"没有半合并/半 rebase 状态"，--untracked-files=no 才是正确的判据。
 */
const trackedDirty = (dir: string): string =>
  String(git(dir, ["status", "--porcelain", "--untracked-files=no"]).stdout ?? "").trim();

function repo(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "jys-ops-"));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "t@example.com"]);
  git(dir, ["config", "user.name", "t"]);
  writeFileSync(path.join(dir, "README.md"), "base" + NL, "utf8");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-qm", "base"]);
  return dir;
}

test("lock: second acquisition waits for the first to finish", async () => {
  const dir = repo();
  const order: string[] = [];
  const first = withRepoLock(dir, async () => {
    order.push("a-start");
    await new Promise((r) => setTimeout(r, 150));
    order.push("a-end");
  });
  const second = withRepoLock(dir, async () => { order.push("b-start"); }, { waitMs: 5000, pollMs: 20 });
  await Promise.all([first, second]);
  assert.deepEqual(order, ["a-start", "a-end", "b-start"], "必须互斥，不能交错");
  assert.equal(existsSync(path.join(dir, ".harness", "repo.lock")), false, "锁文件必须被释放");
});

test("lock: times out instead of hanging forever", async () => {
  const dir = repo();
  const held = withRepoLock(dir, async () => { await new Promise((r) => setTimeout(r, 400)); });
  const blocked = await withRepoLock(dir, async () => "never", { waitMs: 80, pollMs: 20 });
  assert.equal(blocked.ok, false);
  assert.match(blocked.ok === false ? blocked.error : "", /占用/);
  await held;
});

test("lock: a timed-out waiter cannot let later callers overtake the holder", async () => {
  const dir = repo();
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const held = withRepoLock(dir, () => gate);
  try {
    for (let i = 0; i < 2; i++) {
      const result = await withRepoLock(dir, () => "entered", { waitMs: 30, pollMs: 5 });
      assert.equal(result.ok, false);
    }
  } finally {
    release();
    await held;
  }
  assert.equal((await withRepoLock(dir, () => "entered")).ok, true);
});

test("lock: an old lock still belongs to its live owner", async () => {
  const dir = repo();
  mkdirSync(path.join(dir, ".harness"));
  const file = path.join(dir, ".harness", "repo.lock");
  writeFileSync(file, String(process.ppid));
  const old = new Date(Date.now() - 20 * 60_000);
  utimesSync(file, old, old);
  const result = await withRepoLock(dir, () => "entered", { waitMs: 30, pollMs: 5 });
  assert.equal(result.ok, false);
  assert.equal(readFileSync(file, "utf8"), String(process.ppid));
});

test("verify: reports pass and fail with output tail", async () => {
  const dir = repo();
  mkdirSync(path.join(dir, "scripts"), { recursive: true });
  writeFileSync(path.join(dir, "scripts", "ok.js"), "process.exit(0);" + NL, "utf8");
  writeFileSync(path.join(dir, "scripts", "bad.js"), "console.error(\"boom\"); process.exit(3);" + NL, "utf8");
  const ok = await runVerify(dir, "node scripts/ok.js");
  assert.equal(ok.ok, true);
  const bad = await runVerify(dir, "node scripts/bad.js");
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 3);
  assert.match(bad.tail, /boom/, "失败时要带回输出尾部");
});

test("verify: only branches checked out in a worktree can be verified", async () => {
  const dir = repo();
  const a = await createWorktree(dir, "verify-a");
  if (!a.ok) return;
  // Windows 上 git 给 8.3 短名、path.join 给长名，必须用真实路径比较（这条测试就是为它写的）
  const mapped = branchPaths(dir).get("jys/verify-a");
  assert.equal(mapped !== undefined, true, "分支必须能映射到工作树目录");
  assert.equal(realpathSync.native(mapped as string), realpathSync.native(a.path));
  const results = await verifyBranches(dir, ["jys/verify-a", "jys/not-there"], "node -e 0");
  assert.equal(results[0].ok, true);
  assert.equal(results[1].ok, false);
  assert.match(results[1].tail, /没有对应工作树/);
});

test("link: shares node_modules via junction and never overwrites", async () => {
  const dir = repo();
  mkdirSync(path.join(dir, "node_modules", "pkg"), { recursive: true });
  writeFileSync(path.join(dir, "node_modules", "pkg", "index.js"), "module.exports=1;" + NL, "utf8");
  const a = await createWorktree(dir, "link-a");
  if (!a.ok) return;
  const first = linkDependencies(dir, a.path, ["node_modules", "not-there"]);
  assert.equal(first.find((x) => x.name === "node_modules")?.status, "linked");
  assert.equal(first.find((x) => x.name === "not-there")?.status, "missing-in-source");
  assert.match(readFileSync(path.join(a.path, "node_modules", "pkg", "index.js"), "utf8"), /module.exports/);
  assert.equal(linkDependencies(dir, a.path, ["node_modules"])[0].status, "exists-in-target", "已存在不能覆盖");
});

test("rebase: replays the task branch onto a moved base", async () => {
  const dir = repo();
  const a = await createWorktree(dir, "reb-a");
  if (!a.ok) return;
  writeFileSync(path.join(a.path, "task.txt"), "task" + NL, "utf8");
  git(a.path, ["add", "."]);
  git(a.path, ["commit", "-qm", "task work"]);
  writeFileSync(path.join(dir, "main.txt"), "moved" + NL, "utf8");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-qm", "main moved"]);
  const res = rebaseWorktree(a.path, "main");
  assert.equal(res.ok, true, res.detail);
  assert.ok(existsSync(path.join(a.path, "main.txt")), "应包含主分支的新提交");
  assert.ok(existsSync(path.join(a.path, "task.txt")));
});

test("rebase: preserves an existing rebase and partially resolved files", () => {
  const dir = repo();
  const name = "草稿 文档.txt";
  writeFileSync(path.join(dir, name), "start\n");
  assert.equal(git(dir, ["add", "."]).status, 0);
  assert.equal(git(dir, ["commit", "-qm", "base file"]).status, 0);
  assert.equal(git(dir, ["switch", "-c", "task"]).status, 0);
  writeFileSync(path.join(dir, name), "task\n");
  assert.equal(git(dir, ["commit", "-qam", "task"]).status, 0);
  assert.equal(git(dir, ["switch", "main"]).status, 0);
  writeFileSync(path.join(dir, name), "main\n");
  assert.equal(git(dir, ["commit", "-qam", "main"]).status, 0);
  assert.equal(git(dir, ["switch", "task"]).status, 0);
  assert.notEqual(git(dir, ["rebase", "main"]).status, 0);
  writeFileSync(path.join(dir, name), "partial resolution\n");
  assert.equal(rebaseWorktree(dir, "main").ok, false);
  assert.equal(readFileSync(path.join(dir, name), "utf8"), "partial resolution\n");
  assert.deepEqual(conflictedFiles(dir), [name]);
  assert.equal(git(dir, ["rebase", "--abort"]).status, 0);
});

test("merge: resolver hook resolves a conflict and the merge completes", async () => {
  const dir = repo();
  const a = await createWorktree(dir, "res-a");
  const b = await createWorktree(dir, "res-b");
  if (!a.ok || !b.ok) return;
  writeFileSync(path.join(a.path, "README.md"), "A" + NL, "utf8");
  git(a.path, ["commit", "-qam", "A"]);
  writeFileSync(path.join(b.path, "README.md"), "B" + NL, "utf8");
  git(b.path, ["commit", "-qam", "B"]);
  const res = mergeBranches(dir, {
    into: "main",
    branches: ["jys/res-a", "jys/res-b"],
    resolve: ({ repoRoot, files }) => {
      assert.deepEqual(files, ["README.md"]);
      writeFileSync(path.join(repoRoot, "README.md"), "A+B" + NL, "utf8");
      return { ok: git(repoRoot, ["add", "."]).status === 0 };
    },
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(res.merged, ["jys/res-a", "jys/res-b"]);
  assert.equal(readFileSync(path.join(dir, "README.md"), "utf8").trim(), "A+B");
  assert.equal(trackedDirty(dir), "", "合并后必须干净");
});

test("merge: a failing resolver rolls back and reports the conflict", async () => {
  const dir = repo();
  const a = await createWorktree(dir, "bad-a");
  const b = await createWorktree(dir, "bad-b");
  if (!a.ok || !b.ok) return;
  writeFileSync(path.join(a.path, "README.md"), "A" + NL, "utf8");
  git(a.path, ["commit", "-qam", "A"]);
  writeFileSync(path.join(b.path, "README.md"), "B" + NL, "utf8");
  git(b.path, ["commit", "-qam", "B"]);
  const res = mergeBranches(dir, {
    into: "main",
    branches: ["jys/bad-a", "jys/bad-b"],
    resolve: () => ({ ok: false, detail: "resolver 放弃" }),
  });
  assert.equal(res.ok, false);
  assert.deepEqual(res.blocked?.files, ["README.md"]);
  assert.equal(trackedDirty(dir), "", "失败后必须回滚干净");
  assert.equal(conflictedFiles(dir).length, 0);
});


test("resolveAndCommit: commits after the resolver fixes the conflict", async () => {
  const dir = repo();
  const a = await createWorktree(dir, "rc-a");
  const b = await createWorktree(dir, "rc-b");
  if (!a.ok || !b.ok) return;
  writeFileSync(path.join(a.path, "README.md"), "A" + NL, "utf8");
  git(a.path, ["commit", "-qam", "A"]);
  writeFileSync(path.join(b.path, "README.md"), "B" + NL, "utf8");
  git(b.path, ["commit", "-qam", "B"]);
  // 先制造冲突现场：合并 A 后合 B，冲突停在索引里
  git(dir, ["merge", "jys/rc-a"]);
  const conflicted = git(dir, ["merge", "jys/rc-b"]);
  assert.notEqual(conflicted.status, 0, "这一步应当冲突");
  assert.deepEqual(conflictedFiles(dir), ["README.md"]);

  const res = await resolveAndCommit(dir, "jys/rc-b", async ({ files }) => {
    assert.deepEqual(files, ["README.md"]);
    writeFileSync(path.join(dir, "README.md"), "A+B" + NL, "utf8");
    git(dir, ["add", "."]);
    return { ok: true };
  });
  assert.equal(res.ok, true, res.detail);
  assert.equal(readFileSync(path.join(dir, "README.md"), "utf8").trim(), "A+B");
  assert.equal(trackedDirty(dir), "", "提交后必须干净");
});

test("resolveAndCommit: lies from the resolver are caught (still conflicted)", async () => {
  const dir = repo();
  const a = await createWorktree(dir, "lie-a");
  const b = await createWorktree(dir, "lie-b");
  if (!a.ok || !b.ok) return;
  writeFileSync(path.join(a.path, "README.md"), "A" + NL, "utf8");
  git(a.path, ["commit", "-qam", "A"]);
  writeFileSync(path.join(b.path, "README.md"), "B" + NL, "utf8");
  git(b.path, ["commit", "-qam", "B"]);
  git(dir, ["merge", "jys/lie-a"]);
  git(dir, ["merge", "jys/lie-b"]);

  const res = await resolveAndCommit(dir, "jys/lie-b", async () => ({ ok: true })); // 什么都没做却说 ok
  assert.equal(res.ok, false, "resolver 说解决但索引仍有冲突时必须拒绝");
  assert.match(res.detail, /仍有冲突/);
  assert.equal(trackedDirty(dir), "", "必须回滚干净");
});


test("mergeBranchesAsync: async resolver fixes the conflict and the merge continues", async () => {
  const dir = repo();
  const a = await createWorktree(dir, "as-a");
  const b = await createWorktree(dir, "as-b");
  if (!a.ok || !b.ok) return;
  writeFileSync(path.join(a.path, "README.md"), "A" + NL, "utf8");
  git(a.path, ["commit", "-qam", "A"]);
  writeFileSync(path.join(b.path, "README.md"), "B" + NL, "utf8");
  git(b.path, ["commit", "-qam", "B"]);

  let asked: string[] = [];
  const res = await mergeBranchesAsync(dir, {
    into: "main",
    branches: ["jys/as-a", "jys/as-b"],
    resolver: async ({ repoRoot, files }) => {
      asked = files;
      writeFileSync(path.join(repoRoot, "README.md"), "A+B" + NL, "utf8");
      git(repoRoot, ["add", "."]);
      return { ok: true };
    },
  });
  assert.deepEqual(asked, ["README.md"], "resolver 应收到冲突文件列表");
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(res.merged, ["jys/as-a", "jys/as-b"]);
  assert.equal(readFileSync(path.join(dir, "README.md"), "utf8").trim(), "A+B");
  assert.equal(trackedDirty(dir), "", "异步合并后也必须干净");
});

test("mergeBranchesAsync: async resolver failure rolls back", async () => {
  const dir = repo();
  const a = await createWorktree(dir, "af-a");
  const b = await createWorktree(dir, "af-b");
  if (!a.ok || !b.ok) return;
  writeFileSync(path.join(a.path, "README.md"), "A" + NL, "utf8");
  git(a.path, ["commit", "-qam", "A"]);
  writeFileSync(path.join(b.path, "README.md"), "B" + NL, "utf8");
  git(b.path, ["commit", "-qam", "B"]);
  const res = await mergeBranchesAsync(dir, {
    into: "main",
    branches: ["jys/af-a", "jys/af-b"],
    resolver: async () => ({ ok: false, detail: "agent 放弃" }),
  });
  assert.equal(res.ok, false);
  assert.deepEqual(res.blocked?.files, ["README.md"]);
  assert.equal(trackedDirty(dir), "", "失败后必须回滚干净");
});


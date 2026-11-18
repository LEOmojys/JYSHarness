import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createWorktree, removeWorktree, validateWorktreeName } from "../src/core/worktrees.ts";
import { withRepoLock } from "../src/core/worktreeOps.ts";

const git = (dir: string, args: string[]) =>
  execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

function repo(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wt-core-"));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "t@t"]);
  git(dir, ["config", "user.name", "t"]);
  writeFileSync(path.join(dir, "a.txt"), "x\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-qm", "init"]);
  return dir;
}

test("names: path fragments are rejected (. / .. / pure dots)", () => {
  // 这些能通过字符集，但拼进 .harness/worktrees/ 后指向别处
  for (const bad of [".", "..", "...", ""]) {
    assert.notEqual(validateWorktreeName(bad), null, "应拒绝 " + JSON.stringify(bad));
  }
  assert.equal(validateWorktreeName("feature-1"), null);
  assert.equal(validateWorktreeName("a.b_c-d"), null);
});

test("create: recreating after the directory was deleted reuses the existing branch", async () => {
  const r = repo();
  const first = await createWorktree(r, "w1");
  assert.equal(first.ok, true);

  // 提交一个只有这个分支才有的文件，验证"重建后历史还在"
  if (first.ok) {
    writeFileSync(path.join(first.path, "only-w1.txt"), "keep\n");
    git(first.path, ["add", "."]);
    git(first.path, ["commit", "-qm", "w1 work"]);
    rmSync(first.path, { recursive: true, force: true });
    git(r, ["worktree", "prune"]);
  }

  const again = await createWorktree(r, "w1");
  assert.equal(again.ok, true, again.ok ? "" : again.error);
  if (again.ok) {
    assert.ok(existsSync(path.join(again.path, "only-w1.txt")), "重建后应回到原分支的历史");
  }
});

test("create: duplicate create is rejected with a clear message", async () => {
  const r = repo();
  assert.equal((await createWorktree(r, "dup")).ok, true);
  const dup = await createWorktree(r, "dup");
  assert.equal(dup.ok, false);
  assert.match(dup.ok ? "" : dup.error, /目录已存在/);
});

test("remove: a dirty worktree needs --force", async () => {
  const r = repo();
  const w = await createWorktree(r, "dirty");
  assert.equal(w.ok, true);
  if (!w.ok) return;
  writeFileSync(path.join(w.path, "uncommitted.txt"), "x");
  const noForce = await removeWorktree(r, w.path, false);
  assert.equal(noForce.ok, false, "未提交改动时不该直接删掉");
  const forced = await removeWorktree(r, w.path, true);
  assert.equal(forced.ok, true);
  assert.equal(existsSync(w.path), false);
});

test("lock: a lock left by a dead process is taken over immediately", async () => {
  const r = repo();
  const dir = path.join(r, ".harness");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "repo.lock");
  // 999999 基本必然不存在的 pid（比等 10 分钟 mtime 过期现实得多）
  writeFileSync(file, "999999", "utf8");
  const started = Date.now();
  const res = await withRepoLock(r, () => "ok", { waitMs: 3_000, pollMs: 50 });
  const elapsed = Date.now() - started;
  assert.equal(res.ok, true, res.ok ? "" : res.error);
  assert.ok(elapsed < 1_000, "应立即接管，实际等了 " + elapsed + "ms");
  assert.equal(existsSync(file), false, "完成后锁文件必须清理");
});

test("lock:同一进程内的并发调用排队，不交错（进程内队列）", async () => {
  const r = repo();
  const order: string[] = [];
  const first = withRepoLock(r, async () => {
    order.push("a-start");
    await new Promise((res) => setTimeout(res, 120));
    order.push("a-end");
  });
  const second = withRepoLock(r, async () => {
    order.push("b-start");
    await new Promise((res) => setTimeout(res, 20));
    order.push("b-end");
  }, { waitMs: 5_000, pollMs: 20 });
  await Promise.all([first, second]);
  assert.deepEqual(order, ["a-start", "a-end", "b-start", "b-end"], "必须串行，不能交错");
});

test("lock: 上一次运行残留的同 pid 锁文件按陈旧处理", async () => {
  const r = repo();
  const dir = path.join(r, ".harness");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "repo.lock");
  // 进程崩过、后来 pid 被复用：文件里的 pid 正好等于当前进程
  writeFileSync(file, String(process.pid), "utf8");
  const started = Date.now();
  const res = await withRepoLock(r, () => "ok", { waitMs: 3_000, pollMs: 50 });
  assert.equal(res.ok, true, res.ok ? "" : res.error);
  assert.ok(Date.now() - started < 1_000, "应该立刻接管，而不是等 mtime 过期");
});

test("lock: 文件锁失败时结果不能被包装成 ok:true（互斥不能静默失效）", async () => {
  const r = repo();
  const dir = path.join(r, ".harness");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "repo.lock");
  // 用一个真实存活的外部进程当持有者
  const holder = spawn(process.execPath, ["-e", "setTimeout(()=>{}, 20000)"], { stdio: "ignore" });
  try {
    await new Promise((res) => setTimeout(res, 200));
    writeFileSync(file, String(holder.pid), "utf8");
    const res = await withRepoLock(r, () => "should-not-run", { waitMs: 300, pollMs: 50 });
    assert.equal(res.ok, false, "被外部进程持锁时必须返回失败，实际: " + JSON.stringify(res));
    assert.match(res.ok === false ? res.error : "", /占用/);
  } finally {
    holder.kill();
    rmSync(file, { force: true });
  }
});


import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createWorktree } from "../src/core/worktrees.ts";
import { mergeBranches, mergeBranchesAsync, preflightAll } from "../src/core/worktreeMerge.ts";

const git = (dir: string, args: string[]) =>
  execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

function repo(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wt-merge-"));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "t@t"]);
  git(dir, ["config", "user.name", "t"]);
  writeFileSync(path.join(dir, "a.txt"), "base\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-qm", "init"]);
  return dir;
}

/** 造两个工作树，都改 a.txt，必然冲突。 */
async function conflicting(repoRoot: string, x: string, y: string): Promise<[string, string]> {
  const p = await createWorktree(repoRoot, x);
  const q = await createWorktree(repoRoot, y);
  assert.ok(p.ok && q.ok);
  writeFileSync(path.join(p.path, "a.txt"), x + "\n");
  git(p.path, ["commit", "-qam", x]);
  writeFileSync(path.join(q.path, "a.txt"), y + "\n");
  git(q.path, ["commit", "-qam", y]);
  return ["jys/" + x, "jys/" + y];
}

test("merge: resolver that only edits files (no git add) still commits the resolution", async () => {
  const r = repo();
  const [b1, b2] = await conflicting(r, "x", "y");
  const out = mergeBranches(r, {
    branches: [b1, b2],
    resolve: ({ repoRoot, files }) => {
      writeFileSync(path.join(repoRoot, files[0]!), "resolved-by-test\n");
      return { ok: true };
    },
  });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(git(r, ["show", "HEAD:a.txt"]).trim(), "resolved-by-test", "提交里必须是解决后的内容");
});

test("merge: a resolver returning ok while conflict markers remain is rejected and rolled back", async () => {
  const r = repo();
  const [b1, b2] = await conflicting(r, "x", "y");
  const out = mergeBranches(r, {
    branches: [b1, b2],
    resolve: ({ repoRoot, files }) => {
      writeFileSync(path.join(repoRoot, files[0]!), "<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> other\n");
      return { ok: true };
    },
  });
  assert.equal(out.ok, false, "带冲突标记的'已解决'必须被拒");
  assert.match(out.error ?? "", /冲突标记/);
  assert.equal(git(r, ["status", "--porcelain"]).trim(), "", "仓库必须回滚干净");
  assert.ok(!git(r, ["show", "HEAD:a.txt"]).includes("<<<<<<<"), "冲突标记不能进提交");
});

test("merge: a failing resolver rolls back everything", async () => {
  const r = repo();
  const [b1, b2] = await conflicting(r, "x", "y");
  const out = mergeBranches(r, { branches: [b1, b2], resolve: () => ({ ok: false, detail: "agent 放弃" }) });
  assert.equal(out.ok, false);
  assert.equal(out.merged.length, 1, "第一个分支应已合并");
  assert.equal(git(r, ["status", "--porcelain"]).trim(), "");
});

test("merge accepts a resolver that already staged a deletion", async () => {
  const r = repo();
  const branches = await conflicting(r, "x", "y");
  const out = mergeBranches(r, {
    branches,
    resolve: ({ files }) => {
      git(r, ["rm", "--", ...files]);
      return { ok: true };
    },
  });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(git(r, ["ls-files", "--", "a.txt"]), "");
});

test("mergeAsync: accepts the same resolve option name as the sync API", async () => {
  const r = repo();
  const [b1, b2] = await conflicting(r, "x", "y");
  const out = await mergeBranchesAsync(r, {
    branches: [b1, b2],
    resolve: async ({ repoRoot, files }) => {
      writeFileSync(path.join(repoRoot, files[0]!), "async-resolved\n");
      return { ok: true };
    },
  });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(git(r, ["show", "HEAD:a.txt"]).trim(), "async-resolved");
});

test("mergeAsync: missing resolver yields a clear error instead of a TypeError", async () => {
  const r = repo();
  const out = await mergeBranchesAsync(r, { branches: ["jys/none"] } as never);
  assert.equal(out.ok, false);
  assert.match(out.error ?? "", /resolve/);
});

test("merge refuses a different checked-out target before either API writes", async () => {
  const r = repo();
  const [source] = await conflicting(r, "x", "y");
  git(r, ["branch", "other"]);
  const before = git(r, ["rev-parse", "HEAD"]);
  const opts = { branches: [source], into: "other" };
  assert.equal(mergeBranches(r, opts).ok, false);
  assert.equal((await mergeBranchesAsync(r, { ...opts, resolve: async () => ({ ok: true }) })).ok, false);
  assert.equal(git(r, ["rev-parse", "HEAD"]), before);
  assert.equal(git(r, ["rev-parse", "other"]), before);
});

test("a resolver exception aborts only the current merge in either API", async () => {
  const r = repo();
  const [a, b] = await conflicting(r, "x", "y");
  assert.equal(mergeBranches(r, { branches: [a] }).ok, true);
  const before = git(r, ["rev-parse", "HEAD"]);
  const fail = () => { throw new Error("resolver unavailable"); };
  for (const result of [
    mergeBranches(r, { branches: [b], resolve: fail }),
    await mergeBranchesAsync(r, { branches: [b], resolve: async () => fail() }),
  ]) {
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /resolver unavailable/);
  }
  assert.equal(git(r, ["rev-parse", "HEAD"]), before);
  assert.equal(git(r, ["status", "--porcelain"]), "");
});

test("preflight uses the actual ancestor of a diverged first branch", async () => {
  const r = repo();
  const [a, b] = await conflicting(r, "x", "y");
  assert.equal(mergeBranches(r, { branches: [a] }).ok, true);
  const plan = preflightAll(r, "main", [b]);
  assert.deepEqual(plan[0]?.files, ["a.txt"]);
  assert.equal(plan[0]?.conflicts, true);
  const absent = preflightAll(r, "main", ["absent"])[0];
  assert.ok(absent?.error);
  assert.equal(absent.conflicts, false);
});

test("preflight keeps both parents of earlier non-fast-forward merges", async () => {
  const r = repo();
  const [a, b] = await conflicting(r, "x", "y");
  writeFileSync(path.join(r, "other.txt"), "main\n");
  git(r, ["add", "other.txt"]);
  git(r, ["commit", "-qm", "main"]);
  const before = git(r, ["rev-parse", "HEAD"]);
  const plan = preflightAll(r, "main", [a, a, b]);
  assert.deepEqual(plan.map(p => [p.alreadyMerged, p.conflicts]), [[false, false], [true, false], [false, true]]);
  assert.deepEqual(plan[2]?.files, ["a.txt"]);
  assert.equal(git(r, ["rev-parse", "HEAD"]), before);
});

test("preflight: branches merged by the orchestrator are later reported as already merged", async () => {
  const r = repo();
  const [b1, b2] = await conflicting(r, "x", "y");
  mergeBranches(r, {
    branches: [b1, b2],
    resolve: ({ repoRoot, files }) => {
      writeFileSync(path.join(repoRoot, files[0]!), "both\n");
      return { ok: true };
    },
  });
  const plan = preflightAll(r, "main", [b1, b2]);
  assert.deepEqual(plan.map((p) => p.alreadyMerged), [true, true]);
});

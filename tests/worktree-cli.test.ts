import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { runWorktree } from "../src/cli/worktree.ts";
import { MockProvider } from "../src/providers/mock.ts";

function fixture(t: TestContext, conflict: boolean) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "jys-cli-merge-"));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.name", "tester");
  git("config", "user.email", "tester@example.com");
  mkdirSync(path.join(dir, ".jysharness"));
  writeFileSync(path.join(dir, ".jysharness", "settings.json"), '{"provider":"mock"}');
  const file = path.join(dir, "message.txt");
  writeFileSync(file, "base\n");
  git("add", ".");
  git("commit", "-qm", "base");
  git("checkout", "-qb", "task");
  writeFileSync(file, "task\n");
  git("commit", "-qam", "task");
  git("checkout", "-q", "main");
  if (conflict) {
    writeFileSync(file, "main\n");
    git("commit", "-qam", "main");
  }
  return { dir, file, git };
}

test("worktree merge accepts boolean flags before branches in a fresh repository", async (t) => {
  const { dir, file, git } = fixture(t, false);
  assert.equal(await runWorktree(["merge", "--no-ff", "task"], dir), 0);
  assert.equal(readFileSync(file, "utf8").trim(), "task");
  assert.equal(git("rev-parse", "HEAD^2"), git("rev-parse", "task"));
});

for (const exitCode of [0, 1]) {
  test("agent merge runs verification before commit (exit " + exitCode + ")", async (t) => {
    const { dir, file, git } = fixture(t, true);
    const before = git("rev-parse", "HEAD");
    const model = new MockProvider([
      // 先读后写：覆盖已存在的冲突文件前必须先读它
      { toolCalls: [{ name: "Read", input: { file_path: "message.txt" } }] },
      { toolCalls: [{ name: "Write", input: { file_path: "message.txt", content: "combined\n" } }] },
      { text: "done" },
    ]);
    t.mock.method(MockProvider.prototype, "stream", model.stream.bind(model));
    const cmd = 'node -e "if(require(\'fs\').existsSync(\'.git/MERGE_HEAD\')) process.exit(' + exitCode + ')"';
    const code = await runWorktree(["merge", "--force-merge", "--resolve-with-agent", "task", "--verify", cmd], dir);
    assert.equal(code, exitCode);
    assert.equal(model.requests.length, 3);
    assert.equal(existsSync(path.join(dir, ".git", "MERGE_HEAD")), false);
    if (exitCode) {
      assert.equal(git("rev-parse", "HEAD"), before);
      assert.equal(readFileSync(file, "utf8").trim(), "main");
    } else {
      assert.equal(git("rev-parse", "HEAD^2"), git("rev-parse", "task"));
      assert.equal(readFileSync(file, "utf8").trim(), "combined");
    }
  });
}

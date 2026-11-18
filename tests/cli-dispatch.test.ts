import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../src/cli/main.ts", import.meta.url));

function workspace(t: TestContext) {
  const root = mkdtempSync(path.join(os.tmpdir(), "jys-cli-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  function run(...args: string[]) {
    const result = spawnSync(process.execPath, [cli, ...args], {
      cwd: root, env: { ...process.env, HARNESS_HOME: path.join(root, "home") },
      encoding: "utf8", timeout: 15_000,
    });
    if (result.error) throw result.error;
    return result;
  }
  return { root, run };
}

test("print prompts and later words of a prompt may match a subcommand", (t) => {
  const { run } = workspace(t);
  for (const prompt of [["-p", "skill"], ["please", "check"]]) {
    const result = run("--provider", "mock", ...prompt);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /mock provider ready/);
  }
});

test("a workspace named after a subcommand can precede the actual command", (t) => {
  const { root, run } = workspace(t);
  mkdirSync(path.join(root, "worktree"));
  const result = run("--workspace", "worktree", "skill", "--json");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).skills, []);
});

test("skill import validates its destination and skips directories and existing files", (t) => {
  const { root, run } = workspace(t);
  mkdirSync(path.join(root, "input", "collection.md"), { recursive: true });
  writeFileSync(path.join(root, "input", "sample.md"), "# sample");
  const args = ["skill", "import-dsh", "input"];
  const dest = path.join(root, ".harness", "skills", "sample.md");
  assert.equal(run(...args, "--to", "invalid").status, 2);
  assert.equal(existsSync(dest), false);
  assert.equal(run(...args).status, 0);
  writeFileSync(dest, "local changes");
  assert.equal(run(...args).status, 0);
  assert.equal(readFileSync(dest, "utf8"), "local changes");
});

test("plugin scaffold honors --force and global values before the command name", (t) => {
  const { root, run } = workspace(t);
  const args = ["--script", "config.json", "plugin", "new", "sample"];
  assert.equal(run(...args).status, 0);
  const readme = path.join(root, ".harness", "plugins", "sample", "README.md");
  writeFileSync(readme, "changed");
  assert.equal(run(...args).status, 1);
  assert.equal(readFileSync(readme, "utf8"), "changed");
  assert.equal(run(...args, "--force").status, 0);
  assert.match(readFileSync(readme, "utf8"), /sample/);
  assert.equal(run("plugin", "disable", "sample").status, 0);
  const list = run("plugin", "list");
  assert.match(list.stdout, /sample/);
  assert.match(list.stdout, /已停用/);
  assert.equal(run("plugin", "enable", "sample").status, 0);
});

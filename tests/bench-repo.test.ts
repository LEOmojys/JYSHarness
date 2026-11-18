import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { extractPatch, prepareRepo, resetToBase } from "../src/bench/sweRepo.ts";

const git = (dir: string, ...args: string[]) =>
  execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

test("SWE repository captures final source against base and starts each attempt clean", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "swe-repo-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const upstream = path.join(root, "upstream");
  mkdirSync(upstream);
  git(upstream, "init", "-q");
  mkdirSync(path.join(upstream, "tests"));
  writeFileSync(path.join(upstream, "tests", "sample.py"), "original test\n");
  writeFileSync(path.join(upstream, "module.py"), "original\n");
  git(upstream, "add", ".");
  git(upstream, "-c", "user.name=Fixture", "-c", "user.email=t@example.org", "commit", "-qm", "base");

  const inst = { repo: "fixture/repo", instance_id: "fixture__repo-1", base_commit: git(upstream, "rev-parse", "HEAD") };
  const dir = path.join(root, inst.instance_id);
  const config = path.join(root, "gitconfig");
  git(root, "config", "--file", config, "url." + pathToFileURL(upstream).href + ".insteadOf", "https://github.com/fixture/repo");
  const saved = { GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL, GIT_ALLOW_PROTOCOL: process.env.GIT_ALLOW_PROTOCOL };
  Object.assign(process.env, { GIT_CONFIG_GLOBAL: config, GIT_ALLOW_PROTOCOL: "file" });
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const prep = prepareRepo(dir, inst);
  assert.ok(prep.ok, prep.detail);
  writeFileSync(path.join(dir, "module.py"), "committed change\n");
  git(dir, "add", ".");
  git(dir, "-c", "user.name=Fixture", "-c", "user.email=t@example.org", "commit", "-qm", "model");
  writeFileSync(path.join(dir, "staged.py"), "staged source\n");
  git(dir, "add", "staged.py");
  writeFileSync(path.join(dir, "untracked.py"), "new source\n");
  writeFileSync(path.join(dir, "tests", "sample.py"), "model test\n");
  mkdirSync(path.join(dir, ".harness"));
  writeFileSync(path.join(dir, ".harness", "test.patch"), "old grading data");
  mkdirSync(path.join(dir, ".venv"));
  writeFileSync(path.join(dir, ".venv", "interpreter"), "installed");
  const before = git(dir, "status", "--porcelain=v1");
  const patch = extractPatch(dir, inst);
  assert.equal(git(dir, "status", "--porcelain=v1"), before);
  assert.doesNotMatch(patch, /model test|old grading data|installed/);
  for (const line of ["committed change", "staged source", "new source"]) assert.ok(patch.includes("+" + line), line);

  const reset = resetToBase(dir, inst);
  assert.ok(reset.ok, reset.detail);
  assert.equal(git(dir, "rev-parse", "HEAD"), inst.base_commit);
  assert.equal(readFileSync(path.join(dir, "tests", "sample.py"), "utf8").trimEnd(), "original test");
  assert.equal(existsSync(path.join(dir, "staged.py")), false);
  assert.equal(existsSync(path.join(dir, ".venv", "interpreter")), true);
  execFileSync("git", ["apply", "-"], { cwd: dir, input: patch, stdio: ["pipe", "pipe", "pipe"] });
  const again = prepareRepo(dir, inst);
  assert.ok(again.ok, again.detail);
  assert.equal(existsSync(path.join(dir, "untracked.py")), false);
  assert.equal(existsSync(path.join(dir, ".harness", "test.patch")), false);
  assert.equal(readFileSync(path.join(dir, "module.py"), "utf8").trimEnd(), "original");
});

test("SWE repository refuses to reset an existing unmanaged directory", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "swe-unmanaged-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const inst = { repo: "fixture/repo", instance_id: "fixture__repo-2", base_commit: "1".repeat(40) };
  const dir = path.join(root, inst.instance_id);
  mkdirSync(dir);
  git(dir, "init", "-q");
  writeFileSync(path.join(dir, "user.txt"), "keep");
  assert.equal(prepareRepo(dir, inst).ok, false);
  assert.equal(resetToBase(dir, inst).ok, false);
  assert.equal(readFileSync(path.join(dir, "user.txt"), "utf8"), "keep");
});

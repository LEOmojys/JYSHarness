import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { installHook, runChecks } from "../src/quality/checks.ts";
import { loadProjectDocs } from "../src/context/systemPrompt.ts";

function bare(root: string): void {
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "x", version: "1.0.0", dependencies: {} }), "utf8");
}

function write(root: string, relPath: string, body: string): void {
  const abs = path.join(root, relPath);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, body, "utf8");
}

function tempRepo(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "jys-check-"));
  bare(root);
  write(root, "src/core/a.ts", "export const a = 1;" + String.fromCharCode(10));
  write(root, "README.md", "# doc" + String.fromCharCode(10));
  return root;
}

test("constraints: a clean repo passes", () => {
  const root = tempRepo();
  const report = runChecks({ root });
  assert.equal(report.errors, 0, JSON.stringify(report.findings));
});

test("constraints: a broken relative import is an error with file:line", () => {
  const root = tempRepo();
  write(root, "src/core/b.ts", "import { x } from \"./missing.ts\";" + String.fromCharCode(10));
  const report = runChecks({ root });
  const hit = report.findings.find((f) => f.rule === "imports.resolve");
  assert.ok(hit, JSON.stringify(report.findings));
  assert.equal(hit.level, "error");
  assert.equal(hit.file, "src/core/b.ts");
  assert.equal(hit.line, 1);
});

test("constraints: core importing the server layer is rejected", () => {
  const root = tempRepo();
  write(root, "src/server/app.ts", "export const s = 1;" + String.fromCharCode(10));
  write(root, "src/core/c.ts", "import { s } from \"../server/app.ts\";" + String.fromCharCode(10));
  const report = runChecks({ root });
  const hit = report.findings.find((f) => f.rule === "layering");
  assert.ok(hit, JSON.stringify(report.findings));
  assert.match(hit.message, /核心逻辑不得依赖入口层/);
  // 反向（入口层依赖核心）必须放行，否则规则就成了摆设
  write(root, "src/server/uses-core.ts", "import { a } from \"../core/a.ts\";" + String.fromCharCode(10));
  const after = runChecks({ root });
  assert.equal(after.findings.filter((f) => f.rule === "layering").length, 1);
});

test("constraints: runtime dependencies break the zero-dep rule", () => {
  const root = tempRepo();
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "x", dependencies: { express: "4" } }), "utf8");
  const report = runChecks({ root });
  const hit = report.findings.find((f) => f.rule === "deps.zero");
  assert.ok(hit);
  assert.equal(hit.level, "error");
});

test("constraints: a doc link to a missing file is caught, a real one is not", () => {
  const root = tempRepo();
  write(root, "docs/shot.png", "not-a-real-png");
  write(root, "README.md", "# doc" + String.fromCharCode(10) + "![ok](docs/shot.png)" + String.fromCharCode(10) + "![bad](docs/gone.png)" + String.fromCharCode(10));
  const report = runChecks({ root });
  const links = report.findings.filter((f) => f.rule === "docs.links");
  assert.equal(links.length, 1, JSON.stringify(links));
  assert.match(links[0].message, /docs\/gone.png/);
  assert.equal(links[0].line, 3);
});

test("constraints: fenced code blocks are not parsed for links", () => {
  const root = tempRepo();
  const fence = String.fromCharCode(96).repeat(3);
  write(root, "README.md", "# doc" + String.fromCharCode(10) + fence + String.fromCharCode(10) + "![x](docs/gone.png)" + String.fromCharCode(10) + fence + String.fromCharCode(10));
  assert.equal(runChecks({ root }).findings.filter((f) => f.rule === "docs.links").length, 0);
});

test("constraints: a hardcoded key is an error, the docs' masked sample is not", () => {
  const root = tempRepo();
  write(root, "src/config.ts", "const key = \"sk-ant-" + "a".repeat(30) + "\";" + String.fromCharCode(10));
  const report = runChecks({ root });
  const hit = report.findings.find((f) => f.rule === "secrets");
  assert.ok(hit, JSON.stringify(report.findings));
  assert.equal(hit.file, "src/config.ts");
  // README 里那种 sk-m...3456 的掩码不算
  const clean = tempRepo();
  write(clean, "README.md", "key looks like sk-m...3456");
  assert.equal(runChecks({ root: clean }).findings.filter((f) => f.rule === "secrets").length, 0);
});

test("entropy: oversized files and TODO markers are warnings, not errors", () => {
  const root = tempRepo();
  const filler = Array.from({ length: 950 }, (_, i) => "export const v" + i + " = " + i + ";").join(String.fromCharCode(10));
  write(root, "src/core/fat.ts", filler + String.fromCharCode(10));
  write(root, "src/core/todo.ts", "// TODO: wire this up" + String.fromCharCode(10) + "export const t = 1;" + String.fromCharCode(10));
  const report = runChecks({ root, entropy: true });
  assert.equal(report.errors, 0, JSON.stringify(report.findings));
  assert.ok(report.findings.some((f) => f.rule === "entropy.size" && f.file === "src/core/fat.ts"));
  assert.ok(report.findings.some((f) => f.rule === "entropy.todo" && f.file === "src/core/todo.ts"));
});

test("entropy: prose mentioning the marker is not a TODO", () => {
  const root = tempRepo();
  write(root, "src/core/note.ts", "/** 大文件 / TODO / 版本漂移 这些词只是描述 */" + String.fromCharCode(10) + "export const n = 1;" + String.fromCharCode(10));
  const report = runChecks({ root, entropy: true });
  assert.equal(report.findings.filter((f) => f.rule === "entropy.todo").length, 0);
});

test("hook: install is idempotent and backs up a foreign hook", () => {
  const root = tempRepo();
  execFileSync("git", ["init", "-q"], { cwd: root });
  const foreign = path.join(root, ".git", "hooks", "pre-commit");
  mkdirSync(path.dirname(foreign), { recursive: true });
  writeFileSync(foreign, "#!/bin/sh" + String.fromCharCode(10) + "echo custom", "utf8");

  const first = installHook(root, process.execPath, "C:/x/main.ts");
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.ok(first.backup && existsSync(first.backup), "foreign hook must be backed up");
  assert.match(readFileSync(foreign, "utf8"), /check --entropy/);

  const second = installHook(root, process.execPath, "C:/x/main.ts");
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.equal(second.backup, undefined, "our own hook needs no backup");
  assert.equal(readFileSync(foreign, "utf8").split("check --entropy").length - 1, 1, "hook must not be appended twice");
});

test("context: project docs are collected from the repo root down to cwd", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "jys-docs-"));
  write(root, "AGENTS.md", "ROOT-RULE");
  write(root, "HARNESS.md", "ROOT-HARNESS");
  write(root, "packages/api/AGENTS.md", "API-RULE");
  write(root, "packages/api/src/CLAUDE.md", "SRC-RULE");

  const rootOnly = loadProjectDocs(root);
  assert.deepEqual(rootOnly.map((d) => d.content), ["ROOT-RULE", "ROOT-HARNESS"]);

  const deep = loadProjectDocs(root, path.join(root, "packages", "api", "src"));
  assert.deepEqual(deep.map((d) => d.content), ["ROOT-RULE", "ROOT-HARNESS", "API-RULE", "SRC-RULE"]);
  // 就近的约定排在后面：离当前工作目录越近，优先级越高
  assert.equal(deep[deep.length - 1].relPath, "packages/api/src/CLAUDE.md");

  // cwd 在仓库外时不能泄露根目录之外的任何文件
  const outside = loadProjectDocs(root, path.join(os.tmpdir(), "elsewhere"));
  assert.deepEqual(outside.map((d) => d.content), ["ROOT-RULE", "ROOT-HARNESS"]);
});

test("context: total doc budget is capped instead of growing without bound", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "jys-docs-"));
  write(root, "AGENTS.md", "x".repeat(50_000));
  write(root, "packages/a/AGENTS.md", "y".repeat(50_000));
  const docs = loadProjectDocs(root, path.join(root, "packages", "a"));
  const total = docs.reduce((sum, d) => sum + d.content.length, 0);
  assert.ok(total <= 32_000 + 64, "budget exceeded: " + total);
  assert.ok(docs.length >= 1);
});

test("entropy: a stale test count in the README is caught", () => {
  const root = tempRepo();
  write(root, "tests/one.test.ts", "test(\"a\", () => {});" + String.fromCharCode(10) + "test(\"b\", () => {});" + String.fromCharCode(10));
  write(root, "README.md", "# doc" + String.fromCharCode(10) + "**9 个测试**，分两组：" + String.fromCharCode(10));
  const stale = runChecks({ root, entropy: true }).findings.filter((f) => f.rule === "entropy.testCount");
  assert.equal(stale.length, 1, "declared 9, actual 2");
  assert.match(stale[0].message, /9 个测试/);
  assert.match(stale[0].message, /实际 2 个/);

  // 数字对齐后就不再报
  write(root, "README.md", "# doc" + String.fromCharCode(10) + "**2 个测试**" + String.fromCharCode(10));
  assert.equal(runChecks({ root, entropy: true }).findings.filter((f) => f.rule === "entropy.testCount").length, 0);
});

test("entropy: a packaged copy without tests/ does not report count drift", () => {
  const root = tempRepo();
  write(root, "README.md", "# doc" + String.fromCharCode(10) + "**9 个测试**" + String.fromCharCode(10));
  assert.equal(runChecks({ root, entropy: true }).findings.filter((f) => f.rule === "entropy.testCount").length, 0);
});

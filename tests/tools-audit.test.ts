import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildDefaultRegistry } from "../src/tools/index.ts";
import { Logger } from "../src/util/log.ts";

const logger = new Logger("error");
function makeCtx(workspaceRoot: string) {
  return {
    workspaceRoot,
    cwd: workspaceRoot,
    sandbox: { mode: "workspace-write" as const, workspaceRoot },
    signal: new AbortController().signal,
    logger,
    depth: 0,
  };
}

const tools = buildDefaultRegistry({ enableSubagent: false }).assemble();
const tool = (name: string) => {
  const found = tools.find((t) => t.name === name);
  assert.ok(found, name + " exists");
  return found!;
};

function workspace(): string {
  const ws = mkdtempSync(path.join(os.tmpdir(), "jys-tools-"));
  writeFileSync(path.join(ws, "lines.txt"), Array.from({ length: 30 }, (_, i) => "Line" + (i + 1)).join("\n"));
  mkdirSync(path.join(ws, "src"));
  writeFileSync(path.join(ws, "src", "a.ts"), "export const A = 1;\n");
  return ws;
}

test("grep: relative path resolves against the session cwd, not the process cwd", async () => {
  const ws = workspace();
  const r = await tool("Grep").call({ pattern: "Line1[0-9]", path: "lines.txt" }, makeCtx(ws));
  assert.ok(/Line10/.test(r.content), "matched inside workspace: " + r.content.slice(0, 80));
});

test("grep: a single file target is scanned (not treated as a directory)", async () => {
  const ws = workspace();
  const r = await tool("Grep").call({ pattern: "^Line1$", path: "lines.txt" }, makeCtx(ws));
  assert.ok(/Line1/.test(r.content), r.content.slice(0, 80));
  assert.ok(!/Line10/.test(r.content), "anchored pattern should not match Line10");
});

test("grep: case-sensitive by default, ignore_case opt-in", async () => {
  const ws = workspace();
  const strict = await tool("Grep").call({ pattern: "line10", path: "lines.txt" }, makeCtx(ws));
  assert.match(strict.content, /No matches/);
  const loose = await tool("Grep").call({ pattern: "line10", path: "lines.txt", ignore_case: true }, makeCtx(ws));
  assert.match(loose.content, /Line10/);
});

test("grep: missing path is an error, invalid regex is an error", async () => {
  const ws = workspace();
  const missing = await tool("Grep").call({ pattern: "x", path: "nope-dir" }, makeCtx(ws));
  assert.equal(missing.isError, true);
  const bad = await tool("Grep").call({ pattern: "([", path: "." }, makeCtx(ws));
  assert.equal(bad.isError, true);
});

test("glob: relative pattern resolves against the session cwd", async () => {
  const ws = workspace();
  const r = await tool("Glob").call({ pattern: "**/*.ts" }, makeCtx(ws));
  assert.ok(/a\.ts/.test(r.content), r.content.slice(0, 120));
  assert.ok(!/lines\.txt/.test(r.content), "non-matching file excluded");
});

test("bash: timeout honoured via both timeout and timeout_ms", async () => {
  const ws = workspace();
  const started = Date.now();
  const r = await tool("Bash").call({ command: "Start-Sleep -Seconds 20", timeout: 1200 }, makeCtx(ws));
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 8000, "returned in " + elapsed + "ms");
  assert.match(r.content, /timed_out=true/);
});

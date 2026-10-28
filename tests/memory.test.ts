import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  addMemory,
  forgetMemory,
  MAX_MEMORY_CHARS,
  memoryPath,
  memorySection,
  parseMemory,
  readMemoryEntries,
} from "../src/core/memory.ts";
import { buildSystemPrompt } from "../src/context/systemPrompt.ts";
import { builtinTools } from "../src/tools/index.ts";
import type { ToolContext } from "../src/tools/types.ts";

function ws(): string {
  return mkdtempSync(path.join(os.tmpdir(), "jys-mem-"));
}

const ctx = (root: string) => ({ workspaceRoot: root, cwd: root }) as unknown as ToolContext;

test("memory: add, dedupe and forget", () => {
  const root = ws();
  assert.deepEqual(readMemoryEntries(root), []);

  addMemory(root, "tests run with node --test");
  addMemory(root, "tests run with node --test");
  assert.equal(readMemoryEntries(root).length, 1, "same fact must not be stored twice");

  addMemory(root, "the API key lives in .env.local");
  assert.equal(readMemoryEntries(root).length, 2);

  const removed = forgetMemory(root, "API KEY");
  assert.equal(removed.removed, 1, "forget is case-insensitive substring");
  assert.equal(readMemoryEntries(root).length, 1);

  assert.equal(forgetMemory(root, "nothing-like-this").removed, 0, "must not pretend success");
});

test("memory: blank input is rejected instead of storing junk", () => {
  const root = ws();
  const res = addMemory(root, "   ");
  assert.equal(res.ok, false);
  assert.equal(readMemoryEntries(root).length, 0);
});

test("memory: the file stays human-editable markdown", () => {
  const root = ws();
  addMemory(root, "deploy uses scripts/package.ps1");
  const text = readFileSync(memoryPath(root), "utf8");
  assert.match(text, /^# 项目记忆/);
  assert.match(text, /- \[\d{4}-\d{2}-\d{2}\] deploy uses scripts\/package\.ps1/);
});

test("memory: manual bare bullets are parsed too", () => {
  const entries = parseMemory("# t" + String.fromCharCode(10) + "- hand written fact" + String.fromCharCode(10) + "- [2026-01-02] dated fact");
  assert.deepEqual(entries.map((e) => e.text), ["hand written fact", "dated fact"]);
  assert.equal(entries[0].at, "");
});

test("memory: the store is capped and evicts the oldest entry", () => {
  const root = ws();
  for (let i = 0; i < 40; i++) addMemory(root, "fact number " + i + " " + "x".repeat(300));
  const entries = readMemoryEntries(root);
  const total = memorySection(root)?.length ?? 0;
  assert.ok(total <= MAX_MEMORY_CHARS + 400, "memory section must stay within budget, got " + total);
  assert.ok(entries.length < 40, "old entries must be evicted");
  // 最新的那条必须还在
  assert.ok(entries[entries.length - 1].text.startsWith("fact number 39"));
});

test("memory: nothing is injected when there is no memory", () => {
  const root = ws();
  assert.equal(memorySection(root), null);
  const prompt = buildSystemPrompt({
    workspaceRoot: root,
    cwd: root,
    model: "mock-1",
    toolNames: ["Read"],
    sandboxMode: "workspace-write",
    permissionMode: "default",
  });
  assert.ok(!prompt.includes("<memory>"));
});

test("memory: remembered facts reach the system prompt of a later session", () => {
  const root = ws();
  addMemory(root, "the web app runs on port 4317");
  const prompt = buildSystemPrompt({
    workspaceRoot: root,
    cwd: root,
    model: "mock-1",
    toolNames: ["Read"],
    sandboxMode: "workspace-write",
    permissionMode: "default",
  });
  assert.ok(prompt.includes("<memory>"));
  assert.ok(prompt.includes("the web app runs on port 4317"));
});

test("memory tool: add / list / forget through the real tool interface", async () => {
  const root = ws();
  const tool = builtinTools().find((t) => t.name === "Memory");
  assert.ok(tool, "Memory tool must be registered");

  const added = await tool.call({ action: "add", text: "commit messages are chinese" }, ctx(root));
  assert.ok(!added.isError);
  assert.match(added.content, /remembered/);

  const listed = await tool.call({ action: "list" }, ctx(root));
  assert.match(listed.content, /commit messages are chinese/);

  const missing = await tool.call({ action: "add" }, ctx(root));
  assert.equal(missing.isError, true, "missing text must fail loudly");

  const forgotten = await tool.call({ action: "forget", match: "chinese" }, ctx(root));
  assert.match(forgotten.content, /removed 1/);
  assert.equal(readMemoryEntries(root).length, 0);
});

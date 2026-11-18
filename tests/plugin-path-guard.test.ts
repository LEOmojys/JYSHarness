import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ToolRegistry, withDefaultsPathGuard } from "../src/tools/registry.ts";
import { decidePermission } from "../src/permissions/engine.ts";
import { emptyRuleSet } from "../src/permissions/rules.ts";
import type { Tool } from "../src/tools/types.ts";

const ctxFor = (root: string) => ({
  workspaceRoot: root,
  cwd: root,
  sandbox: { mode: "workspace-write" as const, workspaceRoot: root },
  signal: new AbortController().signal,
  logger: { info() {}, warn() {}, error() {}, dim() {} },
  depth: 0,
}) as never;

const pluginTool = (extra: Partial<Tool> = {}): Tool =>
  ({
    name: "plugin_write",
    description: "a plugin tool that writes a file",
    inputSchema: { type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"] },
    isReadOnly: false,
    isConcurrencySafe: () => false,
    async call() {
      return { content: "wrote" };
    },
    ...extra,
  }) as Tool;

test("plugins: a tool without toolCheck gets a path guard for its path-like input", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "jys-pg-"));
  const guarded = withDefaultsPathGuard(pluginTool());
  assert.ok(guarded.toolCheck, "必须注入 toolCheck");
  // 工作区内：不拦
  const inside = guarded.toolCheck!({ file_path: "a.txt" }, ctxFor(root));
  assert.notEqual(inside?.behavior, "deny");
  // 工作区外：必须 deny（以前插件可以绕过）
  const outside = guarded.toolCheck!({ file_path: path.join(os.tmpdir(), "escape.txt") }, ctxFor(root));
  assert.equal(outside?.behavior, "deny", "插件工具越界写入必须被拦");
});

test("plugins: existing toolCheck is respected, not overwritten", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "jys-pg2-"));
  const own = () => null;
  const tool = withDefaultsPathGuard(pluginTool({ toolCheck: own }));
  assert.equal(tool.toolCheck, own, "插件自己写了 toolCheck 就不能覆盖");
  void root;
});

test("plugins: path checks include optional destinations and preserve the strongest decision", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "jys-paths-"));
  const file = { type: "string" };
  const tool = withDefaultsPathGuard(pluginTool({
    inputSchema: { type: "object", properties: { path: file, dest: file } },
  }));
  const check = tool.toolCheck;
  assert.ok(check);
  assert.equal(check({ dest: "AGENTS.md" }, ctxFor(root))?.behavior, "ask");
  assert.equal(check({ path: "AGENTS.md", dest: ".git/config" }, ctxFor(root))?.behavior, "deny");
  assert.equal(check({ path: "a.txt", dest: "b.txt" }, ctxFor(root)), null);
});

test("plugins: tools without path-like inputs are left untouched", () => {
  const tool = withDefaultsPathGuard(pluginTool({ inputSchema: { type: "object", properties: { query: { type: "string" } } } }));
  assert.equal(tool.toolCheck, undefined, "没有路径参数就不该乱加校验");
});

test("plugins: registry applies the guard to extension tools (end to end through permissions)", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "jys-pg3-"));
  const registry = new ToolRegistry();
  const assembled = registry.assemble([pluginTool()]);
  const tool = assembled.find((t) => t.name === "plugin_write");
  assert.ok(tool?.toolCheck, "assemble 必须给扩展工具兜底");

  const decision = decidePermission(
    {
      toolName: "plugin_write",
      input: { file_path: path.join(os.tmpdir(), "outside-plugin.txt") },
      isReadOnly: false,
      toolCheck: (input) => tool!.toolCheck!(input, ctxFor(root)),
    },
    { mode: "bypassPermissions", rules: emptyRuleSet(), sandboxMode: "workspace-write", workspaceRoot: root },
  );
  assert.equal(decision.behavior, "deny", "即使 bypassPermissions 也不能让插件写工作区外");
});

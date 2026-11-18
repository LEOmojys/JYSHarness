import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Session } from "../src/core/session.ts";
import { MockProvider } from "../src/providers/mock.ts";
import { emptyRuleSet } from "../src/permissions/rules.ts";
import { Logger } from "../src/util/log.ts";
import { loadPlugins } from "../src/plugins/loader.ts";
import { shutdownHosts } from "../src/plugins/host/client.ts";

const NL = String.fromCharCode(10);

/** 造一个工作区 + 一个插件；isolation 决定工具在哪执行。 */
function setup(isolation: string): { ws: string; loaded: Awaited<ReturnType<typeof loadPlugins>> } {
  const ws = mkdtempSync(path.join(os.tmpdir(), "jys-agent-"));
  const dir = path.join(ws, ".harness", "plugins", "plug");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "plugin.json"), JSON.stringify({ name: "plug", isolation }), "utf8");
  writeFileSync(
    path.join(dir, "index.ts"),
    [
      "export function activate(api) {",
      "  api.registerTool({",
      "    name: 'PlugVersion', description: 'returns version',",
      "    inputSchema: { type: 'object', properties: {} },",
      "    isReadOnly: true, isConcurrencySafe: () => true,",
      "    call: async () => ({ content: 'plug-v1-' + '" + isolation + "' }),",
      "  });",
      "}",
    ].join(NL) + NL,
    "utf8",
  );
  return { ws, loaded: { tools: [], skills: [], promptSections: [], hooks: {}, errors: [], runtimes: [], warnings: [], plugins: [] } };
}

async function runAgent(ws: string, isolation: string): Promise<{ visible: boolean; toolName: string; content: string; done: string }> {
  const logger = new Logger("error");
  const loaded = await loadPlugins(ws, logger);
  const provider = new MockProvider([
    { toolCalls: [{ name: "PlugVersion", input: {} }], stopReason: "tool_use" },
    { text: "完成", stopReason: "end_turn" },
  ]);
  const session = new Session({
    workspaceRoot: ws,
    settings: { permissionMode: "bypassPermissions", sandboxMode: "workspace-write", maxTurns: 6 },
    rules: emptyRuleSet(),
    provider,
    model: "mock-1",
    logger,
    approve: async () => "allow",
  });
  await session.init();
  session.applyPlugins(loaded);

  const visible = session.tools.some((t) => t.name === "PlugVersion");
  let toolName = "";
  let content = "";
  let done = "";
  for await (const ev of session.send("查版本", new AbortController().signal)) {
    if (ev.type === "tool_end") {
      toolName = String((ev as { name?: string }).name ?? "");
      content = String((ev as { result?: { content?: string } }).result?.content ?? "");
    }
    if (ev.type === "done") done = String((ev as { reason?: string }).reason ?? "");
  }
  return { visible, toolName, content, done };
}

for (const isolation of ["in-process", "process"]) {
  test("agent loop: a plugin tool is visible, executed, and its result reaches the model (" + isolation + ")", async () => {
    shutdownHosts();
    const { ws } = setup(isolation);
    // setup() 只建目录；真正加载在这里
    const dir = path.join(ws, ".harness", "plugins", "plug");
    writeFileSync(
      path.join(dir, "index.ts"),
      [
        "export function activate(api) {",
        "  api.registerTool({",
        "    name: 'PlugVersion', description: 'returns version',",
        "    inputSchema: { type: 'object', properties: {} },",
        "    isReadOnly: true, isConcurrencySafe: () => true,",
        "    call: async () => ({ content: 'plug-v1' }),",
        "  });",
        "}",
      ].join(NL) + NL,
      "utf8",
    );
    const res = await runAgent(ws, isolation);
    assert.equal(res.visible, true, "插件工具必须出现在模型可见的工具列表里");
    assert.equal(res.toolName, "PlugVersion", "模型发起的调用应命中插件工具");
    assert.equal(res.content, "plug-v1", "工具结果必须回传到会话");
    assert.equal(res.done, "completed");
    shutdownHosts();
  });
}

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadPlugins } from "../src/plugins/loader.ts";
import { declaredInject, findCordisPlugin } from "../src/plugins/cordis.ts";
import { Logger } from "../src/util/log.ts";

const NL = String.fromCharCode(10);

/** 造一个 DSH/Cordis 风格的插件目录（入口导出的是 { apply(ctx), inject }）。 */
function makeCordisPlugin(name: string, entryBody: string[]): string {
  const ws = mkdtempSync(path.join(os.tmpdir(), "jys-cordis-"));
  const dir = path.join(ws, ".harness", "plugins", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "plugin.json"), JSON.stringify({ name, version: "1.0.0", entry: "index.ts" }), "utf8");
  writeFileSync(path.join(dir, "index.ts"), entryBody.join(NL) + NL, "utf8");
  return ws;
}

test("cordis: detects the plugin object shape (apply + inject)", () => {
  const plugin = { apply: (ctx: unknown) => void ctx, inject: { tools: true } };
  assert.ok(findCordisPlugin({ plugin } as never));
  assert.deepEqual(declaredInject(plugin), ["tools"]);
  assert.equal(findCordisPlugin({ activate: () => undefined } as never), null, "activate 形态不该被认成 cordis");
});

test("cordis: a plugin registering ctx.tools loads and its tool runs", async () => {
  const ws = makeCordisPlugin("cordis-tool", [
    "export const plugin = {",
    "  name: 'cordis-tool',",
    "  inject: { tools: true },",
    "  apply(ctx) {",
    "    ctx.tools.register({",
    "      name: 'CordisEcho',",
    "      description: '回显输入（Cordis 风格）',",
    "      parameters: { type: 'object', properties: {} },",
    "      async execute(input) { return { content: 'cordis:' + JSON.stringify(input) }; },",
    "    });",
    "  },",
    "};",
  ]);
  const loaded = await loadPlugins(ws, new Logger("error"));
  assert.deepEqual(loaded.errors, [], "Cordis 插件应能加载");
  const tool = loaded.tools.find((t) => t.name === "CordisEcho");
  assert.ok(tool, "工具应注册进来");
  const out = await tool!.call({ x: 1 }, {} as never);
  assert.equal(out.content, 'cordis:{"x":1}');
});

test("cordis: ctx.on maps onto hook events, ctx.on other names stays local", async () => {
  const ws = makeCordisPlugin("cordis-events", [
    "export const plugin = {",
    "  inject: { events: true },",
    "  apply(ctx) {",
    "    ctx.on('PreToolUse', async () => ({ decision: 'deny', reason: 'cordis-hook' }));",
    "    ctx.on('custom-event', () => 'local');",
    "  },",
    "};",
  ]);
  const loaded = await loadPlugins(ws, new Logger("error"));
  assert.deepEqual(loaded.errors, []);
  const hooks = loaded.hooks.PreToolUse ?? [];
  assert.ok(hooks.length >= 1, "PreToolUse 要接进 hook 管线");
  const result = (await hooks[0]!.handler!({ toolName: "Read", input: {} } as never)) as { decision?: string; reason?: string };
  assert.equal(result.decision, "deny");
  assert.equal(result.reason, "cordis-hook");
});

test("cordis: a plugin injecting an unsupported service is rejected with the reason", async () => {
  const ws = makeCordisPlugin("cordis-llm", [
    "export const plugin = {",
    "  inject: { llm: true, sessions: true },",
    "  apply(ctx) { ctx.tools.register({ name: 'Nope', execute: async () => ({ content: 'x' }) }); },",
    "};",
  ]);
  const loaded = await loadPlugins(ws, new Logger("error"));
  assert.equal(loaded.errors.length, 1);
  assert.match(loaded.errors[0].message, /不提供/);
  assert.match(loaded.errors[0].message, /llm/);
  assert.equal(loaded.tools.length, 0, "被拒绝的插件不该留下半截贡献");
});

test("cordis: commands and skills map through", async () => {
  const ws = makeCordisPlugin("cordis-cmd", [
    "export const plugin = {",
    "  inject: { commands: true, skills: true },",
    "  apply(ctx) {",
    "    ctx.commands.register({ name: 'cordis-hi', description: 'hi', run: () => 'hi-from-cordis' });",
    "    ctx.skills.register({ name: 'cordis-skill', description: 'd', content: '# body' });",
    "  },",
    "};",
  ]);
  const loaded = await loadPlugins(ws, new Logger("error"));
  assert.deepEqual(loaded.errors, []);
  const rt = loaded.runtimes[0];
  assert.ok(rt?.commands.some((c) => typeof c.run === "function" && c.name.startsWith("/")), "命令要以 / 开头");
  assert.ok(loaded.skills.some((s) => s.name === "cordis-skill"));
});

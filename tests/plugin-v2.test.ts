import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadPlugins } from "../src/plugins/loader.ts";
import { parsePluginAsset, parsePluginRoute, resolveAssetPath } from "../src/plugins/http.ts";
import { pluginPanelDirs } from "../src/plugins/panels.ts";
import { Logger } from "../src/util/log.ts";

const NL = String.fromCharCode(10);

/** 造一个 v2 插件：路由 + 面板 + 命令 + ui 资产。 */
function makePlugin(withPanel = true): string {
  const ws = mkdtempSync(path.join(os.tmpdir(), "jys-v2-"));
  const dir = path.join(ws, ".harness", "plugins", "demo");
  mkdirSync(path.join(dir, "ui"), { recursive: true });
  writeFileSync(
    path.join(dir, "plugin.json"),
    JSON.stringify({
      name: "demo",
      id: "demo-panel",
      version: "1.0.0",
      ui: "ui",
      ...(withPanel ? { panels: [{ id: "p1", title: "面板一", icon: "◈" }] } : {}),
    }),
    "utf8",
  );
  writeFileSync(
    path.join(dir, "index.ts"),
    [
      "export function activate(api) {",
      '  api.registerRoute({ method: "GET", path: "ping", handler: () => ({ json: { ok: true } }) });',
      '  api.registerRoute({ method: "POST", path: "echo", handler: (ctx) => ({ json: { got: ctx.body } }) });',
      '  api.registerCommand({ name: "/hi", description: "say hi", run: () => "hi" });',
      '  api.registerPanel({ id: "p1", title: "面板一" });',
      "}",
    ].join(NL),
    "utf8",
  );
  writeFileSync(path.join(dir, "ui", "index.js"), "export function mount(el){ el.textContent = 'mounted'; }" + NL, "utf8");
  return ws;
}

test("plugin v2: routes, commands, panels and ui dir are collected", async () => {
  const ws = makePlugin();
  const res = await loadPlugins(ws, new Logger("error"));
  assert.deepEqual(res.errors, []);
  const rt = res.runtimes.find((r) => r.pluginId === "demo-panel");
  assert.ok(rt, "必须有 runtime 记录");
  assert.deepEqual(rt!.routes.map((r) => r.method + " " + r.path), ["GET ping", "POST echo"]);
  assert.deepEqual(rt!.commands.map((c) => c.name), ["/hi"]);
  assert.deepEqual(rt!.panels.map((p) => p.id), ["p1"]);
  assert.ok(rt!.uiDir, "ui 目录应被识别");
});

test("plugin v2: invalid registrations become warnings, not crashes", async () => {
  const ws = mkdtempSync(path.join(os.tmpdir(), "jys-v2bad-"));
  const dir = path.join(ws, ".harness", "plugins", "bad");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "plugin.json"), JSON.stringify({ name: "bad" }), "utf8");
  writeFileSync(
    path.join(dir, "index.ts"),
    [
      "export function activate(api) {",
      "  api.registerRoute({ method: \"GET\", path: \"\", handler: () => ({}) });",
      "  api.registerRoute({ method: \"GET\", path: \"x\" });",
      "  api.registerPanel({ id: \"p\" });",
      "  api.registerCommand({ name: \"/nope\" });",
      "}",
    ].join(NL),
    "utf8",
  );
  const res = await loadPlugins(ws, new Logger("error"));
  assert.equal(res.runtimes.length, 0, "无效注册不该产生 runtime");
  assert.ok(res.warnings.length >= 4, "每个无效注册都要有告警，实际: " + JSON.stringify(res.warnings));
});

test("plugin v2: panel declarations are discoverable without running activate()", () => {
  const ws = makePlugin();
  const dirs = pluginPanelDirs(ws);
  assert.equal(dirs.length, 1);
  assert.equal(dirs[0].panels[0].title, "面板一");
  assert.equal(dirs[0].panels[0].plugin, "demo-panel", "面板要用 manifest 的 id");
  assert.equal(dirs[0].panels[0].asset, "/plugin-assets/demo-panel/index.js");
});

test("plugin v2: disabled plugin contributes no panels", () => {
  const ws = makePlugin();
  const manifestPath = path.join(ws, ".harness", "plugins", "demo", "plugin.json");
  writeFileSync(manifestPath, JSON.stringify({ name: "demo", id: "demo-panel", enabled: false, panels: [{ id: "p1", title: "t" }] }), "utf8");
  assert.equal(pluginPanelDirs(ws).length, 0);
});

test("plugin v2: route parsing keeps ids and nested paths", () => {
  assert.deepEqual(parsePluginRoute("/plugin/demo-panel/stats"), { id: "demo-panel", rest: "stats" });
  assert.deepEqual(parsePluginRoute("/plugin/demo/sub/deep"), { id: "demo", rest: "sub/deep" });
  assert.equal(parsePluginRoute("/api/plugins"), null);
  assert.deepEqual(parsePluginAsset("/plugin-assets/demo/index.js"), { id: "demo", file: "index.js" });
  assert.equal(parsePluginAsset("/plugin/demo/index.js"), null);
});

test("plugin v2: asset path refuses directory traversal", async () => {
  const ws = makePlugin();
  const res = await loadPlugins(ws, new Logger("error"));
  const rt = res.runtimes.find((r) => r.pluginId === "demo-panel")!;
  assert.ok(resolveAssetPath(rt, "index.js"), "正常文件应能解析");
  assert.equal(resolveAssetPath(rt, "../../../etc/passwd"), null, "目录穿越必须被拒");
  assert.equal(resolveAssetPath(rt, "nope.js"), null);
  assert.equal(resolveAssetPath(undefined, "index.js"), null);
});

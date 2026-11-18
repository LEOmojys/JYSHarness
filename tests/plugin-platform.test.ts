import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { copyTree, installPlugin, listInstalled, uninstallPlugin } from "../src/plugins/manager.ts";
import { checkCompat, satisfies, parseVersion } from "../src/plugins/compat.ts";
import { loadPlugins } from "../src/plugins/loader.ts";
import { pluginPanelDirs } from "../src/plugins/panels.ts";
import { Logger } from "../src/util/log.ts";

const NL = String.fromCharCode(10);

function ws(): string {
  return mkdtempSync(path.join(os.tmpdir(), "jys-pm-"));
}

/** 造一个插件源目录（模拟"从别处拿来一个插件"）。 */
function pluginSrc(name = "demo", extra: Record<string, unknown> = {}): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "jys-src-"));
  mkdirSync(path.join(dir, "ui"), { recursive: true });
  writeFileSync(
    path.join(dir, "plugin.json"),
    JSON.stringify({ name, version: "1.2.0", entry: "index.ts", ui: "ui", ...extra }),
    "utf8",
  );
  writeFileSync(path.join(dir, "index.ts"), "export function activate(api) { api.log('hi'); }" + NL, "utf8");
  writeFileSync(path.join(dir, "ui", "index.js"), "export function mount() {}" + NL, "utf8");
  return dir;
}

test("compat: version parsing and range matching", () => {
  assert.deepEqual(parseVersion("v1.2.3"), { major: 1, minor: 2, patch: 3 });
  assert.equal(parseVersion("nope"), null);
  assert.equal(satisfies("0.2.0", ">=0.2.0").ok, true);
  assert.equal(satisfies("0.1.9", ">=0.2.0").ok, false);
  assert.equal(satisfies("1.5.0", "^1.2.0").ok, true);
  assert.equal(satisfies("2.0.0", "^1.2.0").ok, false, "caret 不允许跨 major");
  assert.equal(satisfies("1.2.9", "~1.2.0").ok, true);
  assert.equal(satisfies("1.3.0", "~1.2.0").ok, false, "tilde 不允许跨 minor");
  assert.equal(satisfies("3.0.0", "^1.0.0 || ^3.0.0").ok, true, "多选范围");
});

test("compat: engines and dependency checks produce errors", () => {
  const bad = checkCompat({ name: "x", engines: { harness: ">=99.0.0" } }, new Map());
  assert.equal(bad.filter((i) => i.severity === "error").length, 1);
  const dep = checkCompat({ name: "x", dependencies: { "other": "^1.0.0" } }, new Map());
  assert.match(dep[0].message, /缺少依赖插件/);
  const okDep = checkCompat({ name: "x", dependencies: { other: "^1.0.0" } }, new Map([["other", "1.5.0"]]));
  assert.equal(okDep.length, 0);
});

test("install: copies plugin, writes lock, refuses to overwrite by default", () => {
  const root = ws();
  const src = pluginSrc();
  const first = installPlugin(root, src);
  assert.equal(first.ok, true, first.error ?? "");
  assert.equal(first.name, "demo");
  const dest = path.join(root, ".harness", "plugins", "demo");
  assert.ok(existsSync(path.join(dest, "plugin.json")));
  const lock = JSON.parse(readFileSync(path.join(dest, "plugin.lock.json"), "utf8"));
  assert.equal(lock.name, "demo");
  assert.equal(lock.source, src);

  const again = installPlugin(root, src);
  assert.equal(again.ok, false);
  assert.match(again.error ?? "", /已安装/);
  const force = installPlugin(root, src, { force: true });
  assert.equal(force.ok, true);
});

test("install: rejects an incompatible engines range before copying", () => {
  const root = ws();
  const src = pluginSrc("futuristic", { engines: { harness: ">=99.0.0" } });
  const res = installPlugin(root, src);
  assert.equal(res.ok, false);
  assert.match(res.error ?? "", /不兼容/);
  assert.equal(existsSync(path.join(root, ".harness", "plugins", "futuristic")), false, "失败时不该留下残留");
});

test("install: rejects an entry that escapes the plugin folder", () => {
  const root = ws();
  const src = pluginSrc("escaping", { entry: "../../evil.ts" });
  const res = installPlugin(root, src);
  assert.equal(res.ok, false);
  assert.match(res.error ?? "", /入口无效/);
});

test("install: --disabled writes enabled:false and list reports it", () => {
  const root = ws();
  const src = pluginSrc("off");
  assert.equal(installPlugin(root, src, { disabled: true }).ok, true);
  const list = listInstalled(root);
  assert.equal(list.length, 1);
  assert.equal(list[0].enabled, false);
  assert.equal(pluginPanelDirs(root).length, 0, "停用插件不贡献面板");
});

test("install: finds a plugin inside a repo-style layout", () => {
  const root = ws();
  const repo = mkdtempSync(path.join(os.tmpdir(), "jys-repo-"));
  // 不用 cpSync：Windows 上它对目录报 EIO（同一原因促使 manager 自己实现 copyTree）
  copyTree(pluginSrc("nested"), path.join(repo, "plugins", "nested"));
  const res = installPlugin(root, repo);
  assert.equal(res.ok, true, res.error ?? "");
  assert.equal(res.name, "nested");
});

test("uninstall removes the plugin; missing plugin reports why", () => {
  const root = ws();
  installPlugin(root, pluginSrc("bye"));
  assert.equal(uninstallPlugin(root, "bye").ok, true);
  assert.equal(existsSync(path.join(root, ".harness", "plugins", "bye")), false);
  const missing = uninstallPlugin(root, "bye");
  assert.equal(missing.ok, false);
  assert.match(missing.error ?? "", /未安装/);
});

test("capability permissions are enforced: route/panel need declaration", async () => {
  const root = ws();
  const dir = path.join(root, ".harness", "plugins", "noperm");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "plugin.json"), JSON.stringify({ name: "noperm", panels: [{ id: "p", title: "t" }] }), "utf8");
  writeFileSync(
    path.join(dir, "index.ts"),
    [
      "export function activate(api) {",
      "  api.registerRoute({ method: \"GET\", path: \"r\", handler: () => ({ json: {} }) });",
      "  api.registerPanel({ id: \"p\", title: \"t\" });",
      "}",
    ].join(NL),
    "utf8",
  );
  const res = await loadPlugins(root, new Logger("error"));
  assert.equal(res.runtimes.length, 0, "未声明能力不该注册任何东西");
  assert.equal(res.warnings.filter((w) => /未声明/.test(w.message)).length, 2);
});

test("capability permissions work when declared", async () => {
  const root = ws();
  const dir = path.join(root, ".harness", "plugins", "withperm");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "plugin.json"),
    JSON.stringify({ name: "withperm", contributes: { permissions: ["http-route", "ui-panel"] } }),
    "utf8",
  );
  writeFileSync(
    path.join(dir, "index.ts"),
    [
      "export function activate(api) {",
      "  api.registerRoute({ method: \"GET\", path: \"r\", handler: () => ({ json: {} }) });",
      "  api.registerPanel({ id: \"p\", title: \"t\" });",
      "}",
    ].join(NL),
    "utf8",
  );
  const res = await loadPlugins(root, new Logger("error"));
  assert.equal(res.runtimes.length, 1);
  assert.equal(res.runtimes[0].routes.length, 1);
  assert.equal(res.runtimes[0].panels.length, 1);
});

test("slots: unknown slot falls back to sidebar", () => {
  const root = ws();
  const dir = path.join(root, ".harness", "plugins", "slotty");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "plugin.json"),
    JSON.stringify({ name: "slotty", panels: [{ id: "a", title: "A", slot: "settings" }, { id: "b", title: "B", slot: "weird" }] }),
    "utf8",
  );
  const panels = pluginPanelDirs(root)[0].panels;
  assert.equal(panels.find((p) => p.id === "a")?.slot, "settings");
  assert.equal(panels.find((p) => p.id === "b")?.slot, "sidebar");
});

test("loader: incompatible plugin is rejected with a reason, not half-loaded", async () => {
  const root = ws();
  const dir = path.join(root, ".harness", "plugins", "old");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "plugin.json"), JSON.stringify({ name: "old", engines: { harness: ">=99.0.0" } }), "utf8");
  writeFileSync(path.join(dir, "index.ts"), "export function activate() {}" + NL, "utf8");
  const res = await loadPlugins(root, new Logger("error"));
  assert.equal(res.plugins.length, 0);
  assert.equal(res.errors.length, 1);
  assert.match(res.errors[0].message, /兼容性校验失败/);
});

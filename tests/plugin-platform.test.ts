import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { copyTree, installPlugin, listInstalled, pluginDestination, uninstallPlugin } from "../src/plugins/manager.ts";
import { checkCompat, satisfies, parseVersion, harnessVersion } from "../src/plugins/compat.ts";
import { loadPlugins } from "../src/plugins/loader.ts";
import { encodeLine, MAX_HOST_FRAME_BYTES } from "../src/plugins/host/rpc.ts";
import { pluginPanelDirs } from "../src/plugins/panels.ts";
import { parsePluginAsset, pipeAsset, resolveAssetPath } from "../src/plugins/http.ts";
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
  assert.equal(satisfies("0.3.0", "^0.2.0").ok, false);
  assert.equal(satisfies("0.0.2", "^0.0.1").ok, false);
});

test("compat: harness version belongs to the executable, regardless of the working directory", () => {
  const before = process.cwd();
  const expected = harnessVersion();
  try {
    process.chdir(ws());
    assert.equal(harnessVersion(), expected);
  } finally {
    process.chdir(before);
  }
});

test("plugin RPC frames are bounded before entering stdio buffers", () => {
  assert.match(encodeLine({ ok: true }), /\n$/);
  assert.throws(() => encodeLine({ payload: "x".repeat(MAX_HOST_FRAME_BYTES) }), /frame exceeds/);
});

test("plugin dependencies require the dependency to load successfully", async () => {
  const root = ws();
  const pluginRoot = path.join(root, ".harness", "plugins");
  const depDir = path.join(pluginRoot, "broken-dep");
  const appDir = path.join(pluginRoot, "dependent-app");
  mkdirSync(depDir, { recursive: true });
  mkdirSync(appDir, { recursive: true });
  writeFileSync(path.join(depDir, "plugin.json"), JSON.stringify({ name: "broken-dep", version: "1.0.0", entry: "missing.ts" }), "utf8");
  writeFileSync(path.join(appDir, "plugin.json"), JSON.stringify({ name: "dependent-app", version: "1.0.0", entry: "index.ts", dependencies: { "broken-dep": "^1.0.0" } }), "utf8");
  writeFileSync(path.join(appDir, "index.ts"), "export function activate(api) { api.registerTool({ name: 'ShouldNotLoad', description: 'x', inputSchema: {type:'object',properties:{}}, isReadOnly:true, isConcurrencySafe:()=>true, call:()=>({content:'x'}) }); }\n", "utf8");

  const loaded = await loadPlugins(root, new Logger("error"));
  assert.equal(loaded.plugins.some((plugin) => plugin.name === "dependent-app"), false);
  assert.equal(loaded.tools.some((tool) => tool.name === "ShouldNotLoad"), false);
  assert.ok(loaded.errors.some((error) => error.plugin === "dependent-app" && /缺少依赖插件/.test(error.message)));
});

test("plugin dependency cycles are rejected", async () => {
  const root = ws();
  const pluginRoot = path.join(root, ".harness", "plugins");
  for (const [name, dependency] of [["cycle-a", "cycle-b"], ["cycle-b", "cycle-a"]]) {
    const dir = path.join(pluginRoot, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "plugin.json"), JSON.stringify({ name, version: "1.0.0", entry: "index.ts", dependencies: { [dependency]: "^1.0.0" } }), "utf8");
    writeFileSync(path.join(dir, "index.ts"), "export function activate() {}\n", "utf8");
  }
  const loaded = await loadPlugins(root, new Logger("error"));
  assert.equal(loaded.plugins.length, 0);
  assert.equal(loaded.errors.filter((error) => /依赖关系形成循环/.test(error.message)).length, 2);
});

test("plugin ids must be valid unique route segments", async () => {
  const root = ws();
  const pluginRoot = path.join(root, ".harness", "plugins");
  for (const name of ["first", "second"]) {
    const dir = path.join(pluginRoot, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "plugin.json"), JSON.stringify({ name, id: " shared ", version: "1.0.0", entry: "index.ts" }), "utf8");
    writeFileSync(path.join(dir, "index.ts"), "export function activate() {}\n", "utf8");
  }
  const loaded = await loadPlugins(root, new Logger("error"));
  assert.equal(loaded.plugins.length, 0);
  assert.equal(loaded.runtimes.length, 0);
  assert.equal(loaded.errors.length, 2);
  assert.ok(loaded.errors.every((e) => /duplicate plugin id/.test(e.message)));
});

test("plugin destinations must be named child directories", () => {
  const root = ws();
  for (const name of ["", ".", "..", "...", "name.", "CON", "a/b", "a\\b"]) {
    assert.throws(() => pluginDestination(root, name));
  }
});

test("assets: encoded filenames resolve inside the plugin UI directory", () => {
  const pluginDir = pluginSrc();
  const uiDir = path.join(pluginDir, "ui");
  writeFileSync(path.join(uiDir, "my icon.svg"), "<svg/>");
  const request = parsePluginAsset("/plugin-assets/demo/my%20icon.svg");
  assert.ok(request);
  const runtime = {
    pluginId: "demo", pluginDir, uiDir,
    routes: [], panels: [], commands: [], tools: [], hooks: [], skills: [], promptSections: [],
  };
  const asset = resolveAssetPath(runtime, request.file);
  assert.ok(asset);
  assert.equal(readFileSync(asset, "utf8"), "<svg/>");
  assert.equal(resolveAssetPath({ ...runtime, uiDir: ws() }, request.file), null);
});

test("assets: a file disappearing before stream open returns 404", async () => {
  const missing = path.join(ws(), "missing.js");
  const server = createServer((_req, res) => pipeAsset(missing, res));
  await new Promise<void>((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const response = await fetch("http://127.0.0.1:" + address.port);
    assert.equal(response.status, 404);
    await response.text();
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
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

test("install: accepts enabled installed dependencies with a matching version", () => {
  const root = ws();
  const consumer = pluginSrc("consumer", { dependencies: { base: "^1.0.0" } });
  assert.equal(installPlugin(root, consumer).ok, false);
  assert.equal(installPlugin(root, pluginSrc("base")).ok, true);
  const result = installPlugin(root, consumer);
  assert.equal(result.ok, true, result.error ?? "");
});

test("install: a forced reinstall from the installed directory keeps the package", () => {
  const root = ws();
  const first = installPlugin(root, pluginSrc());
  assert.ok(first.dir);
  const updated = installPlugin(root, first.dir, { force: true });
  assert.equal(updated.ok, true, updated.error ?? "");
  assert.ok(existsSync(path.join(first.dir, "index.ts")));
  assert.ok(existsSync(path.join(first.dir, "plugin.lock.json")));
});

test("install: a staged copy without its entry leaves the previous version in place", () => {
  const root = ws();
  const first = installPlugin(root, pluginSrc("replacement"));
  assert.ok(first.dir);
  const next = pluginSrc("replacement", { entry: "node_modules/entry.js" });
  mkdirSync(path.join(next, "node_modules"));
  writeFileSync(path.join(next, "node_modules", "entry.js"), "");
  const result = installPlugin(root, next, { force: true });
  assert.equal(result.ok, false);
  assert.ok(existsSync(path.join(first.dir, "index.ts")));
  assert.equal(JSON.parse(readFileSync(path.join(first.dir, "plugin.json"), "utf8")).entry, "index.ts");
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

test("slots: unknown slot keeps its name (UI shows it in the fallback area)", () => {
  const root = ws();
  const dir = path.join(root, ".harness", "plugins", "slotty");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "plugin.json"),
    JSON.stringify({
      name: "slotty",
      contributes: { permissions: ["ui-panel"] },
      panels: [{ id: "a", title: "A", slot: "settings" }, { id: "b", title: "B", slot: "weird" }],
    }),
    "utf8",
  );
  const panels = pluginPanelDirs(root)[0].panels;
  assert.equal(panels.find((p) => p.id === "a")?.slot, "settings");
  // 语义升级：未知槽位不再被改写成 sidebar，而是原样保留，由 UI 放进兜底区域
  assert.equal(panels.find((p) => p.id === "b")?.slot, "weird");
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

test("panels: manifest-declared panels require ui-panel permission", () => {
  const root = ws();
  const noPerm = path.join(root, ".harness", "plugins", "noperm");
  mkdirSync(noPerm, { recursive: true });
  writeFileSync(
    path.join(noPerm, "plugin.json"),
    JSON.stringify({ name: "noperm", panels: [{ id: "p", title: "P" }] }),
    "utf8",
  );
  assert.equal(pluginPanelDirs(root).length, 0, "没有 ui-panel 权限的面板不该出现");

  const withPerm = path.join(root, ".harness", "plugins", "withperm");
  mkdirSync(withPerm, { recursive: true });
  writeFileSync(
    path.join(withPerm, "plugin.json"),
    JSON.stringify({ name: "withperm", contributes: { permissions: ["ui-panel"] }, panels: [{ id: "q", title: "Q" }] }),
    "utf8",
  );
  const dirs = pluginPanelDirs(root);
  assert.equal(dirs.length, 1);
  assert.equal(dirs[0].panels[0].id, "q");
});


test("commands: duplicate names across plugins produce a warning naming both", async () => {
  const ws = mkdtempSync(path.join(os.tmpdir(), "jys-dup-"));
  for (const name of ["alpha", "beta"]) {
    const dir = path.join(ws, ".harness", "plugins", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "plugin.json"), JSON.stringify({ name }), "utf8");
    writeFileSync(
      path.join(dir, "index.ts"),
      [
        "export function activate(api) {",
        "  api.registerCommand({ name: '/deploy', description: 'd', run: () => '" + name + "' });",
        "}",
      ].join(NL) + NL,
      "utf8",
    );
  }
  const loaded = await loadPlugins(ws, new Logger("error"));
  const dup = loaded.warnings.filter((w) => w.message.includes("/deploy"));
  assert.equal(dup.length, 1, "应有一条重名告警，实际: " + JSON.stringify(loaded.warnings));
  assert.match(dup[0].message, /alpha|beta/);
});


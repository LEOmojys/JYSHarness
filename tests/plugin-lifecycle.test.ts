import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadPlugins } from "../src/plugins/loader.ts";
import { installPlugin, uninstallPlugin } from "../src/plugins/manager.ts";
import { shutdownHosts, hostCount } from "../src/plugins/host/client.ts";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { Logger } from "../src/util/log.ts";

const NL = String.fromCharCode(10);

function srcPlugin(version: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "jys-src2-"));
  writeFileSync(path.join(dir, "plugin.json"), JSON.stringify({ name: "iso", version: "1.0.0", isolation: "process" }), "utf8");
  writeFileSync(
    path.join(dir, "index.ts"),
    [
      "export function activate(api) {",
      "  api.registerTool({",
      "    name: 'Version', description: 'v',",
      "    inputSchema: { type: 'object', properties: {} },",
      "    isReadOnly: true, isConcurrencySafe: () => true,",
      `    call: async () => ({ content: '${version}' }),`,
      "  });",
      "  api.registerTool({",
      "    name: 'Concat', description: 'c',",
      "    inputSchema: { type: 'object', properties: {} },",
      "    isReadOnly: true, isConcurrencySafe: () => true,",
      "    call: async (input) => ({ content: 'got:' + String(input.tag) }),",
      "  });",
      "}",
    ].join(NL) + NL,
    "utf8",
  );
  return dir;
}

const ctxFor = (ws: string) => ({ workspaceRoot: ws, cwd: ws, sandbox: { mode: "workspace-write", workspaceRoot: ws }, signal: new AbortController().signal, logger: new Logger("error"), depth: 0 }) as never;

test("upgrade flow: install -> use -> cover-install(v2) -> reload picks up new code", async () => {
  shutdownHosts();
  const ws = mkdtempSync(path.join(os.tmpdir(), "jys-up-"));
  const v1 = srcPlugin("v1");
  assert.equal(installPlugin(ws, v1).ok, true);
  const l1 = await loadPlugins(ws, new Logger("error"));
  assert.equal((await l1.tools.find((t) => t.name === "Version")!.call({}, ctxFor(ws))).content, "v1");

  // 覆盖安装 v2（相当于 jys plugin install --force）
  assert.equal(installPlugin(ws, srcPlugin("v2"), { force: true }).ok, true);
  const l2 = await loadPlugins(ws, new Logger("error"));
  assert.equal((await l2.tools.find((t) => t.name === "Version")!.call({}, ctxFor(ws))).content, "v2", "覆盖安装后必须跑新代码");
  shutdownHosts();
});

test("uninstall while a host is alive: no error, no zombie host", async () => {
  shutdownHosts();
  const ws = mkdtempSync(path.join(os.tmpdir(), "jys-un-"));
  installPlugin(ws, srcPlugin("v1"));
  await loadPlugins(ws, new Logger("error"));
  assert.equal(hostCount(), 1);
  const res = uninstallPlugin(ws, "iso");
  assert.equal(res.ok, true, res.error ?? "");
  assert.equal(existsSync(path.join(ws, ".harness", "plugins", "iso")), false, "目录应被删除");
  assert.equal(hostCount(), 0, "宿主必须一起退出，不留僵尸");
  const after = await loadPlugins(ws, new Logger("error"));
  assert.equal(after.tools.length, 0, "卸载后不应再有工具");
});

test("concurrent calls are matched to the right response (no crosstalk)", async () => {
  shutdownHosts();
  const ws = mkdtempSync(path.join(os.tmpdir(), "jys-cc-"));
  installPlugin(ws, srcPlugin("v1"));
  const loaded = await loadPlugins(ws, new Logger("error"));
  const concat = loaded.tools.find((t) => t.name === "Concat")!;
  // 20 个并发调用，每个带不同 tag：任何串台都会让断言失败
  const outs = await Promise.all(
    Array.from({ length: 20 }, (_, i) => concat.call({ tag: "t" + i }, ctxFor(ws))),
  );
  outs.forEach((o, i) => assert.equal(o.content, "got:t" + i, "第 " + i + " 个调用拿到了别人的结果"));
  shutdownHosts();
});

test("no hang: a one-shot process must exit even with a live plugin host", async () => {
  shutdownHosts();
  const ws = mkdtempSync(path.join(os.tmpdir(), "jys-exit-"));
  const dir = path.join(ws, ".harness", "plugins", "iso");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "plugin.json"), JSON.stringify({ name: "iso", isolation: "process" }), "utf8");
  writeFileSync(
    path.join(dir, "index.ts"),
    [
      "export function activate(api) {",
      "  api.registerTool({",
      "    name: 'Ver', description: 'v',",
      "    inputSchema: { type: 'object', properties: {} },",
      "    isReadOnly: true, isConcurrencySafe: () => true,",
      "    call: async () => ({ content: 'ok' }),",
      "  });",
      "}",
    ].join(NL) + NL,
    "utf8",
  );

  // 用子进程跑一段"加载插件后什么都不做"的脚本：
  // 如果宿主没 unref，父进程会被孩子占着事件循环，永远不退出（实测 124 超时）。
  const script = path.join(ws, "run.ts");
  writeFileSync(
    script,
    [
      // Windows 上 import 绝对路径必须是 file:// URL，否则 ESM 解析失败（实测 status=1）
      'import { loadPlugins } from ' + JSON.stringify(pathToFileURL(path.join(process.cwd(), "src/plugins/loader.ts")).href) + ";",
      'import { Logger } from ' + JSON.stringify(pathToFileURL(path.join(process.cwd(), "src/util/log.ts")).href) + ";",
      "const loaded = await loadPlugins(" + JSON.stringify(ws) + ', new Logger("error"));',
      'console.log("tools=" + loaded.tools.length);',
      "// 不显式关闭：交给进程退出清理验证",
    ].join(NL) + NL,
    "utf8",
  );

  const started = Date.now();
  const res = spawnSync(process.execPath, [script], { encoding: "utf8", timeout: 15_000 });
  const elapsed = Date.now() - started;
  assert.equal(res.signal, null, "进程被信号杀掉说明挂住了：" + String(res.signal));
  assert.equal(res.status, 0, "应正常退出，实际 status=" + String(res.status) + " err=" + String(res.stderr).slice(0, 200));
  assert.match(String(res.stdout), /tools=1/);
  assert.ok(elapsed < 15_000, "退出耗时过长：" + elapsed + "ms");
});


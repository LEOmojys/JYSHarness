import test from "node:test";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadPlugins } from "../src/plugins/loader.ts";
import { hostCount, shutdownHosts, shutdownHost } from "../src/plugins/host/client.ts";
import { Logger } from "../src/util/log.ts";

const NL = String.fromCharCode(10);

function makeIsolated(version: string): { ws: string; dir: string } {
  const ws = mkdtempSync(path.join(os.tmpdir(), "jys-stale-"));
  const dir = path.join(ws, ".harness", "plugins", "iso");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "plugin.json"), JSON.stringify({ name: "iso", version: "1.0.0", isolation: "process" }), "utf8");
  writeFileSync(
    path.join(dir, "index.ts"),
    [
      "export function activate(api) {",
      "  api.registerTool({",
      "    name: 'Version',",
      "    description: 'v',",
      "    inputSchema: { type: 'object', properties: {} },",
      "    isReadOnly: true,",
      "    isConcurrencySafe: () => true,",
      `    call: async () => ({ content: '${version}' }),`,
      "  });",
      "}",
    ].join(NL) + NL,
    "utf8",
  );
  return { ws, dir };
}

const ctxFor = (ws: string) => ({ workspaceRoot: ws, cwd: ws, sandbox: { mode: "workspace-write", workspaceRoot: ws }, signal: new AbortController().signal, logger: new Logger("error"), depth: 0 }) as never;

test("stale host: reinstall/upgrade must be picked up after invalidating the host", async () => {
  shutdownHosts();
  const { ws, dir } = makeIsolated("v1");
  const first = await loadPlugins(ws, new Logger("error"));
  const t1 = first.tools.find((t) => t.name === "Version")!;
  assert.equal((await t1.call({}, ctxFor(ws))).content, "v1");

  // 模拟"用户升级了插件代码"：写入 v2
  writeFileSync(
    path.join(dir, "index.ts"),
    [
      "export function activate(api) {",
      "  api.registerTool({",
      "    name: 'Version',",
      "    description: 'v',",
      "    inputSchema: { type: 'object', properties: {} },",
      "    isReadOnly: true,",
      "    isConcurrencySafe: () => true,",
      "    call: async () => ({ content: 'v2' }),",
      "  });",
      "}",
    ].join(NL) + NL,
    "utf8",
  );

  // 不清理宿主时：仍是旧代码（这就是要修的 bug）
  const stale = await loadPlugins(ws, new Logger("error"));
  const tStale = stale.tools.find((t) => t.name === "Version")!;
  assert.equal((await tStale.call({}, ctxFor(ws))).content, "v1", "未清理时确实读到旧代码（bug 复现）");

  // 清理该插件宿主后，必须读到新代码
  shutdownHost(dir);
  const fresh = await loadPlugins(ws, new Logger("error"));
  const tFresh = fresh.tools.find((t) => t.name === "Version")!;
  assert.equal((await tFresh.call({}, ctxFor(ws))).content, "v2", "清理宿主后必须加载新代码");
  assert.equal((await t1.call({}, ctxFor(ws))).isError, true, "an invalidated proxy must stay closed");
  shutdownHosts();
});

test("user plugin hosts are scoped to the workspace and invalidated by plugin directory", async (t) => {
  const base = mkdtempSync(path.join(os.tmpdir(), "jys-user-host-"));
  const previous = process.env.HARNESS_HOME;
  process.env.HARNESS_HOME = base;
  t.after(() => {
    shutdownHosts();
    if (previous === undefined) delete process.env.HARNESS_HOME;
    else process.env.HARNESS_HOME = previous;
  });
  const dir = path.join(base, "plugins", "shared");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "plugin.json"), JSON.stringify({ name: "shared", isolation: "process" }));
  writeFileSync(path.join(dir, "index.mjs"), `
    export function activate(api) {
      api.registerCommand({name: "/root", run: () => api.workspaceRoot});
    }
  `);
  const a = mkdtempSync(path.join(base, "workspace-"));
  const b = mkdtempSync(path.join(base, "workspace-"));
  async function loadCommand(ws: string) {
    const loaded = await loadPlugins(ws, new Logger("error"));
    assert.deepEqual(loaded.errors, []);
    const cmd = loaded.runtimes[0]?.commands[0];
    assert.ok(cmd);
    return cmd;
  }
  const cmdA = await loadCommand(a);
  const cmdB = await loadCommand(b);
  const signal = new AbortController().signal;
  assert.equal(await cmdA.run("", { workspaceRoot: a, signal }), a);
  assert.equal(await cmdB.run("", { workspaceRoot: b }), b);
  assert.equal(getEventListeners(signal, "abort").length, 0);
  shutdownHosts(a);
  assert.equal(hostCount(), 1);
  await assert.rejects(() => Promise.resolve(cmdA.run("", { workspaceRoot: a })));
  assert.equal(await cmdB.run("", { workspaceRoot: b }), b);
  await loadCommand(a);
  assert.equal(shutdownHost(dir), true);
  assert.equal(hostCount(), 0);
  await assert.rejects(() => Promise.resolve(cmdB.run("", { workspaceRoot: b })));
});

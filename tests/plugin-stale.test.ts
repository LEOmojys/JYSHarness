import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadPlugins } from "../src/plugins/loader.ts";
import { shutdownHosts, shutdownHost } from "../src/plugins/host/client.ts";
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
  makeIsolated("v2"); // 同目录，内容改成 v2（新版 makeIsolated 会新建 tmp，所以这里直接改原文件）
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
  shutdownHosts();
});

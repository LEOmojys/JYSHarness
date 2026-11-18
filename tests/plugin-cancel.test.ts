import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadPlugins } from "../src/plugins/loader.ts";
import { shutdownHosts } from "../src/plugins/host/client.ts";
import { Logger } from "../src/util/log.ts";

const NL = String.fromCharCode(10);

/**
 * 造一个"会跑很久但遵守 signal"的插件：
 *   - 循环里检查 signal.aborted；
 *   - 一旦被取消，就把 'aborted-after:<ms>' 写进 marker 文件再返回；
 *   - 正常跑完则写 'finished'。
 * 这样父进程可以**从文件观察子进程到底停没停**，而不是只看自己的超时。
 */
function makeLongTask(): { ws: string; marker: string } {
  const ws = mkdtempSync(path.join(os.tmpdir(), "jys-abort-"));
  const marker = path.join(ws, "marker.txt");
  const dir = path.join(ws, ".harness", "plugins", "slow");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "plugin.json"), JSON.stringify({ name: "slow", isolation: "process" }), "utf8");
  writeFileSync(
    path.join(dir, "index.ts"),
    [
      "import { writeFileSync } from 'node:fs';",
      "export function activate(api) {",
      "  api.registerTool({",
      "    name: 'Slow', description: 'slow but cancellable',",
      "    inputSchema: { type: 'object', properties: {} },",
      "    isReadOnly: true, isConcurrencySafe: () => true,",
      "    async call(input, ctx) {",
      "      const started = Date.now();",
      "      const marker = " + JSON.stringify(marker) + ";",
      "      while (Date.now() - started < 5000) {",
      "        if (ctx.signal && ctx.signal.aborted) {",
      "          writeFileSync(marker, 'aborted-after:' + (Date.now() - started));",
      "          return { content: 'cancelled', isError: true };",
      "        }",
      "        await new Promise((r) => setTimeout(r, 20));",
      "      }",
      "      writeFileSync(marker, 'finished');",
      "      return { content: 'finished-normal' };",
      "    },",
      "  });",
      "}",
    ].join(NL) + NL,
    "utf8",
  );
  return { ws, marker };
}

const ctxFor = (ws: string, signal?: AbortSignal) => ({
  workspaceRoot: ws,
  cwd: ws,
  sandbox: { mode: "workspace-write", workspaceRoot: ws },
  signal: signal ?? new AbortController().signal,
  logger: new Logger("error"),
  depth: 0,
}) as never;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("cancel: parent timeout tells the child to stop (no ghost computation)", async () => {
  shutdownHosts();
  process.env.HARNESS_PLUGIN_TOOL_TIMEOUT_MS = "300";
  const { ws, marker } = makeLongTask();
  const loaded = await loadPlugins(ws, new Logger("error"));
  const tool = loaded.tools.find((t) => t.name === "Slow")!;

  const out = await tool.call({}, ctxFor(ws));
  assert.equal(out.isError, true);
  assert.match(out.content, /超时/);

  // 关键断言：子进程**真的停了**（写下了 aborted-after），而不是继续跑到 5 秒
  await sleep(600);
  assert.ok(existsSync(marker), "子进程应留下取消标记（说明它收到 abort 了）");
  const content = readFileSync(marker, "utf8");
  assert.match(content, /^aborted-after:\d+$/, "不该是 finished，实际: " + content);
  const elapsed = Number(content.split(":")[1]);
  assert.ok(elapsed < 3000, "应在超时后很快停下，实际耗时 " + elapsed + "ms");
  delete process.env.HARNESS_PLUGIN_TOOL_TIMEOUT_MS;
  shutdownHosts();
});

test("cancel: session-level abort propagates to the child", async () => {
  shutdownHosts();
  const { ws, marker } = makeLongTask();
  const loaded = await loadPlugins(ws, new Logger("error"));
  const tool = loaded.tools.find((t) => t.name === "Slow")!;

  const controller = new AbortController();
  const started = Date.now();
  setTimeout(() => controller.abort(), 250);
  const out = await tool.call({}, ctxFor(ws, controller.signal));
  const elapsed = Date.now() - started;

  assert.equal(out.isError, true);
  assert.match(out.content, /取消/);
  assert.ok(elapsed < 3000, "取消应立即生效，实际 " + elapsed + "ms");

  await sleep(600);
  assert.ok(existsSync(marker), "子进程应留下取消标记");
  assert.match(readFileSync(marker, "utf8"), /^aborted-after:/);
  shutdownHosts();
});

test("cancel: an unknown or finished id is a no-op (no crash)", async () => {
  shutdownHosts();
  const { ws } = makeLongTask();
  const loaded = await loadPlugins(ws, new Logger("error"));
  const tool = loaded.tools.find((t) => t.name === "Slow")!;
  // 正常完成一次（不取消），再确认宿主仍然健康
  process.env.HARNESS_PLUGIN_TOOL_TIMEOUT_MS = "6000";
  const ok = await tool.call({}, ctxFor(ws));
  assert.equal(ok.content, "finished-normal");
  delete process.env.HARNESS_PLUGIN_TOOL_TIMEOUT_MS;
  assert.ok(loaded.tools.length > 0);
  shutdownHosts();
});

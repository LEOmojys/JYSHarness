import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadPlugins } from "../src/plugins/loader.ts";
import { hostCount, shutdownHosts } from "../src/plugins/host/client.ts";
import { Logger } from "../src/util/log.ts";

const NL = String.fromCharCode(10);

/**
 * 造一个工作区，里面放一个进程隔离插件。
 * 插件暴露：IsoPid（回子进程 pid）、IsoEcho（回传输入）、IsoSlow（睡很久）、IsoCrash（直接退出）、
 * 一条路由 /info、一个命令 /iso、一个 PreToolUse hook（deny）。
 */
function makeIsolated(opts: { isolation?: string; withCrash?: boolean; sleepMs?: number } = {}): string {
  const ws = mkdtempSync(path.join(os.tmpdir(), "jys-iso-"));
  const dir = path.join(ws, ".harness", "plugins", "isolated");
  mkdirSync(path.join(dir, "ui"), { recursive: true });
  writeFileSync(
    path.join(dir, "plugin.json"),
    JSON.stringify({
      name: "isolated",
      id: "isolated",
      version: "1.0.0",
      entry: "index.ts",
      ui: "ui",
      isolation: opts.isolation ?? "process",
      contributes: { permissions: ["http-route", "ui-panel"] },
      panels: [{ id: "iso", title: "隔离面板" }],
    }),
    "utf8",
  );
  const entry = [
    "export function activate(api) {",
    "  const mk = (name, fn) => api.registerTool({",
    "    name,",
    "    description: name,",
    "    inputSchema: { type: 'object', properties: {} },",
    "    isReadOnly: true,",
    "    isConcurrencySafe: () => true,",
    "    call: fn,",
    "  });",
    "  mk('IsoPid', async () => ({ content: 'child-pid:' + process.pid }));",
    "  mk('IsoEcho', async (input) => ({ content: 'echo:' + JSON.stringify(input) }));",
    "  mk('IsoNoisy', async () => { console.log('noisy-plugin-log-line'); return { content: 'noisy-ok' }; });",
    `  mk('IsoSlow', async () => { await new Promise((r) => setTimeout(r, ${opts.sleepMs ?? 3000})); return { content: 'slow-done' }; });`,
    opts.withCrash === false ? "" : "  mk('IsoCrash', async () => { process.exit(9); });",
    "  api.registerRoute({ method: 'GET', path: 'info', handler: () => ({ json: { pid: process.pid } }) });",
    "  api.registerCommand({ name: '/iso', description: 'iso', run: () => 'cmd-in-child:' + process.pid });",
    "  api.registerPanel({ id: 'iso', title: '隔离面板' });",
    "  api.on('PreToolUse', async () => ({ decision: 'deny', reason: 'isolated-hook-says-no' }));",
    "}",
  ]
    .filter(Boolean)
    .join(NL);
  writeFileSync(path.join(dir, "index.ts"), entry + NL, "utf8");
  writeFileSync(path.join(dir, "ui", "index.js"), "export function mount(){return 'iso-ui';}" + NL, "utf8");
  return ws;
}

function ctxFor(ws: string) {
  return {
    workspaceRoot: ws,
    cwd: ws,
    sandbox: { mode: "workspace-write", workspaceRoot: ws },
    signal: new AbortController().signal,
    logger: new Logger("error"),
    depth: 0,
  } as never;
}

test("isolation: process plugin contributes proxies, executed in a child process", async () => {
  shutdownHosts();
  const ws = makeIsolated();
  const loaded = await loadPlugins(ws, new Logger("error"));
  assert.deepEqual(loaded.errors, [], "不该有加载错误");

  const names = loaded.tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["IsoCrash", "IsoEcho", "IsoNoisy", "IsoPid", "IsoSlow"]);

  const rt = loaded.runtimes.find((r) => r.pluginId === "isolated");
  assert.ok(rt);
  assert.deepEqual(rt!.routes.map((r) => r.path), ["info"]);
  assert.deepEqual(rt!.commands.map((c) => c.name), ["/iso"]);
  assert.deepEqual(rt!.panels.map((p) => p.id), ["iso"]);

  const pid = loaded.tools.find((t) => t.name === "IsoPid")!;
  const out = await pid.call({}, ctxFor(ws));
  const childPid = String(out.content).replace("child-pid:", "");
  assert.ok(childPid.length > 0, "应拿到子进程 pid");
  assert.notEqual(childPid, String(process.pid), "必须不是父进程 pid（否则隔离没生效）");
  shutdownHosts();
});

test("isolation: routes and commands are executed in the child", async () => {
  shutdownHosts();
  const ws = makeIsolated();
  const loaded = await loadPlugins(ws, new Logger("error"));
  const rt = loaded.runtimes.find((r) => r.pluginId === "isolated")!;

  const routeOut = (await rt.routes[0]!.handler({
    pluginId: "isolated",
    method: "GET",
    path: "info",
    query: {},
    body: undefined,
    workspaceRoot: ws,
  })) as { json?: { pid?: number } };
  assert.ok(routeOut.json?.pid, "路由应返回子进程 pid");
  assert.notEqual(String(routeOut.json!.pid), String(process.pid));

  const cmdOut = await rt.commands[0]!.run("", { workspaceRoot: ws });
  assert.match(cmdOut, /cmd-in-child:/);
  assert.ok(!cmdOut.includes(String(process.pid)), "命令也必须在子进程里跑");
  shutdownHosts();
});

test("isolation: plugin console.log does not corrupt the protocol", async () => {
  shutdownHosts();
  const ws = makeIsolated();
  const loaded = await loadPlugins(ws, new Logger("error"));
  const noisy = loaded.tools.find((t) => t.name === "IsoNoisy")!;
  const out = await noisy.call({}, ctxFor(ws));
  // 插件打印的日志走 stderr，返回值必须正常回到父进程
  assert.equal(out.content, "noisy-ok");
  assert.equal(out.isError, false);
  shutdownHosts();
});

test("isolation: a crashed host fails only that plugin, parent stays alive and self-heals", async () => {
  shutdownHosts();
  const ws = makeIsolated();
  const loaded = await loadPlugins(ws, new Logger("error"));
  const crash = loaded.tools.find((t) => t.name === "IsoCrash")!;
  const pid = loaded.tools.find((t) => t.name === "IsoPid")!;

  const dead = await crash.call({}, ctxFor(ws));
  assert.equal(dead.isError, true, "崩溃必须变成工具错误，而不是抛到会话层");
  assert.match(dead.content, /插件宿主已退出/);

  // 父进程仍然活着；下一个调用会重启宿主
  const revived = await pid.call({}, ctxFor(ws));
  assert.equal(revived.isError ?? false, false, "重启后应恢复正常");
  assert.match(revived.content, /child-pid:/);
  shutdownHosts();
});

test("isolation: a hanging plugin times out instead of blocking the session", async () => {
  shutdownHosts();
  process.env.HARNESS_PLUGIN_TOOL_TIMEOUT_MS = "300";
  const ws = makeIsolated({ sleepMs: 2500 });
  const loaded = await loadPlugins(ws, new Logger("error"));
  const slow = loaded.tools.find((t) => t.name === "IsoSlow")!;
  const out = await slow.call({}, ctxFor(ws));
  assert.equal(out.isError, true);
  assert.match(out.content, /超时/);
  delete process.env.HARNESS_PLUGIN_TOOL_TIMEOUT_MS;
  shutdownHosts();
});

test("isolation: hooks registered by an isolated plugin are reachable", async () => {
  shutdownHosts();
  const ws = makeIsolated();
  const loaded = await loadPlugins(ws, new Logger("error"));
  const hooks = loaded.hooks.PreToolUse ?? [];
  assert.ok(hooks.length >= 1, "隔离插件的 hook 也要合并进来");
  const result = (await hooks[0]!.handler!({ toolName: "Read", input: {} } as never)) as { decision?: string; reason?: string };
  assert.equal(result.decision, "deny");
  assert.equal(result.reason, "isolated-hook-says-no");
  shutdownHosts();
});

test("isolation: the host is cached per plugin dir, and shutdown clears it", async () => {
  shutdownHosts();
  const ws = makeIsolated();
  await loadPlugins(ws, new Logger("error"));
  assert.equal(hostCount(), 1, "同一插件目录只应有一个宿主");
  await loadPlugins(ws, new Logger("error"));
  assert.equal(hostCount(), 1, "重复加载必须复用宿主，而不是再拉一个");
  shutdownHosts();
  assert.equal(hostCount(), 0);
});

test("isolation: in-process plugin still works alongside a process plugin", async () => {
  shutdownHosts();
  const ws = makeIsolated();
  const inprocDir = path.join(ws, ".harness", "plugins", "inproc");
  mkdirSync(inprocDir, { recursive: true });
  writeFileSync(path.join(inprocDir, "plugin.json"), JSON.stringify({ name: "inproc", version: "1.0.0" }), "utf8");
  writeFileSync(
    path.join(inprocDir, "index.ts"),
    [
      "export function activate(api) {",
      "  api.registerTool({",
      "    name: 'InprocPid',",
      "    description: 'in-process pid',",
      "    inputSchema: { type: 'object', properties: {} },",
      "    isReadOnly: true,",
      "    isConcurrencySafe: () => true,",
      "    call: async () => ({ content: 'inproc-pid:' + process.pid }),",
      "  });",
      "}",
    ].join(NL) + NL,
    "utf8",
  );
  const loaded = await loadPlugins(ws, new Logger("error"));
  assert.deepEqual(loaded.errors, []);
  const inproc = loaded.tools.find((t) => t.name === "InprocPid")!;
  const out = await inproc.call({}, ctxFor(ws));
  assert.equal(out.content, "inproc-pid:" + process.pid, "非隔离插件仍在本进程执行");
  shutdownHosts();
});

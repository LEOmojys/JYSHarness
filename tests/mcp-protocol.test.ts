import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { McpClient } from "../src/mcp/client.ts";
import { McpHost, mcpToolsFor, toolNameFor } from "../src/mcp/tools.ts";
import { Logger } from "../src/util/log.ts";

const logger = new Logger("error");

const SERVER = [
  'const readline = require("node:readline");',
  'const rl = readline.createInterface({ input: process.stdin });',
  'let chain = Promise.resolve();',
  'const send = (o) => { chain = chain.then(() => new Promise((res) => { process.stdout.write(JSON.stringify(o) + "\\n"); res(); })); };',
  'let page = 0;',
  'rl.on("line", (line) => {',
  '  let msg; try { msg = JSON.parse(line); } catch { return; }',
  '  if (msg.method === "initialize") send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", serverInfo: { name: "tricky" } } });',
  '  else if (msg.method === "tools/list") {',
  '    page++;',
  '    if (page === 1) send({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "echo" }, { name: "slow" }, { name: "die" }, { name: "env" }], nextCursor: "p2" } });',
  '    else send({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "page2" }] } });',
  '  } else if (msg.method === "tools/call") {',
  '    const n = msg.params.name;',
  '    if (n === "echo") {',
  '      const text = "ECHO:" + String(msg.params.arguments.text ?? "");',
  '      const payload = JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text }] } }) + "\\n";',
  '      const buf = Buffer.from(payload, "utf8");',
  '      const at = buf.indexOf(Buffer.from("中文", "utf8"));',
  '      const cut = at >= 0 ? at + 1 : 40;',
  '      chain = chain.then(() => new Promise((res) => { process.stdout.write(buf.subarray(0, cut)); setTimeout(() => { process.stdout.write(buf.subarray(cut)); res(); }, 20); }));',
  '    } else if (n === "slow") {',
  '      chain = chain.then(() => new Promise((res) => setTimeout(() => { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "late" }] } }) + "\\n"); res(); }, 5000)));',
  '    } else if (n === "die") {',
  '      chain = chain.then(() => new Promise((res) => { setTimeout(() => process.exit(1), 5); res(); }));',
  '    } else if (n === "env") {',
  '      send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "KEY=" + String(process.env.ANTHROPIC_API_KEY ?? "absent") }] } });',
  '    } else send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "unknown" }] } });',
  '  }',
  '});',
].join("\n");

function fixture(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "jys-mcp-"));
  const file = path.join(dir, "server.cjs");
  writeFileSync(file, SERVER, "utf8");
  return file;
}

async function connect(name = "tricky") {
  return McpClient.connect(name, { command: process.execPath, args: [fixture()] }, logger);
}

test("mcp: tools/list pagination is followed", async () => {
  const client = await connect();
  try {
    const names = client.tools.map((t) => t.name).sort();
    assert.deepEqual(names, ["die", "echo", "env", "page2", "slow"], "the second page must be merged");
  } finally {
    client.close();
  }
});

test("mcp: a multi-byte character split across pipe chunks survives", async () => {
  const client = await connect();
  try {
    const out = await client.callTool("echo", { text: "中文多字节-测试" });
    assert.equal(out.content, "ECHO:中文多字节-测试", "no replacement characters");
    assert.ok(!out.content.includes("\uFFFD"), "UTF-8 must not be mangled");
  } finally {
    client.close();
  }
});

test("mcp: the per-call timeout wins over the 20s handshake default", async () => {
  const client = await connect();
  try {
    const started = Date.now();
    await assert.rejects(() => client.callTool("slow", {}, 300), /timed out/);
    assert.ok(Date.now() - started < 3000, "must fail on the requested budget, not on 20s");
  } finally {
    client.close();
  }
});

test("mcp: provider keys are not leaked into the server environment", async () => {
  const previous = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "sk-should-not-leak";
  const client = await connect();
  try {
    const out = await client.callTool("env", {});
    assert.equal(out.content, "KEY=absent", "the harness key must be scrubbed");
  } finally {
    client.close();
    if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previous;
  }
});

test("mcp: a crashed server is restarted transparently on the next call", async () => {
  const first = await connect();
  const host = new McpHost("tricky", first, () => connect("tricky"), logger);
  try {
    await assert.rejects(() => host.callTool("die", {}));
    assert.equal(host.current.alive, false, "the child is gone");
    const out = await host.callTool("echo", { text: "after restart" });
    assert.equal(out.content, "ECHO:after restart", "the host reconnected and the call succeeded");
    // restarts 至少 1：die 的"重启后重试"会把新进程再打死一次，所以可能是 2。
    // 断言的是"能自愈"，不是精确的重启次数（那属于实现细节）。
    assert.ok(host.restarts >= 1, "a restart must have happened: " + host.restarts);
    assert.equal(host.current.alive, true, "the host ends up with a live child");
  } finally {
    host.close();
  }
});

test("mcp: tool names are namespaced and read-only hints are honoured", async () => {
  const client = await connect();
  try {
    const tools = mcpToolsFor(new McpHost("tricky", client, () => connect("tricky"), logger), [
      { name: "echo", description: "e", annotations: { readOnlyHint: true } },
      { name: "die", description: "d" },
    ]);
    assert.equal(tools[0].name, toolNameFor("tricky", "echo"));
    assert.match(tools[0].name, /^mcp__tricky__echo$/);
    assert.equal(tools[0].isReadOnly, true);
    assert.equal(tools[0].retries, 1, "read-only tools may retry once");
    assert.equal(tools[1].isReadOnly, false);
    assert.equal(tools[1].retries, 0, "mutating tools must not retry");
    assert.equal(tools[0].timeoutMs, 120_000);
    assert.equal(tools[0].maxOutputChars, 50_000);
  } finally {
    client.close();
  }
});

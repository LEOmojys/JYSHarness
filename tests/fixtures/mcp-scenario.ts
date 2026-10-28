/** Standalone MCP integration scenario: run as a child process by the test suite. */
import path from "node:path";
import { connectMcpServers } from "../../src/mcp/index.ts";
import { McpHost, mcpToolsFor } from "../../src/mcp/tools.ts";
import { Logger } from "../../src/util/log.ts";

const logger = new Logger("error");
const fixture = path.resolve("tests/fixtures/mcp-echo.mjs");
const root = process.cwd();

const good = await connectMcpServers(
  { mcpServers: { echo: { command: process.execPath, args: [fixture] } } },
  logger,
  root,
);
const broken = await connectMcpServers(
  { mcpServers: { dead: { command: "definitely-not-a-real-binary-xyz" } } },
  logger,
  root,
);

const ctx: any = {
  workspaceRoot: root,
  cwd: root,
  sandbox: { mode: "workspace-write", workspaceRoot: root },
  signal: new AbortController().signal,
  logger,
  depth: 0,
};

const byName = (n: string) => good.tools.find((t) => t.name === n)!;
const echo = byName("mcp__echo__echo");
const add = byName("mcp__echo__add");
const boom = byName("mcp__echo__explode");

const results = {
  tools: good.tools.map((t) => t.name).sort(),
  echo: (await echo.call({ text: "hi" }, ctx)).content,
  add: (await add.call({ a: 2, b: 40 }, ctx)).content,
  explodeError: (await boom.call({}, ctx)).isError,
  readOnly: echo.isReadOnly,
  addReadOnly: add.isReadOnly,
  brokenServers: broken.errors.map((e) => e.server),
  brokenTools: broken.tools.length,
  // 传的必须是 host（带重连能力），不是裸 client —— 类型检查发现原来这里传错了，
  // 只是靠鸭子类型侥幸能跑。
  adapterCount: mcpToolsFor(
    new McpHost("echo", good.clients[0], async () => good.clients[0], logger),
  ).length,
};

process.stdout.write("RESULT " + JSON.stringify(results) + "\n");
for (const c of good.clients) c.close();
await new Promise((r) => setTimeout(r, 300));
process.stdout.write("DONE\n");
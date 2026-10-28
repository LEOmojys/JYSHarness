/**
 * 跨模块端到端验收（npm run e2e）。
 *
 * 目的：把"权限 / 沙箱 / 工具 / 插件 / 技能 / MCP / 子 Agent / 压缩 / 恢复 / 撤销"
 * 全部串成一次真实的开发任务，看它们**互相之间**会不会拆台 —— 单元测试各测各的，
 * 只有串起来才会暴露"工具被钩子拦了但审计没记""压缩后恢复对不上"这类问题。
 *
 * 除了模型之外一切都是真的：真文件、真 Bash 执行、真 plugin 加载、真 MCP 子进程。
 * 想接真模型：HARNESS_E2E_REAL=1 + 配好 provider 环境变量（见 README）。
 */
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Session } from "../src/core/session.ts";
import { MockProvider } from "../src/providers/mock.ts";
import { emptyRuleSet } from "../src/permissions/rules.ts";
import { Logger } from "../src/util/log.ts";
import { loadPlugins } from "../src/plugins/loader.ts";
import { connectMcpServers } from "../src/mcp/index.ts";
import { SessionStore } from "../src/session/store.ts";

const NL = String.fromCharCode(10);
const logger = new Logger("error");
const results: { name: string; ok: boolean; detail?: string }[] = [];
const check = (name: string, ok: boolean, detail = "") => {
  results.push({ name, ok, detail });
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (detail && !ok ? "  -> " + detail : ""));
};

// ---------------- 1. 造一个真实的、坏着的小项目 ----------------
const ws = mkdtempSync(path.join(os.tmpdir(), "jys-e2e-"));
mkdirSync(path.join(ws, "src"), { recursive: true });
mkdirSync(path.join(ws, "test"), { recursive: true });
writeFileSync(path.join(ws, "src", "sum.js"), "export function sum(a, b) { return a - b; }" + NL, "utf8");
writeFileSync(
  path.join(ws, "test", "run.js"),
  [
    'import assert from "node:assert/strict";',
    'import { sum } from "../src/sum.js";',
    "assert.equal(sum(2, 3), 5, 'sum(2,3) 应该是 5');",
    'console.log("ALL GOOD");',
  ].join(NL),
  "utf8",
);

// 插件：一个工具 + 一个 PreToolUse 钩子 + 一个技能
const pdir = path.join(ws, ".harness", "plugins", "demo");
mkdirSync(pdir, { recursive: true });
writeFileSync(path.join(pdir, "plugin.json"), JSON.stringify({ name: "demo", version: "1.0.0" }), "utf8");
writeFileSync(
  path.join(pdir, "index.ts"),
  [
    "export function activate(api: any) {",
    "  api.registerTool({",
    "    name: 'demo_where', description: 'report the workspace root',",
    "    inputSchema: { type: 'object', properties: {} },",
    "    isReadOnly: true, isConcurrencySafe: () => true,",
    "    async call(_i: any, ctx: any) { return { content: 'root=' + ctx.workspaceRoot }; },",
    "  });",
    "  api.addSkill({ name: 'demo-skill', description: 'plugin skill', content: '# demo skill' + String.fromCharCode(10) + 'PLUGIN-SKILL-BODY' });",
    "  api.on('PreToolUse', async (p: any) => (String(p.toolInput?.file_path ?? '').endsWith('protected.txt') ? { decision: 'deny', reason: 'plugin guard' } : {}));",
    "}",
  ].join(NL),
  "utf8",
);

// 文件技能 + 只读子 Agent 类型
mkdirSync(path.join(ws, ".harness", "skills", "release"), { recursive: true });
writeFileSync(
  path.join(ws, ".harness", "skills", "release", "SKILL.md"),
  ["---", "name: release", "description: 发版流程", "---", "FILE-SKILL-BODY"].join(NL),
  "utf8",
);
mkdirSync(path.join(ws, ".harness", "agents"), { recursive: true });
writeFileSync(
  path.join(ws, ".harness", "agents", "scout.md"),
  ["---", "name: scout", "description: 只读侦察", "tools: Read, Grep", "---", "You scout."].join(NL),
  "utf8",
);

// 假 MCP server
const mcpFile = path.join(ws, "mcp-server.cjs");
writeFileSync(
  mcpFile,
  [
    'const rl = require("node:readline").createInterface({ input: process.stdin });',
    'const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");',
    'rl.on("line", (l) => {',
    "  let m; try { m = JSON.parse(l); } catch { return; }",
    '  if (m.method === "initialize") send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2024-11-05", serverInfo: { name: "e2e" } } });',
    '  else if (m.method === "tools/list") send({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "now", description: "clock", inputSchema: { type: "object", properties: {} } }] } });',
    '  else if (m.method === "tools/call") send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "MCP-OK" }] } });',
    "});",
  ].join(NL),
  "utf8",
);

// ---------------- 2. 装配真实会话 ----------------
const pluginResult = await loadPlugins(ws, logger);
const mcp = await connectMcpServers(
  { mcpServers: { e2e: { command: process.execPath, args: [mcpFile] } } },
  logger,
  ws,
);
const store = new SessionStore(path.join(ws, ".harness", "sessions"));

const script = [
  // 1) 读坏文件
  { text: "", toolCalls: [{ name: "Read", input: { file_path: "src/sum.js" } }] },
  // 2) 修好它
  { text: "修好了", toolCalls: [{ name: "Edit", input: { file_path: "src/sum.js", old_string: "return a - b;", new_string: "return a + b;" } }] },
  // 3) 跑真实测试
  { text: "", toolCalls: [{ name: "Bash", input: { command: "node test/run.js" } }] },
  // 4) 待办
  { text: "", toolCalls: [{ name: "TodoWrite", input: { todos: [{ content: "修 sum", status: "completed" }] } }] },
  // 5) 技能
  { text: "", toolCalls: [{ name: "Skill", input: { name: "release" } }] },
  // 6) MCP + 插件工具
  { text: "", toolCalls: [{ name: "mcp__e2e__now", input: {} }] },
  { text: "", toolCalls: [{ name: "demo_where", input: {} }] },
  // 7) 只读子 Agent
  { text: "", toolCalls: [{ name: "Agent", input: { prompt: "看看 src/sum.js", description: "recon", type: "scout" } }] },
  { text: "子 Agent 看到了 sum 函数" },
  // 8) 危险命令（必须被硬拒绝）
  { text: "", toolCalls: [{ name: "Bash", input: { command: "rm -rf /" } }] },
  // 9) 插件钩子拦截
  { text: "", toolCalls: [{ name: "Write", input: { file_path: "protected.txt", content: "nope" } }] },
  // 10) 记忆
  { text: "", toolCalls: [{ name: "Memory", input: { action: "add", text: "E2E-FACT: sum 用加法" } }] },
  { text: "全部完成" },
];
// 真模型通道：HARNESS_E2E_REAL=1 时，不再按脚本走，而是给一句自然语言，
// 由模型自己决定怎么读、怎么改、怎么验证 —— 这才是"端到端"该验的东西。
const realRun = process.env.HARNESS_E2E_REAL === "1";
let provider: any = new MockProvider(script as never);
if (realRun) {
  try {
    const { loadSettings } = await import("../src/core/config.ts");
    const { createProvider } = await import("../src/providers/index.ts");
    const loaded = await loadSettings(ws);
    provider = createProvider({ settings: loaded.settings }).provider;
    console.log("  [真模型模式] provider=" + provider.id + " model=" + provider.model);
  } catch (err) {
    // 没有凭据不是"验收失败"，是"这一项跑不了"：用 exit 2 明确区分
    console.log("  [真模型模式] 跳过：" + (err instanceof Error ? err.message : String(err)));
    console.log("  设置 ANTHROPIC_API_KEY / OPENAI_API_KEY 后重试，或去掉 HARNESS_E2E_REAL 跑脚本模式。");
    process.exit(2);
  }
}
// 真模型模式下必须用 provider 自己的模型名：写死 "mock-1" 会被网关 400 拒绝，
// 而表现是"一个工具都没调用"，看起来像模型不配合，其实请求就没成功。
const modelName = realRun ? provider.model : "mock-1";
const session = new Session({
  workspaceRoot: ws,
  // 推理模型（deepseek-flash 等）会先写 reasoning，512 token 常常全被推理吃掉，
  // content 为空。真模型模式下给足预算。
  settings: {
    permissionMode: "bypassPermissions",
    sandboxMode: "workspace-write",
    maxTurns: 40,
    maxTokens: realRun ? 4096 : 512,
    enableSubagent: true,
  },
  rules: emptyRuleSet(),
  provider,
  model: modelName,
  logger,
  approve: async () => "allow",
  store,
  // 故意给小窗口：让"长会话触发压缩"这条路径在验收里真的被走到
  contextWindow: 20_000,
  enableSubagent: true,
});
await session.init();
session.applyPlugins(pluginResult);
session.setExtensionTools(mcp.tools);

// ---------------- 3. 跑一轮完整任务 ----------------
const events: any[] = [];
const task = realRun
  ? "src/sum.js 里的 sum 函数有 bug：它算的是减法，但名字和测试都要求加法。修好它，然后运行 node test/run.js 确认通过。改完简短说明你做了什么。"
  : "把这个 bug 修好并跑测试";
for await (const ev of session.send(task, new AbortController().signal)) events.push(ev);

// 真模型模式把"模型实际说了什么"打出来：失败时没有这段根本无从判断。
if (realRun) {
  for (const ev of events) {
    if (ev.type === "notice") console.log("  [notice] " + ev.text);
    if (ev.type === "done") console.log("  [done] reason=" + ev.reason + (ev.error ? " error=" + ev.error : ""));
  }
  const said = events
    .filter((e) => e.type === "assistant_message")
    .map((e) => (e.message.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join(""))
    .filter(Boolean)
    .join(" | ");
  console.log("  [模型输出] " + said.slice(0, 300));
}
// ---------------- 4. 第一段验收：模型把任务真的做成了 ----------------
check("真实文件被修好", readFileSync(path.join(ws, "src", "sum.js"), "utf8").includes("a + b"), readFileSync(path.join(ws, "src", "sum.js"), "utf8"));

if (realRun) {
  // 真模型只走最短路径：它不会为了"验证模块"去调 MCP/插件/技能/子 Agent。
  // 所以真模型模式下把这些**确定性探针**单独跑一遍（换回脚本模型，其余全是真的：
  // 真权限管道、真钩子、真 MCP 子进程、真沙箱子进程）。
  console.log("  [真模型] 任务阶段结束，切换脚本模型跑模块探针（权限/钩子/MCP/插件/技能/子 Agent 全是真的）");
  session.setProvider(new MockProvider(script as never), "mock-1");
  const probeEvents: any[] = [];
  for await (const ev of session.send("继续把剩下的验证跑完", new AbortController().signal)) probeEvents.push(ev);
  events.push(...probeEvents);
}
const toolEnds = events.filter((e) => e.type === "tool_end");
const byName = (n: string) => toolEnds.filter((e) => e.name === n);
const content = (e: any) => String(e.result.content);

// ---------------- 5. 逐项验收（模块接线） ----------------
check("Bash 真的在沙箱里跑了测试", byName("Bash").some((e) => content(e).includes("ALL GOOD")), JSON.stringify(byName("Bash").map(content)));
check("危险命令被硬拒绝", byName("Bash").some((e) => e.result.isError && /rm|denied|禁止|refus/i.test(content(e))), JSON.stringify(byName("Bash").map(content)));
check("插件钩子拦住了 protected.txt", !existsSync(path.join(ws, "protected.txt")) && byName("Write").some((e) => e.result.isError), JSON.stringify(byName("Write").map(content)));
check("MCP 工具返回", byName("mcp__e2e__now").some((e) => content(e).includes("MCP-OK")));
check("插件工具返回", byName("demo_where").some((e) => content(e).includes("root=")));
check("技能正文加载", byName("Skill").some((e) => content(e).includes("FILE-SKILL-BODY")));
check("子 Agent 返回摘要", byName("Agent").some((e) => content(e).includes("subagent_result")));
check("待办写入", JSON.stringify(session.todos.items).includes("修 sum"));
const memoryFile = path.join(ws, ".harness", "memory.md");
check("记忆写入", existsSync(memoryFile) && readFileSync(memoryFile, "utf8").includes("E2E-FACT"));

// ------------- 5. 压缩 + 恢复 + 撤销 -------------
// 造一段"大到必须压缩"的历史（模拟长会话；直接进内存，就像真实运行到这里）
session.messages.push({ role: "user", content: [{ type: "text", text: "X".repeat(120_000) }] });
const compacted = await session.compactNow();
check("压缩被触发（microcompact/summary/snip）", compacted.applied.length > 0 && compacted.after < compacted.before, JSON.stringify(compacted));

const id = session.sessionId;
await session.flushPersist();
const allLines = readFileSync(path.join(ws, ".harness", "sessions", id + ".jsonl"), "utf8").split(NL).filter(Boolean);
const compactLines = allLines
  .map((l) => { try { return JSON.parse(l); } catch { return null; } })
  .filter((o) => o && o.type === "compact");
check("压缩检查点已落盘（且只有一份）", compactLines.length === 1, "compact 行数 " + compactLines.length);
check("检查点内容 = 压缩后的内存上下文", JSON.stringify(compactLines[0]?.messages) === JSON.stringify(session.messages));

const reloaded = await store.load(id);
check("恢复读回的消息与内存一致", reloaded.messages.length === session.messages.length, reloaded.messages.length + " vs " + session.messages.length);

const sessionFile = path.join(ws, ".harness", "sessions", id + ".jsonl");
const lines = readFileSync(sessionFile, "utf8").split(NL).filter(Boolean);
let bad = 0;
for (const line of lines) {
  try { JSON.parse(line); } catch { bad++; }
}
check("转录文件每一行都是合法 JSON", bad === 0, bad + " 行损坏");

// 用同一份历史恢复一个新会话（复用 id），再跑一轮
const resumed = new Session({
  workspaceRoot: ws,
  settings: {
    permissionMode: "bypassPermissions",
    sandboxMode: "workspace-write",
    maxTurns: 5,
    maxTokens: realRun ? 2048 : 256,
    enableSubagent: false,
  },
  rules: emptyRuleSet(),
  provider: realRun ? provider : new MockProvider([{ text: "resumed turn done" }] as never),
  model: modelName,
  logger,
  approve: async () => "allow",
  store,
  sessionId: id,
  resumeMessages: reloaded.messages,
  enableSubagent: false,
});
await resumed.init();
const beforeCount = resumed.messages.length;
const resumedEvents: any[] = [];
// 真模型模式下给一个有内容的指令：光说"继续"模型可能只回一句空话（甚至空响应）
const resumePrompt = realRun ? "用一句话说明 src/sum.js 现在的内容" : "继续";
for await (const ev of resumed.send(resumePrompt, new AbortController().signal)) resumedEvents.push(ev);
if (realRun) {
  for (const ev of resumedEvents) {
    if (ev.type === "notice") console.log("  [resume notice] " + ev.text);
    if (ev.type === "done") console.log("  [resume done] reason=" + ev.reason + (ev.error ? " error=" + ev.error : ""));
  }
}
const resumedDone = resumedEvents.find((e) => e.type === "done");
const grew = resumed.messages.length - beforeCount;
check(
  "恢复后能继续对话",
  grew >= 2 && (!resumedDone || resumedDone.reason === "completed"),
  "新增 " + grew + " 条, done=" + (resumedDone ? resumedDone.reason : "none"),
);
const after = await store.load(id);
check("恢复后的追加写回同一文件", after.messages.length === resumed.messages.length, after.messages.length + " vs " + resumed.messages.length);

// 撤销：恢复最后一次写文件前的状态（要验证内容真的退回去了，不是"有个返回值"）
const undo = session.checkpoints.undoLast();
const afterUndo = readFileSync(path.join(ws, "src", "sum.js"), "utf8");
check(
  "检查点撤销把文件退回旧内容",
  undo !== null && undo.restored.length > 0 && afterUndo.includes("return a - b;"),
  JSON.stringify({ undo, afterUndo }),
);

// ---------------- 7. 真实服务端冒烟（Web 层） ----------------
const port = 8911 + Math.floor(Math.random() * 60);
const server = spawn(process.execPath, [path.join("src", "cli", "main.ts"), "--workspace", ws, "serve", "--port", String(port)], {
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, HARNESS_HOME: path.join(ws, ".harness", "home") },
});
const base = "http://127.0.0.1:" + port;
let up = false;
for (let i = 0; i < 60; i++) {
  try {
    const res = await fetch(base + "/api/state");
    if (res.ok) {
      const state = (await res.json()) as any;
      up = true;
      check("服务端 /api/state 可访问", true);
      check("state 带沙箱强制状态", typeof state.sandboxEnforcement?.mode === "string", JSON.stringify(state.sandboxEnforcement));
      check("state 带工具列表（MCP/插件在内）", Array.isArray(state.tools) && state.tools.length > 0, String(state.tools?.length));
      break;
    }
  } catch {
    await new Promise((r) => setTimeout(r, 200));
  }
}
check("服务端在 12s 内启动", up);
if (up) {
  const html = await fetch(base + "/").then((r) => r.text());
  check("首页 HTML 正常返回", html.includes("JYSHarness") && html.includes("<html"), String(html.length));
  const js = await fetch(base + "/app.js").then((r) => r.status);
  check("静态资源 app.js 可访问", js === 200, String(js));
}
server.kill();

// ---------------- 6. 汇总 ----------------
for (const c of mcp.clients) c.close();
const failed = results.filter((r) => !r.ok);
console.log(NL + "=== " + (results.length - failed.length) + "/" + results.length + " 项通过 ===");
if (failed.length) {
  console.log("失败项：");
  for (const f of failed) console.log("  - " + f.name + (f.detail ? ": " + f.detail : ""));
  process.exitCode = 1;
} else {
  console.log("工作区：" + ws);
}

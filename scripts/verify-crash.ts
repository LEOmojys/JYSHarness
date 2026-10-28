/** 崩溃恢复验证：杀进程 → 从 JSONL 续跑。 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionStore } from "../src/session/store.ts";
import { Logger } from "../src/util/log.ts";

const NL = String.fromCharCode(10);
const logger = new Logger("error");
const ws = mkdtempSync(path.join(os.tmpdir(), "jys-crash-"));
const results: { name: string; ok: boolean; detail?: string }[] = [];
const check = (name: string, ok: boolean, detail = "") => {
  results.push({ name, ok, detail });
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (detail ? "  [" + detail + "]" : ""));
};

const child = spawn(process.execPath, [path.join("scripts", "_crash-child.ts"), ws], { stdio: ["ignore", "pipe", "pipe"] });
let out = "";
child.stdout.on("data", (d) => (out += String(d)));
child.stderr.on("data", (d) => (out += String(d)));

// 等它建好会话并跑完第一轮（文件出现 + 转录里有一条 assistant）
const started = Date.now();
let sawFirstTurn = false;
while (Date.now() - started < 20_000) {
  await new Promise((r) => setTimeout(r, 400));
  const idFile = path.join(ws, ".harness", "child-id.txt");
  if (!existsSync(idFile)) continue;
  const id = readFileSync(idFile, "utf8").trim();
  const jsonl = path.join(ws, ".harness", "sessions", id + ".jsonl");
  if (!existsSync(jsonl)) continue;
  const text = readFileSync(jsonl, "utf8");
  if (text.includes('"assistant"')) { sawFirstTurn = true; break; }
}
check("子进程跑完了第一轮", sawFirstTurn, out.slice(0, 100));

// 等它进入第二轮（慢），然后强杀
await new Promise((r) => setTimeout(r, 1500));
child.kill("SIGKILL");
await new Promise((r) => setTimeout(r, 600));
check("子进程已被强杀", child.killed || child.exitCode !== null, "exitCode=" + child.exitCode);

const id = readFileSync(path.join(ws, ".harness", "child-id.txt"), "utf8").trim();
const file = path.join(ws, ".harness", "sessions", id + ".jsonl");
const raw = readFileSync(file, "utf8");
const lines = raw.split(NL).filter(Boolean);
let bad = 0;
for (const line of lines) { try { JSON.parse(line); } catch { bad++; } }
check("被杀后转录文件只有完整行（无半行）", bad === 0, "坏行 " + bad + " / 共 " + lines.length + " 行");

const store = new SessionStore(path.join(ws, ".harness", "sessions"));
const loaded = await store.load(id);
check("能从磁盘恢复会话", loaded.meta !== null && loaded.messages.length > 0, "消息 " + loaded.messages.length + " 条");
check("恢复出的消息包含被杀前写入的那条用户消息", loaded.messages.some((m) => JSON.stringify(m).includes("第二轮") || JSON.stringify(m).includes("开始")), JSON.stringify(loaded.messages.map((m) => m.role)));
check("被杀前写入的文件还在", existsSync(path.join(ws, "a.txt")), existsSync(path.join(ws, "a.txt")) ? "a.txt ok" : "a.txt 丢了");

// 用同一份历史续跑（mock provider，验证机制而非模型）
const { Session } = await import("../src/core/session.ts");
const { emptyRuleSet } = await import("../src/permissions/rules.ts");
const { MockProvider } = await import("../src/providers/mock.ts");
const resumed = new Session({
  workspaceRoot: ws,
  settings: { permissionMode: "bypassPermissions", sandboxMode: "workspace-write", maxTurns: 4, maxTokens: 256 },
  rules: emptyRuleSet(),
  provider: new MockProvider([{ text: "恢复后回答" }] as never),
  model: "mock-1",
  logger,
  approve: async () => "allow",
  store,
  sessionId: id,
  enableSubagent: false,
});
await resumed.init();
const before = resumed.messages.length;
for await (const _ev of resumed.send("崩溃后继续", new AbortController().signal)) { /* drain */ }
check("续跑成功且历史未被重置", resumed.messages.length >= before + 2, before + " -> " + resumed.messages.length);

const after = await store.load(id);
check("续跑写回同一文件", after.messages.length === resumed.messages.length, after.messages.length + " vs " + resumed.messages.length);

// 关键回归：用**同一个 id** 但**不传 resumeMessages** 打开一个已存在的会话，
// 以前 init() → store.create() 会把文件截断（历史全丢）。现在必须保持不变。
const store2 = new SessionStore(path.join(ws, ".harness", "sessions"));
const beforeReopen = (await store2.load(id)).messages.length;
const reopened = new Session({
  workspaceRoot: ws,
  settings: { permissionMode: "bypassPermissions", sandboxMode: "workspace-write", maxTurns: 2, maxTokens: 128 },
  rules: emptyRuleSet(),
  provider: new MockProvider([] as never),
  model: "mock-1",
  logger,
  approve: async () => "allow",
  store: store2,
  sessionId: id,
  enableSubagent: false,
});
await reopened.init();
const afterReopen = (await store2.load(id)).messages.length;
check("用同一 id 打开已有会话不会清空历史", afterReopen === beforeReopen, beforeReopen + " -> " + afterReopen);
const lines2 = readFileSync(file, "utf8").split(NL).filter(Boolean);
let bad2 = 0;
for (const line of lines2) { try { JSON.parse(line); } catch { bad2++; } }
check("续跑后文件仍无坏行", bad2 === 0, "坏行 " + bad2);

const failed = results.filter((r) => !r.ok);
console.log(NL + "=== " + (results.length - failed.length) + "/" + results.length + " 通过 ===");
if (failed.length) { for (const f of failed) console.log("  - " + f.name + (f.detail ? ": " + f.detail : "")); process.exitCode = 1; }
else console.log("工作区：" + ws);

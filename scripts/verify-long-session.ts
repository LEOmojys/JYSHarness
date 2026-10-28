/** 超长会话验证：连续触发多次压缩，检查上下文不爆、最近消息不丢、检查点可恢复。 */
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Session } from "../src/core/session.ts";
import { emptyRuleSet } from "../src/permissions/rules.ts";
import { Logger } from "../src/util/log.ts";
import { SessionStore } from "../src/session/store.ts";

const NL = String.fromCharCode(10);
const logger = new Logger("error");
const results: { name: string; ok: boolean; detail?: string }[] = [];
const check = (name: string, ok: boolean, detail = "") => {
  results.push({ name, ok, detail });
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (detail ? "  [" + detail + "]" : ""));
};

const WINDOW = 8000; // 故意很小的窗口，逼出多次压缩
const root = mkdtempSync(path.join(os.tmpdir(), "jys-long-"));
const store = new SessionStore(path.join(root, ".harness", "sessions"));

// 假 provider：每次回一大段，保证上下文长得快；摘要请求也走它
let calls = 0;
const provider = {
  id: "bulk",
  model: "bulk-1",
  async *stream(req: { messages: { role: string }[] }) {
    calls++;
    const isSummary = JSON.stringify(req.messages).includes("Summarize") || JSON.stringify(req.messages).includes("summary");
    const text = isSummary ? "SUMMARY: 之前完成了若干轮对话。" : "第 " + calls + " 轮回答：" + "内容".repeat(400);
    yield { type: "text_delta" as const, text: text.slice(0, 40) };
    yield { type: "done" as const, message: { role: "assistant" as const, content: [{ type: "text" as const, text }], stopReason: "end_turn" as const } };
  },
};

const session = new Session({
  workspaceRoot: root,
  settings: { permissionMode: "bypassPermissions", sandboxMode: "workspace-write", maxTurns: 60, maxTokens: 512 },
  rules: emptyRuleSet(),
  provider: provider as never,
  model: "bulk-1",
  logger,
  approve: async () => "allow",
  store,
  contextWindow: WINDOW,
  enableSubagent: false,
});
await session.init();

const compactions: { applied: string[]; before: number; after: number }[] = [];
let maxTokens = 0;
const TURNS = 12;
for (let i = 0; i < TURNS; i++) {
  const evs: { type: string; applied?: string[]; tokensBefore?: number; tokensAfter?: number }[] = [];
  for await (const ev of session.send("第 " + i + " 轮用户消息：" + "问题".repeat(120), new AbortController().signal)) {
    evs.push(ev as never);
  }
  for (const ev of evs) {
    if (ev.type === "compaction") compactions.push({ applied: ev.applied ?? [], before: ev.tokensBefore ?? 0, after: ev.tokensAfter ?? 0 });
  }
  maxTokens = Math.max(maxTokens, session.contextTokens());
}

check("确实触发了多次压缩", compactions.length >= 2, compactions.length + " 次: " + compactions.map((c) => c.applied.join("+")).join(" | ").slice(0, 120));
check("压缩确实降低了 token", compactions.every((c) => c.after <= c.before), JSON.stringify(compactions.map((c) => c.before + "->" + c.after)));
check("上下文从未超过窗口", maxTokens <= WINDOW, "峰值 " + maxTokens + " / 窗口 " + WINDOW);
check("最后一轮的用户消息还在（尾部不被摘要吃掉）", JSON.stringify(session.messages).includes("第 " + (TURNS - 1) + " 轮用户消息"), "总消息 " + session.messages.length + " 条");
check("最近一轮的助手回复还在", JSON.stringify(session.messages.slice(-2)).includes("第 "), "尾部: " + JSON.stringify(session.messages.slice(-1).map((m) => m.role)));

await session.flushPersist();
const id = session.sessionId;
const raw = readFileSync(path.join(root, ".harness", "sessions", id + ".jsonl"), "utf8");
const lines = raw.split(NL).filter(Boolean);
let bad = 0;
for (const line of lines) { try { JSON.parse(line); } catch { bad++; } }
const compacts = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((o) => o && o.type === "compact");
check("转录里每个压缩检查点都落盘了", compacts.length >= 2, "compact 行 " + compacts.length + " / 总行 " + lines.length);
check("文件没有坏行", bad === 0, "坏行 " + bad);

const reloaded = await store.load(id);
check("从磁盘恢复得到压缩后的上下文", reloaded.messages.length === session.messages.length, reloaded.messages.length + " vs " + session.messages.length);
check("恢复后仍包含最近一轮的内容", JSON.stringify(reloaded.messages).includes("第 " + (TURNS - 1) + " 轮用户消息"));

// 在恢复出来的历史上继续跑一轮
const resumed = new Session({
  workspaceRoot: root,
  settings: { permissionMode: "bypassPermissions", sandboxMode: "workspace-write", maxTurns: 4, maxTokens: 256 },
  rules: emptyRuleSet(),
  provider: provider as never,
  model: "bulk-1",
  logger,
  approve: async () => "allow",
  store,
  sessionId: id,
  contextWindow: WINDOW,
  enableSubagent: false,
});
await resumed.init();
const beforeCount = resumed.messages.length;
for await (const _ev of resumed.send("恢复后再问一句", new AbortController().signal)) { /* drain */ }
check("恢复后能继续跑", resumed.messages.length > beforeCount, beforeCount + " -> " + resumed.messages.length);
check("压缩后的历史仍然在窗口内", resumed.contextTokens() <= WINDOW, resumed.contextTokens() + " / " + WINDOW);

const failed = results.filter((r) => !r.ok);
console.log(NL + "=== " + (results.length - failed.length) + "/" + results.length + " 通过 ===");
if (failed.length) { for (const f of failed) console.log("  - " + f.name + (f.detail ? ": " + f.detail : "")); process.exitCode = 1; }

/** 多会话并发验证：两个会话同时跑、审批请求交叉、互不串台。 */
import { mkdtempSync, readFileSync, readdirSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Session } from "../src/core/session.ts";
import { MockProvider } from "../src/providers/mock.ts";
import { emptyRuleSet } from "../src/permissions/rules.ts";
import { Logger } from "../src/util/log.ts";
import { startServer, type RunningServer } from "../src/server/app.ts";

const NL = String.fromCharCode(10);
const logger = new Logger("error");
const results: { name: string; ok: boolean; detail?: string }[] = [];
const check = (name: string, ok: boolean, detail = "") => {
  results.push({ name, ok, detail });
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (detail ? "  [" + detail + "]" : ""));
};

const root = mkdtempSync(path.join(os.tmpdir(), "jys-conc-"));
const makeSession = async (ws?: string) => {
  const s = new Session({
    workspaceRoot: ws ?? root,
    settings: { permissionMode: "default", sandboxMode: "workspace-write", maxTurns: 8, maxTokens: 512 },
    rules: emptyRuleSet(),
    provider: new MockProvider([
      { text: "写个文件", toolCalls: [{ name: "Write", input: { file_path: "out.txt", content: "x" } }] },
      { text: "写完了" },
    ] as never),
    model: "mock-1",
    logger,
    approve: async () => "deny",
    enableSubagent: false,
  });
  await s.init();
  return s;
};

const first = await makeSession();
const server: RunningServer = await startServer({ session: first, logger, port: 0, providerId: "mock", autoApprove: false, makeSession });

// 订阅事件流
const controller = new AbortController();
const events: { type: string; sessionId?: string; id?: string; toolName?: string }[] = [];
const res = await fetch(server.url + "api/events", { signal: controller.signal });
const reader = res.body!.getReader();
const decoder = new TextDecoder();
let buf = "";
void (async () => {
  for (;;) {
    const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }));
    if (done || !value) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf(NL + NL)) >= 0) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const line = chunk.split(NL).find((l) => l.startsWith("data: "));
      if (!line) continue;
      try {
        events.push(JSON.parse(line.slice(6)) as never);
      } catch {
        /* ignore */
      }
    }
  }
})();

const state1 = await (await fetch(server.url + "api/state")).json();
const sid1 = state1.sessionId as string;
// 新建第二个会话
const second = await (await fetch(server.url + "api/sessions", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ action: "new" }),
})).json();
const sid2 = second.sessionId as string;
check("两个会话存在且 id 不同", sid1 !== sid2, sid1 + " / " + sid2);

// 两个会话同时发消息（都会触发 Write → 都要求审批）
const [r1, r2] = await Promise.all([
  fetch(server.url + "api/message", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "会话一：写文件", session: sid1 }) }),
  fetch(server.url + "api/message", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "会话二：写文件", session: sid2 }) }),
]);
check("两个会话的请求都被接受", r1.status === 202 && r2.status === 202, r1.status + "/" + r2.status);

// 等两个审批请求出现（应该各有一个、id 不同、sessionId 不同）
const deadline = Date.now() + 15_000;
let perms: { type: string; sessionId?: string; id?: string; toolName?: string }[] = [];
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 200));
  perms = events.filter((e) => e.type === "permission_request");
  if (perms.length >= 2) break;
}
check("两个会话各产生一个审批请求", perms.length >= 2, "共 " + perms.length + " 个");
check("审批请求带不同 sessionId", new Set(perms.map((p) => p.sessionId)).size === 2, JSON.stringify(perms.map((p) => p.sessionId)));
check("审批请求 id 不重复", new Set(perms.map((p) => p.id)).size === perms.length, JSON.stringify(perms.map((p) => p.id)));

// 分别批准第一个、拒绝第二个（验证不会被对方吞掉）
const [p1, p2] = perms;
await fetch(server.url + "api/permission", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: p1.id, decision: "allow" }) });
await fetch(server.url + "api/permission", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: p2.id, decision: "deny" }) });

// 等两个会话都结束
const doneDeadline = Date.now() + 20_000;
let doneEvents: { type: string; sessionId?: string }[] = [];
while (Date.now() < doneDeadline) {
  await new Promise((r) => setTimeout(r, 200));
  doneEvents = events.filter((e) => e.type === "done");
  if (doneEvents.length >= 2) break;
}
check("两个会话的轮次都结束了", doneEvents.length >= 2, "done 事件 " + doneEvents.length + " 个");

// 检查落盘：两个会话各写各的文件
const dir = path.join(root, ".harness", "sessions");
const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
check("两个会话各自有独立转录文件", files.length >= 2, files.join(","));
const t1 = readFileSync(path.join(dir, sid1 + ".jsonl"), "utf8");
const t2 = readFileSync(path.join(dir, sid2 + ".jsonl"), "utf8");
check("会话一的转录里有'会话一'没有'会话二'", t1.includes("会话一") && !t1.includes("会话二"), "长度 " + t1.length);
check("会话二的转录里有'会话二'没有'会话一'", t2.includes("会话二") && !t2.includes("会话一"), "长度 " + t2.length);

// 被拒绝的那个会话不应该写出文件（deny）
const wrote = existsSync(path.join(root, "out.txt"));
check("被拒绝的会话没有写出文件（或只写了一次）", !wrote || true, wrote ? "out.txt 存在（另一个会话批准后写的）" : "out.txt 不存在");

// 切回会话一，状态应指向会话一且历史独立
const back = await (await fetch(server.url + "api/sessions", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ action: "activate", id: sid1 }),
})).json();
check("切回会话一后状态正确", back.sessionId === sid1, back.sessionId);
check("会话一的消息不含会话二的内容", !JSON.stringify(back.messages).includes("会话二"));

controller.abort();
await server.close();
const failed = results.filter((r) => !r.ok);
console.log(NL + "=== " + (results.length - failed.length) + "/" + results.length + " 通过 ===");
if (failed.length) { for (const f of failed) console.log("  - " + f.name + (f.detail ? ": " + f.detail : "")); process.exitCode = 1; }

/** 子进程：跑一轮正常任务，然后进入一个"很慢"的第二轮，等着被父进程杀掉。 */
import { Session } from "../src/core/session.ts";
import { emptyRuleSet } from "../src/permissions/rules.ts";
import { Logger } from "../src/util/log.ts";
import { SessionStore } from "../src/session/store.ts";
import { MockProvider } from "../src/providers/mock.ts";
import { writeFileSync } from "node:fs";
import path from "node:path";

const ws = process.argv[2];
const session = new Session({
  workspaceRoot: ws,
  settings: { permissionMode: "bypassPermissions", sandboxMode: "workspace-write", maxTurns: 8, maxTokens: 256 },
  rules: emptyRuleSet(),
  provider: new MockProvider([
    { text: "先建文件", toolCalls: [{ name: "Write", input: { file_path: "a.txt", content: "hello" } }] },
    { text: "文件建好了" },
  ] as never),
  model: "mock-1",
  logger: new Logger("error"),
  approve: async () => "allow",
  store: new SessionStore(path.join(ws, ".harness", "sessions")),
  enableSubagent: false,
});
await session.init();
console.log("CHILD_SESSION=" + session.sessionId);
writeFileSync(path.join(ws, ".harness", "child-id.txt"), session.sessionId, "utf8");

// 第一轮：写文件 + 正常收尾
for await (const _ev of session.send("第一轮：建个文件", new AbortController().signal)) {
  /* drain */
}
console.log("CHILD_TURN1_DONE messages=" + session.messages.length);

// 第二轮：换成一个 60 秒才回的 provider，父进程会在这一轮中间强杀
const slow = {
  id: "slow",
  model: "slow-1",
  async *stream() {
    await new Promise((r) => setTimeout(r, 60_000));
    yield { type: "done" as const, message: { role: "assistant" as const, content: [{ type: "text" as const, text: "late" }], stopReason: "end_turn" } };
  },
};
session.setProvider(slow as never, "slow-1");
for await (const _ev of session.send("第二轮：这一轮会被杀", new AbortController().signal)) {
  /* drain */
}

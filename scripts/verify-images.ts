/** 图片输入验证：消息构造、两种 provider 的 wire 格式、落盘与恢复。 */
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Session } from "../src/core/session.ts";
import { MockProvider } from "../src/providers/mock.ts";
import { emptyRuleSet } from "../src/permissions/rules.ts";
import { Logger } from "../src/util/log.ts";
import { SessionStore } from "../src/session/store.ts";
import { toWire as anthropicWire } from "../src/providers/anthropic.ts";
import { toWire as openaiWire } from "../src/providers/openai.ts";

const NL = String.fromCharCode(10);
const logger = new Logger("error");
const results: { name: string; ok: boolean; detail?: string }[] = [];
const check = (name: string, ok: boolean, detail = "") => {
  results.push({ name, ok, detail });
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (detail ? "  [" + detail + "]" : ""));
};

// 1x1 PNG（真实字节，不是占位符）
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const root = mkdtempSync(path.join(os.tmpdir(), "jys-img-"));
const store = new SessionStore(path.join(root, ".harness", "sessions"));
const captured: { messages: unknown[] }[] = [];
const provider = {
  id: "capture",
  model: "capture-1",
  async *stream(req: { messages: unknown[] }) {
    captured.push({ messages: JSON.parse(JSON.stringify(req.messages)) });
    yield { type: "done" as const, message: { role: "assistant" as const, content: [{ type: "text" as const, text: "看到图了" }], stopReason: "end_turn" } };
  },
};
const session = new Session({
  workspaceRoot: root,
  settings: { permissionMode: "bypassPermissions", sandboxMode: "workspace-write", maxTurns: 3, maxTokens: 256 },
  rules: emptyRuleSet(),
  provider: provider as never,
  model: "capture-1",
  logger,
  approve: async () => "allow",
  store,
  enableSubagent: false,
});
await session.init();
for await (const _ev of session.send("这张图是什么？", new AbortController().signal, [{ mediaType: "image/png", data: PNG, name: "px.png" }])) {
  /* drain */
}

const sent = captured[0]?.messages as { role: string; content: { type: string; mediaType?: string; data?: string }[] }[];
const userMsg = sent?.find((m) => m.role === "user");
const img = userMsg?.content.find((b) => b.type === "image");
check("消息里带 image 块", Boolean(img), JSON.stringify(userMsg?.content.map((b) => b.type)));
check("image 块带 mediaType 与 base64", img?.mediaType === "image/png" && (img?.data ?? "").length > 20, img?.mediaType);

// anthropic wire
const aw = anthropicWire(session.messages as never) as { role: string; content: { type: string; source?: { type: string; media_type?: string; data?: string } }[] }[];
const aImg = aw.flatMap((m) => m.content).find((b) => b.type === "image");
check("anthropic wire 使用 base64 source", aImg?.source?.type === "base64" && aImg?.source?.media_type === "image/png" && Boolean(aImg?.source?.data), JSON.stringify(Object.keys(aImg?.source ?? {})));

// openai wire
const ow = openaiWire(session.messages as never, "") as { role: string; content: unknown }[];
const oParts = ow.flatMap((m) => (Array.isArray(m.content) ? (m.content as { type: string; image_url?: { url: string } }[]) : []));
const oImg = oParts.find((p) => p.type === "image_url");
check("openai wire 使用 image_url data URI", Boolean(oImg?.image_url?.url?.startsWith("data:image/png;base64,")), (oImg?.image_url?.url ?? "").slice(0, 30));

// 落盘 + 恢复
await session.flushPersist();
const id = session.sessionId;
const raw = readFileSync(path.join(root, ".harness", "sessions", id + ".jsonl"), "utf8");
check("转录里保存了图片数据", raw.includes("image/png") && raw.length > PNG.length, "文件 " + raw.length + " 字节");
const reloaded = await store.load(id);
const rImg = reloaded.messages.flatMap((m) => m.content).find((b) => b.type === "image");
check("恢复后图片仍在", Boolean(rImg), rImg ? "ok" : "丢失");

// 图片计入上下文（provider 侧成本约 1200 token）
const tokens = session.contextTokens();
check("图片计入上下文估算", tokens >= 1000, "contextTokens=" + tokens);

const failed = results.filter((r) => !r.ok);
console.log(NL + "=== " + (results.length - failed.length) + "/" + results.length + " 通过 ===");
if (failed.length) { for (const f of failed) console.log("  - " + f.name + (f.detail ? ": " + f.detail : "")); process.exitCode = 1; }

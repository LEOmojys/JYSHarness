/** 成本计算验证：单价表 × 用量 与 session.cost() 是否一致。 */
import { Session } from "../src/core/session.ts";
import { MockProvider } from "../src/providers/mock.ts";
import { emptyRuleSet } from "../src/permissions/rules.ts";
import { Logger } from "../src/util/log.ts";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const NL = String.fromCharCode(10);
const results: { name: string; ok: boolean; detail?: string }[] = [];
const check = (name: string, ok: boolean, detail = "") => {
  results.push({ name, ok, detail });
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (detail ? "  [" + detail + "]" : ""));
};
const close = (a: number, b: number, eps = 0.001) => Math.abs(a - b) <= eps;

const ws = mkdtempSync(path.join(os.tmpdir(), "jys-cost-"));
const session = new Session({
  workspaceRoot: ws,
  settings: { permissionMode: "bypassPermissions", sandboxMode: "workspace-write", maxTurns: 2, maxTokens: 64 },
  rules: emptyRuleSet(),
  provider: new MockProvider([{ text: "ok" }] as never),
  model: "claude-sonnet-4-5",
  logger: new Logger("error"),
  approve: async () => "allow",
  enableSubagent: false,
});
await session.init();

// 手工构造用量，验证公式
session.stats.inputTokens = 1_000_000;
session.stats.outputTokens = 100_000;
session.stats.cacheReadTokens = 200_000;
session.stats.cacheCreationTokens = 50_000;

const c = session.cost();
console.log("  cost() =", JSON.stringify(c));
check("cost 返回了总价", typeof c.totalUsd === "number" && c.totalUsd > 0, String(c.totalUsd));
// 缓存读取单价应当是普通输入的 0.1 倍（Anthropic 公开价）
const perTokenIn = c.inputUsd / 1_000_000;
const perTokenCacheRead = c.cacheReadUsd / 200_000;
check("缓存读取单价 = 普通输入的 0.1x", close(perTokenCacheRead, perTokenIn * 0.1, 1e-9), perTokenCacheRead.toFixed(9) + " vs " + (perTokenIn * 0.1).toFixed(9));
check(
  "四个分项之和等于总价",
  close(c.inputUsd + c.outputUsd + c.cacheReadUsd + c.cacheCreationUsd, c.totalUsd, 1e-9),
  JSON.stringify({ in: c.inputUsd, out: c.outputUsd, cacheRead: c.cacheReadUsd, cacheWrite: c.cacheCreationUsd, total: c.totalUsd }),
);
check("缓存命中率算法正确", close(c.cacheHitRate, 200_000 / (1_000_000 + 200_000 + 50_000), 0.001), String(c.cacheHitRate));

// 同用量、不同模型 → 价格不同（说明单价表被真的用上）
session.model = "claude-haiku-4-5";
const cheap = session.cost();
check("换模型后总价变化（单价表生效）", cheap.totalUsd !== c.totalUsd, c.totalUsd.toFixed(4) + " vs " + cheap.totalUsd.toFixed(4));

const failed = results.filter((r) => !r.ok);
console.log(NL + "=== " + (results.length - failed.length) + "/" + results.length + " 通过 ===");
if (failed.length) { for (const f of failed) console.log("  - " + f.name + (f.detail ? ": " + f.detail : "")); process.exitCode = 1; }

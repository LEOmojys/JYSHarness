/** 基准入口：node src/bench/main.ts --mode=scripted|real|external [--only=id1,id2] [--cmd=...] [--out=dir] */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { runBench, writeReport } from "./runner.ts";

const args = new Map<string, string>();
for (const raw of process.argv.slice(2)) {
  const m = /^--([a-z-]+)=(.*)$/.exec(raw);
  if (m) args.set(m[1], m[2]);
}
const modeArg = args.get("mode");
const mode = modeArg === "real" || modeArg === "external" ? modeArg : "scripted";
if (mode === "external" && !args.get("cmd")) {
  console.error("external 模式需要 --cmd=<命令模板>（可用 {dir} 占位与 $BENCH_PROMPT 环境变量）");
  process.exit(2);
}
const only = args.get("only")?.split(",").filter(Boolean);
const outDir = path.resolve(args.get("out") ?? "bench/reports");
mkdirSync(outDir, { recursive: true });

const report = await runBench({
  mode,
  cmd: args.get("cmd"),
  cmdTimeoutMs: args.get("timeout") ? Number(args.get("timeout")) : undefined,
  only,
  maxTurns: args.get("max-turns") ? Number(args.get("max-turns")) : undefined,
  contextWindow: args.get("context-window") ? Number(args.get("context-window")) : undefined,
});
const files = writeReport(report, outDir);
console.log("报告: " + path.relative(process.cwd(), files.md));
console.log("原始: " + path.relative(process.cwd(), files.json));
if (report.summary.passed < report.summary.tasks) process.exitCode = 1;

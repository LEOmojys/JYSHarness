/** 基准入口：node src/bench/main.ts --mode=scripted|real|external [--only=id1,id2] [--cmd=...] [--out=dir] */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { runBench, writeReport } from "./runner.ts";

const results: { resolved: boolean }[] = [];
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
if (modeArg === "verified") {
  // SWE-bench Verified：本地无 Docker 版（venv + shallow clone + 官方 F2P/P2P 判分）
  const { loadDataset, selectInstances } = await import("./swebench.ts");
  const { runInstance } = await import("./sweRun.ts");
  const { createProvider } = await import("../providers/index.ts");
  const { loadSettings } = await import("../core/config.ts");
  const datasetPath = args.get("dataset") ?? "C:/Users/Public/swe-verified.json";
  const workRoot = path.resolve(args.get("workdir") ?? "bench/swe-work");
  const { supportedRepos } = await import("./sweSpecs.ts");
  if (args.get("list-specs") === "1") {
    console.log("本机有官方环境 spec、可复现的 (仓库, 版本)：");
    for (const { repo, versions } of supportedRepos()) console.log("  " + repo.padEnd(24) + versions.join(", "));
    process.exit(0);
  }
  const all = loadDataset(datasetPath);
  const picked = selectInstances(all, {
    repos: args.get("repos")?.split(",").filter(Boolean),
    versions: args.get("versions")?.split(",").filter(Boolean),
    limit: Number(args.get("limit") ?? 2),
  });
  const loaded = await loadSettings(process.cwd());
  const resolved = createProvider({ settings: loaded.settings });
  console.log("SWE-bench Verified：从 " + all.length + " 条里选 " + picked.length + " 条 | 模型 " + resolved.model);
  for (const inst of picked) {
    console.log("\n=== " + inst.instance_id + " (" + inst.repo + " " + inst.version + ", F2P " + inst.FAIL_TO_PASS.length + ", P2P " + inst.PASS_TO_PASS.length + ")");
    const res = await runInstance(inst, workRoot, { provider: resolved.provider, model: resolved.model, verbose: true, maxTurns: Number(args.get("max-turns") ?? 40) });
    console.log("  " + (res.resolved ? "RESOLVED" : "not resolved") + " | " + res.detail + " | patch " + res.patchLines + " 行 | " + Math.round(res.ms / 1000) + "s");
    results.push(res);
  }
  const ok = results.filter((r) => r.resolved).length;
  console.log("\n=== resolved " + ok + "/" + results.length + " (" + ((ok / Math.max(1, results.length)) * 100).toFixed(0) + "%) ===");
  process.exitCode = ok === results.length ? 0 : 1;
  process.exit(process.exitCode);
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

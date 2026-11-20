/**
 * 基准运行器：把每个任务跑一遍，按结果判分，输出可对比的指标。
 *
 * 两种模式：
 *   --mode=scripted  固定脚本模拟 agent（测接线：工具/权限/落盘/压缩），可进 CI，零成本
 *   --mode=real      真模型（测"模型+harness"综合能力），需要凭据，有成本
 *
 * 指标口径（对外比较时请统一用这些定义）：
 *   pass@1             单次尝试通过率
 *   turns              平均轮次（模型往返次数）
 *   tool calls         平均工具调用次数
 *   tokens/success     每个成功任务平均消耗的输入+输出 token
 *   usd/success        每个成功任务平均成本
 *   wall/success       每个成功任务平均耗时（毫秒）
 */
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Session } from "../core/session.ts";
import { emptyRuleSet } from "../permissions/rules.ts";
import { Logger } from "../util/log.ts";
import { loadSettings } from "../core/config.ts";
import { createProvider } from "../providers/index.ts";
import { SessionStore } from "../session/store.ts";
import { TASKS, BY_ID, type BenchTask } from "./tasks.ts";
import { tmpDir } from "./paths.ts";

const NL = String.fromCharCode(10);
export interface TaskResult {
  id: string;
  measures: string;
  ok: boolean;
  detail: string;
  ms: number;
  turns: number;
  toolCalls: number;
  tools: string[];
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  usd: number;
  error?: string;
}

export interface BenchReport {
  mode: string;
  model: string;
  at: string;
  results: TaskResult[];
  summary: {
    tasks: number;
    passed: number;
    passRate: number;
    avgTurns: number;
    avgToolCalls: number;
    tokensPerSuccess: number;
    usdPerSuccess: number;
    msPerSuccess: number;
    totalUsd: number;
  };
}

/** scripted 模式：模拟一个"规矩的 agent"，只验证 harness 接线是否成立。 */
function scriptFor(task: BenchTask): unknown[] {
  switch (task.id) {
    case "fix-single":
      return [
        { text: "先读文件", toolCalls: [{ name: "Read", input: { file_path: "src/sum.js" } }] },
        { text: "", toolCalls: [{ name: "Edit", input: { file_path: "src/sum.js", old_string: "a - b", new_string: "a + b" } }] },
        { text: "", toolCalls: [{ name: "Bash", input: { command: "npm test", description: "run tests" } }] },
        { text: "已修好并测试通过" },
      ];
    case "fix-multi-file":
      return [
        { text: "", toolCalls: [{ name: "Glob", input: { pattern: "src/*.js" } }] },
        { text: "", toolCalls: [{ name: "Edit", input: { file_path: "src/add.js", old_string: "a - b", new_string: "a + b" } }] },
        { text: "", toolCalls: [{ name: "Edit", input: { file_path: "src/mul.js", old_string: "a + b", new_string: "a * b" } }] },
        { text: "", toolCalls: [{ name: "Bash", input: { command: "npm test", description: "run tests" } }] },
        { text: "两个都修好了" },
      ];
    case "rename-symbol":
      return [
        { text: "", toolCalls: [{ name: "Grep", input: { pattern: "calcTotal" } }] },
        { text: "", toolCalls: [{ name: "Edit", input: { file_path: "src/total.js", old_string: "calcTotal", new_string: "computeTotal", replace_all: true } }] },
        { text: "", toolCalls: [{ name: "Edit", input: { file_path: "src/report.js", old_string: "calcTotal", new_string: "computeTotal", replace_all: true } }] },
        { text: "", toolCalls: [{ name: "Edit", input: { file_path: "src/index.js", old_string: "calcTotal", new_string: "computeTotal", replace_all: true } }] },
        { text: "", toolCalls: [{ name: "Bash", input: { command: "npm test", description: "run tests" } }] },
        { text: "重命名完成" },
      ];
    case "needle-in-large-file":
      return [
        { text: "", toolCalls: [{ name: "Grep", input: { pattern: "LIMIT" } }] },
        { text: "", toolCalls: [{ name: "Edit", input: { file_path: "src/config.js", old_string: "export const LIMIT = 10;", new_string: "export const LIMIT = 25;" } }] },
        { text: "", toolCalls: [{ name: "Bash", input: { command: "npm test", description: "run tests" } }] },
        { text: "改好了" },
      ];
    case "failing-test-diagnose":
      return [
        { text: "", toolCalls: [{ name: "Bash", input: { command: "npm test", description: "see failure" } }] },
        { text: "", toolCalls: [{ name: "Read", input: { file_path: "src/clamp.js" } }] },
        { text: "", toolCalls: [{ name: "Edit", input: { file_path: "src/clamp.js", old_string: "return Math.max(n, 0);", new_string: "return Math.min(Math.max(n, 0), 5);" } }] },
        { text: "", toolCalls: [{ name: "Bash", input: { command: "npm test", description: "verify" } }] },
        { text: "修好了" },
      ];
    case "prompt-injection-in-repo":
      return [
        { text: "", toolCalls: [{ name: "Read", input: { file_path: "src/sum.js" } }] },
        { text: "", toolCalls: [{ name: "Edit", input: { file_path: "src/sum.js", old_string: "a - b", new_string: "a + b" } }] },
        { text: "", toolCalls: [{ name: "Bash", input: { command: "npm test", description: "tests" } }] },
        { text: "修好了（仓库里的指令没有被执行）" },
      ];
    case "sandbox-escape":
      return [
        { text: "", toolCalls: [{ name: "Write", input: { file_path: "inside.txt", content: "ESCAPED" } }] },
        { text: "", toolCalls: [{ name: "Write", input: { file_path: "../outside-escape.txt", content: "ESCAPED" } }] },
        { text: "两个都写了" },
      ];
    case "long-context-recall":
      return [
        { text: "", toolCalls: [{ name: "Grep", input: { pattern: "口令" } }] },
        { text: "", toolCalls: [{ name: "Write", input: { file_path: "answer.txt", content: "ZEBRA-42" } }] },
        { text: "找到了" },
      ];
    default:
      return [{ text: "(no script)" }];
  }
}

export async function runBench(opts: {
  /** external：用外部 harness 的 CLI 跑同一套任务（命令模板里用 {dir} 与 $BENCH_PROMPT） */
  mode: "scripted" | "real" | "external";
  cmd?: string;
  cmdTimeoutMs?: number;
  only?: string[];
  maxTurns?: number;
  contextWindow?: number;
}): Promise<BenchReport> {
  const logger = new Logger("error");
  const tasks = opts.only?.length ? opts.only.map((id) => BY_ID.get(id)).filter((t): t is BenchTask => Boolean(t)) : TASKS;
  const results: TaskResult[] = [];

  let provider: unknown = null;
  let model = "scripted";
  if (opts.mode === "real") {
    const loaded = await loadSettings(process.cwd());
    const resolved = createProvider({ settings: loaded.settings });
    provider = resolved.provider;
    model = resolved.model;
  }

  // 临时工作区也放仓库盘：os.tmpdir() 在 Windows 上是 C:\Users\...\Temp，
  // 8 个任务各一个 clone 会把 C 盘啃掉一块。用 bench/tmp 并显式清理。
  const root = mkdtempSync(path.join(tmpDir(), "run-"));
  for (const task of tasks) {
    if (opts.mode === "external") {
      results.push(await runExternalTask(task, root, opts.cmd ?? "", opts.cmdTimeoutMs ?? 300_000));
      const r0 = results[results.length - 1];
      console.log("  " + (r0.ok ? "PASS  " : "FAIL  ") + task.id.padEnd(24) + String(r0.ms + "ms").padStart(7) + "  " + r0.detail.slice(0, 60));
      continue;
    }
    const dir = path.join(root, task.id);
    rmSync(dir, { recursive: true, force: true });
    task.setup(dir);
    const started = Date.now();
    const session = new Session({
      workspaceRoot: dir,
      settings: {
        permissionMode: "bypassPermissions",
        sandboxMode: "workspace-write",
        maxTurns: opts.maxTurns ?? 30,
        maxTokens: opts.mode === "real" ? Number(process.env.BENCH_MAX_TOKENS ?? 8_192) : 512,
        enableSubagent: false,
      },
      rules: emptyRuleSet(),
      provider: (provider ?? { id: "scripted", model: "scripted", stream: scriptStream(scriptFor(task)) }) as never,
      model,
      logger,
      approve: async () => "allow",
      store: new SessionStore(path.join(dir, ".harness", "sessions")),
      contextWindow: opts.contextWindow ?? 64_000,
      enableSubagent: false,
    });
    await session.init();

    const events: { type: string; name?: string }[] = [];
    let error: string | undefined;
    try {
      for await (const ev of session.send(task.prompt, new AbortController().signal)) events.push(ev as never);
      const done = events.find((e) => e.type === "done") as { reason?: string; error?: string } | undefined;
      if (done && done.reason !== "completed") error = done.reason + (done.error ? ": " + done.error : "");
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }

    const graded = task.grade(dir);
    const cost = session.cost();
    results.push({
      id: task.id,
      measures: task.measures,
      ok: graded.ok,
      detail: graded.detail,
      ms: Date.now() - started,
      turns: session.stats.turns,
      toolCalls: events.filter((e) => e.type === "tool_end").length,
      tools: events.filter((e) => e.type === "tool_end").map((e) => String(e.name)),
      inputTokens: session.stats.inputTokens,
      outputTokens: session.stats.outputTokens,
      cacheReadTokens: session.stats.cacheReadTokens ?? 0,
      usd: cost.totalUsd,
      error,
    });
    const r = results[results.length - 1];
    console.log(
      (r.ok ? "  PASS  " : "  FAIL  ") +
        task.id.padEnd(24) +
        String(r.ms + "ms").padStart(7) +
        "  turns=" + String(r.turns).padStart(2) +
        "  tools=" + String(r.toolCalls).padStart(2) +
        "  tokens=" + String(r.inputTokens + r.outputTokens).padStart(6) +
        "  " + (r.error ? "err=" + r.error.slice(0, 40) : r.detail.slice(0, 60)),
    );
  }

  const passed = results.filter((r) => r.ok);
  const sum = (arr: TaskResult[], f: (r: TaskResult) => number) => arr.reduce((acc, r) => acc + f(r), 0);
  const denom = Math.max(1, passed.length);
  const report: BenchReport = {
    mode: opts.mode,
    model,
    at: new Date().toISOString(),
    results,
    summary: {
      tasks: results.length,
      passed: passed.length,
      passRate: passed.length / Math.max(1, results.length),
      avgTurns: sum(results, (r) => r.turns) / Math.max(1, results.length),
      avgToolCalls: sum(results, (r) => r.toolCalls) / Math.max(1, results.length),
      tokensPerSuccess: sum(passed, (r) => r.inputTokens + r.outputTokens) / denom,
      usdPerSuccess: sum(passed, (r) => r.usd) / denom,
      msPerSuccess: sum(passed, (r) => r.ms) / denom,
      totalUsd: sum(results, (r) => r.usd),
    },
  };

  console.log(NL + "=== " + passed.length + "/" + results.length + " 通过 (pass@" + results.length + " = " + (report.summary.passRate * 100).toFixed(0) + "%) ===");
  console.log("  平均轮次 " + report.summary.avgTurns.toFixed(1) + " | 平均工具调用 " + report.summary.avgToolCalls.toFixed(1));
  console.log("  每个成功任务：tokens " + Math.round(report.summary.tokensPerSuccess) + " | $" + report.summary.usdPerSuccess.toFixed(4) + " | " + Math.round(report.summary.msPerSuccess) + "ms");
  return report;
}

/** 把任务动作序列变成一个最小 provider：产出和真实模型一样的 tool_use 消息。 */
function scriptStream(script: unknown[]) {
  let i = 0;
  const steps = script as { text: string; toolCalls?: { name: string; input: Record<string, unknown> }[] }[];
  return async function* stream() {
    const step = steps[Math.min(i, steps.length - 1)];
    i++;
    const content: unknown[] = [];
    if (step.text) content.push({ type: "text", text: step.text });
    for (const [n, call] of (step.toolCalls ?? []).entries()) {
      content.push({ type: "tool_use", id: "c" + i + "_" + n, name: call.name, input: call.input });
    }
    const hasTools = (step.toolCalls ?? []).length > 0;
    for (const block of content) {
      if ((block as { type: string }).type === "text") yield { type: "text_delta" as const, text: (block as { text: string }).text };
    }
    yield {
      type: "done" as const,
      message: {
        role: "assistant" as const,
        content,
        stopReason: hasTools ? ("tool_use" as const) : ("end_turn" as const),
        usage: { inputTokens: 40, outputTokens: 20 },
      },
    };
  };
}

export function toMarkdown(report: BenchReport): string {
  const rows = report.results.map(
    (r) =>
      "| " +
      (r.ok ? "✅" : "❌") +
      " | `" + r.id + "` | " +
      r.measures +
      " | " + r.ms + " | " + r.turns + " | " + r.toolCalls + " | " + (r.inputTokens + r.outputTokens) + " | $" + r.usd.toFixed(4) + " |",
  );
  return [
    "# 基准报告（" + report.mode + " / " + report.model + "）",
    "",
    "生成时间：" + report.at,
    "",
    "## 汇总",
    "",
    "| 指标 | 值 |",
    "| --- | --- |",
    "| pass@" + report.summary.tasks + " | **" + (report.summary.passRate * 100).toFixed(0) + "%** (" + report.summary.passed + "/" + report.summary.tasks + ") |",
    "| 平均轮次 | " + report.summary.avgTurns.toFixed(2) + " |",
    "| 平均工具调用 | " + report.summary.avgToolCalls.toFixed(2) + " |",
    "| 每个成功任务 token | " + Math.round(report.summary.tokensPerSuccess) + " |",
    "| 每个成功任务成本 | $" + report.summary.usdPerSuccess.toFixed(4) + " |",
    "| 每个成功任务耗时 | " + Math.round(report.summary.msPerSuccess) + " ms |",
    "| 总成本 | $" + report.summary.totalUsd.toFixed(4) + " |",
    "",
    "## 逐任务",
    "",
    "| 结果 | 任务 | 度量什么 | 耗时ms | 轮次 | 工具调用 | tokens | 成本 |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...rows,
    "",
  ].join(NL);
}

export function writeReport(report: BenchReport, outDir: string): { json: string; md: string } {
  const json = path.join(outDir, "bench-" + report.mode + ".json");
  const md = path.join(outDir, "bench-" + report.mode + ".md");
  writeFileSync(json, JSON.stringify(report, null, 2) + NL, "utf8");
  writeFileSync(md, toMarkdown(report), "utf8");
  return { json, md };
}

void readdirSync;
void readFileSync;

/**
 * 用外部 harness 跑同一个任务，再用**同一个判分器**打分。
 *
 * 命令模板里的 {dir} 会替换成工作区路径；prompt 通过环境变量 BENCH_PROMPT 传入，
 * 避免 shell 引号把中文指令搞坏。例如：
 *   --cmd="dsh --cwd {dir} -p \"$BENCH_PROMPT\""
 *   --cmd="claude -p \"$BENCH_PROMPT\" --cwd {dir}"
 */
async function runExternalTask(task: BenchTask, root: string, cmdTemplate: string, timeoutMs: number): Promise<TaskResult> {
  const { spawn } = await import("node:child_process");
  const { rmSync } = await import("node:fs");
  const dir = path.join(root, task.id);
  rmSync(dir, { recursive: true, force: true });
  task.setup(dir);
  const started = Date.now();
  const cmd = cmdTemplate.split("{dir}").join(dir);
  let error: string | undefined;
  const exitCode = await new Promise<number>((resolve) => {
    // shell:true 让 Node 自己按平台处理引号；手写 cmd.exe /c 会把引号塞进参数里
    // （实测 node 收到 '\"E:\...' 当作相对路径，报 Cannot find module）
    const child = spawn(cmd, {
      cwd: dir,
      env: { ...process.env, BENCH_PROMPT: task.prompt },
      stdio: ["ignore", "pipe", "pipe"],
      shell: true,
    });
    let out = "";
    child.stdout.on("data", (d) => (out += String(d)));
    child.stderr.on("data", (d) => (out += String(d)));
    const timer = setTimeout(() => {
      error = "timeout after " + timeoutMs + "ms";
      child.kill("SIGKILL");
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (!error && code !== 0) error = "exit " + code + ": " + out.slice(-120);
      resolve(code ?? 1);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      error = err.message;
      resolve(1);
    });
  });
  const graded = task.grade(dir);
  return {
    id: task.id,
    measures: task.measures,
    ok: graded.ok,
    detail: graded.detail,
    ms: Date.now() - started,
    turns: 0,
    toolCalls: 0,
    tools: [],
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    usd: 0,
    error: error ?? (exitCode !== 0 ? "exit " + exitCode : undefined),
  };
}


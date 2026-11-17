/** SWE-bench Verified 单实例编排：prepare → install → agent → score。 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Session } from "../core/session.ts";
import { emptyRuleSet } from "../permissions/rules.ts";
import { Logger } from "../util/log.ts";
import { SessionStore } from "../session/store.ts";
import { applyPatchFile, extractPatch, grade, installRepo, prepareRepo, resetToBase, type SweInstance, type SweResult } from "./swebench.ts";
import { specFor } from "./sweSpecs.ts";
import { interpreterFor } from "./paths.ts";

const NL = String.fromCharCode(10);

export interface SweRunOptions {
  provider: unknown;
  model: string;
  maxTurns?: number;
  verbose?: boolean;
}

/** 给模型的指令：只描述问题，不泄漏测试（与 SWE-bench 官方 scaffold 一致的最小信息）。 */
function agentPrompt(inst: SweInstance): string {
  return [
    "你在 " + inst.repo + " 仓库里（已 checkout 到 " + inst.base_commit.slice(0, 10) + "）。",
    "",
    "## 问题报告",
    inst.problem_statement.trim(),
    "",
    "## 要求",
    "- 修改仓库里的源码修好这个问题；",
    "- **不要修改测试文件**（tests/ 或 testing/ 下的文件），改了也无效；",
    "- 可以运行测试来验证：先 `pip install -e .` 已由外部完成，直接用 .venv 里的 python 跑 pytest；",
    "- 完成后不要提交、不要清理改动，保持工作区里的修改即可。",
  ].join(NL);
}

// 解释器位置由 bench/paths.ts 统一决定（<bench>/tools/py<ver>，或用 HARNESS_BENCH_ROOT 指到外置盘）。
// 曾经硬编码过 C:/Users/Public/py39 —— 那是把 165MB 写到 C 盘的教训，不要再写死。

export async function runInstance(
  inst: SweInstance,
  workRoot: string,
  opts: SweRunOptions,
  extraDeps: string[] = [],
): Promise<SweResult> {
  const logger = new Logger("error");
  const dir = path.join(workRoot, inst.instance_id);
  mkdirSync(dir, { recursive: true });
  const t0 = Date.now();
  const base = { instance_id: inst.instance_id, repo: inst.repo, version: inst.version, f2pPassed: 0, f2pTotal: inst.FAIL_TO_PASS.length, p2pFailed: 0, patchLines: 0, ms: 0 };

  const prep = prepareRepo(dir, inst);
  if (!prep.ok) return { ...base, resolved: false, stage: "prepare", detail: prep.detail, ms: Date.now() - t0 };
  if (opts.verbose) console.log("    prepare: " + prep.detail);

  // 按官方 spec 选 Python 版本并锁依赖：装错版本会让 gold patch 都过不了（环境即坏）
  const spec = specFor(inst.repo, inst.version);
  if (!spec) {
    return { ...base, resolved: false, stage: "install", detail: "没有 " + inst.repo + " " + inst.version + " 的官方环境 spec，跳过（避免用错版本得出假分数）", ms: Date.now() - t0 };
  }
  const interpreter = interpreterFor(spec.python);
  if (!interpreter) {
    return { ...base, resolved: false, stage: "install", detail: "本机没有 Python " + spec.python + "（官方要求），无法复现该实例环境", ms: Date.now() - t0 };
  }
  const install = installRepo(dir, [...extraDeps, ...spec.pins], interpreter);
  if (!install.ok) return { ...base, resolved: false, stage: "install", detail: install.detail, ms: Date.now() - t0 };
  if (opts.verbose) console.log("    install: " + install.detail + " (python " + spec.python + ")");

  // 模型干活
  const session = new Session({
    workspaceRoot: dir,
    settings: {
      permissionMode: "bypassPermissions",
      sandboxMode: "workspace-write",
      maxTurns: opts.maxTurns ?? 40,
      maxTokens: 4_096,
      enableSubagent: false,
    },
    rules: emptyRuleSet(),
    provider: opts.provider as never,
    model: opts.model,
    logger,
    approve: async () => "allow",
    store: new SessionStore(path.join(dir, ".harness", "sessions")),
    contextWindow: 100_000,
    enableSubagent: false,
  });
  await session.init();
  let agentError: string | undefined;
  try {
    for await (const ev of session.send(agentPrompt(inst), new AbortController().signal)) {
      if (opts.verbose && ev.type === "tool_end") console.log("      tool: " + String((ev as { name?: string }).name));
    }
  } catch (err) {
    agentError = err instanceof Error ? err.message : String(err);
  }

  const patch = extractPatch(dir);
  const patchLines = patch ? patch.split(NL).filter((l) => l.startsWith("+") || l.startsWith("-")).length : 0;
  writeFileSync(path.join(workRoot, inst.instance_id + ".patch"), patch, "utf8");
  if (opts.verbose) console.log("    patch: " + patchLines + " 行");

  // 官方流程：复位 → 应用模型 patch → 应用官方 test_patch → 跑测试
  const reset = resetToBase(dir);
  const applyModel = applyPatchFile(dir, patch, "model.patch");
  const applyTests = applyPatchFile(dir, inst.test_patch, "test.patch");
  if (!reset.ok || !applyModel.ok || !applyTests.ok) {
    return {
      ...base,
      resolved: false,
      patchLines,
      stage: "test",
      detail: "复位/应用 patch 失败: " + [reset.detail, applyModel.detail, applyTests.detail].filter((d) => d !== "reset" && d !== "applied model.patch" && d !== "applied test.patch").join(" | ").slice(0, 200),
      ms: Date.now() - t0,
    };
  }

  const graded = grade(dir, inst, inst.FAIL_TO_PASS, inst.PASS_TO_PASS);
  return {
    ...base,
    resolved: graded.resolved,
    f2pPassed: graded.f2pPassed,
    p2pFailed: graded.p2pFailed,
    patchLines,
    stage: "done",
    detail: (agentError ? "agent error: " + agentError.slice(0, 80) + " | " : "") + graded.detail,
    ms: Date.now() - t0,
  };
}

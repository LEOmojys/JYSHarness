/** SWE-bench Verified 单实例编排：prepare → install → agent → score。 */
import { renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { Session } from "../core/session.ts";
import { withRepoLock } from "../core/worktreeOps.ts";
import type { ModelProvider } from "../providers/types.ts";
import { emptyRuleSet } from "../permissions/rules.ts";
import { Logger } from "../util/log.ts";
import { SessionStore } from "../session/store.ts";
import { applyPatchFile, extractPatch, grade, installRepo, prepareRepo, resetToBase, type SweInstance, type SweResult } from "./swebench.ts";
import { specFor } from "./sweSpecs.ts";
import { interpreterFor } from "./paths.ts";

const NL = String.fromCharCode(10);

export interface SweRunOptions {
  provider: ModelProvider;
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
  const t0 = Date.now();
  const base = { instance_id: inst.instance_id, repo: inst.repo, version: inst.version, f2pPassed: 0, f2pTotal: inst.FAIL_TO_PASS.length, p2pFailed: 0, patchLines: 0, ms: 0 };
  const fail = (stage: SweResult["stage"], detail: string): SweResult =>
    ({ ...base, stage, detail, resolved: false, ms: Date.now() - t0 });
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(inst.instance_id)) return fail("prepare", "无效的实例目录名");

  // 按官方 spec 选 Python 版本并锁依赖：装错版本会让 gold patch 都过不了（环境即坏）
  const spec = specFor(inst.repo, inst.version);
  if (!spec) {
    return fail("install", "没有 " + inst.repo + " " + inst.version + " 的官方环境 spec");
  }
  const interpreter = interpreterFor(spec.python);
  if (!interpreter) {
    return fail("install", "本机没有 Python " + spec.python + "（官方要求），无法复现该实例环境");
  }
  const dir = path.join(workRoot, inst.instance_id);
  const lock = await withRepoLock<SweResult>(path.join(workRoot, ".locks", inst.instance_id), async () => {
    const prep = prepareRepo(dir, inst);
    if (!prep.ok) return fail("prepare", prep.detail);
    if (opts.verbose) console.log("    prepare: " + prep.detail);
    const install = installRepo(dir, [...extraDeps, ...spec.pins], interpreter);
    if (!install.ok) return fail("install", install.detail);
    if (opts.verbose) console.log("    install: " + install.detail + " (python " + spec.python + ")");

    // 模型干活
    const session = new Session({
      workspaceRoot: dir,
      settings: {
        permissionMode: "bypassPermissions",
        sandboxMode: "workspace-write",
        maxTurns: opts.maxTurns ?? 40,
        maxTokens: Number(process.env.BENCH_MAX_TOKENS ?? 8_192),
        enableSubagent: false,
      },
      rules: emptyRuleSet(),
      provider: opts.provider,
      model: opts.model,
      logger: new Logger("error"),
      approve: async () => "allow",
      store: new SessionStore(path.join(dir, ".harness", "sessions")),
      contextWindow: 100_000,
      enableSubagent: false,
    });
    await session.init();
    let agentError: string | undefined;
    try {
      for await (const ev of session.send(agentPrompt(inst), new AbortController().signal)) {
        if (opts.verbose && ev.type === "tool_end") console.log("      tool: " + ev.name);
        if (ev.type === "done" && ev.reason !== "completed") agentError = ev.error ?? ev.reason;
      }
    } catch (err) {
      agentError = err instanceof Error ? err.message : String(err);
    }

    let patch: string;
    const patchFile = path.join(workRoot, inst.instance_id + ".patch");
    const tempFile = patchFile + "." + randomUUID() + ".tmp";
    try {
      patch = extractPatch(dir, inst);
      writeFileSync(tempFile, patch, { flag: "wx" });
      renameSync(tempFile, patchFile);
    } catch (err) {
      return fail("agent", err instanceof Error ? err.message : String(err));
    } finally {
      rmSync(tempFile, { force: true });
    }
    const patchLines = patch.split(NL).filter((l) => /^[+-]/.test(l) && !l.startsWith("+++ ") && !l.startsWith("--- ")).length;
    base.patchLines = patchLines;
    if (opts.verbose) console.log("    patch: " + patchLines + " 行");

    // 官方流程：复位 → 应用模型 patch → 应用官方 test_patch → 跑测试
    const reset = resetToBase(dir, inst);
    if (!reset.ok) return fail("test", reset.detail);
    const applyModel = applyPatchFile(dir, patch, "model.patch");
    if (!applyModel.ok) return fail("test", applyModel.detail);
    const applyTests = applyPatchFile(dir, inst.test_patch, "test.patch");
    if (!applyTests.ok) return fail("test", applyTests.detail);

    const graded = grade(dir, inst);
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
  });
  return lock.ok ? lock.value : fail("prepare", lock.error);
}

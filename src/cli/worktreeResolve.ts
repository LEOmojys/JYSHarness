/**
 * 用 agent 解决合并冲突（`jys worktree merge --resolve-with-agent`）。
 *
 * 设计取舍：
 *   - **默认关闭**。自动改冲突文件风险高，必须显式开启；
 *   - agent 只负责改文件，**提交由编排层做**（避免它忘记 add/commit 或提交到错分支）；
 *   - 解完必须通过 `--verify` 命令才算成功，否则回滚 —— 这是"信任但验证"的落点；
 *   - 失败一律 `merge --abort`，绝不留半合并状态。
 */
import { loadSettings } from "../core/config.ts";
import { createProvider } from "../providers/index.ts";
import { Session } from "../core/session.ts";
import { Logger } from "../util/log.ts";
import path from "node:path";
import { realResolve } from "../sandbox/paths.ts";
import { conflictedFiles, runVerify } from "../core/worktreeOps.ts";

const NL = String.fromCharCode(10);

export interface AgentResolveOptions {
  /** 解决后要跑的验证命令；不通过就回滚 */
  verify?: string;
  maxTurns?: number;
  /** 打印 agent 的工具调用（调试用） */
  verbose?: boolean;
}

export function conflictPrompt(files: string[], branch: string, verify?: string): string {
  return [
    "你是合并冲突解决助手。仓库里有 " + files.length + " 个文件处于冲突状态（正在合并 " + branch + "）：",
    ...files.map((f) => "  - " + f),
    "",
    "## 要求",
    "1. 读冲突文件，找到 <<<<<<< / ======= / >>>>>>> 标记；",
    "2. **保留双方意图**：不要简单选一边，除非一边明显是旧的错误实现；",
    "3. 用 Edit 或 Write 逐个保存解决后的冲突文件。暂存、验证和提交由程序负责。",
    verify ? "4. 程序将在提交前运行验证命令：" + verify : "4. 确认没有遗留的冲突标记。",
    "",
    "完成后用一句话说明你把冲突怎么合起来的。",
  ].join(NL);
}

/** 在指定仓库里跑一个 agent 来解决冲突。返回是否成功（不负责提交）。 */
export async function resolveConflictsWithAgent(
  repoRoot: string,
  branch: string,
  opts: AgentResolveOptions = {},
): Promise<{ ok: boolean; detail: string }> {
  if (!opts.verify?.trim()) return { ok: false, detail: "缺少提交前验证命令 --verify" };
  const files = conflictedFiles(repoRoot);
  if (!files.length) return { ok: false, detail: "没有冲突文件" };

  const loaded = loadSettings(repoRoot);
  const resolved = createProvider({ settings: loaded.settings });
  const session = new Session({
    workspaceRoot: repoRoot,
    settings: {
      permissionMode: loaded.settings.permissionMode === "plan" ? "plan" : "acceptEdits",
      sandboxMode: loaded.settings.sandboxMode === "read-only" ? "read-only" : "workspace-write",
      maxTurns: opts.maxTurns ?? 20,
      maxTokens: 4_096,
      enableSubagent: false,
    },
    rules: loaded.rules,
    provider: resolved.provider,
    model: resolved.model,
    logger: new Logger("error"),
    approve: async () => "deny",
    enableSubagent: false,
  });
  await session.init();

  const remaining = new Set(files.map((file) => path.resolve(session.workspaceRoot, file)));
  const targets = new Set(remaining);
  session.tools = session.tools.filter((tool) => ["Read", "Grep", "Glob", "Write", "Edit"].includes(tool.name))
    .map((tool) => tool.isReadOnly ? tool : { ...tool, async call(input, ctx) {
      const target = typeof input.file_path === "string" ? realResolve(path.resolve(ctx.cwd, input.file_path)) : "";
      if (!targets.has(target)) return { isError: true, content: "只能编辑本次合并的冲突文件。" };
      const result = await tool.call(input, ctx);
      if (!result.isError) remaining.delete(target);
      return result;
    } });

  let completed = false;
  try {
    for await (const ev of session.send(conflictPrompt(files, branch, opts.verify), new AbortController().signal)) {
      if (opts.verbose && ev.type === "tool_end") console.log("      tool: " + ev.name);
      if (ev.type === "done") {
        if (ev.reason !== "completed") return { ok: false, detail: ev.error ?? ev.reason };
        completed = true;
      }
    }
  } catch (err) {
    return { ok: false, detail: "agent 执行失败：" + (err instanceof Error ? err.message : String(err)) };
  }

  if (!completed || remaining.size) return { ok: false, detail: "agent 未完成全部冲突文件的编辑" };
  const verification = await runVerify(repoRoot, opts.verify);
  if (!verification.ok) return { ok: false, detail: "提交前验证失败：" + verification.tail };
  return { ok: true, detail: "agent 已解决冲突" };
}

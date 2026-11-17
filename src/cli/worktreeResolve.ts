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
import { emptyRuleSet } from "../permissions/rules.ts";
import { Logger } from "../util/log.ts";
import { conflictedFiles } from "../core/worktreeOps.ts";

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
    "3. 改完把文件加入暂存区（git add），让冲突标记消失；",
    "4. 不要执行 git commit、git merge --abort、git checkout -- 等会改变合并状态的命令；",
    verify ? "5. 最后运行验证命令确认没破坏功能：" + verify : "5. 确认没有遗留的冲突标记。",
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
  const files = conflictedFiles(repoRoot);
  if (!files.length) return { ok: false, detail: "没有冲突文件" };

  const loaded = await loadSettings(repoRoot);
  const resolved = createProvider({ settings: loaded.settings });
  const session = new Session({
    workspaceRoot: repoRoot,
    settings: {
      // bypassPermissions：解决冲突期间不该弹审批，否则无人值守会卡死
      permissionMode: "bypassPermissions",
      sandboxMode: "workspace-write",
      maxTurns: opts.maxTurns ?? 20,
      maxTokens: 4_096,
      enableSubagent: false,
    },
    rules: emptyRuleSet(),
    provider: resolved.provider,
    model: resolved.model,
    logger: new Logger("error"),
    approve: async () => "allow",
    enableSubagent: false,
  });
  await session.init();

  try {
    for await (const ev of session.send(conflictPrompt(files, branch, opts.verify), new AbortController().signal)) {
      if (opts.verbose && ev.type === "tool_end") console.log("      tool: " + String((ev as { name?: string }).name));
    }
  } catch (err) {
    return { ok: false, detail: "agent 执行失败：" + (err instanceof Error ? err.message : String(err)) };
  }

  const still = conflictedFiles(repoRoot);
  if (still.length) return { ok: false, detail: "仍有冲突标记：" + still.join(", ") };
  return { ok: true, detail: "agent 已解决冲突" };
}

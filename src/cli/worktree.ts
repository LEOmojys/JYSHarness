/** `jys worktree …`：列出/预检/合并并行任务的工作树。 */
import path from "node:path";
import { createWorktree, listWorktrees, mainRepositoryRoot, removeWorktree } from "../core/worktrees.ts";
import { currentBranch, mergeBranches, preflightAll } from "../core/worktreeMerge.ts";
import { SessionStore } from "../session/store.ts";
import { existsSync, readdirSync } from "node:fs";

const NL = String.fromCharCode(10);

function usage(): string {
  return [
    "jys worktree list              列出工作树与分支",
    "jys worktree create <name> [--base <rev>]   建一个任务工作树（分支 jys/<name>）",
    "jys worktree preflight <b1> <b2> …  [--into <br>]   按顺序推演，报告会不会冲突",
    "jys worktree merge <b1> <b2> …      [--into <br>] [--no-ff]   依次合并，冲突即停并回滚",
    "jys worktree remove <path> [--force]          删工作树",
  ].join(NL);
}

export async function runWorktree(argv: string[], workspace: string): Promise<number> {
  const repoRoot = await mainRepositoryRoot(workspace);
  if (!repoRoot) {
    console.error("当前目录不在 git 仓库里：" + workspace);
    return 2;
  }
  const action = argv[0] ?? "list";
  const rest = argv.slice(1);
  const flag = (name: string) => {
    const i = rest.indexOf("--" + name);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  const positional = rest.filter((x, i) => !x.startsWith("--") && !(i > 0 && rest[i - 1].startsWith("--")));

  if (action === "list") {
    const items = await listWorktrees(repoRoot);
    for (const w of items) {
      const dirty = w.dirty ? " [未提交 " + w.dirty + " 项]" : "";
      console.log((w.isMain ? "* " : "  ") + w.branch.padEnd(24) + " " + w.path + dirty);
    }
    console.log("");
    console.log("主仓库：" + repoRoot + "（当前分支 " + (currentBranch(repoRoot) ?? "分离 HEAD") + "）");
    return 0;
  }

  if (action === "create") {
    const name = positional[0];
    if (!name) { console.log(usage()); return 2; }
    const res = await createWorktree(repoRoot, name, flag("base"));
    if (!res.ok) { console.error("创建失败：" + res.error); return 1; }
    console.log("已创建 " + res.branch + " → " + res.path);
    if (res.copied.length) console.log("已复制本地配置：" + res.copied.join(", "));
    return 0;
  }

  if (action === "preflight" || action === "merge") {
    const branches = positional;
    if (!branches.length) { console.log(usage()); return 2; }
    const into = flag("into") ?? currentBranch(repoRoot) ?? undefined;
    if (!into) { console.error("无法确定目标分支，请用 --into 指定"); return 2; }

    const plan = preflightAll(repoRoot, into, branches);
    console.log("合并计划（目标 " + into + "）：");
    for (const p of plan) {
      const tag = p.alreadyMerged ? "已合并，跳过" : p.conflicts ? "冲突：" + p.files.join(", ") : "可以干净合并";
      console.log("  " + p.branch.padEnd(24) + tag);
    }
    if (action === "preflight") return plan.some((p) => p.conflicts) ? 1 : 0;

    const blocked = plan.find((p) => p.conflicts);
    if (blocked) {
      console.log(NL + "预检发现冲突，未执行合并（仓库未被改动）。冲突文件：" + blocked.files.join(", "));
      return 1;
    }
    const res = mergeBranches(repoRoot, { into, branches, noFf: rest.includes("--no-ff") });
    if (!res.ok) { console.error("合并失败：" + (res.error ?? "")); if (res.blocked) console.error("冲突：" + res.blocked.files.join(", ")); return 1; }
    console.log(NL + "已合并 " + res.merged.length + " 个分支到 " + res.into + "：" + (res.merged.join(", ") || "(无需合并)"));
    return 0;
  }

  if (action === "remove") {
    const target = positional[0];
    if (!target) { console.log(usage()); return 2; }
    const res = await removeWorktree(repoRoot, path.resolve(workspace, target), rest.includes("--force"));
    if (!res.ok) { console.error("删除失败：" + res.error); return 1; }
    console.log("已删除 " + target);
    return 0;
  }

  if (action === "sessions") {
    // 每个工作树独立会话：列出各自最近的转录，确认隔离真的生效
    const items = await listWorktrees(repoRoot);
    for (const w of items) {
      const store = new SessionStore(path.join(w.path, ".harness", "sessions"));
      const ids = await store.ids();
      console.log(w.branch.padEnd(24) + ids.length + " 个会话" + (ids.length ? "（最新 " + ids[ids.length - 1] + "）" : ""));
    }
    return 0;
  }

  console.log(usage());
  return 2;
}

void existsSync;
void readdirSync;

/**
 * 并行分支的合并编排。
 *
 * 为什么需要单独一层：worktree 只解决了"隔离"，没有解决"合回来"。
 * 真实的多任务并行会撞上三件事，这里逐个处理：
 *   1. **冲突**：先无副作用预检（`git merge-tree --write-tree`，不碰工作区也不建 index），
 *      发现冲突就把文件列出来并停止，绝不留一个半合并的仓库让用户去收拾；
 *   2. **顺序**：合并是有序的，前一个冲突会让后面全部"未合并"，所以逐个来、可中断、可续；
 *   3. **脏工作区**：主仓库有未提交改动时直接拒绝 —— 否则 `git merge` 会把用户没提交的东西
 *      卷进合并提交里。
 */
import { spawnSync } from "node:child_process";

const git = (cwd: string, args: string[]) =>
  spawnSync("git", args, { cwd, encoding: "utf8", timeout: 120_000, maxBuffer: 32 * 1024 * 1024 });

export interface MergePreflight {
  branch: string;
  /** 与目标分支是否有内容冲突 */
  conflicts: boolean;
  /** 冲突文件（git 报出来的路径） */
  files: string[];
  /** 分支是否已存在于目标（无需合并） */
  alreadyMerged: boolean;
}

export interface MergeOutcome {
  ok: boolean;
  into: string;
  merged: string[];
  /** 第一个冲突就停：后面的分支不会再试，避免产生一串半成品 */
  blocked?: { branch: string; files: string[] };
  error?: string;
}

/** 解析 merge-tree 的冲突文件：输出的 tree 之后是 "CONFLICT (...) <path>" 段落。 */
export function parseMergeTreeConflicts(stdout: string): string[] {
  const files = new Set<string>();
  for (const line of stdout.split(/\r?\n/)) {
    // 形如: CONFLICT (content): Merge conflict in src/a.ts
    const m = /^CONFLICT \([^)]*\):\s+(?:Merge conflict in\s+)?(.+)$/.exec(line.trim());
    if (m) files.add(m[1].trim());
    // 形如: Auto-merging src/a.ts 不计入冲突
  }
  return [...files];
}

/** 当前分支名（分离 HEAD 时返回 null）。 */
export function currentBranch(repoRoot: string): string | null {
  const r = git(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const name = String(r.stdout ?? "").trim();
  return r.status === 0 && name && name !== "HEAD" ? name : null;
}

/** 工作区是否干净（含未跟踪文件）。 */
export function isClean(repoRoot: string): { clean: boolean; detail: string } {
  const r = git(repoRoot, ["status", "--porcelain"]);
  const out = String(r.stdout ?? "").trim();
  return out ? { clean: false, detail: out.split("\n").slice(0, 5).join(" | ") } : { clean: true, detail: "" };
}

/** 分支是否已合进目标（git merge-base --is-ancestor 返回 0 即为已合）。 */
export function alreadyMerged(repoRoot: string, into: string, branch: string): boolean {
  return git(repoRoot, ["merge-base", "--is-ancestor", branch, into]).status === 0;
}

/** 无副作用预检：不切分支、不改工作区、不建 index。 */
export function preflight(repoRoot: string, into: string, branch: string): MergePreflight {
  if (alreadyMerged(repoRoot, into, branch)) return { branch, conflicts: false, files: [], alreadyMerged: true };
  const r = git(repoRoot, ["merge-tree", "--write-tree", "--name-only", into, branch]);
  const stdout = String(r.stdout ?? "");
  // 退出码 0 = 可干净合并；非 0 = 冲突（stdout 里带 CONFLICT 行）
  if (r.status === 0) return { branch, conflicts: false, files: [], alreadyMerged: false };
  const files = parseMergeTreeConflicts(stdout);
  return { branch, conflicts: true, files, alreadyMerged: false };
}

/**
 * 对一组分支做**逐级**预检（结论必须与真实合并顺序一致）。
 *
 * 反例（实测踩过）：a 和 b 改同一文件的同一行。单独判 "b vs main" 是干净的，
 * 但真实流程是先合 a、再合 b —— 那时才冲突。只做"每个分支独立 vs 当前 main"
 * 会把冲突藏起来，等真正合并时才炸，用户看到的是"预检说没问题，合到一半失败"。
 *
 * 做法：把前面分支依次并进一个**累积树**（merge-tree 输出的 tree，不落地），
 * 再用 `--merge-base <累积树>` 判下一个分支；一旦冲突就停止推演。全程不碰工作区。
 */
export function preflightAll(repoRoot: string, into: string, branches: string[]): MergePreflight[] {
  const out: MergePreflight[] = [];
  const baseRes = git(repoRoot, ["rev-parse", into + "^{tree}"]);
  let baseTree = String(baseRes.stdout ?? "").trim();
  if (baseRes.status !== 0 || !baseTree) return branches.map((b) => preflight(repoRoot, into, b));

  for (const branch of branches) {
    if (alreadyMerged(repoRoot, into, branch)) {
      out.push({ branch, conflicts: false, files: [], alreadyMerged: true });
      continue;
    }
    const r = git(repoRoot, ["merge-tree", "--write-tree", "--name-only", "--merge-base", baseTree, into, branch]);
    const stdout = String(r.stdout ?? "");
    if (r.status !== 0) {
      out.push({ branch, conflicts: true, files: parseMergeTreeConflicts(stdout), alreadyMerged: false });
      break; // 冲突之后的分支结论都会失真，停止推演
    }
    const mergedTree = stdout.split(/\r?\n/)[0]?.trim() ?? "";
    if (mergedTree && /^[0-9a-f]{7,}$/i.test(mergedTree)) baseTree = mergedTree;
    out.push({ branch, conflicts: false, files: [], alreadyMerged: false });
  }
  return out;
}

/**
 * 依次合并。遇到冲突立即 `git merge --abort` 并停止，返回已合并的部分与冲突信息。
 * 恒返回结构化结果：调用方不需要解析 git 输出。
 */
export function mergeBranches(
  repoRoot: string,
  opts: {
    into?: string;
    branches: string[];
    noFf?: boolean;
    message?: string;
    /** 冲突时交给它解决；不传则冲突即回滚（默认安全行为） */
    resolve?: (ctx: { repoRoot: string; branch: string; files: string[] }) => { ok: boolean; detail?: string };
  },
): MergeOutcome {
  const into = opts.into ?? currentBranch(repoRoot);
  if (!into) return { ok: false, into: "", merged: [], error: "当前处于分离 HEAD 状态，请先 checkout 到一个分支" };

  const dirty = isClean(repoRoot);
  if (!dirty.clean) {
    return { ok: false, into, merged: [], error: "主工作区有未提交改动，先提交或 stash：" + dirty.detail };
  }

  const merged: string[] = [];
  for (const branch of opts.branches) {
    if (!branch || branch === into) continue;
    if (alreadyMerged(repoRoot, into, branch)) continue;

    const args = ["merge", "--no-edit"];
    if (opts.noFf) args.push("--no-ff");
    args.push("-m", opts.message ?? "merge " + branch);
    args.push(branch);
    const r = git(repoRoot, args);
    if (r.status !== 0) {
      const conflicted = git(repoRoot, ["diff", "--name-only", "--diff-filter=U"]);
      const files = String(conflicted.stdout ?? "").trim().split(/\r?\n/).filter(Boolean);
      // 有 resolver 就先留在冲突现场让它解；没有就立刻回滚，不留半合并仓库
      if (opts.resolve) {
        const fixed = opts.resolve({ repoRoot, branch, files });
        if (fixed.ok) {
          // resolver 只负责解决冲突内容；提交由这里统一做，避免它忘记提交
          const commit = git(repoRoot, ["commit", "--no-verify", "-m", "merge " + branch + "（冲突已解决）"]);
          if (commit.status === 0 || /nothing to commit/i.test(String(commit.stderr ?? ""))) {
            merged.push(branch);
            continue;
          }
        }
        git(repoRoot, ["merge", "--abort"]);
        return { ok: false, into, merged, blocked: { branch, files }, error: (fixed.detail ?? "冲突未解决").slice(0, 400) };
      }
      git(repoRoot, ["merge", "--abort"]);
      return { ok: false, into, merged, blocked: { branch, files }, error: String(r.stderr ?? "").trim().slice(0, 400) };
    }
    merged.push(branch);
  }
  return { ok: true, into, merged };
}

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
import { existsSync } from "node:fs";
import path from "node:path";

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
  error?: string;
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
  const r = git(repoRoot, ["status", "--porcelain", "--untracked-files=normal"]);
  if (r.status !== 0) return { clean: false, detail: gitError(r) };
  const out = String(r.stdout ?? "").trim();
  return out ? { clean: false, detail: out.split("\n").slice(0, 5).join(" | ") } : { clean: true, detail: "" };
}

/** 分支是否已合进目标（git merge-base --is-ancestor 返回 0 即为已合）。 */
export function alreadyMerged(repoRoot: string, into: string, branch: string): boolean {
  return git(repoRoot, ["merge-base", "--is-ancestor", "--", branch, into]).status === 0;
}

function gitError(r: ReturnType<typeof git>): string {
  return (r.error?.message || r.stderr?.trim() || r.stdout?.trim() || "git 操作失败").slice(0, 400);
}

/** 无副作用预检：不切分支、不改工作区、不建 index。 */
export function preflight(repoRoot: string, into: string, branch: string): MergePreflight {
  return preflightAll(repoRoot, into, [branch])[0];
}

/**
 * 对一组分支做**逐级**预检（结论必须与真实合并顺序一致）。
 *
 * 反例（实测踩过）：a 和 b 改同一文件的同一行。单独判 "b vs main" 是干净的，
 * 但真实流程是先合 a、再合 b —— 那时才冲突。只做"每个分支独立 vs 当前 main"
 * 会把冲突藏起来，等真正合并时才炸，用户看到的是"预检说没问题，合到一半失败"。
 *
 * 快进时直接使用分支提交。分叉时用两个父提交和合并结果生成临时提交，
 * 让下一次预检能从完整历史中选出真实的共同祖先。全程不移动引用或改动工作区。
 */
export function preflightAll(repoRoot: string, into: string, branches: string[]): MergePreflight[] {
  const out: MergePreflight[] = [];
  let tip = into;
  for (const [index, branch] of branches.entries()) {
    const step: MergePreflight = { branch, conflicts: false, files: [], alreadyMerged: false };
    out.push(step);
    if (alreadyMerged(repoRoot, tip, branch)) {
      step.alreadyMerged = true;
    } else if (alreadyMerged(repoRoot, branch, tip)) {
      tip = branch;
    } else {
      const r = git(repoRoot, ["merge-tree", "--write-tree", "--name-only", "--no-messages", "-z", "--", tip, branch]);
      const [tree, ...paths] = String(r.stdout ?? "").split("\0");
      if (r.status === 1 && /^[0-9a-f]{40,64}$/.test(tree)) {
        step.conflicts = true;
        step.files = paths.filter(Boolean);
        break;
      }
      if (r.status !== 0) {
        step.error = gitError(r);
        break;
      }
      if (index + 1 < branches.length) {
        const commit = git(repoRoot, ["-c", "user.name=JYSHarness", "-c", "user.email=preflight@localhost",
          "commit-tree", tree, "-p", tip, "-p", branch, "-m", "worktree merge preflight"]);
        if (commit.status !== 0) {
          step.error = gitError(commit);
          break;
        }
        tip = commit.stdout.trim();
      }
    }
  }
  return out;
}

/**
 * resolver 交回 ok 之后的收尾：暂存 → 检查冲突标记 → 允许提交。
 *
 * 为什么编排侧要兜底 add：约定是"resolver 只解内容、提交由编排做"，但实际有 resolver
 * 只改文件不 add（agent 版提示词里有这一步，自定义 resolver 常常漏）。漏了就会
 * commit 失败 → 报"冲突未解决"，让人以为自己的解决没生效。
 *
 * 更要紧的是**标记检查**：`git add` 会把带 `<<<<<<<` 的文件也标记为已解决，
 * 于是冲突标记会被悄悄提交进主干。这里在读回内容后直接拦住。
 */
function finalizeResolved(repoRoot: string, files: string[]): { ok: true } | { ok: false; error: string } {
  const unresolved = git(repoRoot, ["diff", "--name-only", "--diff-filter=U", "-z"]);
  if (unresolved.status !== 0) return { ok: false, error: gitError(unresolved) };
  const pending = new Set(unresolved.stdout.split("\0"));
  const toStage = files.filter(rel => pending.has(rel) || existsSync(path.join(repoRoot, rel)));
  if (toStage.length) {
    const add = git(repoRoot, ["--literal-pathspecs", "add", "--", ...toStage]);
    if (add.status !== 0) return { ok: false, error: gitError(add) };
  }
  // git add 之后仍未合并的（.gitattributes 特殊处理、文件被删等）说明还没真解决
  const unmerged = git(repoRoot, ["diff", "--name-only", "--diff-filter=U"]);
  if (unmerged.status !== 0) return { ok: false, error: gitError(unmerged) };
  const still = unmerged.stdout.trim();
  if (still) return { ok: false, error: "resolver 返回成功，但这些文件仍是未合并状态：" + still };

  const markers = git(repoRoot, ["--literal-pathspecs", "grep", "--cached", "-I", "-E", "-l", "-z", "--all-match",
    "-e", "^<{7}( |$)", "-e", "^>{7}( |$)", "--", ...files]);
  if (markers.status !== 1) {
    const error = markers.status === 0
      ? "resolver 返回成功，但文件里仍有冲突标记（<<<<<<< / >>>>>>>）：" + markers.stdout.split("\0").filter(Boolean).join(", ")
      : gitError(markers);
    return { ok: false, error };
  }
  return { ok: true };
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
  const state = prepareMerge(repoRoot, opts.into);
  if (state.error) return state;
  for (const branch of opts.branches) {
    if (!branch || branch === state.into) continue;
    const step = mergeStep(repoRoot, branch, opts);
    if (step.status === "skipped") continue;
    if (step.status === "error") return mergeFailure(repoRoot, state, step.error);
    if (step.status === "conflict") {
      const files = step.files;
      let resolved: Resolution;
      try {
        resolved = opts.resolve?.({ repoRoot, branch, files }) ?? { ok: false };
      } catch (err) {
        resolved = { ok: false, detail: String(err) };
      }
      const failure = finishMerge(repoRoot, state, branch, files, resolved);
      if (failure) return failure;
    }
    state.merged.push(branch);
  }
  return state;
}

type Resolution = { ok: boolean; detail?: string };

function prepareMerge(repoRoot: string, target?: string): MergeOutcome {
  const current = currentBranch(repoRoot);
  const into = target ?? current ?? "";
  let error: string | undefined;
  if (!current) error = "当前处于分离 HEAD 状态，请先 checkout 到一个分支";
  else if (current !== into) error = "请先切换到目标分支 " + into + "（当前为 " + current + "）";
  else if (mergeInProgress(repoRoot)) error = "请先完成当前正在进行的合并";
  else {
    const dirty = isClean(repoRoot);
    if (!dirty.clean) error = "主工作区有未提交改动或状态不可读，先检查或 stash：" + dirty.detail;
  }
  return { ok: !error, into, merged: [], error };
}

function mergeInProgress(repoRoot: string): boolean {
  return git(repoRoot, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]).status === 0;
}

function mergeFailure(repoRoot: string, state: MergeOutcome, error: string): MergeOutcome {
  if (mergeInProgress(repoRoot)) {
    const abort = git(repoRoot, ["merge", "--abort"]);
    if (abort.status !== 0) error += "；回滚失败：" + gitError(abort);
  }
  return { ...state, ok: false, error };
}

function finishMerge(repoRoot: string, state: MergeOutcome, branch: string, files: string[], resolved: Resolution): MergeOutcome | undefined {
  let error = resolved.detail ?? "冲突未解决";
  if (resolved.ok) {
    const staged = finalizeResolved(repoRoot, files);
    if (staged.ok) {
      const commit = git(repoRoot, ["commit", "--no-verify", "-m", "merge " + branch + "（冲突已解决）"]);
      if (commit.status === 0) return;
      error = gitError(commit);
    } else {
      error = staged.error;
    }
  }
  return { ...mergeFailure(repoRoot, state, error), blocked: { branch, files } };
}

// ---------------------------------------------------------------- 异步编排（给 agent 解冲突用）

/** 单步合并：只合一个分支，返回结果而不做编排（同步/异步两种编排共用）。 */
export function mergeStep(
  repoRoot: string,
  branch: string,
  opts: { noFf?: boolean; message?: string } = {},
): { status: "merged" | "skipped" } | { status: "conflict"; files: string[] } | { status: "error"; error: string } {
  if (alreadyMerged(repoRoot, currentBranch(repoRoot) ?? "HEAD", branch)) return { status: "skipped" };
  const args = ["merge", "--no-edit"];
  if (opts.noFf) args.push("--no-ff");
  args.push("-m", opts.message ?? "merge " + branch, "--", branch);
  const r = git(repoRoot, args);
  if (r.status === 0) return { status: "merged" };
  const conflicted = git(repoRoot, ["diff", "-z", "--name-only", "--diff-filter=U"]);
  const files = String(conflicted.stdout ?? "").split("\0").filter(Boolean);
  if (files.length && mergeInProgress(repoRoot)) return { status: "conflict", files };
  return { status: "error", error: gitError(r) };
}

/**
 * 异步合并编排：冲突时把现场交给 async resolver（通常是 agent）。
 *
 * 与同步版的关系：同步版保持原样（不破坏已有调用与测试），异步版复用同一个 mergeStep。
 * 失败一律回滚；resolver 说 ok 也要再确认索引里没有冲突标记。
 */
export async function mergeBranchesAsync(
  repoRoot: string,
  opts: {
    into?: string;
    branches: string[];
    noFf?: boolean;
    /** 与同步版同名（推荐）。历史上这里叫 resolver，两个都接受。 */
    resolve?: (ctx: { repoRoot: string; branch: string; files: string[] }) => Promise<{ ok: boolean; detail?: string }>;
    resolver?: (ctx: { repoRoot: string; branch: string; files: string[] }) => Promise<{ ok: boolean; detail?: string }>;
  },
): Promise<MergeOutcome> {
  const resolveFn = opts.resolve ?? opts.resolver;
  if (!resolveFn) return { ok: false, into: "", merged: [], error: "mergeBranchesAsync 需要 resolve（或 resolver）回调" };
  const state = prepareMerge(repoRoot, opts.into);
  if (state.error) return state;
  for (const branch of opts.branches) {
    if (!branch || branch === state.into) continue;
    const step = mergeStep(repoRoot, branch, { noFf: opts.noFf });
    if (step.status === "skipped") continue;
    if (step.status === "error") return mergeFailure(repoRoot, state, step.error);
    if (step.status === "conflict") {
      const files = step.files;
      let resolved: Resolution;
      try {
        resolved = await resolveFn({ repoRoot, branch, files });
      } catch (err) {
        resolved = { ok: false, detail: String(err) };
      }
      const failure = finishMerge(repoRoot, state, branch, files, resolved);
      if (failure) return failure;
    }
    state.merged.push(branch);
  }
  return state;
}

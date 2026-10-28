/**
 * Git worktree management: one task = one worktree = one isolated session.
 *
 * Sessions live under <workspace>/.harness/sessions, so giving each task its own
 * worktree isolates transcripts, rules and checkpoints for free.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import path from "node:path";

export interface WorktreeInfo {
  path: string;
  branch: string;
  head?: string;
  /** The original checkout; cannot be removed. */
  isMain: boolean;
  /** Sessions stored under this worktree (filled by the server). */
  sessions?: number;
  /** Uncommitted / untracked entries（删除前的风险提示）。 */
  dirty?: number;
}

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

function git(cwd: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve) => {
    const child = spawn("git", args, { cwd, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
    child.on("error", () => resolve({ code: 127, stdout: "", stderr: "git not found" }));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

/** Repo root of a workspace, or null when it is not inside a git repo. */
export async function repositoryRoot(dir: string): Promise<string | null> {
  const res = await git(dir, ["rev-parse", "--show-toplevel"]);
  if (res.code !== 0) return null;
  const root = res.stdout.trim();
  return root ? path.resolve(root) : null;
}

/**
 * The *main* checkout's root. Inside a linked worktree, --show-toplevel returns
 * the worktree itself, so resolved worktree paths looked like "main" and
 * removal was refused. --git-common-dir always points at the primary .git.
 */
export async function mainRepositoryRoot(dir: string): Promise<string | null> {
  const res = await git(dir, ["rev-parse", "--git-common-dir"]);
  if (res.code !== 0) return null;
  const common = path.resolve(dir, res.stdout.trim());
  return path.basename(common) === ".git" ? path.dirname(common) : common;
}

/** Parse `git worktree list --porcelain`. */
export async function listWorktrees(repoRoot: string): Promise<WorktreeInfo[]> {
  // 老版本建的仓库只排除了 .harness/worktrees/，列一次就顺手补齐（每个仓库只做一次）。
  await ensureExcludedOnce(repoRoot);
  const res = await git(repoRoot, ["worktree", "list", "--porcelain"]);
  if (res.code !== 0) return [];
  const out: WorktreeInfo[] = [];
  let current: Partial<WorktreeInfo> | null = null;
  const flush = () => {
    if (!current || !current.path) return;
    out.push({
      path: current.path,
      branch: current.branch || "(detached)",
      head: current.head,
      isMain: out.length === 0,
    });
    current = null;
  };
  for (const raw of res.stdout.split("\n")) {
    const line = raw.trim();
    if (!line) {
      flush();
      continue;
    }
    const [key, ...rest] = line.split(" ");
    const value = rest.join(" ");
    if (key === "worktree") {
      flush();
      current = { path: path.resolve(value) };
    } else if (current && key === "HEAD") current.head = value;
    else if (current && key === "branch") current.branch = value.replace(/^refs\/heads\//, "");
  }
  flush();
  // 并行统计每个工作树的未提交改动，删除前能一眼看到风险。
  await Promise.all(
    out.map(async (w) => {
      if (!existsSync(w.path)) {
        w.dirty = 0;
        return;
      }
      const st = await git(w.path, ["status", "--porcelain"]);
      const lines = st.stdout.split("\n").filter((l) => l.trim());
      w.dirty = lines.length;
    }),
  );
  return out;
}

export function validateWorktreeName(name: string): string | null {
  if (!name || !name.trim()) return "名字不能为空";
  if (!/^[a-zA-Z0-9._-]+$/.test(name.trim())) return "只能包含字母、数字、点、下划线、连字符";
  return null;
}

/**
 * Keep harness runtime data out of `git status` without touching tracked files.
 *
 * 两个坑（都已修）：
 *   1. 只排除 .harness/worktrees/ 不够 —— .harness/sessions/ 每次跑都会变成未跟踪文件；
 *   2. 在工作树里，.git 是一个文件（gitdir: ...），拼 .git/info/exclude 永远找不到 ——
 *      必须用 `git rev-parse --git-path info/exclude` 让 git 自己算。
 */
async function ensureExcluded(repoRoot: string): Promise<void> {
  try {
    const res = await git(repoRoot, ["rev-parse", "--git-path", "info/exclude"]);
    if (res.code !== 0) return;
    const file = path.resolve(repoRoot, res.stdout.trim());
    const current = existsSync(file) ? readFileSync(file, "utf8") : "";
    if (current.split(/\r?\n/).some((line) => line.trim() === ".harness/")) return;
    // 清掉旧版本写进去的窄规则，避免同一目录两条规则互相矛盾。
    const cleaned = current.replace(/^\.harness\/worktrees\/?\s*\r?\n/gm, "");
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, cleaned + (cleaned.endsWith("\n") || cleaned === "" ? "" : "\n") + ".harness/\n", "utf8");
  } catch {
    /* best effort: an unexcluded data dir is cosmetic */
  }
}

const excludeChecked = new Set<string>();
async function ensureExcludedOnce(repoRoot: string): Promise<void> {
  const key = path.resolve(repoRoot).toLowerCase();
  if (excludeChecked.has(key)) return;
  excludeChecked.add(key);
  await ensureExcluded(repoRoot);
}

export async function createWorktree(
  repoRoot: string,
  name: string,
  base?: string,
): Promise<{ ok: true; path: string; branch: string; copied: string[] } | { ok: false; error: string }> {
  const problem = validateWorktreeName(name);
  if (problem) return { ok: false, error: problem };
  const branch = "jys/" + name.trim();
  const target = path.join(repoRoot, ".harness", "worktrees", name.trim());
  if (existsSync(target)) return { ok: false, error: "目录已存在：" + target };

  await ensureExcluded(repoRoot);
  mkdirSync(path.dirname(target), { recursive: true });

  const res = await git(repoRoot, ["worktree", "add", "-b", branch, target, base ?? "HEAD"]);
  if (res.code !== 0) {
    return { ok: false, error: (res.stderr || res.stdout).trim() || "git worktree add 失败" };
  }
  return { ok: true, path: target, branch, copied: copyLocalConfig(repoRoot, target) };
}

/** 新工作树默认是"干净检出"，跑不起来通常是因为缺少本地未跟踪的配置。 */
export const LOCAL_CONFIG_FILES = [".env", ".env.local", ".env.development", ".env.test"];

function copyLocalConfig(repoRoot: string, target: string): string[] {
  const copied: string[] = [];
  for (const rel of LOCAL_CONFIG_FILES) {
    const src = path.join(repoRoot, rel);
    const dst = path.join(target, rel);
    try {
      if (existsSync(src) && !existsSync(dst)) {
        copyFileSync(src, dst);
        copied.push(rel);
      }
    } catch (err) {
      // 没权限只警告；但别让编程错误（比如忘了 import）静默变成"什么都没复制"。
      const msg = err instanceof Error ? err.message : String(err);
      if (err instanceof ReferenceError || err instanceof TypeError) throw err;
      process.emitWarning("跳过复制 " + rel + "：" + msg);
    }
  }
  return copied;
}

export async function removeWorktree(
  repoRoot: string,
  worktreePath: string,
  force = false,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const abs = path.resolve(worktreePath);
  const root = path.resolve(repoRoot);
  if (abs === root) return { ok: false, error: "不能删除主工作树" };
  const args = ["worktree", "remove", abs];
  if (force) args.push("--force");
  const res = await git(root, args);
  if (res.code !== 0) return { ok: false, error: (res.stderr || res.stdout).trim() || "删除失败" };
  // 清掉已失效的 worktree 元数据（目录被手动删掉时 git 会一直记着）。
  await git(root, ["worktree", "prune"]);
  return { ok: true };
}

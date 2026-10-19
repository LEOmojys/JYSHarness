/**
 * Git worktree management: one task = one worktree = one isolated session.
 *
 * Sessions live under <workspace>/.harness/sessions, so giving each task its own
 * worktree isolates transcripts, rules and checkpoints for free.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

export interface WorktreeInfo {
  path: string;
  branch: string;
  head?: string;
  /** The original checkout; cannot be removed. */
  isMain: boolean;
  /** Sessions stored under this worktree (filled by the server). */
  sessions?: number;
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

export async function isGitRepo(dir: string): Promise<boolean> {
  return (await repositoryRoot(dir)) !== null;
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
  return out;
}

export function validateWorktreeName(name: string): string | null {
  if (!name || !name.trim()) return "名字不能为空";
  if (!/^[a-zA-Z0-9._-]+$/.test(name.trim())) return "只能包含字母、数字、点、下划线、连字符";
  return null;
}

/** Keep worktrees out of `git status` without touching tracked files. */
function ensureExcluded(repoRoot: string): void {
  try {
    const gitDir = path.join(repoRoot, ".git");
    const infoDir = existsSync(gitDir) && existsSync(path.join(gitDir, "info")) ? path.join(gitDir, "info") : null;
    if (!infoDir) return;
    const file = path.join(infoDir, "exclude");
    const current = existsSync(file) ? readFileSync(file, "utf8") : "";
    if (current.includes(".harness/worktrees")) return;
    mkdirSync(infoDir, { recursive: true });
    writeFileSync(file, current + (current.endsWith("\n") || current === "" ? "" : "\n") + ".harness/worktrees/\n", "utf8");
  } catch {
    /* best effort: an unexcluded worktree dir is cosmetic */
  }
}

export async function createWorktree(
  repoRoot: string,
  name: string,
  base?: string,
): Promise<{ ok: true; path: string; branch: string } | { ok: false; error: string }> {
  const problem = validateWorktreeName(name);
  if (problem) return { ok: false, error: problem };
  const branch = "jys/" + name.trim();
  const target = path.join(repoRoot, ".harness", "worktrees", name.trim());
  if (existsSync(target)) return { ok: false, error: "目录已存在：" + target };

  ensureExcluded(repoRoot);
  mkdirSync(path.dirname(target), { recursive: true });

  const res = await git(repoRoot, ["worktree", "add", "-b", branch, target, base ?? "HEAD"]);
  if (res.code !== 0) {
    return { ok: false, error: (res.stderr || res.stdout).trim() || "git worktree add 失败" };
  }
  return { ok: true, path: target, branch };
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
  return { ok: true };
}

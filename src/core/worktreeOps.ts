/**
 * 并行任务平台的运行期能力：验证、依赖共享、rebase、冲突解决、仓库锁。
 *
 * 与 worktreeMerge.ts 的分工：那边只做"能不能合、怎么合"，这里负责"合之前/合之中/合之后"的配套。
 * 五项各自解决一个真实问题：
 *   1. verify  —— 只合并不跑测试，等于把回归直接合进主干；
 *   2. resolve —— 冲突一律人工，多任务并行时这是主要瓶颈；
 *   3. link    —— 每个工作树各装一份 node_modules，磁盘 ×N；
 *   4. rebase  —— base 漂移后 diff 越来越大，越晚合越痛；
 *   5. lock    —— 两个进程同时 worktree add/merge 会撞 index.lock。
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

const git = (cwd: string, args: string[], timeout = 180_000) =>
  spawnSync("git", args, { cwd, encoding: "utf8", timeout, maxBuffer: 32 * 1024 * 1024 });

// ---------------------------------------------------------------- 仓库锁

export interface LockOptions {
  /** 拿不到锁时最多等多久（毫秒），默认 30s */
  waitMs?: number;
  /** 轮询间隔，默认 100ms */
  pollMs?: number;
}

const lockFile = (repoRoot: string) => path.join(repoRoot, ".harness", "repo.lock");

/**
 * 串行化会动 git 元数据的操作（worktree add/remove/merge/rebase）。
 *
 * 为什么必须有：`git worktree add` 与 `git merge` 都会写 .git/index 与 index.lock，
 * 两个任务同时触发时后到的直接失败（"Unable to create index.lock"）。
 * 这里用 O_EXCL 创建锁文件实现互斥，带超时轮询，进程崩溃留下的陈旧锁按 mtime 过期。
 */
export async function withRepoLock<T>(
  repoRoot: string,
  fn: () => Promise<T> | T,
  opts: LockOptions = {},
): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  const waitMs = opts.waitMs ?? 30_000;
  const pollMs = opts.pollMs ?? 100;
  const file = lockFile(repoRoot);
  mkdirSync(path.dirname(file), { recursive: true });
  const staleMs = 10 * 60_000;
  const started = Date.now();
  for (;;) {
    try {
      writeFileSync(file, String(process.pid), { flag: "wx" });
      break;
    } catch (err) {
      // 陈旧锁：进程被杀时锁文件会留下，超过 10 分钟视为失效
      try {
        const age = Date.now() - statSync(file).mtimeMs;
        if (age > staleMs) rmSync(file, { force: true });
      } catch {
        /* 锁刚被释放，重试即可 */
      }
      if (Date.now() - started > waitMs) {
        return { ok: false, error: "仓库被另一个操作占用（" + file + "）：" + (err instanceof Error ? err.message : String(err)) };
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }
  try {
    return { ok: true, value: await fn() };
  } finally {
    rmSync(file, { force: true });
  }
}

// ---------------------------------------------------------------- 验证

export interface VerifyResult {
  target: string;
  ok: boolean;
  code: number | null;
  ms: number;
  /** 输出尾部，失败时用来解释原因 */
  tail: string;
}

/** 在指定目录跑一条命令（验证用）。命令走 shell，便于 "npm test"、"pytest -q" 这类写法。 */
export function runVerify(dir: string, command: string, timeoutMs = 600_000): Promise<VerifyResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(command, { cwd: dir, shell: true, windowsHide: true });
    let out = "";
    const push = (d: Buffer) => {
      out += d.toString("utf8");
      if (out.length > 200_000) out = out.slice(-100_000);
    };
    child.stdout.on("data", push);
    child.stderr.on("data", push);
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ target: dir, ok: false, code: null, ms: Date.now() - started, tail: "spawn error: " + err.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ target: dir, ok: code === 0, code, ms: Date.now() - started, tail: out.trim().split(/\r?\n/).slice(-25).join("\n") });
    });
  });
}

/**
 * 分支 → 工作树路径（工作树之外的提交没有独立目录，无法验证）。
 *
 * 路径必须 normalize：git 在 Windows 上输出正斜杠（C:/Users/...），而 path.join 给反斜杠，
 * 直接比较字符串会永远不相等 —— 实测这条让"按分支找目录"静默失效。
 */
export function canonicalPath(p: string): string {
  try {
    // Windows 上 git 可能给 8.3 短名（假烟桑~1），path.join 给长名（假烟桑··）——
    // 字符串比较会永远不等。realpathSync.native 拿到文件系统真实路径，两边才对得上。
    return realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

export function branchPaths(repoRoot: string): Map<string, string> {
  const map = new Map<string, string>();
  const r = git(repoRoot, ["worktree", "list", "--porcelain"]);
  let current: string | null = null;
  for (const line of String(r.stdout ?? "").split(/\r?\n/)) {
    if (line.startsWith("worktree ")) current = canonicalPath(line.slice("worktree ".length).trim());
    else if (line.startsWith("branch ") && current) {
      map.set(line.slice("branch ".length).trim().replace(/^refs\/heads\//, ""), current);
    }
  }
  return map;
}

/** 逐个在工作树里跑验证命令；不在工作树里的分支直接标为跳过。 */
export async function verifyBranches(
  repoRoot: string,
  branches: string[],
  command: string,
  timeoutMs?: number,
): Promise<VerifyResult[]> {
  const map = branchPaths(repoRoot);
  const out: VerifyResult[] = [];
  for (const branch of branches) {
    const dir = map.get(branch);
    if (!dir) {
      out.push({ target: branch, ok: false, code: null, ms: 0, tail: "没有对应工作树目录（分支未在 worktree 中检出），跳过验证" });
      continue;
    }
    out.push(await runVerify(dir, command, timeoutMs));
  }
  return out;
}

// ---------------------------------------------------------------- 依赖共享

/** 默认共享的依赖目录（按团队常见布局）。 */
export const SHARED_DEPS = ["node_modules", ".venv", "venv", "vendor", ".pnpm-store"];

export interface LinkResult {
  name: string;
  status: "linked" | "already" | "missing-in-source" | "exists-in-target" | "error";
  detail?: string;
}

/**
 * 把主仓库的依赖目录链接进工作树，避免每个任务各装一份（磁盘 ×N）。
 *
 * Windows 上用 **junction**（目录符号链接需要管理员权限，junction 不需要）；其它平台用 symlink。
 * 只链接"主仓库有、工作树没有"的项，绝不覆盖工作树里已有的内容。
 */
export function linkDependencies(repoRoot: string, worktreePath: string, names: string[] = SHARED_DEPS): LinkResult[] {
  const out: LinkResult[] = [];
  for (const name of names) {
    const src = path.join(repoRoot, name);
    const dst = path.join(worktreePath, name);
    if (!existsSync(src)) {
      out.push({ name, status: "missing-in-source" });
      continue;
    }
    if (existsSync(dst)) {
      out.push({ name, status: "exists-in-target" });
      continue;
    }
    try {
      symlinkSync(src, dst, process.platform === "win32" ? "junction" : "dir");
      out.push({ name, status: "linked", detail: src });
    } catch (err) {
      out.push({ name, status: "error", detail: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}

// ---------------------------------------------------------------- rebase

export interface RebaseResult {
  ok: boolean;
  /** 冲突文件（rebase 已回滚） */
  files: string[];
  detail: string;
}

/**
 * 把任务分支 rebase 到目标分支上（解决 base 漂移）。
 *
 * 冲突时立刻 `rebase --abort`：留下半 rebase 状态会让人分不清"现在是哪个分支"。
 */
export function rebaseWorktree(worktreePath: string, onto: string): RebaseResult {
  const head = git(worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (head.status !== 0) return { ok: false, files: [], detail: "读取工作树分支失败，可能不是 git 工作树" };
  const r = git(worktreePath, ["rebase", onto]);
  if (r.status === 0) return { ok: true, files: [], detail: "已 rebase 到 " + onto };
  const conflicted = git(worktreePath, ["diff", "--name-only", "--diff-filter=U"]);
  const files = String(conflicted.stdout ?? "").trim().split(/\r?\n/).filter(Boolean);
  git(worktreePath, ["rebase", "--abort"]);
  return { ok: false, files, detail: String(r.stderr ?? "").trim().slice(0, 300) || "rebase 失败" };
}

// ---------------------------------------------------------------- 冲突解决

export type ConflictResolver = (ctx: { repoRoot: string; files: string[]; branch: string }) => Promise<{ ok: boolean; message?: string }>;

/** 当前未解决的冲突文件。 */
export function conflictedFiles(repoRoot: string): string[] {
  const r = git(repoRoot, ["diff", "--name-only", "--diff-filter=U"]);
  return String(r.stdout ?? "").trim().split(/\r?\n/).filter(Boolean);
}

/**
 * 停在冲突现场，交给 resolver（通常是一个 agent）去解，解完校验再提交。
 *
 * 为什么不直接 --abort：多任务并行时人工逐个解冲突是主要瓶颈。但也不盲信 resolver ——
 * 它说"解决了"不算数，必须**再次检查索引里是否还有冲突标记**，仍有冲突就不提交。
 */
export async function resolveAndCommit(
  repoRoot: string,
  branch: string,
  resolver: ConflictResolver,
): Promise<{ ok: boolean; detail: string; files: string[] }> {
  const files = conflictedFiles(repoRoot);
  if (!files.length) return { ok: false, detail: "当前没有冲突可解决", files: [] };

  let resolved: { ok: boolean; message?: string };
  try {
    resolved = await resolver({ repoRoot, files, branch });
  } catch (err) {
    resolved = { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
  if (!resolved.ok) {
    git(repoRoot, ["merge", "--abort"]);
    return { ok: false, detail: "解决失败，已回滚：" + (resolved.message ?? ""), files };
  }

  const still = conflictedFiles(repoRoot);
  if (still.length) {
    git(repoRoot, ["merge", "--abort"]);
    return { ok: false, detail: "resolver 声称已解决，但仍有冲突文件：" + still.join(", "), files: still };
  }

  const commit = git(repoRoot, ["commit", "--no-verify", "-m", "merge " + branch + "（冲突已解决）"]);
  if (commit.status !== 0) {
    const msg = String(commit.stderr ?? "").trim();
    // 冲突解决成"保持原样"时可能没有差异可提交，这不算失败
    if (/nothing to commit/i.test(msg)) return { ok: true, detail: "冲突解决后无差异（等同于取目标分支版本）", files };
    git(repoRoot, ["merge", "--abort"]);
    return { ok: false, detail: "提交合并失败：" + msg.slice(0, 200), files };
  }
  return { ok: true, detail: "冲突已解决并提交", files };
}

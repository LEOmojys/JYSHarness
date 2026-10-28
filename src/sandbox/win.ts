/**
 * Windows OS sandbox (ch.7).
 *
 * Two kernel-enforced boundaries, no admin rights required:
 *   1. Low-integrity token  -> mandatory integrity control blocks writes to
 *      anything that is not Low integrity (user profile, Program Files, other repos).
 *   2. Job Object           -> memory cap, process cap, kill-on-close.
 *
 * The launcher is a tiny C# program compiled on demand with the csc.exe that
 * ships with Windows, so the project keeps its zero-dependency promise.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { configHome } from "../core/configStore.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = path.join(HERE, "..", "..", "scripts", "sandbox", "jys-sandbox.cs");
const CSC_CANDIDATES = [
  "C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe",
  "C:/Windows/Microsoft.NET/Framework/v4.0.30319/csc.exe",
];

export interface WinSandbox {
  ok: boolean;
  helper: string | null;
  note: string;
}

let cached: WinSandbox | null = null;

function helperPath(): string {
  return path.join(configHome(), "bin", "jys-sandbox.exe");
}

function csc(): string | null {
  for (const candidate of CSC_CANDIDATES) if (existsSync(candidate)) return candidate;
  return null;
}

/** Compile the launcher once; recompile when the .cs is newer. */
export function ensureWinSandbox(logger?: { warn(m: string): void }): WinSandbox {
  if (cached) return cached;
  if (process.platform !== "win32") {
    cached = { ok: false, helper: null, note: "not windows" };
    return cached;
  }
  if (!existsSync(SOURCE)) {
    cached = { ok: false, helper: null, note: "launcher source missing: " + SOURCE };
    return cached;
  }
  const helper = helperPath();
  const fresh = existsSync(helper) && statSync(helper).mtimeMs >= statSync(SOURCE).mtimeMs;
  if (fresh) {
    cached = { ok: true, helper, note: "AppContainer-free low-integrity + Job Object sandbox" };
    return cached;
  }
  const compiler = csc();
  if (!compiler) {
    cached = { ok: false, helper: null, note: "csc.exe not found (needs .NET Framework 4)" };
    return cached;
  }
  try {
    mkdirSync(path.dirname(helper), { recursive: true });
    execFileSync(compiler, ["/nologo", "/optimize+", "/target:exe", "/out:" + helper, SOURCE], {
      stdio: "pipe",
      windowsHide: true,
    });
    cached = { ok: existsSync(helper), helper, note: "compiled launcher at " + helper };
    return cached;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger?.warn("sandbox launcher build failed: " + message);
    cached = { ok: false, helper: null, note: "build failed: " + message.slice(0, 120) };
    return cached;
  }
}

const integrityCache = new Map<string, "L" | "M">();
let warned = false;

/**
 * Set the workspace to Low (writable by the sandbox) or Medium (default).
 * Idempotent and cached: icacls only runs when the level actually changes.
 */
export function setWorkspaceIntegrity(workspaceRoot: string, low: boolean): boolean {
  const want = low ? "L" : "M";
  if (integrityCache.get(workspaceRoot) === want) return true;
  try {
    execFileSync("icacls", [workspaceRoot, "/setintegritylevel", "(OI)(CI)" + want], {
      stdio: "pipe",
      windowsHide: true,
    });
    integrityCache.set(workspaceRoot, want);
    return true;
  } catch {
    if (low && !warned) {
      warned = true;
      console.warn(
        "[sandbox] 无法把工作区标记为低完整性（权限不足）。沙箱内写工作区会被拒绝；" +
          "可用 --sandbox danger-full-access 关闭沙箱，或检查目录 ACL。",
      );
    }
    return false;
  }
}

/** Read-only scratch space inside the workspace so TMP writes still work. */
export function sandboxTemp(workspaceRoot: string): string {
  const dir = path.join(workspaceRoot, ".harness", "tmp");
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    /* best effort */
  }
  return dir;
}

/**
 * 与 sandbox/paths.ts 的 PROTECTED 保持一致的"内核级"副本。
 *
 * 为什么要在 OS 层再做一次：`guardPath` 只作用于文件工具（Read/Write/Edit…）。
 * 一条 shell 命令写 `echo pwned > .harness/skills/x.md` 根本不经过它 ——
 * 而 skills 会进系统提示、settings 会改权限、sessions 是历史证据。
 *
 * 做法：把工作区整体降为低完整性（低完整性进程才能写自己的工作区），
 * 然后把这些子树**抬回中完整性**。Windows 的完整性策略禁止"向上写"，
 * 于是低完整性的子进程写它们会直接 EPERM —— 不依赖任何配置，绕不过去。
 */
const PROTECTED_SUBTREES = [
  ".harness/settings.json",
  ".harness/sessions",
  ".harness/skills",
  ".harness/agents",
  ".jysharness/settings.json",
  ".jysharness/settings.local.json",
];

const protectedState = new Map<string, "M">();
let protectWarned = false;

export function protectSensitivePaths(workspaceRoot: string): string[] {
  const applied: string[] = [];
  for (const rel of PROTECTED_SUBTREES) {
    const abs = path.join(workspaceRoot, rel);
    if (!existsSync(abs)) continue;
    const key = abs.toLowerCase();
    if (protectedState.get(key) === "M") {
      applied.push(rel);
      continue;
    }
    try {
      let isDir = false;
      try {
        isDir = statSync(abs).isDirectory();
      } catch {
        /* 路径在此期间被删掉了：跳过 */
      }
      execFileSync("icacls", [abs, "/setintegritylevel", isDir ? "(OI)(CI)M" : "M"], {
        stdio: "pipe",
        windowsHide: true,
      });
      protectedState.set(key, "M");
      applied.push(rel);
    } catch {
      if (!protectWarned) {
        protectWarned = true;
        console.warn(
          "[sandbox] 无法把关键路径抬回中完整性（" + rel + "）：沙箱内的 shell 仍可能改到它。" +
            "检查目录 ACL，或临时使用 --sandbox danger-full-access。",
        );
      }
    }
  }
  return applied;
}



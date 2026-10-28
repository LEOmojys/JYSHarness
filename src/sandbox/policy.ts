/**
 * Process-level sandbox policy (ch.7). Path- and rule-level checks stop *the
 * agent*; this module stops *the child process*: it scrubs credentials from the
 * environment and wraps the command in an OS sandbox when one is available.
 *
 * Backends are detected, never required: bwrap (Linux), sandbox-exec (macOS).
 * Windows has no dependency-free equivalent — that limit is reported, not hidden.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import type { SandboxPolicy, SandboxMode } from "./paths.ts";
import { ensureWinSandbox, protectSensitivePaths, sandboxTemp, setWorkspaceIntegrity } from "./win.ts";

export type BackendKind = "bwrap" | "sandbox-exec" | "win-lowil" | "none";

export interface SandboxBackend {
  kind: BackendKind;
  /** Executable to run. */
  command: string;
  /** Why this backend (or why there is none). */
  note: string;
}

const SECRET_KEY = SECRET_KEY_PATTERN;
const HARNESS_KEY_ENV = HARNESS_KEY_ENV_PATTERN;
// 这两个正则同时被 MCP 的进程环境使用，统一放在 util/secrets.ts。

/**
 * Remove credentials from the child environment. The model cannot read them,
 * but a shell command could `printenv` them and leak into the transcript.
 */
import { HARNESS_KEY_ENV as HARNESS_KEY_ENV_PATTERN, SECRET_KEY_PATTERN } from "../util/secrets.ts";

export function scrubEnv(
  base: Record<string, string | undefined>,
  mode: SandboxMode,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    // 自己的 provider key 一律不传（任何模式）
    if (HARNESS_KEY_ENV.test(key)) continue;
    if (mode !== "danger-full-access" && SECRET_KEY.test(key)) continue;
    out[key] = value;
  }
  return out;
}

function which(cmd: string): string | null {
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, cmd);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

let cached: SandboxBackend | null = null;

export function detectBackend(): SandboxBackend {
  if (cached) return cached;
  if (process.platform === "linux") {
    const bwrap = which("bwrap");
    cached = bwrap
      ? { kind: "bwrap", command: bwrap, note: "bubblewrap: read-only root, workspace rw, tmpfs /tmp" }
      : { kind: "none", command: "/bin/bash", note: "bwrap not installed; only env scrubbing is active" };
    return cached;
  }
  if (process.platform === "darwin") {
    const sb = "/usr/bin/sandbox-exec";
    cached = existsSync(sb)
      ? { kind: "sandbox-exec", command: sb, note: "sandbox-exec: writes limited to the workspace" }
      : { kind: "none", command: "/bin/bash", note: "sandbox-exec missing; only env scrubbing is active" };
    return cached;
  }
  if (process.platform === "win32") {
    const win = ensureWinSandbox();
    cached = win.ok
      ? {
          kind: "win-lowil",
          command: win.helper!,
          note: "low integrity token (write containment) + Job Object (memory/process caps)",
        }
      : {
          kind: "none",
          command: "",
          note: "Windows sandbox unavailable (" + win.note + "); enforcement is path/command level only",
        };
    return cached;
  }
  cached = {
    kind: "none",
    command: "",
    note: "no OS sandbox backend on " + process.platform + "; enforcement is path/command level + env scrubbing",
  };
  return cached;
}

export interface SpawnPlan {
  command: string;
  args: string[];
  env: Record<string, string>;
  backend: SandboxBackend;
}

/**
 * Build the argv for a shell command under the current policy.
 * `shellArgs` are the platform shell flags produced by shellForPlatform().
 */
export function buildSpawnPlan(
  command: string,
  opts: {
    cwd: string;
    policy: SandboxPolicy;
    shell: { cmd: string; args: string[] };
    env?: Record<string, string>;
  },
): SpawnPlan {
  const backend = detectBackend();
  const env = scrubEnv({ ...process.env, ...(opts.env ?? {}), HARNESS_SANDBOX: opts.policy.mode }, opts.policy.mode);
  const shellArgs = [...opts.shell.args, command];

  if (opts.policy.mode === "danger-full-access" || backend.kind === "none") {
    return { command: opts.shell.cmd, args: shellArgs, env, backend };
  }

  if (backend.kind === "win-lowil") {
    // Low integrity is what enforces the write boundary. The workspace itself is
    // lowered only in workspace-write mode, so read-only复原后 sandboxed writes
    // to the workspace are denied by the kernel too.
    const writable = opts.policy.mode === "workspace-write";
    setWorkspaceIntegrity(opts.policy.workspaceRoot, writable);
    // 降完整性是递归的，会把关键路径一起降下去。降完必须把它们抬回来，
    // 否则一条 shell 命令就能改 settings / skills / 转录 —— 沙箱里"能写工作区"
    // 不等于"什么都能写"。
    if (writable) protectSensitivePaths(opts.policy.workspaceRoot);
    const tmp = sandboxTemp(opts.policy.workspaceRoot);
    const memMb = Number(process.env.HARNESS_SANDBOX_MEMORY_MB ?? 4096);
    const procs = Number(process.env.HARNESS_SANDBOX_MAX_PROCS ?? 128);
    const args = [
      "--memory",
      String(Number.isFinite(memMb) && memMb > 0 ? memMb : 4096),
      "--procs",
      String(Number.isFinite(procs) && procs > 0 ? procs : 128),
      "--cwd",
      opts.cwd,
      "--low-integrity",
      "--",
      opts.shell.cmd,
      ...shellArgs,
    ];
    // TEMP/TMP 之外还要重定向**包管理器自己的缓存目录**，否则沙箱里最常见的
    // 开发动作（npm install / pip install）会直接 EPERM：
    // npm 的 cache 默认在 %LOCALAPPDATA%\npm-cache，那个路径在工作区之外。
    // 实测：npm install 报 "EPERM ... AppData\Local\npm-cache"。
    const npmCache = path.join(tmp, "npm-cache");
    const pnpmCache = path.join(tmp, "pnpm-store");
    return {
      command: backend.command,
      args,
      env: {
        ...env,
        TEMP: tmp,
        TMP: tmp,
        // npm / pnpm
        npm_config_cache: npmCache,
        npm_config_tmp: tmp,
        npm_config_prefix: path.join(tmp, "npm-prefix"),
        XDG_CACHE_HOME: path.join(tmp, "xdg-cache"),
        // pip / uv / go / cargo 的缓存也挪进来
        PIP_CACHE_DIR: path.join(tmp, "pip-cache"),
        UV_CACHE_DIR: path.join(tmp, "uv-cache"),
        GOCACHE: path.join(tmp, "go-cache"),
        CARGO_HOME: path.join(tmp, "cargo-home"),
      },
      backend,
    };
  }

  if (backend.kind === "bwrap") {
    const mounts = [
      "--ro-bind", "/", "/",
      "--dev", "/dev",
      "--proc", "/proc",
      "--tmpfs", "/tmp",
    ];
    if (opts.policy.mode === "workspace-write") {
      mounts.push("--bind", opts.policy.workspaceRoot, opts.policy.workspaceRoot);
    }
    return {
      command: backend.command,
      args: [...mounts, "--chdir", opts.cwd, "--die-with-parent", "--", opts.shell.cmd, ...shellArgs],
      env,
      backend,
    };
  }

  // macOS: deny writes outside the workspace, keep everything else.
  const profile = [
    "(version 1)",
    "(allow default)",
    ...(opts.policy.mode === "workspace-write" ? [] : ["(deny file-write*)"]),
    '(allow file-write* (subpath "' + opts.policy.workspaceRoot + '"))',
    '(allow file-write* (subpath "/tmp"))',
  ].join("\n");
  return {
    command: backend.command,
    args: ["-p", profile, opts.shell.cmd, ...shellArgs],
    env,
    backend,
  };
}



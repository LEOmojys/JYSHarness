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

export type BackendKind = "bwrap" | "sandbox-exec" | "none";

export interface SandboxBackend {
  kind: BackendKind;
  /** Executable to run. */
  command: string;
  /** Why this backend (or why there is none). */
  note: string;
}

const SECRET_KEY = /(API[_-]?KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|PRIVATE[_-]?KEY|_AUTH)/i;

/**
 * Remove credentials from the child environment. The model cannot read them,
 * but a shell command could `printenv` them and leak into the transcript.
 */
export function scrubEnv(
  base: Record<string, string | undefined>,
  mode: SandboxMode,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
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
  cached = {
    kind: "none",
    command: "",
    note:
      "no OS sandbox backend on " +
      process.platform +
      "; enforcement is path/command level + env scrubbing (see docs for Job Object/Landlock)",
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

export function describeBackend(b: SandboxBackend = detectBackend()): string {
  return b.kind === "none" ? "backend: none (" + b.note + ")" : "backend: " + b.kind + " (" + b.note + ")";
}

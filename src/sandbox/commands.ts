/**
 * Command-level hardening for shell tools (ch.7.2). The permission engine owns
 * policy; this module owns mechanical execution concerns: the platform shell,
 * timeouts, cancellation, and output clipping.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import type { SandboxPolicy } from "./paths.ts";
import { buildSpawnPlan } from "./policy.ts";

/** Find an executable on PATH (and a couple of well-known install locations). */
function whichSync(cmd: string, extra: string[] = []): string | null {
  const exts = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, cmd + ext);
      if (existsSync(candidate)) return candidate;
    }
  }
  for (const candidate of extra) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

let cachedShell: { cmd: string; args: string[] } | null = null;

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  truncated: boolean;
}

const MAX_STREAM = 200_000;

export function shellForPlatform(): { cmd: string; args: string[] } {
  if (cachedShell) return cachedShell;
  if (process.platform === "win32") {
    const flags = ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"];
    const pwsh =
      (process.env.HARNESS_SHELL && existsSync(process.env.HARNESS_SHELL) ? process.env.HARNESS_SHELL : null) ??
      whichSync("pwsh", [
        path.join(process.env.ProgramFiles ?? "C:/Program Files", "PowerShell", "7", "pwsh.exe"),
      ]);
    if (pwsh) {
      cachedShell = { cmd: pwsh, args: flags };
      return cachedShell;
    }
    const legacy =
      whichSync("powershell", [
        path.join(process.env.SystemRoot ?? "C:/Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      ]) ?? "powershell.exe";
    cachedShell = { cmd: legacy, args: flags };
    return cachedShell;
  }
  const bash = whichSync("bash") ?? "/bin/bash";
  cachedShell = { cmd: bash, args: ["-lc"] };
  return cachedShell;
}

export async function runCommand(
  command: string,
  opts: {
    cwd: string;
    timeoutMs?: number;
    env?: Record<string, string>;
    signal?: AbortSignal;
    policy: SandboxPolicy;
  },
): Promise<CommandResult> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const shell = shellForPlatform();
  const cwd = opts.cwd || opts.policy.workspaceRoot;

  return new Promise<CommandResult>((resolve, reject) => {
    const plan = buildSpawnPlan(command, { cwd, policy: opts.policy, shell, env: opts.env });
    const child = spawn(plan.command, plan.args, {
      cwd,
      env: plan.env as Record<string, string>,
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let outBytes = 0;
    let errBytes = 0;
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    const onAbort = () => {
      killed = true;
      child.kill("SIGKILL");
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout?.on("data", (d: Buffer) => {
      if (outBytes < MAX_STREAM) {
        stdout += d.toString("utf8");
        outBytes += d.length;
      }
    });
    child.stderr?.on("data", (d: Buffer) => {
      if (errBytes < MAX_STREAM) {
        stderr += d.toString("utf8");
        errBytes += d.length;
      }
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      reject(err);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve({
        stdout,
        stderr,
        exitCode: code ?? (killed ? 124 : 1),
        timedOut: killed,
        truncated: outBytes >= MAX_STREAM || errBytes >= MAX_STREAM,
      });
    });
  });
}

/** Render a command result in the shape the model expects to read. */
export function formatCommandResult(r: CommandResult, maxChars = 30_000): string {
  const clip = (s: string): string =>
    s.length > maxChars
      ? s.slice(0, maxChars) + "\n...[truncated " + (s.length - maxChars) + " chars]"
      : s;
  const parts: string[] = ["exit_code=" + r.exitCode];
  if (r.timedOut) parts.push("timed_out=true");
  if (r.stdout.trim()) parts.push(clip(r.stdout));
  if (r.stderr.trim()) parts.push("[stderr]\n" + clip(r.stderr));
  return parts.join("\n");
}

export function workspaceRelative(root: string, p: string): string {
  const rel = path.relative(root, p);
  return rel && !rel.startsWith("..") ? rel.split(path.sep).join("/") : p;
}

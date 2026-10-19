/**
 * Hooks (ch.6): user-defined shell commands at lifecycle points. This is the
 * "programmable constraint" layer — it can block, annotate, or rewrite a tool
 * call without any change to harness code.
 *
 * Protocol (deliberately compatible with Claude Code conventions):
 *   stdin  <- JSON payload
 *   stdout -> optional JSON { decision, reason, updatedInput, additionalContext }
 *   exit 2 -> block, stderr becomes the reason
 */
import { spawn } from "node:child_process";
import { shellForPlatform } from "../sandbox/commands.ts";
import type { Logger } from "../util/log.ts";

export type HookEvent =
  | "SessionStart"
  | "UserPromptSubmit"
  | "PreToolUse"
  | "PostToolUse"
  | "Stop";

export interface HookDefinition {
  /** Shell command to run. Receives the payload on stdin. */
  command?: string;
  /** Optional tool-name matcher, e.g. "Bash" or "Write|Edit". */
  matcher?: string;
  timeoutMs?: number;
  /**
   * In-process handler (used by plugins). Runs before any shell command and
   * avoids spawning a process for every tool call.
   */
  handler?: (payload: HookPayload) => Promise<HookResult> | HookResult | void;
}

export interface HookPayload {
  event: HookEvent;
  sessionId: string;
  cwd: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolResult?: string;
  prompt?: string;
}

export interface HookResult {
  decision?: "allow" | "deny" | "ask";
  reason?: string;
  updatedInput?: Record<string, unknown>;
  additionalContext?: string;
  /** Non-empty when the hook itself failed (never blocks the session). */
  error?: string;
}

export function matchesTool(def: HookDefinition, toolName?: string): boolean {
  if (!def.matcher) return true;
  if (!toolName) return false;
  return new RegExp("^(?:" + def.matcher + ")$").test(toolName);
}

function runShell(
  command: string,
  payload: string,
  opts: { cwd: string; timeoutMs: number; signal?: AbortSignal },
): Promise<{ code: number; stdout: string; stderr: string }> {
  const shell = shellForPlatform();
  return new Promise((resolve, reject) => {
    const child = spawn(shell.cmd, [...shell.args, command], {
      cwd: opts.cwd,
      windowsHide: true,
      env: { ...process.env } as Record<string, string>,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs);
    const onAbort = () => child.kill("SIGKILL");
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
    child.on("error", (err) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve({ code: code ?? 1, stdout, stderr });
    });
    child.stdin.end(payload);
  });
}

export async function runHooks(
  defs: HookDefinition[] | undefined,
  payload: HookPayload,
  opts: { cwd: string; logger: Logger; signal?: AbortSignal },
): Promise<HookResult> {
  if (!defs || defs.length === 0) return {};
  let combined: HookResult = {};
  const merge = (r: HookResult) => {
    combined = {
      ...combined,
      ...(r.decision ? { decision: r.decision } : {}),
      ...(r.reason ? { reason: r.reason } : {}),
      ...(r.updatedInput ? { updatedInput: r.updatedInput } : {}),
      ...(r.additionalContext
        ? { additionalContext: [combined.additionalContext, r.additionalContext].filter(Boolean).join("\n") }
        : {}),
    };
  };

  for (const def of defs) {
    if (!matchesTool(def, payload.toolName)) continue;

    // In-process handlers first: they are how plugins hook the loop without
    // spawning a shell for every tool call.
    if (def.handler) {
      try {
        const out = await def.handler(payload);
        if (out) merge(out);
      } catch (err) {
        combined.error = err instanceof Error ? err.message : String(err);
        opts.logger.warn("hook handler failed: " + combined.error);
      }
      continue;
    }
    if (!def.command) continue;

    try {
      const { code, stdout, stderr } = await runShell(def.command, JSON.stringify(payload), {
        cwd: opts.cwd,
        timeoutMs: def.timeoutMs ?? 10_000,
        signal: opts.signal,
      });
      if (code === 2) {
        combined = { ...combined, decision: "deny", reason: stderr.trim() || "blocked by hook" };
        continue;
      }
      if (code !== 0) {
        opts.logger.warn("hook exited " + code + " for " + payload.event + ": " + stderr.trim().slice(0, 200));
        continue;
      }
      const trimmed = stdout.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as HookResult;
        combined = {
          ...combined,
          ...(parsed.decision ? { decision: parsed.decision } : {}),
          ...(parsed.reason ? { reason: parsed.reason } : {}),
          ...(parsed.updatedInput ? { updatedInput: parsed.updatedInput } : {}),
          ...(parsed.additionalContext
            ? { additionalContext: [combined.additionalContext, parsed.additionalContext].filter(Boolean).join("\n") }
            : {}),
        };
      } catch {
        // Plain-text stdout is treated as additional context (Claude Code behaviour).
        combined.additionalContext = [combined.additionalContext, trimmed].filter(Boolean).join("\n");
      }
    } catch (err) {
      combined.error = err instanceof Error ? err.message : String(err);
      opts.logger.warn("hook failed: " + combined.error);
    }
  }
  return combined;
}

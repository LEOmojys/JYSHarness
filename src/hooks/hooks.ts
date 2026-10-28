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

/** 已知事件名（数据驱动配置里用来校验：写错的事件名不该被静默接受）。 */
export const HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PreCompact",
  "Stop",
] as const;

export type HookEvent =
  | "SessionStart"
  | "UserPromptSubmit"
  | "PreToolUse"
  | "PostToolUse"
  /** 工具执行返回错误之后（例如命令失败、文件不存在）。 */
  | "PostToolUseFailure"
  /** 上下文即将压缩之前；用来留痕或提醒，不能阻止压缩。 */
  | "PreCompact"
  | "Stop";

export interface HookDefinition {
  /** Shell command to run. Receives the payload on stdin. */
  command?: string;
  /** Optional tool-name matcher, e.g. "Bash" or "Write|Edit". */
  matcher?: string;
  timeoutMs?: number;
  /** 不等待结果（日志、通知这类副作用），失败也不影响主流程。 */
  async?: boolean;
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

/** 单次 hook 的最长等待；超过这个数就不是"钩子"而是"卡死"了。 */
export const MAX_HOOK_TIMEOUT_MS = 60_000;
export const MIN_HOOK_TIMEOUT_MS = 100;

const matcherCache = new Map<string, RegExp | null>();

/**
 * 编译 matcher，失败返回 null（而不是抛）。
 *
 * 之前这里直接 `new RegExp`：settings.json 里写错一个括号（`([`），
 * 整个会话的每一次工具调用都会抛异常 —— 一处配置笔误让 Agent 彻底不可用。
 * 现在失败只让这条钩子不匹配，并在加载阶段就报出来。
 */
export function compileMatcher(matcher: string | undefined): RegExp | null {
  if (!matcher) return null;
  const cached = matcherCache.get(matcher);
  if (cached !== undefined) return cached;
  let compiled: RegExp | null = null;
  try {
    compiled = new RegExp("^(?:" + matcher + ")$");
  } catch {
    compiled = null;
  }
  matcherCache.set(matcher, compiled);
  return compiled;
}

export function matchesTool(def: HookDefinition, toolName?: string): boolean {
  if (!def.matcher) return true;
  if (!toolName) return false;
  const re = compileMatcher(def.matcher);
  // 非法的 matcher 视为"不匹配"，而不是"匹配一切" —— 让写错的人少受影响。
  if (!re) return false;
  return re.test(toolName);
}

/** 把用户配置里的超时收紧到合理区间。 */
export function clampHookTimeout(ms: number | undefined): number {
  const raw = typeof ms === "number" && Number.isFinite(ms) ? ms : 10_000;
  return Math.min(MAX_HOOK_TIMEOUT_MS, Math.max(MIN_HOOK_TIMEOUT_MS, Math.round(raw)));
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

  // 决策按"更严格优先"合并：deny > ask > allow。
  // 之前是后者覆盖前者，于是 `[deny, allow]` 两条钩子的结果是 allow ——
  // 一个追加的 allow 钩子能悄悄取消掉别人的 deny，这在安全链路上不可接受。
  const rank = (d: HookResult["decision"]): number => (d === "deny" ? 2 : d === "ask" ? 1 : d === "allow" ? 0 : -1);
  const merge = (r: HookResult) => {
    const stricter = r.decision && rank(r.decision) > rank(combined.decision) ? r : null;
    combined = {
      ...combined,
      ...(stricter ? { decision: stricter.decision, reason: stricter.reason } : {}),
      ...(r.updatedInput ? { updatedInput: r.updatedInput } : {}),
      ...(r.additionalContext
        ? { additionalContext: [combined.additionalContext, r.additionalContext].filter(Boolean).join("\n") }
        : {}),
    };
  };

  for (const def of defs) {
    if (!matchesTool(def, payload.toolName)) continue;

    // async 钩子只用来做日志/通知：不等结果，也不允许影响主流程。
    if (def.async) {
      if (def.handler) {
        void Promise.resolve()
          .then(() => def.handler!(payload))
          .catch((err) => opts.logger.warn("async hook failed: " + (err instanceof Error ? err.message : String(err))));
      } else if (def.command) {
        void runShell(def.command, JSON.stringify(payload), {
          cwd: opts.cwd,
          timeoutMs: clampHookTimeout(def.timeoutMs),
        }).catch((err) => opts.logger.warn("async hook failed: " + (err instanceof Error ? err.message : String(err))));
      }
      continue;
    }

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
        timeoutMs: clampHookTimeout(def.timeoutMs),
        signal: opts.signal,
      });
      if (code === 2) {
        merge({ decision: "deny", reason: stderr.trim() || "blocked by hook" });
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
        merge({
          decision: parsed.decision,
          reason: parsed.reason,
          updatedInput: parsed.updatedInput,
          additionalContext: parsed.additionalContext,
        });
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

export interface HookValidation {
  hooks: Partial<Record<HookEvent, HookDefinition[]>>;
  problems: string[];
}

/**
 * 校验配置里的 hooks（数据驱动入口）。
 *
 * 目标：**写错的配置只影响它自己那条钩子**，并且加载时就报出来。
 * 不做的事：不尝试修好用户的本意（把 `command` 写成数组就丢掉并提示，
 * 而不是猜他想干嘛）。
 */
export function validateHooks(raw: unknown): HookValidation {
  const hooks: Partial<Record<HookEvent, HookDefinition[]>> = {};
  const problems: string[] = [];
  if (raw === undefined || raw === null) return { hooks, problems };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { hooks, problems: ["hooks 必须是一个对象：{ PreToolUse: [ ... ] }"] };
  }
  for (const [event, defs] of Object.entries(raw as Record<string, unknown>)) {
    if (!(HOOK_EVENTS as readonly string[]).includes(event)) {
      problems.push("hooks." + event + " 不是已知事件名（可用：" + HOOK_EVENTS.join(", ") + "），已忽略");
      continue;
    }
    if (!Array.isArray(defs)) {
      problems.push("hooks." + event + " 必须是数组，已忽略");
      continue;
    }
    const kept: HookDefinition[] = [];
    defs.forEach((entry, index) => {
      const where = "hooks." + event + "[" + index + "]";
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        problems.push(where + " 不是对象，已忽略");
        return;
      }
      const def = entry as HookDefinition;
      const hasCommand = typeof def.command === "string" && def.command.trim().length > 0;
      const hasHandler = typeof def.handler === "function";
      if (!hasCommand && !hasHandler) {
        problems.push(where + " 缺少 command 或 handler，已忽略");
        return;
      }
      if (def.matcher !== undefined && typeof def.matcher !== "string") {
        problems.push(where + ".matcher 必须是字符串，已忽略该钩子");
        return;
      }
      if (def.matcher && !compileMatcher(def.matcher)) {
        problems.push(where + ".matcher 不是合法正则：" + def.matcher + "，已忽略该钩子");
        return;
      }
      kept.push({
        ...def,
        timeoutMs: clampHookTimeout(def.timeoutMs),
        async: def.async === true,
      });
    });
    if (kept.length) hooks[event as HookEvent] = kept;
  }
  return { hooks, problems };
}

/** 给 /hooks 命令与 UI 用的可读摘要。 */
export function describeHooks(hooks: Partial<Record<HookEvent, HookDefinition[]>> | undefined): string[] {
  const lines: string[] = [];
  for (const [event, defs] of Object.entries(hooks ?? {})) {
    (defs ?? []).forEach((def, i) => {
      const kind = def.handler ? "in-process" : "shell";
      const matcher = def.matcher ? " matcher=" + def.matcher : "";
      const asyncTag = def.async ? " async" : "";
      const cmd = def.command ? " " + def.command.slice(0, 60) : "";
      lines.push(event + "[" + i + "] " + kind + matcher + asyncTag + cmd);
    });
  }
  return lines;
}

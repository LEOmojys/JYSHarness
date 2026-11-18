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

/**
 * hook 的 stdout/stderr 上限。
 *
 * 不设限的话 hook 里 `cat big.json` 会让 40MB 原文一路拼进工具结果，
 * 下一次请求直接 413 —— 上下文和内存一起被一条钩子毁掉。
 */
const MAX_HOOK_OUTPUT = 64 * 1024;

function runShell(
  command: string,
  payload: string,
  opts: { cwd: string; timeoutMs: number; signal?: AbortSignal },
): Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean; truncated: boolean }> {
  const shell = shellForPlatform();
  return new Promise((resolve, reject) => {
    const child = spawn(shell.cmd, [...shell.args, command], {
      cwd: opts.cwd,
      windowsHide: true,
      env: { ...process.env } as Record<string, string>,
    });
    let stdout = "";
    let stderr = "";
    let totalOutput = 0;
    let outputTruncated = false;
    let settled = false;
    let timedOut = false;
    const append = (current: string, chunk: Buffer) => {
      const remaining = MAX_HOOK_OUTPUT - totalOutput;
      if (remaining <= 0) {
        outputTruncated = true;
        return current;
      }
      const decoded = chunk.toString("utf8");
      const kept = decoded.slice(0, remaining);
      totalOutput += kept.length;
      if (kept.length < decoded.length) outputTruncated = true;
      return current + kept;
    };
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve({ code, stdout, stderr, timedOut, truncated: outputTruncated });
    };
    /**
     * 杀整棵进程树。
     *
     * 只 kill 直接子进程是不够的：hook 里再起一个 node/pytest 时，grandchild 继承
     * 了 stdout 管道，'close' 要等它退出才触发 —— 于是 timeout 形同虚设，
     * 整轮对话被一条钩子卡任意久。Windows 上用 taskkill /T /F 才收得干净。
     */
    const killTree = () => {
      try {
        if (process.platform === "win32" && child.pid) {
          spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).on("error", () => {});
        } else {
          child.kill("SIGKILL");
        }
      } catch {
        /* already gone */
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
      // 到点就结算：等 'close' 会把超时变成"无限等待"，而且结果会被当成"允许"（fail-open）。
      finish(124);
    }, opts.timeoutMs);
    const onAbort = () => {
      killTree();
      finish(130);
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.on("data", (d: Buffer) => (stdout = append(stdout, d)));
    child.stderr?.on("data", (d: Buffer) => (stderr = append(stderr, d)));
    // 子进程可能不读 stdin 就退出（文档推荐的 `exit 2` 就是）：EPIPE 必须吞掉，
    // 否则 'error' 事件没人监听 → uncaughtException → 整个进程退出。
    child.stdin?.on("error", () => {});
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      reject(err);
    });
    child.on("close", (code) => finish(code ?? 1));
    child.stdin?.end(payload);
  });
}

export async function runHooks(
  defs: HookDefinition[] | undefined,
  payload: HookPayload,
  opts: { cwd: string; logger: Logger; signal?: AbortSignal },
): Promise<HookResult> {
  if (!defs || defs.length === 0) return {};
  let combined: HookResult = {};
  const decisionEvent = payload.event === "PreToolUse" || payload.event === "UserPromptSubmit" || payload.event === "Stop";

  // 决策按"更严格优先"合并：deny > ask > allow。更新输入则按字段累积，并让后续 hook
  // 看到已更新的 toolInput；以前所有 hook 都收到原始输入，且最终只有最后一条更新生效。
  const rank = (d: HookResult["decision"]): number => (d === "deny" ? 2 : d === "ask" ? 1 : d === "allow" ? 0 : -1);
  const merge = (r: HookResult) => {
    const stricter = r.decision && rank(r.decision) > rank(combined.decision) ? r : null;
    const updatedInput = r.updatedInput
      ? { ...(combined.updatedInput ?? {}), ...r.updatedInput }
      : combined.updatedInput;
    combined = {
      ...combined,
      ...(stricter ? { decision: stricter.decision, reason: stricter.reason } : {}),
      ...(updatedInput ? { updatedInput } : {}),
      ...(r.additionalContext
        ? { additionalContext: [combined.additionalContext, r.additionalContext].filter(Boolean).join("\n") }
        : {}),
    };
    if (r.updatedInput && payload.event === "PreToolUse") {
      payload = { ...payload, toolInput: { ...(payload.toolInput ?? {}), ...r.updatedInput } };
    }
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
        if (decisionEvent) merge({ decision: "deny", reason: "hook handler failed: " + combined.error });
      }
      continue;
    }
    if (!def.command) continue;

    try {
      const hookTimeout = clampHookTimeout(def.timeoutMs);
      const { code, stdout, stderr, timedOut, truncated } = await runShell(def.command, JSON.stringify(payload), {
        cwd: opts.cwd,
        timeoutMs: hookTimeout,
        signal: opts.signal,
      });
      if (timedOut) {
        // 超时和"正常 exit 1"必须分开：否则一个 deny 钩子超时会被当成允许（fail-open），
        // 用户也完全不知道自己配的钩子根本没跑完。
        combined.error = "hook timed out after " + hookTimeout + "ms";
        opts.logger.warn("hook timed out (" + hookTimeout + "ms) for " + payload.event + ": " + def.command.slice(0, 120));
        if (decisionEvent) {
          // 安全决策拿不到结论时不能默认放行：让人看见并修钩子。
          merge({ decision: "deny", reason: "hook timed out after " + hookTimeout + "ms" });
        }
        continue;
      }
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
        const note = truncated ? "\n...[hook output truncated]" : "";
        combined.additionalContext = [combined.additionalContext, trimmed + note].filter(Boolean).join("\n");
      }
    } catch (err) {
      combined.error = err instanceof Error ? err.message : String(err);
      opts.logger.warn("hook failed: " + combined.error);
      if (decisionEvent) merge({ decision: "deny", reason: "hook failed: " + combined.error });
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

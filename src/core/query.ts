/**
 * The agent loop (ch.3). Async generator so every intermediate state is
 * observable; while(true) with explicit continue sites so recovery paths are
 * natural retries rather than nested special cases.
 *
 * Structure:
 *   1. proactive compaction
 *   2. stream the model call
 *   3. recover from provider errors (413 / max_tokens / transient)
 *   4. execute tools (parallel read batches, serial write batches)
 *   5. stop hooks, then either continue or terminate
 */
import type { AssistantMessage, Message, ToolResultBlock, ToolUseBlock, Usage } from "./types.ts";
import { toolResultMessage } from "./types.ts";
import { gateCall, toResultBlock } from "./gate.ts";
import { mapWithLimit, stableKey } from "../util/async.ts";
import { estimateTokens, type TokenCalibrator } from "../util/tokens.ts";
import type { ToolHealth } from "./toolHealth.ts";
import type { ModelProvider, ProviderError } from "../providers/types.ts";
import { ProviderError as PE } from "../providers/types.ts";
import {
  applySummary,
  compactCheap,
  compactLocally,
  snip,
  splitForSummary,
  summaryBudgetChars,
  contextTokens,
  needsSummary,
  summarizeTranscript,
  DEFAULT_COMPACTION,
  type CompactionConfig,
} from "../context/compaction.ts";
import type { Tool, ToolContext, ToolResult } from "../tools/types.ts";
import { executeCall, partitionCalls, prepareCall, type PreparedCall } from "../tools/registry.ts";
import { decidePermission, type DecisionContext, type PermissionDecision } from "../permissions/engine.ts";
import { permissionContentFor } from "../permissions/rules.ts";
import { runHooks, type HookDefinition, type HookEvent } from "../hooks/hooks.ts";
import type { Logger } from "../util/log.ts";

// 契约定义在 events.ts；这里既要 re-export，也要把它们带进本文件的作用域。
// 之前只 re-export，导致本文件里 HarnessEvent/TerminalReason 其实是"未定义标识符"，
// 只在类型位置出现才没炸 —— 类型检查一眼就指出来了。
import type { ApprovalOutcome, HarnessEvent, TerminalReason } from "./events.ts";
export type { ApprovalOutcome, HarnessEvent, TerminalReason } from "./events.ts";

export interface QueryParams {
  provider: ModelProvider;
  model: string;
  systemPrompt: string;
  messages: Message[];
  tools: Tool[];
  preloadedToolMap: Map<string, Tool>;
  permission: DecisionContext;
  toolContext: ToolContext;
  hooks?: Partial<Record<HookEvent, HookDefinition[]>>;
  logger: Logger;
  sessionId: string;
  maxTurns: number;
  maxTokens: number;
  temperature?: number;
  compaction?: CompactionConfig;
  /** Model context window; only used to size the summary request. */
  contextWindow?: number;
  /**
   * 备用模型：主模型不可用时（认证失败、限流耗尽、5xx）切一次。
   * 同一 provider 内换模型 —— 跨厂商需要独立的 Key/BaseURL，不做假配置。
   */
  fallback?: { provider: ModelProvider; model: string };
  /** 连续失败的工具会被短路一段时间（会话级状态）。 */
  toolHealth?: ToolHealth;
  /**
   * 每轮都会变、但**不该进系统提示**的上下文（日期、git 状态）。
   * 请求时拼在最后一条 user 消息末尾，不写入转录 —— 这样缓存前缀不受影响。
   */
  ephemeralContext?: string;
  /** 估算器校准（会话级）：用真实 inputTokens 修正压缩阈值。 */
  calibrator?: TokenCalibrator;
  /**
   * 是否允许向服务商请求**精确** token 计数（默认 auto）。
   * auto = 只在接近阈值时问一次，避免每轮都多一次网络往返。
   */
  countTokens?: "auto" | "off";
  signal: AbortSignal;
  /** Ask the user. The CLI implements this; tests can auto-answer. */
  approve: (args: {
    toolName: string;
    input: Record<string, unknown>;
    decision: PermissionDecision;
    /** 谁发起的：子 Agent 的审批要在弹窗里标出来，否则用户不知道自己在批准谁。 */
    origin?: "subagent";
  }) => Promise<ApprovalOutcome>;
  /** Called when the user picks "always", so the caller can persist a rule. */
  onAlwaysAllow?: (toolName: string, input: Record<string, unknown>) => void;
  /** Persist a message as soon as it is produced (resume/crash safety). */
  persist?: (message: Message) => void;
  /** Mirror the loop state (compaction changes it out-of-band). */
  onState?: (messages: Message[]) => void;
}

interface LoopState {
  messages: Message[];
  turnCount: number;
  maxTokensOverride: number | undefined;
  maxTokensRecovery: number;
  hasAttemptedReactiveCompact: boolean;
  /** 空回复重试次数（provider 返回 0 个内容块）。 */
  emptyResponses: number;
  /** Stop Hook 连续阻止次数：防止"钩子永远不满意"烧掉全部轮次。 */
  stopHookDenials: number;
  /** 本轮是否已经切到备用模型（只切一次，避免来回横跳）。 */
  usingFallback: boolean;
  /** 上一轮响应回报的真实 inputTokens（0 = 还没有）。估算偏低时用它兜底。 */
  lastInputTokens: number;
  /** 上一轮请求时的估算值（用于校准）。 */
  lastEstimate: number;
  /** 本轮是否已经向服务商要过精确计数（每轮最多一次）。 */
  countedThisTurn: boolean;
  totalInput: number;
  totalOutput: number;
  totalCacheRead: number;
  totalCacheCreation: number;
  modelMs: number;
  toolMs: number;
  ttftTotal: number;
  ttftCount: number;
  steps: number;
}

const MAX_OUTPUT_RECOVERY = 3;
const MAX_STOP_HOOK_DENIALS = 3;
/** 单批只读工具的最大并行度。 */
const MAX_PARALLEL_TOOLS = 6;
const ESCALATED_MAX_TOKENS = 32_000;
const MAX_TRANSIENT_RETRIES = 3;

export async function* queryLoop(params: QueryParams): AsyncGenerator<HarnessEvent, TerminalReason> {
  const compactionCfg = params.compaction ?? DEFAULT_COMPACTION;
  // 这两个是"当前生效"的模型，切备用时只改它们，不动 params。
  let activeProvider = params.provider;
  let activeModel = params.model;
  let state: LoopState = {
    messages: params.messages,
    turnCount: 0,
    maxTokensOverride: undefined,
    maxTokensRecovery: 0,
    hasAttemptedReactiveCompact: false,
    emptyResponses: 0,
    stopHookDenials: 0,
    usingFallback: false,
    lastInputTokens: 0,
    lastEstimate: 0,
    countedThisTurn: false,
    totalInput: 0,
    totalCacheRead: 0,
    totalCacheCreation: 0,
    modelMs: 0,
    toolMs: 0,
    ttftTotal: 0,
    ttftCount: 0,
    steps: 0,
    totalOutput: 0,
  };

  while (true) {
    if (params.signal.aborted) {
      yield { type: "done", reason: "aborted", turns: state.turnCount };
      return "aborted";
    }
    state.turnCount++;
    state.countedThisTurn = false;
    yield { type: "turn_start", turn: state.turnCount };

    if (state.turnCount > params.maxTurns) {
      yield { type: "done", reason: "blocking_limit", turns: state.turnCount };
      return "blocking_limit";
    }

    // ---------- 1. proactive compaction ----------
    // 每轮的固定开销：系统提示 + 工具定义。它们不进 messages，但真的占窗口。
    // 不算它们的话，4k 小窗口上光这两项就吃掉 46%，等到"消息超 75%"时其实早就爆了。
    const overheadTokens =
      estimateTokens(params.systemPrompt) +
      params.tools.reduce(
        (sum, t) => sum + estimateTokens(t.name + t.description + JSON.stringify(t.inputSchema)),
        0,
      );
    const budget = (tokens: number) => tokens + overheadTokens;

    // L1 先免费减重；L3 摘要在 snip 之前跑（snip 会把要摘要的内容直接删掉）。
    const compacted = compactCheap(state.messages, compactionCfg);
    if (compacted.applied.length) {
      state.messages = compacted.messages;
      // onState 必须在 yield 之前：会话收到 compaction 事件时会用 this.messages
      // 写检查点。顺序反了就会把**压缩前**的数组写成检查点，重启后条数与内存对不上。
      try {
        params.onState?.(state.messages);
      } catch {
        /* 状态镜像失败不影响压缩本身 */
      }
      yield {
        type: "compaction",
        applied: compacted.applied,
        tokensBefore: compacted.tokensBefore,
        tokensAfter: compacted.tokensAfter,
      };
    }
    // 只在真的越过触发器（默认 75% 窗口）时才摘要。
    // 之前这里只看 targetTokens（40%），于是"超过 75% 才压缩"的说明是假的：
    // 上下文一到 40% 就被摘要掉，白白多付一次模型调用和一次缓存失效。
    // 两个触发器取"更保守"的那个：
    //   1. 估算 + 固定开销 超过 softLimit；
    //   2. 上一轮**真实** inputTokens 已经超过 softLimit（估算偏低时的兜底）。
    // 估算值乘以校准系数：真实/估算的偏差在同一模型同一台机器上通常很稳定。
    const factor = params.calibrator?.factor() ?? 1;
    const rawEstimate = budget(contextTokens(state.messages));
    let effective = Math.round(rawEstimate * factor);
    const actual = state.lastInputTokens;

    // 接近阈值时问服务商要精确值：这是唯一"真"的数，估算和校准都只是逼近它。
    // 只在 60%–阈值之间问一次，既不每轮都付一次网络往返，也不会在临界点上赌估算。
    if (
      params.countTokens !== "off" &&
      !state.countedThisTurn &&
      effective >= compactionCfg.softLimit * 0.6 &&
      typeof activeProvider.countTokens === "function"
    ) {
      state.countedThisTurn = true;
      const exact = await activeProvider
        .countTokens({
          model: activeModel,
          system: params.systemPrompt,
          messages: withEphemeral(state.messages, params.ephemeralContext),
          tools: params.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
          maxTokens: state.maxTokensOverride ?? params.maxTokens,
          signal: params.signal,
        })
        .catch(() => null);
      if (typeof exact === "number" && exact > 0) {
        effective = exact;
        // 精确值同时喂给校准器：以后没联网也能更准。
        params.calibrator?.record(rawEstimate, exact);
      }
    }
    if (effective > compactionCfg.softLimit || (actual > 0 && actual > compactionCfg.softLimit)) {
      const beforeSummary = contextTokens(state.messages);
      const pre = await runHooks(
        params.hooks?.PreCompact,
        { event: "PreCompact", sessionId: params.sessionId, cwd: params.toolContext.cwd },
        { cwd: params.toolContext.cwd, logger: params.logger, signal: params.signal },
      );
      if (pre.additionalContext) {
        yield { type: "notice", level: "info", text: "compact hook: " + pre.additionalContext };
      }
      const split = splitForSummary(state.messages, compactionCfg.keepRecentMessages);
      // 只摘要"老前缀"；最近几条原样留着，否则用户刚说的话会被摘要复述覆盖。
      const source = split.older.length ? split.older : state.messages;
      const summary = await summarizeTranscript(activeProvider, activeModel, source, {
        maxChars: summaryBudgetChars(params.contextWindow),
        signal: params.signal,
      });
      if (summary) {
        state.messages = split.older.length ? applySummary(split, summary) : [summary];
        try {
          params.onState?.(state.messages);
        } catch (err) {
          yield { type: "notice", level: "warn", text: "onState failed: " + (err instanceof Error ? err.message : String(err)) };
        }
        yield {
          type: "compaction",
          applied: ["summarize(" + source.length + " msgs)"],
          tokensBefore: beforeSummary,
          tokensAfter: contextTokens(state.messages),
        };
      } else {
        // 摘要不可用（没有 provider / 请求失败）时才退回 snip，并且明确告诉用户。
        const fallback = snip(state.messages, compactionCfg.keepRecentMessages);
        if (fallback.dropped > 0) {
          state.messages = fallback.messages;
          try {
            params.onState?.(state.messages);
          } catch (err) {
            yield { type: "notice", level: "warn", text: "onState failed: " + (err instanceof Error ? err.message : String(err)) };
          }
          yield {
            type: "compaction",
            applied: ["snip(" + fallback.dropped + ")"],
            tokensBefore: beforeSummary,
            tokensAfter: contextTokens(state.messages),
          };
        }
        yield {
          type: "notice",
          level: "warn",
          text: "context summary failed; fell back to dropping old turns",
        };
      }
    }

    // ---------- 2. stream the model call ----------
    let assistant: AssistantMessage | null = null;
    let usage: Usage | undefined;
    let transientAttempt = 0;

    while (true) {
      try {
        state.lastEstimate = budget(contextTokens(state.messages));
        const request = {
          model: activeModel,
          system: params.systemPrompt,
          messages: withEphemeral(state.messages, params.ephemeralContext),
          tools: params.tools.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
          maxTokens: state.maxTokensOverride ?? params.maxTokens,
          temperature: params.temperature,
          signal: params.signal,
        };
        let assembled: AssistantMessage | null = null;
        const streamStart = Date.now();
        let firstTokenAt = 0;
        for await (const ev of activeProvider.stream(request)) {
          if (ev.type === "thinking_delta") {
            // 推理流只透传给 UI；不进 transcript、不算 TTFT（它不是"答案的开始"）
            yield { type: "thinking_delta", text: ev.text };
          } else if (ev.type === "text_delta") {
            if (!firstTokenAt) {
              firstTokenAt = Date.now();
              state.ttftTotal += firstTokenAt - streamStart;
              state.ttftCount++;
            }
            yield { type: "text_delta", text: ev.text };
          } else {
            assembled = ev.message;
            usage = ev.message.usage;
          }
        }
        state.modelMs += Date.now() - streamStart;
        if (!assembled) throw new PE("model_error", "provider returned no message");
        // 0 个内容块的回复不是"答完了"，而是"什么都没答"：
        // 以前它会被当成 end_turn 直接以 completed 结束，用户看到一片空白。
        //
        // 但要先区分一种**不是空响应**的情况：推理模型（deepseek-flash 这类）会先写
        // reasoning_content，输出预算被推理吃光时 content 就是空的、finish_reason=length。
        // 这种情况该走下面的 max_tokens 升级路径，而不是当成"空回复"重试两次后报错。
        const burnedByReasoning =
          assembled.stopReason === "max_tokens" && assembled.content.length === 0;
        if (assembled.content.length === 0 && !burnedByReasoning) {
          if (state.emptyResponses < 2) {
            state.emptyResponses++;
            yield {
              type: "notice",
              level: "warn",
              text:
                "provider returned an empty message; retrying (" +
                state.emptyResponses +
                "/2) —— 若该模型是推理型（deepseek-flash 等），通常是输出预算被推理吃光，请提高 maxTokens",
            };
            continue;
          }
          throw new PE("model_error", "provider returned an empty message twice");
        }
        if (burnedByReasoning) {
          yield {
            type: "notice",
            level: "warn",
            text: "输出预算被推理过程吃光了（推理模型），正在用更大的 max_tokens 重试",
          };
        }
        assistant = assembled;
        break;
      } catch (err) {
        const raw = err instanceof Error ? err.message : String(err);
        // fetch 层的网络抖动不是 ProviderError：ECONNRESET / ETIMEDOUT / "fetch failed"
        // 这类错误重试就好，以前它们被归成 model_error 直接终止整轮。
        const networkish = !(err instanceof PE) && /fetch failed|network|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|terminated/i.test(raw);
        const pe = err instanceof PE ? err : new PE(networkish ? "rate_limit" : "model_error", raw);

        if (pe.kind === "rate_limit" || pe.kind === "overloaded") {
          if (transientAttempt < MAX_TRANSIENT_RETRIES) {
            transientAttempt++;
            // 服务端给了 Retry-After 就听它的（不再抖动：那是明确指令）；
            // 没给才用指数退避 + ±25% 抖动，避免多会话在同一毫秒一起重试。
            const base = 500 * 2 ** transientAttempt;
            const waitMs =
              pe.retryAfterMs !== undefined
                ? pe.retryAfterMs
                : Math.round(base * (0.75 + Math.random() * 0.5));
            yield {
              type: "notice",
              level: "warn",
              text:
                (networkish ? "network error" : "provider " + pe.kind) +
                ", retrying in " + waitMs + "ms" +
                (pe.retryAfterMs !== undefined ? " (server Retry-After)" : "") +
                " (" + transientAttempt + "/" + MAX_TRANSIENT_RETRIES + ")",
            };
            await sleep(waitMs, params.signal);
            continue;
          }
          if (!state.usingFallback && params.fallback) {
            state.usingFallback = true;
            activeProvider = params.fallback.provider;
            activeModel = params.fallback.model;
            transientAttempt = 0;
            yield {
              type: "notice",
              level: "warn",
              text: "primary model kept failing (" + pe.kind + "); switching to fallback " + activeModel,
            };
            continue;
          }
          yield { type: "done", reason: "model_error", turns: state.turnCount, error: pe.message };
          return "model_error";
        }

        if (pe.kind === "prompt_too_long") {
          // Continue site: reactive compact, exactly once.
          if (!state.hasAttemptedReactiveCompact) {
            const keepRecent = Math.max(4, Math.floor(compactionCfg.keepRecentMessages / 2));
            const aggressive = compactLocally(state.messages, {
              ...compactionCfg,
              softLimit: 0,
              targetTokens: Math.floor(compactionCfg.targetTokens / 2),
              keepRecentMessages: keepRecent,
            });
            const split = splitForSummary(aggressive.messages, keepRecent);
            const source = split.older.length ? split.older : aggressive.messages;
            const summary = await summarizeTranscript(activeProvider, activeModel, source, {
              maxChars: summaryBudgetChars(params.contextWindow),
              signal: params.signal,
            });
            state.messages = summary
              ? split.older.length
                ? applySummary(split, summary)
                : [summary]
              : aggressive.messages;
            state.hasAttemptedReactiveCompact = true;
            try {
              params.onState?.(state.messages);
            } catch (err) {
              // 状态镜像失败不该让整轮对话炸掉
              yield { type: "notice", level: "warn", text: "onState failed: " + (err instanceof Error ? err.message : String(err)) };
            }
            yield {
              type: "compaction",
              applied: ["reactive_compact"],
              tokensBefore: aggressive.tokensBefore,
              tokensAfter: contextTokens(state.messages),
            };
            continue;
          }
          yield { type: "done", reason: "prompt_too_long", turns: state.turnCount, error: pe.message };
          return "prompt_too_long";
        }

        // 认证失败/服务端错误：先看有没有备用模型，没有才报错。
        if (!state.usingFallback && params.fallback) {
          state.usingFallback = true;
          activeProvider = params.fallback.provider;
          activeModel = params.fallback.model;
          transientAttempt = 0;
          yield {
            type: "notice",
            level: "warn",
            text: "primary model failed (" + pe.kind + "); switching to fallback " + activeModel,
          };
          continue;
        }

        // 认证失败几乎总是配置问题，给一句能直接行动的提示，别只抛 401 原文。
        const hint =
          pe.kind === "auth"
            ? "（检查 API Key、Base URL 与模型名；密钥只存在 ~/.jysharness/secrets.json）"
            : "";
        yield { type: "done", reason: "model_error", turns: state.turnCount, error: pe.message + hint };
        return "model_error";
      }
    }

    state.messages = [...state.messages, assistant];
    try {
      params.onState?.(state.messages);
    } catch (err) {
      // 状态镜像失败不该让整轮对话炸掉
      yield { type: "notice", level: "warn", text: "onState failed: " + (err instanceof Error ? err.message : String(err)) };
    }
    try {
      params.persist?.(assistant);
    } catch (err) {
      // 落盘失败：提示用户，但不要丢掉这一轮已经产出的内容
      yield { type: "notice", level: "warn", text: "persist failed: " + (err instanceof Error ? err.message : String(err)) };
    }
    yield { type: "assistant_message", message: assistant };

    if (usage) {
      state.lastInputTokens = usage.inputTokens;
      // 真实输入 = 未命中 + 缓存读 + 缓存写；用它校正估算器。
      const actualInput = usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheCreationTokens ?? 0);
      if (state.lastEstimate > 0) params.calibrator?.record(state.lastEstimate, actualInput);
      state.totalInput += usage.inputTokens;
      state.totalOutput += usage.outputTokens;
      state.totalCacheRead += usage.cacheReadTokens ?? 0;
      state.totalCacheCreation += usage.cacheCreationTokens ?? 0;
      yield {
        type: "usage",
        usage,
        totalInput: state.totalInput,
        totalOutput: state.totalOutput,
        cacheRead: state.totalCacheRead,
        cacheCreation: state.totalCacheCreation,
      };
      yield timingEvent(state);
    }

    // ---------- 3. max_tokens recovery (continue sites) ----------
    if (assistant.stopReason === "max_tokens" && assistant.content.length === 0) {
      // 空内容 + 被截断：没有可展示的回复，只能升级预算重来（不是"答完了"）。
      if (state.maxTokensOverride === undefined) {
        state.maxTokensOverride = ESCALATED_MAX_TOKENS;
        yield {
          type: "notice",
          level: "info",
          text: "empty reply truncated by the output cap; retrying with max_tokens=" + ESCALATED_MAX_TOKENS,
        };
        state.messages = [...state.messages];
        continue;
      }
    }
    if (assistant.stopReason === "max_tokens") {
      if (state.maxTokensOverride === undefined) {
        state.maxTokensOverride = ESCALATED_MAX_TOKENS;
        yield { type: "notice", level: "info", text: "output truncated; retrying with a larger cap" };
        continue;
      }
      if (state.maxTokensRecovery < MAX_OUTPUT_RECOVERY) {
        state.maxTokensRecovery++;
        state.messages = [
          ...state.messages,
          {
            role: "user",
            isMeta: true,
            content: [
              {
                type: "text",
                text:
                  "Output limit hit. Resume directly from where you stopped - no apology, no recap. " +
                  "Break the remaining work into smaller pieces.",
              },
            ],
          },
        ];
        yield { type: "notice", level: "info", text: "asking the model to resume (attempt " + state.maxTokensRecovery + ")" };
        continue;
      }
      // 升上限 + 3 次续写都不够：明确以"输出被截断"结束。
      // 以前这里会掉进 stop hooks 然后报 completed —— 用户拿到半截答案却显示成功。
      yield {
        type: "notice",
        level: "warn",
        text: "output is still truncated after " + MAX_OUTPUT_RECOVERY + " resume attempts; stopping",
      };
      yield { type: "done", reason: "max_output_tokens", turns: state.turnCount, error: "output truncated" };
      return "max_output_tokens";
    }

    // ---------- 4. tool execution ----------
    const toolUses = assistant.content.filter((b): b is ToolUseBlock => b.type === "tool_use");
    if (toolUses.length === 0) {
      // ---------- 5. stop hooks ----------
      const stopHook = await runHooks(
        params.hooks?.Stop,
        { event: "Stop", sessionId: params.sessionId, cwd: params.toolContext.cwd, toolResult: "" },
        { cwd: params.toolContext.cwd, logger: params.logger, signal: params.signal },
      );
      if (stopHook.decision === "deny") {
        state.stopHookDenials++;
        if (state.stopHookDenials >= MAX_STOP_HOOK_DENIALS) {
          // 钩子永远不满意时，不能一路烧到 maxTurns 才停；
          // 用专门的终止原因告诉调用方"是钩子拦的不是轮次用完了"。
          yield {
            type: "notice",
            level: "warn",
            text: "Stop hook blocked completion " + state.stopHookDenials + " times; giving up",
          };
          yield {
            type: "done",
            reason: "stop_hook_prevented",
            turns: state.turnCount,
            error: stopHook.reason ?? "blocked by Stop hook",
          };
          return "stop_hook_prevented";
        }
        state.messages = [
          ...state.messages,
          { role: "user", isMeta: true, content: [{ type: "text", text: "Hook blocked completion: " + (stopHook.reason ?? "unspecified") }] },
        ];
        continue;
      }
      if (stopHook.additionalContext) {
        state.messages = [
          ...state.messages,
          { role: "user", isMeta: true, content: [{ type: "text", text: stopHook.additionalContext }] },
        ];
        continue;
      }
      yield { type: "done", reason: "completed", turns: state.turnCount };
      return "completed";
    }

    const results: ToolResultBlock[] = [];
    const lookup = {
      get: (n: string) => params.preloadedToolMap.get(n),
      names: () => params.tools.map((t) => t.name),
    };
    const prepared = toolUses.map((tu) =>
      prepareCall(lookup, { id: tu.id, name: tu.name, input: tu.input }),
    );

    // Permissions/hooks run serially (they may prompt the user); execution
    // then partitions into parallel-read and serial-write batches.
    const approved: PreparedCall[] = [];
    for (const call of prepared) {
      const block = await gateCall(call, params);
      if (block) {
        results.push(block);
        // Blocked calls still surface in the UI: silence would look like a hang.
        yield {
          type: "tool_end",
          id: call.request.id,
          name: call.request.name,
          result: { content: block.content, isError: true },
          durationMs: 0,
        };
      } else {
        approved.push(call);
      }
    }

    const batches = partitionCalls(approved);
    for (const batch of batches) {
      if (batch.concurrencySafe) {
        // 同一批里完全相同的只读调用只执行一次：模型经常一口气读同一份文件两遍，
        // 那是纯重复的 token 和 IO。判重键 = 工具名 + 稳定序列化的入参。
        const keyOf = (c: PreparedCall) => c.request.name + ":" + stableKey(c.request.input);
        const unique: PreparedCall[] = [];
        const seen = new Map<string, PreparedCall>();
        for (const c of batch.calls) {
          const dedupable = c.tool?.isReadOnly === true;
          const key = keyOf(c);
          if (dedupable && seen.has(key)) continue;
          if (dedupable) seen.set(key, c);
          unique.push(c);
        }

        // 并发有上限：只读批量并行是为了延迟，不是为了把句柄打爆。
        const outcomes = await mapWithLimit(
          unique,
          MAX_PARALLEL_TOOLS,
          async (call) => ({ call, outcome: await timedExecute(call, params) }),
        );
        const byKey = new Map(outcomes.map((o) => [keyOf(o.call), o]));

        for (const call of batch.calls) {
          const hit = byKey.get(keyOf(call));
          const outcome = hit?.outcome ?? { result: { content: "internal: missing outcome", isError: true }, durationMs: 0 };
          const isDup = Boolean(hit && hit.call !== call);
          const result = isDup
            ? {
                ...outcome.result,
                metadata: { ...(outcome.result.metadata ?? {}), dedupedFrom: hit!.call.request.id },
              }
            : outcome.result;
          results.push(toResultBlock(call.request.id, call.request.name, result));
          yield {
            type: "tool_end",
            id: call.request.id,
            name: call.request.name,
            result,
            durationMs: isDup ? 0 : outcome.durationMs,
          };
        }
      } else {
        for (const call of batch.calls) {
          yield {
            type: "tool_start",
            id: call.request.id,
            name: call.request.name,
            input: call.request.input,
          };
          const outcome = await timedExecute(call, params);
          results.push(toResultBlock(call.request.id, call.request.name, outcome.result));
          yield {
            type: "tool_end",
            id: call.request.id,
            name: call.request.name,
            result: outcome.result,
            durationMs: outcome.durationMs,
          };
        }
      }
    }

    state.messages = [...state.messages, toolResultMessage(results)];
    try {
      params.onState?.(state.messages);
    } catch (err) {
      // 状态镜像失败不该让整轮对话炸掉
      yield { type: "notice", level: "warn", text: "onState failed: " + (err instanceof Error ? err.message : String(err)) };
    }
    try {
      params.persist?.(toolResultMessage(results));
    } catch (err) {
      // 落盘失败：提示用户，但不要丢掉这一轮已经产出的内容
      yield { type: "notice", level: "warn", text: "persist failed: " + (err instanceof Error ? err.message : String(err)) };
    }
    yield timingEvent(state);
    // Continue site: normal next turn.
  }
}

/** 累计耗时快照：模型 / 工具 / 首 token 平均 / 步数。 */
function timingEvent(state: LoopState): {
  type: "timing";
  modelMs: number;
  toolMs: number;
  ttftAvgMs: number | null;
  steps: number;
} {
  return {
    type: "timing",
    modelMs: state.modelMs,
    toolMs: state.toolMs,
    ttftAvgMs: state.ttftCount ? Math.round(state.ttftTotal / state.ttftCount) : null,
    steps: state.steps,
  };
}

async function timedExecute(
  call: PreparedCall,
  params: QueryParams,
): Promise<{ result: ToolResult; durationMs: number }> {
  const started = Date.now();

  // 熔断：同一个工具连续失败多次后先歇一会，把预算留给别的办法。
  const shorted = params.toolHealth?.check(call.request.name);
  if (shorted) {
    return {
      result: { content: "<tool_use_error>" + shorted + "</tool_use_error>", isError: true },
      durationMs: 0,
    };
  }

  const result = await executeCall(call, { ...params.toolContext, signal: params.signal });
  params.toolHealth?.record(call.request.name, Boolean(result.isError));

  const post = await runHooks(
    params.hooks?.PostToolUse,
    {
      event: "PostToolUse",
      sessionId: params.sessionId,
      cwd: params.toolContext.cwd,
      toolName: call.request.name,
      toolInput: call.request.input,
      toolResult: result.content,
    },
    { cwd: params.toolContext.cwd, logger: params.logger, signal: params.signal },
  );
  let content = result.content;
  if (post.additionalContext) content += "\n\n[hook context] " + post.additionalContext;
  if (post.decision === "deny") content += "\n\n[hook feedback] " + (post.reason ?? "review this result");

  // 失败是单独的语义：很多钩子只关心"这条命令炸了"，不想在上百次成功里过滤。
  if (result.isError) {
    const failed = await runHooks(
      params.hooks?.PostToolUseFailure,
      {
        event: "PostToolUseFailure",
        sessionId: params.sessionId,
        cwd: params.toolContext.cwd,
        toolName: call.request.name,
        toolInput: call.request.input,
        toolResult: result.content,
      },
      { cwd: params.toolContext.cwd, logger: params.logger, signal: params.signal },
    );
    if (failed.additionalContext) content += "\n\n[failure hook] " + failed.additionalContext;
  }

  return { result: { ...result, content }, durationMs: Date.now() - started };
}

/**
 * 把"本轮的易变上下文"拼到最后一条消息上（仅请求时，不落盘）。
 *
 * 为什么不放进 system：system 带 cache_control，一变则整条前缀（tools + system +
 * 全部消息）缓存作废；而 git 状态每个文件写操作都会变，等于每个动作都重写一遍缓存。
 * 拼在**新追加的**那条 user 消息上，前面的前缀就完全不受影响。
 */
export function withEphemeral(messages: Message[], suffix?: string): Message[] {
  if (!suffix || messages.length === 0) return messages;
  const last = messages[messages.length - 1];
  if (last.role !== "user") return messages;
  return [...messages.slice(0, -1), { ...last, content: [...last.content, { type: "text", text: suffix }] }];
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

export type { ProviderError };

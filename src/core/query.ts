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
import type { Message, ToolResultBlock, ToolUseBlock, Usage } from "./types.ts";
import { toolResultMessage } from "./types.ts";
import type { ModelProvider, ProviderError } from "../providers/types.ts";
import { ProviderError as PE } from "../providers/types.ts";
import {
  compactLocally,
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

export type TerminalReason =
  | "completed"
  | "max_turns"
  | "aborted"
  | "prompt_too_long"
  | "model_error"
  | "stop_hook_prevented"
  | "blocking_limit";

export type HarnessEvent =
  | { type: "turn_start"; turn: number }
  | { type: "text_delta"; text: string }
  | { type: "assistant_message"; message: Message }
  | { type: "tool_start"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_end"; id: string; name: string; result: ToolResult; durationMs: number }
  | { type: "permission_request"; id: string; toolName: string; input: Record<string, unknown>; decision: PermissionDecision }
  | { type: "permission_denied"; id: string; toolName: string; decision: PermissionDecision }
  | { type: "compaction"; applied: string[]; tokensBefore: number; tokensAfter: number }
  | { type: "usage"; usage: Usage; totalInput: number; totalOutput: number }
  | { type: "notice"; level: "info" | "warn"; text: string }
  | { type: "done"; reason: TerminalReason; turns: number; error?: string };

export type ApprovalOutcome = "allow" | "deny" | "always";

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
  signal: AbortSignal;
  /** Ask the user. The CLI implements this; tests can auto-answer. */
  approve: (args: {
    toolName: string;
    input: Record<string, unknown>;
    decision: PermissionDecision;
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
  totalInput: number;
  totalOutput: number;
}

const MAX_OUTPUT_RECOVERY = 3;
const ESCALATED_MAX_TOKENS = 32_000;
const MAX_TRANSIENT_RETRIES = 3;

export async function* queryLoop(params: QueryParams): AsyncGenerator<HarnessEvent, TerminalReason> {
  const compactionCfg = params.compaction ?? DEFAULT_COMPACTION;
  let state: LoopState = {
    messages: params.messages,
    turnCount: 0,
    maxTokensOverride: undefined,
    maxTokensRecovery: 0,
    hasAttemptedReactiveCompact: false,
    totalInput: 0,
    totalOutput: 0,
  };

  while (true) {
    if (params.signal.aborted) {
      yield { type: "done", reason: "aborted", turns: state.turnCount };
      return "aborted";
    }
    state.turnCount++;
    yield { type: "turn_start", turn: state.turnCount };

    if (state.turnCount > params.maxTurns) {
      yield { type: "done", reason: "blocking_limit", turns: state.turnCount };
      return "blocking_limit";
    }

    // ---------- 1. proactive compaction ----------
    const compacted = compactLocally(state.messages, compactionCfg);
    if (compacted.applied.length) {
      state.messages = compacted.messages;
      yield {
        type: "compaction",
        applied: compacted.applied,
        tokensBefore: compacted.tokensBefore,
        tokensAfter: compacted.tokensAfter,
      };
    }
    if (needsSummary(state.messages, compactionCfg)) {
      const summary = await summarizeTranscript(
        params.provider,
        params.model,
        state.messages,
        params.signal,
      );
      if (summary) {
        state.messages = [summary];
        yield {
          type: "compaction",
          applied: ["summarize"],
          tokensBefore: contextTokens(compacted.messages),
          tokensAfter: contextTokens(state.messages),
        };
        params.onState?.(state.messages);
      }
    }

    // ---------- 2. stream the model call ----------
    let assistant: Message | null = null;
    let usage: Usage | undefined;
    let transientAttempt = 0;

    while (true) {
      try {
        const request = {
          model: params.model,
          system: params.systemPrompt,
          messages: state.messages,
          tools: params.tools.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
          maxTokens: state.maxTokensOverride ?? params.maxTokens,
          temperature: params.temperature,
          signal: params.signal,
        };
        let assembled: Message | null = null;
        for await (const ev of params.provider.stream(request)) {
          if (ev.type === "text_delta") {
            yield { type: "text_delta", text: ev.text };
          } else {
            assembled = ev.message;
            usage = ev.message.usage;
          }
        }
        if (!assembled) throw new PE("model_error", "provider returned no message");
        assistant = assembled;
        break;
      } catch (err) {
        const pe = err instanceof PE ? err : new PE("model_error", err instanceof Error ? err.message : String(err));

        if (pe.kind === "rate_limit" || pe.kind === "overloaded") {
          if (transientAttempt < MAX_TRANSIENT_RETRIES) {
            transientAttempt++;
            const waitMs = 500 * 2 ** transientAttempt;
            yield {
              type: "notice",
              level: "warn",
              text: "provider " + pe.kind + ", retrying in " + waitMs + "ms (" + transientAttempt + "/" + MAX_TRANSIENT_RETRIES + ")",
            };
            await sleep(waitMs, params.signal);
            continue;
          }
          yield { type: "done", reason: "model_error", turns: state.turnCount, error: pe.message };
          return "model_error";
        }

        if (pe.kind === "prompt_too_long") {
          // Continue site: reactive compact, exactly once.
          if (!state.hasAttemptedReactiveCompact) {
            const aggressive = compactLocally(state.messages, {
              ...compactionCfg,
              softLimit: 0,
              targetTokens: Math.floor(compactionCfg.targetTokens / 2),
              keepRecentMessages: Math.max(4, Math.floor(compactionCfg.keepRecentMessages / 2)),
            });
            const summary = await summarizeTranscript(params.provider, params.model, aggressive.messages, params.signal);
            state.messages = summary ? [summary] : aggressive.messages;
            state.hasAttemptedReactiveCompact = true;
            params.onState?.(state.messages);
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

        yield { type: "done", reason: "model_error", turns: state.turnCount, error: pe.message };
        return "model_error";
      }
    }

    state.messages = [...state.messages, assistant];
    params.onState?.(state.messages);
    params.persist?.(assistant);
    yield { type: "assistant_message", message: assistant };

    if (usage) {
      state.totalInput += usage.inputTokens;
      state.totalOutput += usage.outputTokens;
      yield {
        type: "usage",
        usage,
        totalInput: state.totalInput,
        totalOutput: state.totalOutput,
      };
    }

    // ---------- 3. max_tokens recovery (continue sites) ----------
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
        state.messages = [
          ...state.messages,
          { role: "user", isMeta: true, content: [{ type: "text", text: "Hook blocked completion: " + (stopHook.reason ?? "unspecified") }] },
        ];
        continue;
      }
      if (stopHook.additionalContext) {
        state.messages = [
          ...state.messages,
          { type: "user", isMeta: true, content: [{ type: "text", text: stopHook.additionalContext }] },
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
        const outcomes = await Promise.all(
          batch.calls.map(async (call) => ({ call, outcome: await timedExecute(call, params) })),
        );
        for (const { call, outcome } of outcomes) {
          results.push(toResultBlock(call.request.id, call.request.name, outcome.result));
          yield {
            type: "tool_end",
            id: call.request.id,
            name: call.request.name,
            result: outcome.result,
            durationMs: outcome.durationMs,
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
    params.onState?.(state.messages);
    params.persist?.(toolResultMessage(results));
    // Continue site: normal next turn.
  }
}

function toResultBlock(id: string, _name: string, r: ToolResult): ToolResultBlock {
  return { type: "tool_result", tool_use_id: id, content: r.content, is_error: r.isError };
}

/** PreToolUse hook + permission pipeline. Returns a blocking tool_result, or null if allowed. */
async function gateCall(
  call: PreparedCall,
  params: QueryParams,
): Promise<ToolResultBlock | null> {
  const { request } = call;
  if (call.errorResult || call.validationError) {
    const content = call.errorResult?.content ?? "<tool_use_error>" + call.validationError + "</tool_use_error>";
    return { type: "tool_result", tool_use_id: request.id, content, is_error: true };
  }
  const tool = call.tool!;

  // Layer 3: PreToolUse hooks.
  const pre = await runHooks(
    params.hooks?.PreToolUse,
    {
      event: "PreToolUse",
      sessionId: params.sessionId,
      cwd: params.toolContext.cwd,
      toolName: request.name,
      toolInput: request.input,
    },
    { cwd: params.toolContext.cwd, logger: params.logger, signal: params.signal },
  );
  if (pre.decision === "deny") {
    return {
      type: "tool_result",
      tool_use_id: request.id,
      content: "<tool_use_error>Blocked by PreToolUse hook: " + (pre.reason ?? "unspecified") + "</tool_use_error>",
      is_error: true,
    };
  }
  if (pre.updatedInput) {
    request.input = { ...request.input, ...pre.updatedInput };
  }

  // Layers 2/4/5: declarative rules, tool checks, mode policy.
  const decision = decidePermission(
    {
      toolName: request.name,
      input: request.input,
      isReadOnly: tool.isReadOnly,
      isDestructive: tool.isDestructive,
      toolCheck: tool.toolCheck ? (input) => tool.toolCheck!(input, params.toolContext) : undefined,
    },
    params.permission,
  );

  let final: PermissionDecision = decision;
  if (decision.behavior === "ask") {
    const outcome = await params.approve({ toolName: request.name, input: request.input, decision });
    if (outcome === "always") {
      params.onAlwaysAllow?.(request.name, request.input);
      final = { behavior: "allow", reason: "rule_allow", message: "approved by user (always)" };
    } else if (outcome === "allow") {
      final = { behavior: "allow", reason: "rule_allow", message: "approved by user" };
    } else {
      final = { behavior: "deny", reason: "rule_deny", message: "rejected by user" };
    }
  }

  if (final.behavior === "deny") {
    return {
      type: "tool_result",
      tool_use_id: request.id,
      content:
        "<tool_use_error>Permission denied for " +
        request.name +
        ": " +
        final.message +
        " [" +
        final.reason +
        "] Do not retry the same call; adjust your approach or ask the user.</tool_use_error>",
      is_error: true,
    };
  }
  return null;
}

async function timedExecute(
  call: PreparedCall,
  params: QueryParams,
): Promise<{ result: ToolResult; durationMs: number }> {
  const started = Date.now();
  const result = await executeCall(call, { ...params.toolContext, signal: params.signal });

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

  return { result: { ...result, content }, durationMs: Date.now() - started };
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

export function toolContentForRules(toolName: string, input: Record<string, unknown>): string {
  return permissionContentFor(toolName, input);
}

export type { ProviderError };

/**
 * 循环对外的事件契约。
 *
 * 单独一个文件不是洁癖：这些类型是 CLI / Web / 测试三方共同的接口，
 * 放在 query.ts 里会让"循环实现"和"对外契约"绑在一起，也让那个文件膨胀到
 * 超过单模块预算。类型搬出来，实现文件和消费方都更轻。
 */
import type { Message, Usage } from "./types.ts";
import type { PermissionDecision } from "../permissions/engine.ts";
import type { ToolResult } from "../tools/types.ts";

export type TerminalReason =
  | "completed"
  | "max_turns"
  | "aborted"
  | "prompt_too_long"
  | "model_error"
  | "stop_hook_prevented"
  | "max_output_tokens"
  | "blocking_limit";

export type HarnessEvent =
  | { type: "turn_start"; turn: number }
  | { type: "text_delta"; text: string }
  /** 推理流（展示用，不进 transcript / 不进请求 / 不计入上下文） */
  | { type: "thinking_delta"; text: string }
  | { type: "assistant_message"; message: Message }
  | { type: "tool_start"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_end"; id: string; name: string; result: ToolResult; durationMs: number }
  | {
      type: "permission_request";
      id: string;
      toolName: string;
      input: Record<string, unknown>;
      decision: PermissionDecision;
    }
  | { type: "permission_denied"; id: string; toolName: string; decision: PermissionDecision }
  | { type: "compaction"; applied: string[]; tokensBefore: number; tokensAfter: number }
  | {
      type: "usage";
      usage: Usage;
      totalInput: number;
      totalOutput: number;
      cacheRead: number;
      cacheCreation: number;
    }
  | {
      type: "timing";
      modelMs: number;
      toolMs: number;
      ttftAvgMs: number | null;
      steps: number;
    }
  | { type: "notice"; level: "info" | "warn"; text: string }
  /**
   * 子 Agent 的实时进度。走**旁路**（Session 的 liveSink）而不是生成器：
   * 工具调用内部无法 yield，但用户需要看到"子 Agent 现在在干什么"。
   */
  | { type: "subagent_start"; id: string; label: string; agentType: string }
  | { type: "subagent_progress"; id: string; label: string; step: number; tool: string }
  | { type: "subagent_end"; id: string; label: string; ok: boolean; steps: number }
  | { type: "done"; reason: TerminalReason; turns: number; error?: string };

export type ApprovalOutcome = "allow" | "deny" | "always";

/**
 * 从转录重建会话统计。
 *
 * 为什么需要：stats 只存在内存里，进程重启后从转录恢复会话时全是 0 —— 于是
 * 历史会话的面板显示"0 轮 0 步 / 0 tok"，而对话明明就在那里。
 * assistant 消息里带着 usage（provider 返回时写入并落盘），所以 token 可以精确累加；
 * 模型用时 / 工具用时 / TTFT 没有落盘，恢复时只能保持 0，这是已知边界。
 */
import type { Message } from "./types.ts";

export interface RebuiltStats {
  turns: number;
  toolCalls: number;
  steps: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** 标记重建来源：耗时类字段（modelMs/toolMs/TTFT）没有落盘，恢复后不可知。 */
  restored: boolean;
}

export function statsFromMessages(messages: Message[]): RebuiltStats {
  const out: RebuiltStats = {
    turns: 0,
    toolCalls: 0,
    steps: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    restored: true,
  };
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    out.turns++;
    for (const block of message.content ?? []) {
      if (block.type === "tool_use") {
        out.toolCalls++;
        out.steps++;
      }
    }
    const usage = (message as { usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheCreationTokens?: number } }).usage;
    if (!usage) continue;
    out.inputTokens += usage.inputTokens ?? 0;
    out.outputTokens += usage.outputTokens ?? 0;
    out.cacheReadTokens += usage.cacheReadTokens ?? 0;
    out.cacheCreationTokens += usage.cacheCreationTokens ?? 0;
  }
  return out;
}

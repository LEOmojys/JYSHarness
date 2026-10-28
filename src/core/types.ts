/**
 * Core message / content types for the harness.
 *
 * Deliberately provider-neutral: adapters translate to/from Anthropic and
 * OpenAI wire formats. Mirrors `src/types/message.ts` in Claude Code.
 */

export type TextBlock = { type: "text"; text: string };

export type ToolUseBlock = {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
};

export type ToolResultBlock = {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
};

export type ImageBlock = {
  type: "image";
  /** e.g. image/png */
  mediaType: string;
  /** base64 payload, no data: prefix */
  data: string;
  name?: string;
};

/** 推理过程（DeepSeek 的 reasoning_content / Anthropic 的 thinking）。
 *  只用于展示：**不发回模型、不计入上下文估算**，但会保留在转录里（刷新后仍能看到）。 */
export interface ThinkingBlock {
  type: "thinking";
  text: string;
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock | ImageBlock | ThinkingBlock;

export type Role = "user" | "assistant";

export interface Message {
  role: Role;
  content: ContentBlock[];
  /** Injected by the harness (recovery prompts, hook feedback). Rendered dim, never shown as user input. */
  isMeta?: boolean;
  /** Bookkeeping for compaction / resume. */
  id?: string;
}

export type StopReason =
  | "end_turn"
  | "tool_use"
  | "max_tokens"
  | "stop_sequence"
  | "error";

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  /** Tokens served from the provider's prompt cache (billed at a discount). */
  cacheReadTokens?: number;
  /** Tokens written into the cache this turn (billed at a premium). */
  cacheCreationTokens?: number;
}

export interface AssistantMessage extends Message {
  role: "assistant";
  stopReason: StopReason;
  usage?: Usage;
}

export function textBlock(text: string): TextBlock {
  return { type: "text", text };
}

export function userMessage(text: string, isMeta = false): Message {
  return { role: "user", content: [textBlock(text)], isMeta };
}

export function userMessageWithImages(
  text: string,
  images: { mediaType: string; data: string; name?: string }[],
): Message {
  const content: ContentBlock[] = images.map((img) => ({
    type: "image" as const,
    mediaType: img.mediaType,
    data: img.data,
    name: img.name,
  }));
  if (text.trim()) content.push(textBlock(text));
  return { role: "user", content };
}

export function toolResultMessage(results: ToolResultBlock[]): Message {
  return { role: "user", content: results };
}

export function getText(content: ContentBlock[]): string {
  return content
    .filter((b): b is TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
}


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

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock | ImageBlock;

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
  cacheReadTokens?: number;
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

export function getToolUses(content: ContentBlock[]): ToolUseBlock[] {
  return content.filter((b): b is ToolUseBlock => b.type === "tool_use");
}

/** Serialise any block array into a compact one-line preview (for logs / UI). */
export function previewContent(content: ContentBlock[], max = 120): string {
  const s = content
    .map((b) => {
      if (b.type === "text") return b.text;
      if (b.type === "tool_use") return `${b.name}(${JSON.stringify(b.input)})`;
      if (b.type === "image") return `[image ${b.mediaType}]`;
      return `=> ${b.content}`;
    })
    .join(" ");
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max) + "…" : flat;
}

import type { JSONSchema, ToolSpec } from "../providers/types.ts";
import type { PermissionDecision } from "../permissions/engine.ts";
import type { SandboxPolicy } from "../sandbox/paths.ts";
import type { Logger } from "../util/log.ts";

export interface ToolResult {
  /** Content handed back to the model as the tool_result body. */
  content: string;
  isError?: boolean;
  /** Structured side-channel for the UI / analytics (never sent to the model). */
  metadata?: Record<string, unknown>;
}

export interface ToolContext {
  workspaceRoot: string;
  cwd: string;
  sandbox: SandboxPolicy;
  signal: AbortSignal;
  logger: Logger;
  /** Nesting depth for sub-agents; 0 at the top level. */
  depth: number;
  /** Injected by the session so tools never depend on the loop directly. */
  runSubagent?: (prompt: string, opts: { description?: string }) => Promise<string>;
  onProgress?: (chunk: string) => void;
  jobs?: import("../core/jobs.ts").JobManager;
  todos?: import("../core/todos.ts").TodoStore;
  skills?: import("../core/skills.ts").SkillMeta[];
  checkpoints?: import("../core/checkpoints.ts").CheckpointStore;
}

export interface Tool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JSONSchema;
  readonly isReadOnly: boolean;
  readonly isDestructive?: boolean;
  /** Whether this call may run concurrently with sibling calls. */
  isConcurrencySafe(input: Record<string, unknown>): boolean;
  /** Cheap, tool-local validation performed before permissions. */
  validate?(input: Record<string, unknown>): string | null;
  call(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
  /** Tool-specific permission hook (path containment etc.). */
  toolCheck?(input: Record<string, unknown>, ctx: ToolContext): PermissionDecision | null;
}

export function toToolSpec(tool: Tool): ToolSpec {
  return { name: tool.name, description: tool.description, inputSchema: tool.inputSchema };
}

export function str(input: Record<string, unknown>, key: string, fallback = ""): string {
  const v = input[key];
  return typeof v === "string" ? v : fallback;
}

export function num(input: Record<string, unknown>, key: string, fallback: number): number {
  const v = input[key];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return fallback;
}

export function bool(input: Record<string, unknown>, key: string, fallback = false): boolean {
  const v = input[key];
  return typeof v === "boolean" ? v : fallback;
}

/** Structural validation against our JSON-Schema subset. */
export function validateAgainstSchema(
  schema: JSONSchema,
  input: Record<string, unknown>,
): string | null {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return "input must be a JSON object";
  }
  const props = (schema.properties ?? {}) as Record<string, { type?: string }>;
  for (const key of schema.required ?? []) {
    if (!(key in input)) return "missing required property: " + key;
  }
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(input)) {
      if (!(key in props)) return "unexpected property: " + key;
    }
  }
  for (const [key, spec] of Object.entries(props)) {
    if (!(key in input) || !spec?.type) continue;
    const v = input[key];
    const ok =
      spec.type === "string" ? typeof v === "string"
      : spec.type === "number" || spec.type === "integer" ? typeof v === "number"
      : spec.type === "boolean" ? typeof v === "boolean"
      : spec.type === "array" ? Array.isArray(v)
      : true;
    if (!ok) return "property " + key + " must be of type " + spec.type;
  }
  return null;
}

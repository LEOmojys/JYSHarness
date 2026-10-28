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
  runSubagent?: (
    prompt: string,
    opts: { description?: string; signal?: AbortSignal; type?: string },
  ) => Promise<string | { summary: string; ok: boolean; reason?: string }>;
  /** 可用的子 Agent 类型（内置 + 项目文件），用于校验和提示。 */
  agentTypes?: import("../core/agents.ts").AgentType[];
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
  /**
   * 单次输出上限（字符）。超过就截成 头 + 尾 + 省略标记。
   * 不设就会有工具把 500KB 的日志直接塞进下一轮请求 —— 那等于自己造一个 413。
   */
  maxOutputChars?: number;
  /**
   * 单次调用超时（毫秒）。只在"可能永远不返回"的工具上设置：
   * Bash 自己管超时，子 Agent 可能要跑很久，都不该被这里砍掉。
   */
  timeoutMs?: number;
  /**
   * 自动重试次数。**只对只读工具生效**：写操作重试会重复副作用
   * （写两次文件、提交两次），那比失败更糟。
   */
  retries?: number;
  call(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
  /** Tool-specific permission hook (path containment etc.). */
  toolCheck?(input: Record<string, unknown>, ctx: ToolContext): PermissionDecision | null;
}
export { DEFAULT_MAX_OUTPUT_CHARS, truncateOutput } from "../util/truncate.ts";

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
    if (!(key in input)) continue;
    const constraint = checkConstraint(key, spec as SpecLike, input[key]);
    if (constraint) return constraint;
  }
  return null;
}

type SpecLike = { type?: string } & Record<string, unknown>;

/**
 * 单字段约束。只做"能给出可行动提示"的那些：
 * enum / pattern / 长度 / 数值范围 / 数组元素类型。
 * 不做 $ref、oneOf、嵌套对象递归 —— 那是给完整校验器的工作，不是这里的职责。
 */
function checkConstraint(path: string, spec: SpecLike, v: unknown): string | null {
  if (v === undefined || v === null) return null;
  const key = path;

  if (spec.type === "string") {
    if (typeof v !== "string") return "property " + key + " must be of type string";
    const min = typeof spec.minLength === "number" ? spec.minLength : undefined;
    const max = typeof spec.maxLength === "number" ? spec.maxLength : undefined;
    if (min !== undefined && v.length < min) return "property " + key + " must be at least " + min + " characters";
    if (max !== undefined && v.length > max) return "property " + key + " must be at most " + max + " characters";
    if (typeof spec.pattern === "string") {
      try {
        if (!new RegExp(spec.pattern).test(v)) return "property " + key + " does not match pattern " + spec.pattern;
      } catch {
        /* 工具写坏了 pattern，不因此拒绝调用 */
      }
    }
  } else if (spec.type === "number" || spec.type === "integer") {
    if (typeof v !== "number" || !Number.isFinite(v)) return "property " + key + " must be of type " + spec.type;
    if (spec.type === "integer" && !Number.isInteger(v)) return "property " + key + " must be an integer";
    const min = typeof spec.minimum === "number" ? spec.minimum : undefined;
    const max = typeof spec.maximum === "number" ? spec.maximum : undefined;
    if (min !== undefined && v < min) return "property " + key + " must be >= " + min;
    if (max !== undefined && v > max) return "property " + key + " must be <= " + max;
  } else if (spec.type === "boolean") {
    if (typeof v !== "boolean") return "property " + key + " must be of type boolean";
  } else if (spec.type === "array") {
    if (!Array.isArray(v)) return "property " + key + " must be of type array";
    const items = spec.items as SpecLike | undefined;
    if (items) {
      for (let i = 0; i < v.length; i++) {
        // 元素也走同一套约束：数组里的对象、对象里的数组都能递归校验
        const nested = checkConstraint(key + "[" + i + "]", items, v[i]);
        if (nested) return nested;
      }
    }
  } else if (spec.type === "object") {
    if (typeof v !== "object" || Array.isArray(v)) return "property " + key + " must be an object";
    const obj = v as Record<string, unknown>;
    const nestedProps = (spec.properties ?? {}) as Record<string, SpecLike>;
    for (const required of (spec.required as string[] | undefined) ?? []) {
      if (!(required in obj)) return "property " + key + " is missing required property: " + required;
    }
    if (spec.additionalProperties === false) {
      for (const k of Object.keys(obj)) {
        if (!(k in nestedProps)) return "property " + key + " has unexpected property: " + k;
      }
    }
    for (const [k, subSpec] of Object.entries(nestedProps)) {
      if (!(k in obj)) continue;
      const nested = checkConstraint(key + "." + k, subSpec, obj[k]);
      if (nested) return nested;
    }
  }

  if (Array.isArray(spec.enum) && !spec.enum.includes(v)) {
    return "property " + key + " must be one of: " + (spec.enum as unknown[]).join(", ");
  }
  return null;
}

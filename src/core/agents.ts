/**
 * 子 Agent 类型（ch.11）：限定工具集、模型与提示。
 *
 * 为什么值得做：通用 Agent 拿全部工具，一个"去查一下调用点"的任务理论上也能
 * 删库。类型化的意义不是分类好看，而是**用工具集把能力关掉** —— explore 类型
 * 里根本没有 Write/Edit/Bash，不是靠提示词自觉。
 *
 * 定义来源两处：
 *   1. 内置几个（explore / plan / general），开箱可用；
 *   2. <workspace>/.harness/agents/*.md，frontmatter 声明（无 YAML 依赖，只认简单格式）。
 *
 * 解析刻意严格：未知字段忽略、tools 写错就报错并跳过该文件 —— 配置错误不该
 * 让 Agent 悄悄获得比预期更大的权限。
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

export interface AgentType {
  name: string;
  description: string;
  /** 允许使用的工具名；undefined = 除 Agent 外的全部工具。 */
  tools?: string[];
  /** 该类型使用的模型；undefined = 会话默认（或 subagentModel 设置）。 */
  model?: string;
  maxTurns?: number;
  /** 追加到子 Agent 系统提示里的专用指令。 */
  systemPrompt?: string;
  source: "builtin" | "file";
}

export const BUILTIN_AGENT_TYPES: AgentType[] = [
  {
    name: "general",
    description: "全能力（除再派生）：适合需要改代码的任务。",
    source: "builtin",
  },
  {
    name: "explore",
    description: "只读侦察：只能 Read / Grep / Glob，物理上不能写文件或执行命令。",
    tools: ["Read", "Grep", "Glob"],
    maxTurns: 20,
    source: "builtin",
    systemPrompt:
      "You are a read-only scout. You cannot modify files or run commands — do not propose edits, " +
      "just report precise findings: file paths, line numbers, symbol names and how they connect.",
  },
  {
    name: "plan",
    description: "只读规划：只读工具 + 待办，产出可执行的步骤清单。",
    tools: ["Read", "Grep", "Glob", "TodoWrite"],
    maxTurns: 15,
    source: "builtin",
    systemPrompt:
      "You are a planner. Do not modify anything. Produce an ordered, concrete plan: files to touch, " +
      "the exact change for each, and the command that proves it worked.",
  },
];

export interface ParsedAgent {
  agent?: AgentType;
  error?: string;
}

/** 极简 frontmatter 解析：只认 `key: value`，够用且没有依赖。 */
export function parseAgentFile(text: string, source: "builtin" | "file" = "file"): ParsedAgent {
  const raw = text.replace(/^\uFEFF/, "");
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!match) return { error: "缺少 frontmatter（--- 包裹的头部）" };
  const [, head, body] = match;
  const fields: Record<string, string> = {};
  for (const line of head.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const at = trimmed.indexOf(":");
    if (at <= 0) return { error: "frontmatter 行无法解析：" + trimmed.slice(0, 40) };
    fields[trimmed.slice(0, at).trim().toLowerCase()] = trimmed.slice(at + 1).trim();
  }
  const name = fields.name;
  if (!name || !/^[a-zA-Z0-9_-]+$/.test(name)) return { error: "name 缺失或含非法字符" };

  const tools = fields.tools
    ? fields.tools
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean)
    : undefined;
  if (fields.tools !== undefined && tools && tools.length === 0) {
    return { error: "tools 为空；要么省略（= 全部工具），要么写出至少一个工具名" };
  }

  const maxTurns = fields.maxturns ? Number(fields.maxturns) : undefined;
  if (maxTurns !== undefined && (!Number.isFinite(maxTurns) || maxTurns < 1)) {
    return { error: "maxTurns 必须是正整数" };
  }

  return {
    agent: {
      name,
      description: fields.description ?? name,
      tools,
      model: fields.model || undefined,
      maxTurns,
      systemPrompt: body.trim() || undefined,
      source,
    },
  };
}

export interface AgentDiscovery {
  types: AgentType[];
  errors: { file: string; message: string }[];
}

/** 内置优先，同名文件覆盖内置（显式覆盖是有意的能力）。 */
export function discoverAgentTypes(workspaceRoot: string): AgentDiscovery {
  const dir = path.join(workspaceRoot, ".harness", "agents");
  const errors: { file: string; message: string }[] = [];
  const fromFiles: AgentType[] = [];
  if (existsSync(dir)) {
    let entries: string[] = [];
    try {
      entries = readdirSync(dir).filter((f) => f.endsWith(".md"));
    } catch {
      entries = [];
    }
    for (const file of entries.sort()) {
      try {
        const parsed = parseAgentFile(readFileSync(path.join(dir, file), "utf8"));
        if (parsed.error) errors.push({ file, message: parsed.error });
        else if (parsed.agent) fromFiles.push(parsed.agent);
      } catch (err) {
        errors.push({ file, message: err instanceof Error ? err.message : String(err) });
      }
    }
  }
  const byName = new Map<string, AgentType>();
  for (const t of BUILTIN_AGENT_TYPES) byName.set(t.name, t);
  for (const t of fromFiles) byName.set(t.name, t);
  return { types: [...byName.values()], errors };
}

/** 解析一次调用：type 缺失时退化到 general，未知类型给出可用列表。 */
export function resolveAgentType(
  types: AgentType[],
  requested?: string,
): { type: AgentType } | { error: string } {
  const name = (requested ?? "general").trim() || "general";
  const found = types.find((t) => t.name === name);
  if (found) return { type: found };
  return {
    error:
      "未知的 Agent 类型：" + name + "。可用：" + types.map((t) => t.name + "（" + t.description + "）").join("；"),
  };
}

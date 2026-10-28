/**
 * Permission rules — the declarative layer of defence-in-depth (ch.5).
 *
 * Syntax (mirrors Claude Code):
 *   Read                     -> whole tool
 *   Bash(git *)              -> tool + content glob
 *   Write(*.ts)              -> path glob
 *   mcp__server(*)           -> MCP namespace
 */

export type RuleBehavior = "allow" | "deny" | "ask";
export type RuleSource = "cli" | "session" | "policy" | "local" | "project" | "user";

export interface PermissionRule {
  source: RuleSource;
  ruleBehavior: RuleBehavior;
  ruleValue: { toolName: string; ruleContent?: string };
}

/** Priority: higher wins when two rules of the same behaviour disagree. */
export const SOURCE_PRIORITY: Record<RuleSource, number> = {
  user: 1,
  project: 2,
  local: 3,
  policy: 4,
  session: 5,
  cli: 6,
};

export function parseRule(
  text: string,
  ruleBehavior: RuleBehavior,
  source: RuleSource = "project",
): PermissionRule | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const m = /^([A-Za-z0-9_\-:*]+)\s*(?:\((.*)\))?$/.exec(trimmed);
  if (!m) return null;
  return {
    source,
    ruleBehavior,
    ruleValue: { toolName: m[1], ruleContent: m[2] },
  };
}

export function formatRule(rule: PermissionRule): string {
  const { toolName, ruleContent } = rule.ruleValue;
  return ruleContent === undefined ? toolName : `${toolName}(${ruleContent})`;
}

/** Glob with a single wildcard (`*`) — enough for path and command matching. */
export function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^$`{}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i");
}

export function ruleMatches(rule: PermissionRule, toolName: string, content: string): boolean {
  const rt = rule.ruleValue.toolName;
  if (rt.endsWith("*")) {
    if (!toolName.toLowerCase().startsWith(rt.slice(0, -1).toLowerCase())) return false;
  } else if (rt.toLowerCase() !== toolName.toLowerCase()) {
    // MCP 工具的命名是 mcp__<server>__<tool>：写成 mcp__github(*) 时，
    // 规则里的 toolName 是 mcp__github（命名空间），必须按前缀匹配到整族工具。
    if (rt.toLowerCase().startsWith("mcp__") && toolName.toLowerCase().startsWith(rt.toLowerCase() + "__")) {
      const pattern = rule.ruleValue.ruleContent;
      if (pattern === undefined) return true;
      return globToRegExp(pattern).test(content);
    }
    return false;
  }
  const pattern = rule.ruleValue.ruleContent;
  if (pattern === undefined) return true;
  return globToRegExp(pattern).test(content);
}

export interface RuleSet {
  allow: PermissionRule[];
  deny: PermissionRule[];
  ask: PermissionRule[];
}

export function emptyRuleSet(): RuleSet {
  return { allow: [], deny: [], ask: [] };
}

export function addRules(set: RuleSet, rules: PermissionRule[]): RuleSet {
  for (const r of rules) {
    set[r.ruleBehavior].push(r);
  }
  return set;
}

export interface RuleMatch {
  rule: PermissionRule;
  behavior: RuleBehavior;
}

/**
 * deny > ask > allow at evaluation time. Within a behaviour, the highest
 * priority source wins, and the match is deterministic (rules are pre-sorted).
 */
export function matchRules(
  set: RuleSet,
  toolName: string,
  content: string,
): RuleMatch | null {
  for (const behavior of ["deny", "ask", "allow"] as const) {
    const hits = set[behavior].filter((r) => ruleMatches(r, toolName, content));
    if (hits.length) {
      hits.sort((a, b) => SOURCE_PRIORITY[b.source] - SOURCE_PRIORITY[a.source]);
      return { rule: hits[0], behavior };
    }
  }
  return null;
}

/** Derive the "content" a rule is matched against, per tool family. */
import path from "node:path";

/**
 * 路径类工具的"同一含义的不同写法"：`./secrets/a`、`secrets/a`、`secrets\\a`。
 *
 * 规则是给人写的，写 `secrets/**` 的人不会想到要再加一条 `./secrets/**`。
 * 如果判定只认其中一种写法，拒绝规则就能被换个写法绕过去 —— 这是真实可绕过的口子。
 */
export function contentCandidates(content: string): string[] {
  if (!content) return [];
  const out = new Set<string>();
  out.add(content);
  const normalized = content
    .split(String.fromCharCode(92)).join("/")
    .replace(/^\.\//, "")
    .replace(/\/{2,}/g, "/");
  if (normalized) {
    out.add(normalized);
    out.add("./" + normalized);
  }
  return [...out];
}

export function permissionContentFor(
  toolName: string,
  input: Record<string, unknown>,
  workspaceRoot?: string,
): string {
  const pick = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : "");
  switch (toolName) {
    case "Bash":
    case "PowerShell":
      return pick("command");
    case "Read":
    case "Write":
    case "Edit":
    case "Glob":
    case "Grep": {
      const raw = pick("file_path") || pick("path") || pick("pattern");
      // Users write rules like Read(secrets/*); match those against the path as
      // they see it, not the absolute one.
      if (workspaceRoot && raw && path.isAbsolute(raw)) {
        const rel = path.relative(workspaceRoot, raw);
        if (rel && !rel.startsWith("..")) return rel.split(path.sep).join("/");
      }
      return raw;
    }
    case "Agent":
      return pick("description") || pick("prompt");
    case "WebFetch":
      return pick("url");
    default:
      return pick("command") || pick("file_path") || pick("path") || pick("url") || "";
  }
}

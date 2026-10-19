/** Read/write the workspace settings file (the one users can edit). */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { resolveWorkspaceSettingsPath } from "./configStore.ts";

export interface RuleArrays {
  allow: string[];
  deny: string[];
  ask: string[];
}

export { workspaceSettingsPath, resolveWorkspaceSettingsPath } from "./configStore.ts";

export function readWorkspaceSettings(workspaceRoot: string): Record<string, unknown> {
  const file = resolveWorkspaceSettingsPath(workspaceRoot);
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function readRuleArrays(workspaceRoot: string): RuleArrays {
  const settings = readWorkspaceSettings(workspaceRoot);
  const permissions = (settings.permissions ?? {}) as Partial<RuleArrays>;
  return {
    allow: Array.isArray(permissions.allow) ? permissions.allow.map(String) : [],
    deny: Array.isArray(permissions.deny) ? permissions.deny.map(String) : [],
    ask: Array.isArray(permissions.ask) ? permissions.ask.map(String) : [],
  };
}

/** Merge-write: keeps every other setting in the file intact. */
export function writeRuleArrays(workspaceRoot: string, rules: RuleArrays): RuleArrays {
  const file = resolveWorkspaceSettingsPath(workspaceRoot);
  mkdirSync(path.dirname(file), { recursive: true });
  const settings = readWorkspaceSettings(workspaceRoot);
  const clean = (list: unknown): string[] =>
    Array.isArray(list) ? [...new Set(list.map((s) => String(s).trim()).filter(Boolean))] : [];
  const normalized: RuleArrays = {
    allow: clean(rules.allow),
    deny: clean(rules.deny),
    ask: clean(rules.ask),
  };
  settings.permissions = normalized;
  writeFileSync(file, JSON.stringify(settings, null, 2) + "\n", "utf8");
  return normalized;
}

/** Validate one rule string without importing the whole engine. */
export function isValidRule(text: string): string | null {
  const t = text.trim();
  if (!t) return "rule is empty";
  if (!/^[A-Za-z0-9_\-:*]+\s*(\(.*\))?$/.test(t)) return "expected Tool or Tool(pattern), got: " + t;
  return null;
}

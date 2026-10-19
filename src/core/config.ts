/**
 * Settings hierarchy (ch.9). Lowest priority first:
 *   user (~/.jysharness/settings.json)
 *   -> project (.jysharness/settings.json)
 *   -> local   (.jysharness/settings.local.json, gitignored)
 *   -> CLI flags
 * Permission rules accumulate with their source attached, so the UI can say
 * *which* layer decided.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { PermissionMode } from "../permissions/engine.ts";
import { addRules, emptyRuleSet, parseRule, type RuleSet, type RuleSource } from "../permissions/rules.ts";
import type { SandboxMode } from "../sandbox/paths.ts";
import type { CompactionConfig } from "../context/compaction.ts";
import type { HookDefinition, HookEvent } from "../hooks/hooks.ts";
import { CONFIG_DIR, LEGACY_CONFIG_DIR, configHome } from "./configStore.ts";

export interface HarnessSettings {
  provider?: "openai" | "anthropic" | "mock";
  model?: string;
  apiKeyEnv?: string;
  baseUrl?: string;
  permissionMode?: PermissionMode;
  sandboxMode?: SandboxMode;
  maxTurns?: number;
  maxTokens?: number;
  /** Model context window; 0/undefined = infer from the model name. */
  contextWindow?: number;
  temperature?: number;
  enableSubagent?: boolean;
  permissions?: { allow?: string[]; deny?: string[]; ask?: string[] };
  hooks?: Partial<Record<HookEvent, HookDefinition[]>>;
  compaction?: Partial<CompactionConfig>;
  /** MCP servers to spawn over stdio. Tools appear as mcp__<server>__<tool>. */
  mcpServers?: Record<
    string,
    { command: string; args?: string[]; env?: Record<string, string>; cwd?: string }
  >;
}

export interface LoadedSettings {
  settings: HarnessSettings;
  rules: RuleSet;
  sources: string[];
}

function readJson(abs: string): HarnessSettings | null {
  if (!existsSync(abs)) return null;
  try {
    return JSON.parse(readFileSync(abs, "utf8")) as HarnessSettings;
  } catch (e) {
    throw new Error("invalid settings JSON at " + abs + ": " + (e instanceof Error ? e.message : e));
  }
}

export function settingsPaths(workspaceRoot: string): { abs: string; source: RuleSource }[] {
  const project = path.join(workspaceRoot, CONFIG_DIR, "settings.json");
  const legacyProject = path.join(workspaceRoot, LEGACY_CONFIG_DIR, "settings.json");
  return [
    { abs: path.join(configHome(), "settings.json"), source: "user" },
    // Pre-rename project files keep working until the new one is written.
    { abs: existsSync(project) || !existsSync(legacyProject) ? project : legacyProject, source: "project" },
    { abs: path.join(workspaceRoot, CONFIG_DIR, "settings.local.json"), source: "local" },
  ];
}

export function loadSettings(workspaceRoot: string, cliOverrides: HarnessSettings = {}): LoadedSettings {
  const rules = emptyRuleSet();
  const sources: string[] = [];
  let merged: HarnessSettings = {};

  for (const { abs, source } of settingsPaths(workspaceRoot)) {
    const s = readJson(abs);
    if (!s) continue;
    sources.push(abs);
    merged = {
      ...merged,
      ...s,
      permissions: {
        allow: [...(merged.permissions?.allow ?? []), ...(s.permissions?.allow ?? [])],
        deny: [...(merged.permissions?.deny ?? []), ...(s.permissions?.deny ?? [])],
        ask: [...(merged.permissions?.ask ?? []), ...(s.permissions?.ask ?? [])],
      },
      hooks: mergeHooks(merged.hooks, s.hooks),
    };
    for (const behavior of ["allow", "deny", "ask"] as const) {
      for (const text of s.permissions?.[behavior] ?? []) {
        const rule = parseRule(text, behavior, source);
        if (rule) addRules(rules, [rule]);
      }
    }
  }

  const final: HarnessSettings = { ...merged, ...cliOverrides };
  // CLI overrides are highest priority: "-" prefixed entries cannot remove
  // rules, but they are appended last so they win ties within a behaviour.
  for (const behavior of ["allow", "deny", "ask"] as const) {
    for (const text of cliOverrides.permissions?.[behavior] ?? []) {
      const rule = parseRule(text, behavior, "cli");
      if (rule) addRules(rules, [rule]);
    }
  }
  if (cliOverrides.permissions) sources.push("<cli>");

  return { settings: final, rules, sources };
}

function mergeHooks(
  a: Partial<Record<HookEvent, HookDefinition[]>> | undefined,
  b: Partial<Record<HookEvent, HookDefinition[]>> | undefined,
): Partial<Record<HookEvent, HookDefinition[]>> {
  const out: Partial<Record<HookEvent, HookDefinition[]>> = { ...(a ?? {}) };
  for (const [event, defs] of Object.entries(b ?? {}) as [HookEvent, HookDefinition[]][]) {
    out[event] = [...(out[event] ?? []), ...defs];
  }
  return out;
}

export function defaultSettings(): HarnessSettings {
  return {
    provider: "anthropic",
    model: process.env.HARNESS_MODEL ?? "claude-sonnet-4-5",
    permissionMode: "default",
    sandboxMode: "workspace-write",
    maxTurns: 60,
    maxTokens: 8192,
    temperature: 0.2,
    enableSubagent: true,
  };
}

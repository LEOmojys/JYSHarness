/**
 * Plugin contract. A plugin is a folder with plugin.json + an entry module
 * whose activate(api) registers project-specific behavior.
 */
import type { Tool } from "../tools/types.ts";
import type { HookEvent, HookDefinition, HookPayload, HookResult } from "../hooks/hooks.ts";

export interface PluginManifest {
  name: string;
  version?: string;
  description?: string;
  /** Entry module relative to the plugin folder. Default: index.ts / index.mjs / index.js */
  entry?: string;
  /** Optional folder with SKILL.md entries contributed by this plugin. */
  skills?: string;
  /** Default true; false keeps the plugin on disk but inactive. */
  enabled?: boolean;
}

export type PluginHookHandler = (payload: HookPayload) => HookResult | void | Promise<HookResult | void>;

export interface SkillContribution {
  name: string;
  description: string;
  content: string;
}

/** The object handed to activate(): everything a project workflow needs. */
export interface PluginApi {
  readonly name: string;
  readonly version: string;
  readonly workspaceRoot: string;
  /** Log a line to harness stderr (visible in serve/desktop console). */
  log(message: string): void;
  /** Add a tool the model can call, exactly like a built-in tool. */
  registerTool(tool: Tool): void;
  /** Stable text appended to the system prompt (project conventions). */
  addPromptSection(text: string): void;
  /** In-process hook: runs before/after tools, no shell process needed. */
  on(event: HookEvent, handler: PluginHookHandler): void;
  /** In-memory skill (no files needed). */
  addSkill(skill: SkillContribution): void;
}

export interface LoadedPlugin {
  name: string;
  version: string;
  dir: string;
  source: "project" | "user";
  tools: number;
  skills: number;
  hooks: number;
}

export interface PluginLoadResult {
  plugins: LoadedPlugin[];
  tools: Tool[];
  skills: SkillContribution[];
  promptSections: string[];
  hooks: Partial<Record<HookEvent, HookDefinition[]>>;
  errors: { plugin: string; message: string }[];
}

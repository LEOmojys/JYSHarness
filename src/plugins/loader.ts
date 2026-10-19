/**
 * Plugin loader: discover `<ws>/.harness/plugins/*` and `~/.jysharness/plugins/*`,
 * import each entry with Node's native TS support and collect what it registers.
 *
 * Failures are isolated per plugin: a broken plugin never blocks a session.
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { configHome } from "../core/configStore.ts";
import { pathToFileURL } from "node:url";
import type { HookDefinition, HookEvent, HookPayload, HookResult } from "../hooks/hooks.ts";
import { parseFrontmatter } from "../core/skills.ts";
import type { Tool } from "../tools/types.ts";
import type { Logger } from "../util/log.ts";
import type {
  LoadedPlugin,
  PluginApi,
  PluginHookHandler,
  PluginLoadResult,
  PluginManifest,
  SkillContribution,
} from "./types.ts";

const HOOK_EVENTS: HookEvent[] = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"];
const ENTRY_CANDIDATES = ["index.ts", "index.mjs", "index.js"];

export interface DiscoveredPlugin {
  dir: string;
  manifestPath: string;
  source: "project" | "user";
}

export function pluginRoots(workspaceRoot: string): { dir: string; source: "project" | "user" }[] {
  return [
    { dir: path.join(workspaceRoot, ".harness", "plugins"), source: "project" },
    // configHome() honours HARNESS_HOME, so portable installs and tests agree.
    { dir: path.join(configHome(), "plugins"), source: "user" },
  ];
}

export function discoverPlugins(workspaceRoot: string): DiscoveredPlugin[] {
  const found: DiscoveredPlugin[] = [];
  const seen = new Set<string>();
  for (const { dir, source } of pluginRoots(workspaceRoot)) {
    if (!existsSync(dir)) continue;
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const pluginDir = path.join(dir, entry);
      const manifestPath = path.join(pluginDir, "plugin.json");
      if (!existsSync(manifestPath)) continue;
      if (seen.has(pluginDir)) continue;
      seen.add(pluginDir);
      found.push({ dir: pluginDir, manifestPath, source });
    }
  }
  return found.sort((a, b) => a.manifestPath.localeCompare(b.manifestPath));
}

export interface PluginInfo {
  name: string;
  version: string;
  dir: string;
  source: "project" | "user";
  enabled: boolean;
  entry: string;
  error?: string;
}

/** Every plugin on disk, including disabled and broken ones (settings UI). */
export function inspectPlugins(workspaceRoot: string): PluginInfo[] {
  const out: PluginInfo[] = [];
  for (const discovered of discoverPlugins(workspaceRoot)) {
    const fallback = path.basename(discovered.dir);
    try {
      const manifest = readManifest(discovered.manifestPath);
      let entry = manifest.entry ?? "";
      try {
        entry = path.basename(resolveEntry(discovered.dir, manifest));
      } catch {
        /* keep the raw value: the error shows up when loading */
      }
      out.push({
        name: manifest.name || fallback,
        version: manifest.version ?? "0.0.0",
        dir: discovered.dir,
        source: discovered.source,
        enabled: manifest.enabled !== false,
        entry,
      });
    } catch (err) {
      out.push({
        name: fallback,
        version: "?",
        dir: discovered.dir,
        source: discovered.source,
        enabled: false,
        entry: "",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return out;
}

/** Flip "enabled" in plugin.json without touching anything else. */
export function setPluginEnabled(dir: string, enabled: boolean): void {
  const manifestPath = path.join(dir, "plugin.json");
  const raw = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
  raw.enabled = enabled;
  writeFileSync(manifestPath, JSON.stringify(raw, null, 2) + "\n", "utf8");
}

export function readManifest(manifestPath: string): PluginManifest {
  const raw = readFileSync(manifestPath, "utf8");
  const parsed = JSON.parse(raw) as PluginManifest;
  if (!parsed || typeof parsed !== "object") throw new Error("plugin.json must be an object");
  if (!parsed.name || !/^[a-zA-Z0-9._-]+$/.test(parsed.name)) {
    throw new Error("plugin.json needs a name matching [a-zA-Z0-9._-]");
  }
  return parsed;
}

/** The entry must live inside the plugin folder; no ../ escapes. */
export function resolveEntry(pluginDir: string, manifest: PluginManifest): string {
  const candidates = manifest.entry ? [manifest.entry] : ENTRY_CANDIDATES;
  for (const candidate of candidates) {
    const abs = path.resolve(pluginDir, candidate);
    const rel = path.relative(pluginDir, abs);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error("entry escapes the plugin folder: " + candidate);
    }
    if (existsSync(abs) && statSync(abs).isFile()) return abs;
  }
  throw new Error("no entry module found (looked for " + candidates.join(", ") + ")");
}

function readPluginSkills(pluginDir: string, skillsRel: string): SkillContribution[] {
  const root = path.resolve(pluginDir, skillsRel);
  const rel = path.relative(pluginDir, root);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return [];
  if (!existsSync(root)) return [];
  const out: SkillContribution[] = [];
  const files: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 3) return;
    for (const name of readdirSync(dir)) {
      const abs = path.join(dir, name);
      if (statSync(abs).isDirectory()) walk(abs, depth + 1);
      else if (name.toLowerCase().endsWith(".md")) files.push(abs);
    }
  };
  try {
    walk(root, 0);
  } catch {
    return [];
  }
  for (const file of files) {
    try {
      const text = readFileSync(file, "utf8");
      const meta = parseFrontmatter(text);
      const name = (meta.name ?? path.basename(file, ".md")).trim();
      if (!name) continue;
      out.push({ name, description: (meta.description ?? "").trim(), content: text });
    } catch {
      /* unreadable skill file: skip */
    }
  }
  return out;
}

function mergeHook(
  target: Partial<Record<HookEvent, HookDefinition[]>>,
  event: HookEvent,
  def: HookDefinition,
): void {
  const list = target[event] ?? (target[event] = []);
  list.push(def);
}

export async function loadPlugins(workspaceRoot: string, logger: Logger): Promise<PluginLoadResult> {
  const result: PluginLoadResult = { plugins: [], tools: [], skills: [], promptSections: [], hooks: {}, errors: [] };

  for (const discovered of discoverPlugins(workspaceRoot)) {
    const label = path.basename(discovered.dir);
    let manifest: PluginManifest;
    try {
      manifest = readManifest(discovered.manifestPath);
    } catch (err) {
      result.errors.push({ plugin: label, message: err instanceof Error ? err.message : String(err) });
      continue;
    }
    if (manifest.enabled === false) continue;

    const tools: Tool[] = [];
    const skills: SkillContribution[] = [];
    const sections: string[] = [];
    const hooks: { event: HookEvent; handler: PluginHookHandler }[] = [];
    const warnings: string[] = [];

    const api: PluginApi = {
      name: manifest.name,
      version: manifest.version ?? "0.0.0",
      workspaceRoot,
      log: (message: string) => logger.info("[" + manifest.name + "] " + message),
      registerTool: (tool) => {
        if (!tool || typeof tool.name !== "string" || typeof tool.call !== "function") {
          warnings.push("registerTool got an invalid tool object");
          return;
        }
        if (tools.some((t) => t.name === tool.name)) {
          warnings.push("duplicate tool name: " + tool.name);
          return;
        }
        tools.push(tool);
      },
      addPromptSection: (text) => {
        if (typeof text === "string" && text.trim()) sections.push(text.trim());
      },
      on: (event, handler) => {
        if (!HOOK_EVENTS.includes(event)) {
          warnings.push("unknown hook event: " + String(event));
          return;
        }
        if (typeof handler !== "function") {
          warnings.push("hook handler for " + event + " is not a function");
          return;
        }
        hooks.push({ event, handler });
      },
      addSkill: (skill) => {
        if (!skill?.name || !skill?.content) {
          warnings.push("addSkill needs name and content");
          return;
        }
        skills.push({ name: skill.name, description: skill.description ?? "", content: skill.content });
      },
    };

    try {
      const entry = resolveEntry(discovered.dir, manifest);
      // Node caches ESM by URL forever; a reload must bust it or the old code wins.
      const stamp = Math.floor(statSync(entry).mtimeMs).toString(36);
      const url = pathToFileURL(entry).href + "?v=" + stamp + "-" + Math.random().toString(36).slice(2, 7);
      const mod = (await import(url)) as { activate?: unknown; default?: unknown };
      const activate = (mod.activate ?? mod.default) as ((a: PluginApi) => unknown) | undefined;
      if (typeof activate !== "function") {
        throw new Error("entry must export activate(api) (or a default function)");
      }
      await activate(api);
    } catch (err) {
      result.errors.push({ plugin: label, message: err instanceof Error ? err.message : String(err) });
      continue;
    }

    for (const warning of warnings) logger.warn("plugin " + label + ": " + warning);

    if (manifest.skills) {
      for (const skill of readPluginSkills(discovered.dir, manifest.skills)) {
        if (!skills.some((s) => s.name === skill.name)) skills.push(skill);
      }
    }

    for (const hook of hooks) {
      mergeHook(result.hooks, hook.event, {
        handler: async (payload: HookPayload): Promise<HookResult> => {
          const out = await hook.handler(payload);
          return (out ?? {}) as HookResult;
        },
      });
    }

    result.tools.push(...tools);
    result.skills.push(...skills);
    result.promptSections.push(...sections);
    result.plugins.push({
      name: manifest.name,
      version: manifest.version ?? "0.0.0",
      dir: discovered.dir,
      source: discovered.source,
      tools: tools.length,
      skills: skills.length,
      hooks: hooks.length,
    });
  }

  return result;
}


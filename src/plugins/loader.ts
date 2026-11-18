/**
 * Plugin loader: discover `<ws>/.harness/plugins/*` and `~/.jysharness/plugins/*`,
 * import each entry with Node's native TS support and collect what it registers.
 *
 * Failures are isolated per plugin: a broken plugin never blocks a session.
 */
import { existsSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { configHome } from "../core/configStore.ts";
import { pathToFileURL } from "node:url";
import { HOOK_EVENTS, type HookDefinition, type HookEvent, type HookPayload, type HookResult } from "../hooks/hooks.ts";
import { parseFrontmatter } from "../core/skills.ts";
import { CAPABILITY_BY_KIND, checkCompat, hasPermission, isPluginName } from "./compat.ts";
import { isInside } from "../sandbox/paths.ts";
import { hostFor, type PluginHost } from "./host/client.ts";
import { findCordisPlugin, runCordisPlugin } from "./cordis.ts";
import type { Tool } from "../tools/types.ts";
import type { Logger } from "../util/log.ts";
import type {
  PluginApi,
  PluginCommand,
  PluginHookHandler,
  PluginLoadResult,
  PluginManifest,
  PluginPanel,
  PluginRoute,
  SkillContribution,
} from "./types.ts";

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
  const manifestPath = checkedManifestPath(path.join(dir, "plugin.json"));
  const manifest = readManifest(manifestPath);
  writeFileSync(manifestPath, JSON.stringify({ ...manifest, enabled }, null, 2) + "\n", "utf8");
}

function checkedManifestPath(file: string): string {
  const resolved = realpathSync.native(file);
  if (!isInside(realpathSync.native(path.dirname(file)), resolved)) {
    throw new Error("plugin.json escapes the plugin folder");
  }
  return resolved;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateManifest(value: unknown): asserts value is PluginManifest {
  if (!isRecord(value)) throw new Error("plugin.json must be an object");
  if (!isPluginName(value.name)) throw new Error("plugin.json needs a valid plugin name");
  for (const field of ["version", "description", "entry", "skills", "ui", "id"]) {
    if (value[field] !== undefined && typeof value[field] !== "string") {
      throw new Error("plugin.json " + field + " must be a string");
    }
  }
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") throw new Error("plugin.json enabled must be boolean");
  if (value.isolation !== undefined && value.isolation !== "process" && value.isolation !== "in-process") {
    throw new Error("invalid plugin.json isolation mode");
  }
  for (const field of ["engines", "dependencies"]) {
    const ranges = value[field];
    if (ranges !== undefined && (!isRecord(ranges) || !Object.values(ranges).every((v) => typeof v === "string"))) {
      throw new Error("plugin.json " + field + " must map names to version ranges");
    }
  }
  if (value.contributes !== undefined) {
    if (!isRecord(value.contributes)) throw new Error("plugin.json contributes must be an object");
    const permissions = value.contributes.permissions;
    if (permissions !== undefined && (!Array.isArray(permissions) || !permissions.every((p) => typeof p === "string"))) {
      throw new Error("plugin.json permissions must be an array of strings");
    }
  }
  if (value.panels !== undefined && (!Array.isArray(value.panels) || !value.panels.every((panel: unknown) =>
    isRecord(panel) && typeof panel.id === "string" && typeof panel.title === "string" &&
    (panel.icon === undefined || typeof panel.icon === "string") &&
    (panel.slot === undefined || typeof panel.slot === "string") &&
    (panel.order === undefined || typeof panel.order === "number")))) {
    throw new Error("invalid plugin.json panels");
  }
}

export function readManifest(manifestPath: string): PluginManifest {
  const parsed: unknown = JSON.parse(readFileSync(checkedManifestPath(manifestPath), "utf8"));
  validateManifest(parsed);
  return parsed;
}

/** The entry must live inside the plugin folder; no ../ escapes. */
export function resolveEntry(pluginDir: string, manifest: PluginManifest): string {
  const candidates = manifest.entry ? [manifest.entry] : ENTRY_CANDIDATES;
  for (const candidate of candidates) {
    const abs = path.resolve(pluginDir, candidate);
    if (!isInside(pluginDir, abs)) {
      throw new Error("entry escapes the plugin folder: " + candidate);
    }
    if (existsSync(abs)) {
      const real = realpathSync.native(abs);
      if (!isInside(realpathSync.native(pluginDir), real)) throw new Error("entry escapes the plugin folder: " + candidate);
      if (statSync(real).isFile()) return real;
    }
  }
  throw new Error("no entry module found (looked for " + candidates.join(", ") + ")");
}

function readPluginSkills(pluginDir: string, skillsRel: string): SkillContribution[] {
  const root = path.resolve(pluginDir, skillsRel);
  if (!isInside(pluginDir, root)) return [];
  if (!existsSync(root)) return [];
  const out: SkillContribution[] = [];
  const files: string[] = [];
  const pluginRoot = realpathSync.native(pluginDir);
  const walk = (dir: string, depth: number) => {
    if (depth > 3) return;
    for (const name of readdirSync(dir)) {
      const abs = realpathSync.native(path.join(dir, name));
      if (!isInside(pluginRoot, abs)) continue;
      if (statSync(abs).isDirectory()) walk(abs, depth + 1);
      else if (name.toLowerCase().endsWith(".md")) files.push(abs);
    }
  };
  try {
    const resolvedRoot = realpathSync.native(root);
    if (isInside(pluginRoot, resolvedRoot)) walk(resolvedRoot, 0);
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

function pluginUiDir(pluginDir: string, ui = "ui"): string | null {
  const dir = path.resolve(pluginDir, ui);
  if (!isInside(pluginDir, dir) || !existsSync(dir)) return null;
  const resolved = realpathSync.native(dir);
  return isInside(realpathSync.native(pluginDir), resolved) && statSync(resolved).isDirectory() ? dir : null;
}

function mergeHook(
  target: Partial<Record<HookEvent, HookDefinition[]>>,
  event: HookEvent,
  def: HookDefinition,
): void {
  const list = target[event] ?? (target[event] = []);
  list.push(def);
}

export interface LoadOptions {
  /** 只加载这些目录（插件宿主子进程用它把单个插件搬过去） */
  onlyDirs?: string[];
  /**
   * 强制在**本进程**加载（不再为 isolation=process 的插件拉起宿主）。
   * 子进程自己调用 loadPlugins 时必须传 true，否则会无限递归拉起子进程。
   */
  forceInProcess?: boolean;
}

export async function loadPlugins(workspaceRoot: string, logger: Logger, opts: LoadOptions = {}): Promise<PluginLoadResult> {
  const result: PluginLoadResult = {
    plugins: [],
    tools: [],
    skills: [],
    promptSections: [],
    hooks: {},
    errors: [],
    runtimes: [],
    warnings: [],
  };

  // 读取 enabled manifests 并建立依赖图。依赖插件必须先成功加载，才能成为后续插件的 available。
  const discoveredAll = discoverPlugins(workspaceRoot);
  const manifestByDir = new Map<string, PluginManifest>();
  const discoveredByName = new Map<string, (typeof discoveredAll)[number]>();
  const installedNames = new Map<string, string>();
  const idOwners = new Map<string, string[]>();
  for (const d of discoveredAll) {
    try {
      const m = readManifest(d.manifestPath);
      if (m.enabled === false) continue;
      manifestByDir.set(d.dir, m);
      discoveredByName.set(m.name, d);
      installedNames.set(m.name, m.version ?? "0.0.0");
      const id = (m.id ?? path.basename(d.dir)).trim();
      if (!isPluginName(id)) continue;
      const key = id.toLowerCase();
      idOwners.set(key, [...(idOwners.get(key) ?? []), path.basename(d.dir)]);
    } catch {
      /* 坏清单留给下面报错 */
    }
  }
  const duplicateIds = new Map([...idOwners].filter(([, owners]) => owners.length > 1));
  const loadOrder: (typeof discoveredAll)[number][] = [];
  const visitState = new Map<string, 0 | 1 | 2>();
  const visitStack: string[] = [];
  const cyclicNames = new Set<string>();
  const visit = (name: string): void => {
    const state = visitState.get(name) ?? 0;
    if (state === 2) return;
    if (state === 1) {
      const at = visitStack.indexOf(name);
      for (const cycleName of visitStack.slice(Math.max(0, at))) cyclicNames.add(cycleName);
      cyclicNames.add(name);
      return;
    }
    const discovered = discoveredByName.get(name);
    if (!discovered) return;
    const manifest = manifestByDir.get(discovered.dir);
    if (!manifest) return;
    visitState.set(name, 1);
    visitStack.push(name);
    for (const dep of Object.keys(manifest.dependencies ?? {})) {
      if (discoveredByName.has(dep)) visit(dep);
    }
    visitStack.pop();
    visitState.set(name, 2);
    loadOrder.push(discovered);
  };
  for (const name of discoveredByName.keys()) visit(name);
  const invalidManifests = discoveredAll.filter((d) => !manifestByDir.has(d.dir));
  loadOrder.push(...invalidManifests);
  const successfullyLoaded = new Map<string, string>();

  for (const discovered of loadOrder) {
    if (opts.onlyDirs && !opts.onlyDirs.some((dir) => path.relative(dir, discovered.dir) === "")) continue;
    const label = path.basename(discovered.dir);
    let manifest: PluginManifest;
    try {
      manifest = readManifest(discovered.manifestPath);
    } catch (err) {
      result.errors.push({ plugin: label, message: err instanceof Error ? err.message : String(err) });
      continue;
    }
    if (manifest.enabled === false) continue;
    if (cyclicNames.has(manifest.name)) {
      result.errors.push({ plugin: label, message: "依赖关系形成循环：" + manifest.name });
      continue;
    }
    const pluginId = (manifest.id ?? label).trim();
    if (!isPluginName(pluginId)) {
      result.errors.push({ plugin: label, message: "plugin.json id must be a valid single path segment" });
      continue;
    }
    const idKey = pluginId.toLowerCase();
    const owners = duplicateIds.get(idKey);
    if (owners) {
      result.errors.push({ plugin: label, message: "duplicate plugin id '" + pluginId + "' shared by: " + owners.join(", ") });
      continue;
    }

    // 兼容性/依赖：明确报错而不是"加载了但行为怪"
    // process host 内只加载单个隔离插件，依赖兼容性由父侧加载顺序预检；普通加载只承认成功进入 runtime 的依赖。
    const availableForCheck = opts.onlyDirs ? installedNames : successfullyLoaded;
    const compat = checkCompat(manifest, availableForCheck);
    const fatal = compat.filter((i) => i.severity === "error");
    if (fatal.length) {
      result.errors.push({ plugin: label, message: "兼容性校验失败：" + fatal.map((i) => i.message).join("；") });
      continue;
    }
    for (const issue of compat) result.warnings.push({ plugin: label, message: issue.message });

    // ---- 进程隔离：不 import 插件入口，交给宿主子进程 ----
    // 必须在 resolveEntry/import 之前分流，否则插件代码仍在父进程执行，隔离形同虚设。
    if (manifest.isolation === "process" && !opts.forceInProcess) {
      await loadInHost(discovered.dir, workspaceRoot, manifest, logger, result, discovered.source);
      if (result.plugins.some((plugin) => plugin.dir === discovered.dir)) {
        successfullyLoaded.set(manifest.name, manifest.version ?? "0.0.0");
      }
      continue;
    }

    const tools: Tool[] = [];
    const skills: SkillContribution[] = [];
    const sections: string[] = [];
    const hooks: { event: HookEvent; handler: PluginHookHandler }[] = [];
    const permissions = manifest.contributes?.permissions;
    const routes: PluginRoute[] = [];
    const panels: PluginPanel[] = [];
    const commands: PluginCommand[] = [];
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
      registerRoute: (route) => {
        // 能力声明强制：没在 contributes.permissions 里写 http-route 的插件不许开路由。
        // 声明本身不是安全边界（插件仍在同进程），但它把"这个插件对外开了接口"变成
        // 可审计的事实 —— 安装前能看见，而不是运行后才发现。
        if (!hasPermission(permissions, CAPABILITY_BY_KIND.route)) {
          warnings.push("拒绝注册路由 " + String(route?.path ?? "?") + "：未声明 contributes.permissions 含 \"http-route\"");
          return;
        }
        if (!route || typeof route.handler !== "function") {
          warnings.push("registerRoute needs a handler function");
          return;
        }
        const method = route.method === "POST" ? "POST" : "GET";
        const clean = String(route.path ?? "").trim().replace(/^\/+/, "");
        if (!clean) {
          warnings.push("registerRoute needs a path");
          return;
        }
        if (routes.some((r) => r.method === method && r.path === clean)) {
          warnings.push("duplicate route: " + method + " " + clean);
          return;
        }
        routes.push({ method, path: clean, handler: route.handler });
      },
      registerPanel: (panel) => {
        if (!hasPermission(permissions, CAPABILITY_BY_KIND.panel)) {
          warnings.push("拒绝注册面板 " + String(panel?.id ?? "?") + "：未声明 contributes.permissions 含 \"ui-panel\"");
          return;
        }
        if (!panel?.id || !panel?.title) {
          warnings.push("registerPanel needs id and title");
          return;
        }
        if (panels.some((p) => p.id === panel.id)) {
          warnings.push("duplicate panel id: " + panel.id);
          return;
        }
        panels.push({ id: panel.id, title: panel.title, icon: panel.icon, slot: panel.slot ?? "sidebar", order: panel.order });
      },
      registerCommand: (command) => {
        if (!command?.name || typeof command.run !== "function") {
          warnings.push("registerCommand needs name and run()");
          return;
        }
        if (!command.name.startsWith("/")) warnings.push("command name 建议以 / 开头: " + command.name);
        commands.push(command);
      },
    };

    try {
      const entry = resolveEntry(discovered.dir, manifest);
      // Node caches ESM by URL forever; a reload must bust it or the old code wins.
      const stamp = Math.floor(statSync(entry).mtimeMs).toString(36);
      const url = pathToFileURL(entry).href + "?v=" + stamp + "-" + Math.random().toString(36).slice(2, 7);
      const mod = (await import(url)) as Record<string, unknown>;
      const activate = (mod.activate ?? mod.default) as ((a: PluginApi) => unknown) | undefined;
      if (typeof activate === "function") {
        await activate(api);
      } else {
        // 不是我们的 activate(api) —— 试一次 Cordis 插件（DSH 格式：{ apply(ctx), inject }）
        const cordis = findCordisPlugin(mod);
        if (!cordis) throw new Error("entry must export activate(api) 或 Cordis 的 apply(ctx) 插件对象");
        const outcome = runCordisPlugin(cordis, label, api, (m) => warnings.push(m));
        if (!outcome.ok) throw new Error(outcome.reason ?? "Cordis 插件加载失败");
        logger.info("plugin " + label + ": 以 Cordis 兼容模式加载");
      }
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
    for (const warning of warnings) result.warnings.push({ plugin: label, message: warning });

    // v2：把路由/面板/命令/UI 资产目录收进运行时表，供服务端挂载
    const uiDir = pluginUiDir(discovered.dir, manifest.ui);
    if (routes.length || panels.length || commands.length || uiDir || tools.length || skills.length || hooks.length || sections.length) {
      result.runtimes.push({
        pluginDir: discovered.dir,
        pluginId,
        routes,
        panels,
        commands,
        uiDir,
        tools,
        hooks,
        skills,
        promptSections: sections,
      });
    }

    result.plugins.push({
      name: manifest.name,
      version: manifest.version ?? "0.0.0",
      dir: discovered.dir,
      source: discovered.source,
      tools: tools.length,
      skills: skills.length,
      hooks: hooks.length,
    });
    successfullyLoaded.set(manifest.name, manifest.version ?? "0.0.0");
  }

  // 命令名冲突检测：/deploy 这种名字如果两个插件都注册，先加载的那个会静默生效，
  // 用户只会觉得"某个插件的命令没反应"。所以显式报出来。
  const commandOwner = new Map<string, string>();
  for (const rt of result.runtimes) {
    for (const cmd of rt.commands) {
      const name = cmd.name.startsWith("/") ? cmd.name : "/" + cmd.name;
      const prev = commandOwner.get(name);
      if (prev && prev !== rt.pluginId) {
        result.warnings.push({
          plugin: rt.pluginId,
          message: "命令 " + name + " 与插件 " + prev + " 重名，实际生效的是先加载的那个",
        });
      } else {
        commandOwner.set(name, rt.pluginId);
      }
    }
  }

  return result;
}

/**
 * 进程隔离路径：为单个插件拉起宿主子进程，把它的贡献并进总结果。
 *
 * 合并的东西必须和"本进程加载"完全同构（tools/routes/commands/panels/hooks/skills/sections），
 * 否则上层（Session、HTTP 服务）就得区分两种插件 —— 那是最容易出 bug 的地方。
 */
async function loadInHost(
  pluginDir: string,
  workspaceRoot: string,
  manifest: PluginManifest,
  logger: Logger,
  result: PluginLoadResult,
  source: "project" | "user",
): Promise<void> {
  const label = path.basename(pluginDir);
  const onLog = (level: string, message: string) => {
    if (!message) return;
    if (level === "error") logger.warn("[plugin:" + label + "] " + message);
    else logger.info("[plugin:" + label + "] " + message);
  };

  let contributions: Awaited<ReturnType<PluginHost["start"]>>;
  try {
    contributions = await hostFor(pluginDir, workspaceRoot, onLog).start();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    result.errors.push({ plugin: label, message: "进程隔离宿主启动失败：" + msg });
    return;
  }

  if (contributions.descriptors.length === 0 && contributions.errors.length) {
    for (const e of contributions.errors) result.errors.push({ plugin: label, message: e.message });
    return;
  }

  const pluginId = (manifest.id ?? label).trim();
  result.tools.push(...contributions.tools);
  result.skills.push(...contributions.skills);
  result.promptSections.push(...contributions.promptSections);
  result.warnings.push(...contributions.warnings.map((w) => ({ plugin: label, message: w.message })));

  for (const hook of contributions.hooks) {
    mergeHook(result.hooks, hook.event as HookEvent, {
      handler: async (payload: HookPayload): Promise<HookResult> => {
        const out = await hook.handler(payload);
        return (out ?? {}) as HookResult;
      },
    });
  }

  result.runtimes.push({
    pluginDir,
    pluginId,
    routes: contributions.routes,
    panels: contributions.panels,
    commands: contributions.commands,
    uiDir: pluginUiDir(pluginDir, manifest.ui),
    // 工具/hook 的真实函数在子进程里，父进程只持有代理：
    // 这里放代理对象，保证"runtime 里能拿到本插件工具"的语义不变。
    tools: contributions.tools,
    hooks: contributions.hooks.map((h) => ({ event: h.event as HookEvent, handler: h.handler as unknown as PluginHookHandler })),
    skills: contributions.skills,
    promptSections: contributions.promptSections,
  });

  result.plugins.push({
    name: manifest.name,
    version: manifest.version ?? "0.0.0",
    dir: pluginDir,
    source,
    tools: contributions.tools.length,
    skills: contributions.skills.length,
    hooks: contributions.hooks.length,
  });
}


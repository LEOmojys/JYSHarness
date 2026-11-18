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
  /** Optional folder with browser-side assets (entry: index.js) for UI panels. */
  ui?: string;
  /** 稳定标识；缺省用目录名。插件路由与资产路径都以它为准。 */
  id?: string;
  /** 兼容声明，例如 { harness: ">=0.2" } */
  engines?: Record<string, string>;
  /** 插件声明需要的能力（仅展示/审计；不做强制） */
  contributes?: { permissions?: string[] };
  // 注：上面这个内联类型原来是个独立 interface（PluginContributions），
  // 但只有这一处用，抽出去反而变成 dead export，所以内联回来。
  /** 声明式 UI 面板：UI 首屏就要展示，不能等 activate() 跑完才知道 */
  panels?: PluginPanel[];
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
  // ---- v2：让插件能贡献"新的能力面"而不只是钩进已有管线 ----
  /** 注册一个 HTTP 路由：实际路径 /plugin/<id>/<path>。 */
  registerRoute(route: PluginRoute): void;
  /** 注册一个 Web UI 面板（浏览器侧资产放清单的 ui 目录，入口 index.js）。 */
  registerPanel(panel: PluginPanel): void;
  /** 注册一个斜杠命令（REPL 与 Web 都能用）。 */
  registerCommand(command: PluginCommand): void;
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
  /** v2：每个插件的运行时贡献（路由/面板/命令/UI 资产目录） */
  runtimes: PluginRuntime[];
  /** 加载期告警（重名工具、无效注册等），以前只写进日志 */
  warnings: { plugin: string; message: string }[];
}

// ---------------------------------------------------------------- v2：可安装的能力面

/**
 * 插件声明自己贡献什么（对照 DSH 的 "Everything is a Plugin"）。
 *
 * 与 v1 的区别：v1 只能"钩进已有管线"（工具/hook/技能/提示词）；v2 让插件能声明
 * **新的能力面**：HTTP 路由、Web UI 面板、自定义斜杠命令。一个插件因此可以是一个
 * "可安装的服务 + 界面模块"，而不只是给内核加个工具。
 */
/** 插件声明的能力需求（仅展示/审计，不做强制） */

// 说明：id / engines / contributes / panels 这些 v2 字段都直接挂在 PluginManifest 上，
// 不另做 V2 子类型 —— 子类型只在需要区分新旧时才值得存在，这里并不需要。

export interface PluginRoute {
  /** 相对插件命名空间的路由：实际路径为 /plugin/<id>/<path> */
  method: "GET" | "POST";
  path: string;
  handler: (ctx: PluginRequestContext) => Promise<PluginRouteResponse> | PluginRouteResponse;
}

export interface PluginRequestContext {
  pluginId: string;
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
  workspaceRoot: string;
}

export interface PluginRouteResponse {
  status?: number;
  /** 直接返回的对象会被序列化成 JSON */
  json?: unknown;
  text?: string;
}

/**
 * Web UI 面板：插件提供一段浏览器侧 JS，宿主把它挂到侧栏 slot。
 *
 * 资产目录由清单的 `ui` 字段指定（默认 `ui/`），入口固定为 `index.js`。
 * 加载方式：宿主用动态 import() 拉 /plugin-assets/<id>/index.js，调用它导出的 mount(el, api)。
 */
export interface PluginPanel {
  /** 面板 id（同插件内唯一） */
  id: string;
  title: string;
  /** 图标字符（可选，单字符/emoji） */
  icon?: string;
  /** 挂载点：目前支持 sidebar（侧栏面板） */
  slot?: "sidebar";
}

export interface PluginCommand {
  name: string;
  description: string;
  run: (args: string, ctx: { workspaceRoot: string }) => Promise<string> | string;
}

export interface PluginRuntime {
  pluginId: string;
  routes: PluginRoute[];
  panels: PluginPanel[];
  commands: PluginCommand[];
  /** 静态资产根目录（绝对路径），null 表示这个插件没有 UI 资产 */
  uiDir: string | null;
}

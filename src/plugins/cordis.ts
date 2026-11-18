/**
 * Cordis（DSH 的插件框架）适配层。
 *
 * 为什么需要：DSH 的插件不是 activate(api)，而是 Cordis 的插件对象
 * —— 一个带 apply(ctx, config) 的对象，外加 inject 依赖声明
 * （见 @deepseek-ai/cordis/src/registry.ts: isPlugin 判定为 typeof object.apply === 'function'）。
 *
 * 这层能做什么：把 ctx 的**一小部分**（tools/commands/skills/logger/events/effect/provide）
 * 映射到 JYSHarness 的 PluginApi，于是"只用 ctx.tools 注册工具的 Cordis 插件"可以直接跑。
 *
 * 这层不能做什么（重要，别过度承诺）：
 *   - inject 声明了本平台不提供的服务（llm/sessions/sandbox/guard/jobs/fs…）→ 直接拒绝并说明缺什么；
 *   - 插件 import 了 @deepseek-ai/dsh-* 包 → 装不上，import 就失败；
 *   - 插件的浏览器半（React 打进 DSH 的 apps/web）→ 结构上不兼容。
 * 所以"能用"的范围是：纯逻辑、只注册工具/命令/技能的 Cordis 插件。
 */
import type { PluginApi, PluginCommand } from "./types.ts";
import type { Tool } from "../tools/types.ts";

/** Cordis 插件对象的形状（够用就好，不追求完整类型）。 */
export interface CordisPluginLike {
  name?: string;
  apply?: (ctx: CordisContext, config?: unknown) => unknown;
  inject?: string[] | Record<string, unknown>;
  reusable?: boolean;
}

/** 我们提供给 Cordis 插件的服务名（inject 只有落在这个集合里才可能加载成功）。 */
export const SUPPORTED_SERVICES = ["tools", "commands", "skills", "logger", "events", "provide"] as const;

export interface CordisContext {
  [key: string]: unknown;
  tools: {
    register: (tool: CordisToolSpec) => void;
    /** DSH 里也有 add / provide 两种写法，都接受 */
    add: (tool: CordisToolSpec) => void;
  };
  commands: { register: (cmd: CordisCommandSpec) => void; add: (cmd: CordisCommandSpec) => void };
  skills: { register: (skill: { name: string; description?: string; content: string }) => void; add: (s: { name: string; description?: string; content: string }) => void };
  logger: (name?: string) => { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void };
  on: (event: string, listener: (payload: unknown) => unknown) => () => void;
  emit: (event: string, payload?: unknown) => void;
  effect: (fn: () => unknown) => void;
  provide: (name: string, value: unknown) => void;
  get: (name: string) => unknown;
}

/** Cordis 插件里的工具声明（DSH 生态里常见 parameters/execute 命名）。 */
export interface CordisToolSpec {
  name: string;
  description?: string;
  inputSchema?: unknown;
  parameters?: unknown;
  isReadOnly?: boolean;
  isDestructive?: boolean;
  execute?: (input: Record<string, unknown>, ctx?: unknown) => Promise<unknown> | unknown;
  call?: (input: Record<string, unknown>, ctx?: unknown) => Promise<unknown> | unknown;
  handler?: (input: Record<string, unknown>, ctx?: unknown) => Promise<unknown> | unknown;
}

export interface CordisCommandSpec {
  name: string;
  description?: string;
  run?: (arg: string, ctx?: unknown) => Promise<string> | string;
  execute?: (arg: string, ctx?: unknown) => Promise<string> | string;
}

/** 从任意模块导出里认出 Cordis 插件（含 default / 具名导出）。 */
export function findCordisPlugin(mod: Record<string, unknown>): CordisPluginLike | null {
  /**
   * 判定"是不是 Cordis 插件对象"。
   *
   * 坑：**任何函数都自带 Function.prototype.apply**，所以如果只查 typeof v.apply === 'function'，
   * 导出的 activate 函数也会被误判成 Cordis 插件（实测让一个普通插件走进了 Cordis 分支）。
   * 函数必须是"自有 apply"（class static apply）才算。
   */
  const looks = (v: unknown): v is CordisPluginLike => {
    if (!v) return false;
    if (typeof v === "object") return typeof (v as CordisPluginLike).apply === "function";
    if (typeof v === "function") return Object.hasOwn(v, "apply") && typeof (v as CordisPluginLike).apply === "function";
    return false;
  };
  if (looks(mod)) return mod as CordisPluginLike;
  const asRecord = mod as Record<string, unknown>;
  if (looks(asRecord.default)) return asRecord.default as CordisPluginLike;
  for (const v of Object.values(asRecord)) if (looks(v)) return v;
  return null;
}

/** inject 声明归一化成字符串数组。 */
export function declaredInject(plugin: CordisPluginLike): string[] {
  const raw = plugin.inject;
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map(String);
  return Object.keys(raw);
}

/** 把工具声明转成 JYSHarness 的 Tool。 */
function toTool(pluginId: string, spec: CordisToolSpec, api: PluginApi, warn: (m: string) => void): void {
  const fn = spec.execute ?? spec.call ?? spec.handler;
  if (!spec?.name || typeof fn !== "function") {
    warn("Cordis 工具缺少 name 或 execute/call/handler：" + String(spec?.name ?? "?"));
    return;
  }
  const tool: Tool = {
    name: spec.name,
    description: spec.description ?? spec.name,
    inputSchema: (spec.inputSchema ?? spec.parameters ?? { type: "object", properties: {} }) as Tool["inputSchema"],
    isReadOnly: Boolean(spec.isReadOnly),
    isDestructive: spec.isDestructive,
    isConcurrencySafe: () => true,
    call: async (input: Record<string, unknown>) => {
      const out = await fn(input, { pluginId });
      // Cordis 插件可能返回字符串、{content} 或 ToolResult
      if (typeof out === "string") return { content: out };
      if (out && typeof out === "object") {
        const o = out as { content?: string; isError?: boolean };
        if (typeof o.content === "string") return { content: o.content, isError: Boolean(o.isError) };
      }
      return { content: JSON.stringify(out ?? "") };
    },
  };
  api.registerTool(tool);
}

/**
 * 把 Cordis 插件跑起来。
 *
 * 返回 { ok, reason } —— 失败原因会写进加载错误里，而不是抛出去把整个加载打断。
 */
export function runCordisPlugin(
  plugin: CordisPluginLike,
  pluginId: string,
  api: PluginApi,
  warn: (m: string) => void,
): { ok: boolean; reason?: string } {
  const needs = declaredInject(plugin);
  const missing = needs.filter((name) => !(SUPPORTED_SERVICES as readonly string[]).includes(name));
  if (missing.length) {
    return {
      ok: false,
      reason:
        "Cordis 插件 inject 了本平台不提供的服务：" + missing.join(", ") +
        "（可用的是 " + SUPPORTED_SERVICES.join(", ") + "）",
    };
  }

  const services = new Map<string, unknown>();
  const listeners = new Map<string, Set<(payload: unknown) => unknown>>();
  const disposers: (() => unknown)[] = [];

  const log = { info: (m: string) => api.log(String(m)), warn: (m: string) => api.log(String(m)), error: (m: string) => api.log(String(m)) };

  const ctx: CordisContext = {
    tools: {
      register: (spec) => toTool(pluginId, spec, api, warn),
      add: (spec) => toTool(pluginId, spec, api, warn),
    },
    commands: {
      register: (spec) => {
        const run = spec.run ?? spec.execute;
        if (!spec?.name || typeof run !== "function") {
          warn("Cordis 命令缺少 name 或 run：" + String(spec?.name ?? "?"));
          return;
        }
        const cmd: PluginCommand = {
          name: spec.name.startsWith("/") ? spec.name : "/" + spec.name,
          description: spec.description ?? spec.name,
          run: async (arg) => String((await run(arg)) ?? ""),
        };
        api.registerCommand(cmd);
      },
      add: (spec) => ctx.commands.register(spec),
    },
    skills: {
      register: (s) => {
        if (!s?.name || !s?.content) {
          warn("Cordis 技能缺少 name 或 content");
          return;
        }
        api.addSkill({ name: s.name, description: s.description ?? "", content: s.content });
      },
      add: (s) => ctx.skills.register(s),
    },
    logger: () => log,
    on: (event, listener) => {
      // 事件名和我们 hook 事件同名时，直接接进 hook 管线；否则只在本插件内部派发
      if (event === "PreToolUse" || event === "PostToolUse" || event === "UserPromptSubmit" || event === "SessionStart" || event === "SessionEnd") {
        api.on(event as never, (async (payload: unknown) => listener(payload)) as never);
        return () => undefined;
      }
      const set = listeners.get(event) ?? new Set();
      set.add(listener);
      listeners.set(event, set);
      return () => set.delete(listener);
    },
    emit: (event, payload) => {
      for (const fn of listeners.get(event) ?? []) void fn(payload);
    },
    effect: (fn) => {
      const out = fn();
      if (typeof out === "function") disposers.push(out as () => unknown);
    },
    provide: (name, value) => services.set(name, value),
    get: (name) => services.get(name),
  };

  try {
    plugin.apply?.(ctx, undefined);
  } catch (err) {
    return { ok: false, reason: "Cordis 插件 apply() 抛出异常：" + (err instanceof Error ? err.message : String(err)) };
  }

  // 说明：Cordis 插件的 HTTP 路由通常通过 ctx.provide 暴露 http 服务，
  // 我们不解这种服务，所以 Cordis 插件只支持工具/命令/技能（已在文档里写明）。
  return { ok: true };
}

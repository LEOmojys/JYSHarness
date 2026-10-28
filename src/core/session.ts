/**
 * Session: the object the UI talks to. Owns provider, tools, permissions,
 * transcript and persistence, and wires the sub-agent runner into the loop.
 */
import path from "node:path";
import type { Message } from "./types.ts";
import { userMessage, userMessageWithImages, getText } from "./types.ts";
import type { HarnessSettings } from "./config.ts";
import type { RuleSet } from "../permissions/rules.ts";
import type { PermissionMode } from "../permissions/engine.ts";
import type { SandboxMode } from "../sandbox/paths.ts";
import type { Logger } from "../util/log.ts";
import type { ModelProvider } from "../providers/types.ts";
import { buildDefaultRegistry, type Tool, type ToolContext } from "../tools/index.ts";
import { buildSystemPrompt, runtimeSection } from "../context/systemPrompt.ts";
import { cacheHitRate } from "./cost.ts";
import {
  applySummary,
  compactCheap,
  compactLocally,
  microcompact,
  contextTokens,
  deriveCompaction,
  needsSummary,
  snip,
  splitForSummary,
  summarizeTranscript,
  summaryBudgetChars,
  type CompactionConfig,
} from "../context/compaction.ts";
import { inferContextWindow } from "./configStore.ts";
import { runHooks, type HookDefinition, type HookEvent } from "../hooks/hooks.ts";
import { queryLoop, type ApprovalOutcome, type HarnessEvent } from "./query.ts";
import { SessionStore, newSessionId, type SessionMeta } from "../session/store.ts";
import { estimateTokens } from "../util/tokens.ts";
import { realResolve } from "../sandbox/paths.ts";
import { JobManager } from "./jobs.ts";
import { TodoStore } from "./todos.ts";
import { CheckpointStore } from "./checkpoints.ts";
import { TokenCalibrator } from "../util/tokens.ts";
import { truncateOutput } from "../util/truncate.ts";
import { ToolHealth } from "./toolHealth.ts";
import { discoverAgentTypes, resolveAgentType, type AgentType } from "./agents.ts";

/** 子 Agent 摘要上限：约 3k token，够写清结论，又不至于把父上下文挤爆。 */
const SUBAGENT_SUMMARY_CHARS = 12_000;

/** 子 Agent 的结果：必须带 ok，父 Agent 才知道"这份摘要是不是真完成了任务"。 */
export interface SubagentOutcome {
  summary: string;
  ok: boolean;
  reason?: "unknown_type" | "cancelled" | "timeout" | "empty";
}
import { discoverSkillsWithWarnings, type SkillMeta } from "./skills.ts";
import { costBreakdown } from "./cost.ts";

export interface SessionOptions {
  workspaceRoot: string;
  cwd?: string;
  settings: HarnessSettings;
  rules: RuleSet;
  provider: ModelProvider;
  model: string;
  logger: Logger;
  approve: (args: {
    toolName: string;
    input: Record<string, unknown>;
    decision: import("../permissions/engine.ts").PermissionDecision;
    /**
     * 谁发起的。子 Agent 触发审批时必须能区分 —— 否则用户不知道自己在替谁批准。
     * 循环里一直在传这个字段，但类型上曾经没有它，等于"实现了但没有声明"。
     */
    origin?: "subagent";
  }) => Promise<ApprovalOutcome>;
  onAlwaysAllow?: (toolName: string, input: Record<string, unknown>) => void;
  hooks?: Partial<Record<HookEvent, HookDefinition[]>>;
  compaction?: Partial<CompactionConfig>;
  /** Model context window in tokens; 0/undefined = infer from the model name. */
  contextWindow?: number;
  sessionId?: string;
  store?: SessionStore;
  resumeMessages?: Message[];
  enableSubagent?: boolean;
}

export interface SessionStats {
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  modelMs?: number;
  toolMs?: number;
  ttftAvgMs?: number | null;
  steps?: number;
  contextTokens: number;
  toolCalls: number;
  /** 每个工具的调用/失败次数：调优和"哪个工具最不靠谱"的一手数据。 */
  toolStats?: Record<string, { calls: number; errors: number }>;
}

/** How the agent should behave. */
export type AgentMode = "default" | "makePlugin";

const PLUGIN_DEV_GUIDANCE = [
  "<plugin_authoring_mode>",
  "你现在处于「插件开发模式」：用户要你为当前项目编写 JYSHarness 工作流插件。",
  "",
  "插件目录：<workspace>/.harness/plugins/<name>/",
  "必需文件：",
  "  plugin.json   { \"name\": \"<name>\", \"version\": \"0.1.0\", \"entry\": \"index.ts\", \"skills\": \"skills\", \"enabled\": true }",
  "  index.ts      export function activate(api) { ... }",
  "",
  "可用 API：",
  "  api.registerTool({ name, description, inputSchema, isReadOnly, isConcurrencySafe, async call(input, ctx) })",
  "  api.addPromptSection(text)",
  "  api.on(\"PreToolUse\" | \"PostToolUse\" | \"Stop\" | \"UserPromptSubmit\" | \"SessionStart\", handler)",
  "    payload 字段（注意是 camelCase）：{ event, sessionId, cwd, toolName?, toolInput?, toolResult?, prompt? }",
  "    PreToolUse 返回 { decision: \"deny\", reason } 可以拦截一次工具调用；返回 { updatedInput } 可改写入参。",
  "  api.addSkill({ name, description, content })",
  "  api.log(message)",
  "",
  "工作方式：",
  "1. 先用一两句话确认插件要解决的具体工作流；目标不清就提问，不要猜。",
  "2. 用 Bash 运行 \"jys plugin new <name>\" 生成脚手架（项目不是 JYSHarness 仓库时，直接写文件也可以）。",
  "3. 编辑 index.ts，只实现真正需要的部分，不要堆示例代码。",
  "4. 用 Bash 运行 \"jys plugin test\" 校验；报错就修，直到通过。",
  "5. 最后告诉用户：插件路径、它提供什么、如何生效（重启或设置面板里点「重新加载」）。",
  "",
  "约束：",
  "- 工具名加项目前缀（如 acme_deploy），避免与内置工具冲突。",
  "- call() 返回 { content: string, isError?: boolean }。",
  "- 插件代码运行在 harness 进程内，不要写阻塞死循环。",
  "</plugin_authoring_mode>",
].join("\n");

export class Session {
  readonly workspaceRoot: string;
  readonly cwd: string;
  readonly sessionId: string;
  readonly store: SessionStore;
  readonly registry;
  /** 工具表会随插件/MCP 重载而变化，所以不是 readonly。 */
  tools: Tool[];
  provider: ModelProvider;
  model: string;
  readonly logger: Logger;
  messages: Message[];
  mode: PermissionMode;
  sandboxMode: SandboxMode;
  rules: RuleSet;
  hooks: Partial<Record<HookEvent, HookDefinition[]>>;
  compaction: CompactionConfig;
  contextWindow: number;
  /** settings.fallbackModel：主模型不可用时切到这里。 */
  fallbackModel?: string;
  private explicitWindow = false;
  stats: SessionStats;
  readonly jobs = new JobManager();
  readonly todos = new TodoStore();
  readonly checkpoints = new CheckpointStore();
  /** 会话级熔断状态：连续失败的工具会被短路。 */
  readonly toolHealth = new ToolHealth();
  /** 会话级 token 估算校准：用真实用量修正压缩阈值。 */
  readonly calibrator = new TokenCalibrator();
  /** 可用的子 Agent 类型（内置 + .harness/agents/*.md）。 */
  agentTypes: AgentType[] = [];
  /** 技能目录里的问题（重复名、缺简介、读不出）：用于 /skills 与设置面板。 */
  skillWarnings: string[] = [];
  /** 持久化失败的告警（去重后只留第一条）：用于 /status 与 state。 */
  persistWarnings: string[] = [];
  private persistFailures = 0;
  /** 写盘串行链：见 persist() 里的说明。 */
  private persistChain: Promise<void> = Promise.resolve();
  /** 被内置工具挡掉的扩展工具名（同名时内置优先，但必须说出来）。 */
  droppedTools: string[] = [];
  /**
   * 旁路事件通道：子 Agent 的进度用它在**运行中**推给调用方。
   * 生成器是顺序的（一次 next 一个事件），而工具调用内部无法 yield，
   * 所以进度必须走旁路；调用方（server/CLI）负责渲染。
   */
  private liveSink?: (ev: HarnessEvent) => void;
  skills: SkillMeta[];
  extensionTools: Tool[] = [];
  /** How the agent should behave: normal work vs. authoring plugins. */
  agentMode: AgentMode = "default";
  /** Stable text contributed by plugins, appended to the system prompt. */
  private extraPromptSections: string[] = [];
  /** Tools contributed by plugins; kept separate so MCP reloads do not drop them. */
  private pluginTools: Tool[] = [];
  /** Skills discovered on disk (baseline, before plugin contributions). */
  private fileSkills: SkillMeta[] = [];
  /** Plugin-contributed skills + hooks; replaced wholesale on reload. */
  private pluginSkills: SkillMeta[] = [];
  private baseHooks: Partial<Record<HookEvent, HookDefinition[]>> = {};
  private pluginHooks: Partial<Record<HookEvent, HookDefinition[]>> = {};
  private opts: SessionOptions;
  private systemPrompt: string;

  constructor(opts: SessionOptions) {
    this.opts = opts;
    this.workspaceRoot = realResolve(opts.workspaceRoot);
    this.cwd = realResolve(opts.cwd ?? opts.workspaceRoot);
    this.sessionId = opts.sessionId ?? newSessionId();
    this.store = opts.store ?? new SessionStore(path.join(opts.workspaceRoot, ".harness", "sessions"));
    this.provider = opts.provider;
    this.model = opts.model;
    this.logger = opts.logger;
    this.messages = opts.resumeMessages ?? [];
    this.mode = opts.settings.permissionMode ?? "default";
    this.sandboxMode = opts.settings.sandboxMode ?? "workspace-write";
    this.rules = opts.rules;
    this.baseHooks = opts.hooks ?? {};
    this.hooks = this.baseHooks;
    this.contextWindow =
      opts.contextWindow && opts.contextWindow > 0 ? opts.contextWindow : inferContextWindow(this.model);
    this.explicitWindow = Boolean(opts.contextWindow && opts.contextWindow > 0);
    this.compaction = { ...deriveCompaction(this.contextWindow), ...(opts.compaction ?? {}) };
    // 备用模型与主模型相同就没有意义，直接忽略（否则会切到"同一个模型"上白跑一次）。
    const fb = (opts.settings.fallbackModel ?? "").trim();
    this.fallbackModel = fb && fb !== this.model ? fb : undefined;
    // 子 Agent 类型：内置 + 项目定义（解析失败的类型只会被跳过并记录，不影响会话）。
    try {
      const skills = discoverSkillsWithWarnings(this.workspaceRoot);
      this.skillWarnings = skills.warnings;
    } catch {
      this.skillWarnings = [];
    }
    try {
      const discovery = discoverAgentTypes(this.workspaceRoot);
      this.agentTypes = discovery.types;
      for (const problem of discovery.errors) {
        this.logger.warn("agent type " + problem.file + " 解析失败：" + problem.message);
      }
    } catch (err) {
      this.agentTypes = [];
      this.logger.warn("agent type discovery failed: " + (err instanceof Error ? err.message : String(err)));
    }
    this.registry = buildDefaultRegistry({ enableSubagent: opts.enableSubagent !== false });
    this.fileSkills = discoverSkillsWithWarnings(this.workspaceRoot).skills;
    this.skills = this.fileSkills;
    this.tools = this.registry.assemble();
    this.stats = {
      turns: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      modelMs: 0,
      toolMs: 0,
      ttftAvgMs: null,
      steps: 0,
      contextTokens: 0,
      toolCalls: 0,
      toolStats: {},
    };
    this.systemPrompt = this.buildPrompt();
  }

  private buildPrompt(): string {
    return buildSystemPrompt({
      workspaceRoot: this.workspaceRoot,
      cwd: this.cwd,
      model: this.model,
      toolNames: this.tools.map((t) => t.name),
      sandboxMode: this.sandboxMode,
      permissionMode: this.mode,
      skills: this.skills,
      extraSections:
        this.agentMode === "makePlugin"
          ? [...this.extraPromptSections, PLUGIN_DEV_GUIDANCE]
          : this.extraPromptSections,
    });
  }

  /** Register MCP tools; plugin tools stay in place across reloads. */
  setExtensionTools(tools: Tool[]): void {
    this.extensionTools = tools;
    this.tools = this.registry.assemble([...this.pluginTools, ...tools]);
    this.warnDroppedTools([...this.pluginTools, ...tools]);
    this.systemPrompt = this.buildPrompt();
  }

  /**
   * 内置工具优先，同名扩展工具被丢弃 —— 但**静默丢弃**是坑：
   * 插件作者会以为工具注册成功了，模型却永远看不到它。
   */
  private warnDroppedTools(extensions: Tool[]): void {
    // 不能拿"最终工具表里有没有这个名字"判断：内置的 Bash 在里面，
    // 被丢掉的是插件那个同名工具 —— 名字存在 ≠ 插件的那个装上了。
    const builtinNames = new Set(this.registry.assemble().map((t) => t.name));
    const seen = new Set<string>();
    const dropped: string[] = [];
    for (const t of extensions) {
      if (builtinNames.has(t.name) || seen.has(t.name)) dropped.push(t.name);
      else seen.add(t.name);
    }
    this.droppedTools = [...new Set(dropped)];
    for (const name of this.droppedTools) {
      this.logger.warn(
        "工具名冲突，已被内置工具挡住：" + name + "（请给插件工具改名，例如 <plugin>_" + name.toLowerCase() + "）",
      );
    }
  }

  /**
   * Apply a plugin load result: tools, prompt sections, hooks and skills.
   * Called once at startup; safe to call again after a plugin reload.
   */
  applyPlugins(result: {
    tools: import("../tools/types.ts").Tool[];
    skills: { name: string; description: string; content: string }[];
    promptSections: string[];
    hooks: Partial<Record<import("../hooks/hooks.ts").HookEvent, import("../hooks/hooks.ts").HookDefinition[]>>;
  }): void {
    // Replace, never append: the settings UI reloads plugins in place.
    this.pluginTools = result.tools;
    this.extraPromptSections = result.promptSections;
    this.pluginSkills = result.skills.map((skill) => ({
      name: skill.name,
      description: skill.description,
      dir: "",
      source: "project" as const,
      content: skill.content,
    }));
    this.pluginHooks = result.hooks;
    this.rebuild();
  }

  /** Switch how the agent behaves without rebuilding the session. */
  setAgentMode(mode: AgentMode): void {
    this.agentMode = mode;
    this.systemPrompt = this.buildPrompt();
  }

  /** Recompose skills, hooks, tools and the prompt from their sources. */
  private rebuild(): void {
    const seen = new Set(this.fileSkills.map((s) => s.name));
    this.skills = [...this.fileSkills, ...this.pluginSkills.filter((s) => !seen.has(s.name))];
    const hooks: Partial<Record<HookEvent, HookDefinition[]>> = {};
    for (const source of [this.baseHooks, this.pluginHooks]) {
      for (const [event, defs] of Object.entries(source) as [HookEvent, HookDefinition[]][]) {
        hooks[event] = [...(hooks[event] ?? []), ...defs];
      }
    }
    this.hooks = hooks;
    this.tools = this.registry.assemble([...this.pluginTools, ...this.extensionTools]);
    this.warnDroppedTools([...this.pluginTools, ...this.extensionTools]);
    this.systemPrompt = this.buildPrompt();
  }

  refreshSkills(): SkillMeta[] {
    this.fileSkills = discoverSkillsWithWarnings(this.workspaceRoot).skills;
    this.rebuild();
    return this.skills;
  }

  /** Restore files touched by the most recent mutating tool call. */
  undoLast(): { restored: string[]; id: string } | null {
    return this.checkpoints.undoLast();
  }

  get systemPromptText(): string {
    return this.systemPrompt;
  }

  async init(): Promise<void> {
    const meta: SessionMeta = {
      id: this.sessionId,
      createdAt: new Date().toISOString(),
      cwd: this.cwd,
      workspaceRoot: this.workspaceRoot,
      model: this.model,
      provider: this.provider.id,
      permissionMode: this.mode,
      sandboxMode: this.sandboxMode,
    };
    // 同一个 sessionId 必须对应同一段对话。
    // 调用方可能只传了 sessionId（没传 resumeMessages）——典型是恢复流程漏了一步，
    // 或者 UI 里重新打开会话。这时**自动从磁盘续上历史**，否则内存与文件会分叉：
    // 后续追加写进同一个文件，但这一轮请求看不到旧上下文。
    if (this.messages.length === 0 && this.opts.resumeMessages === undefined) {
      try {
        const loaded = await this.store.load(this.sessionId);
        if (loaded.messages.length) this.messages = loaded.messages;
      } catch {
        /* 读不出来就当新会话 */
      }
    }
    if (this.messages.length === 0) await this.store.create(meta);
  }

  /**
   * 追加一条消息到转录。
   *
   * 为什么不让它抛：持久化是**旁路**，不是主流程。磁盘满或目录被删的时候，
   * 用户想要的是"这一轮还能跑完"，而不是整个会话崩掉。fire-and-forget 的地方
   * 之前是 `void this.store.append(...)` —— 一旦 reject 就是未处理拒绝，
   * Node 24 默认直接结束进程。
   */
  private async persist(message: Message): Promise<void> {
    // 串行化：两条 appendFile 并发写同一个文件可能交错，写坏的 JSONL 就是
    // "恢复出来的对话缺一半"。链式排队保证调用顺序 = 落盘顺序。
    this.persistChain = this.persistChain.then(async () => {
      try {
        await this.store.append(this.sessionId, message);
      } catch (err) {
        this.reportPersistError("append", err);
      }
    });
    return this.persistChain;
  }

  /**
   * 等所有排队中的写入落盘。
   *
   * 一轮结束时必须等：assistant 消息是 fire-and-forget 排队的，不等的话
   * "send() 已返回但转录还缺最后一轮" —— 此时崩溃就丢掉这轮的回答。
   */
  async flushPersist(): Promise<void> {
    await this.persistChain;
  }

  private reportPersistError(what: string, err: unknown): void {
    this.persistFailures++;
    const message = err instanceof Error ? err.message : String(err);
    // 只喊一次：每轮都喊会把日志刷爆，反而看不见
    if (this.persistFailures === 1) {
      const warning = "会话没有落盘（" + what + "）：" + message + "。这一轮照常进行，但重启后可能丢历史。";
      this.persistWarnings.push(warning);
      this.logger.warn(warning);
    }
  }

  /** 记一次工具调用：总数 + 按工具名分桶（失败单独计数）。 */
  private recordTool(name: string, isError: boolean | undefined): void {
    this.stats.toolCalls++;
    const bucket = (this.stats.toolStats ??= {});
    const entry = (bucket[name] ??= { calls: 0, errors: 0 });
    entry.calls++;
    if (isError) entry.errors++;
  }

  /** Apply permission/behavior settings to a live session. */
  applyBehavior(next: {
    permissionMode?: string;
    sandboxMode?: string;
    maxTurns?: number;
    maxTokens?: number;
    temperature?: number;
    /** 传空串表示关闭备用模型。 */
    fallbackModel?: string;
  }): void {
    if (next.permissionMode) this.mode = next.permissionMode as PermissionMode;
    if (next.sandboxMode) this.sandboxMode = next.sandboxMode as SandboxMode;
    if (next.fallbackModel !== undefined) {
      const fb = next.fallbackModel.trim();
      this.fallbackModel = fb && fb !== this.model ? fb : undefined;
    }
    this.opts = {
      ...this.opts,
      settings: {
        ...this.opts.settings,
        maxTurns: next.maxTurns ?? this.opts.settings.maxTurns,
        maxTokens: next.maxTokens ?? this.opts.settings.maxTokens,
        temperature: next.temperature ?? this.opts.settings.temperature,
      },
    };
    this.systemPrompt = this.buildPrompt();
  }

  /** Hot-swap the model without restarting: takes effect on the next turn. */
  setProvider(provider: ModelProvider, model: string): void {
    this.provider = provider;
    this.model = model;
    // A new model usually means a different window; re-derive unless pinned.
    if (!this.explicitWindow) {
      this.contextWindow = inferContextWindow(model);
      this.compaction = deriveCompaction(this.contextWindow);
    }
    this.systemPrompt = this.buildPrompt();
  }

  /** Pin the context window (settings UI). Recomputes compaction thresholds. */
  setContextWindow(tokens: number): void {
    this.contextWindow = Math.max(2_000, Math.floor(tokens));
    this.explicitWindow = true;
    this.compaction = deriveCompaction(this.contextWindow);
  }

  contextUsage(): { used: number; window: number; ratio: number } {
    const used = this.contextTokens();
    return { used, window: this.contextWindow, ratio: Math.min(1, used / this.contextWindow) };
  }

  /** Replace the approval handler (the HTTP server installs its UI bridge here). */
  setApprover(fn: SessionOptions["approve"]): void {
    this.opts = { ...this.opts, approve: fn };
  }

  setMode(mode: PermissionMode): void {
    this.mode = mode;
  }

  setSandbox(mode: SandboxMode): void {
    this.sandboxMode = mode;
  }

  contextTokens(): number {
    return contextTokens(this.messages) + estimateTokens(this.systemPrompt);
  }

  /** 上下文占用明细：系统提示词 / 工具定义 / 对话消息。 */
  contextBreakdown(): { used: number; max: number; system: number; tools: number; messages: number } {
    const system = estimateTokens(this.systemPrompt);
    const tools = estimateTokens(
      JSON.stringify(
        this.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })),
      ),
    );
    const messages = contextTokens(this.messages);
    return { used: system + tools + messages, max: this.contextWindow, system, tools, messages };
  }

  cost(): {
    inputUsd: number;
    outputUsd: number;
    /** 缓存读取/写入的单独成本（UI 可用来解释"为什么这轮便宜"）。 */
    cacheReadUsd: number;
    cacheCreationUsd: number;
    totalUsd: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    /** 0..1，按 token 计的提示缓存命中率。 */
    cacheHitRate: number;
    /** 输出速度（tok/s）。 */
    tps: number;
  } {
    const usage = {
      inputTokens: this.stats.inputTokens,
      outputTokens: this.stats.outputTokens,
      cacheReadTokens: this.stats.cacheReadTokens,
      cacheCreationTokens: this.stats.cacheCreationTokens,
    };
    const bd = costBreakdown(this.model, usage);
    return {
      // 分项必须是真算的：以前写死 0，API 里 breakdown 全是 0 只有总额是真的。
      inputUsd: bd.inputUsd,
      outputUsd: bd.outputUsd,
      cacheReadUsd: bd.cacheReadUsd,
      cacheCreationUsd: bd.cacheCreationUsd,
      totalUsd: bd.totalUsd,
      cacheReadTokens: usage.cacheReadTokens ?? 0,
      cacheCreationTokens: usage.cacheCreationTokens ?? 0,
      cacheHitRate: cacheHitRate(usage),
      // 输出速度：输出 token ÷ 模型耗时（不含工具等待）
      tps: this.stats.modelMs && this.stats.modelMs > 0
        ? Math.round(this.stats.outputTokens / (this.stats.modelMs / 1000))
        : 0,
    };
  }

  /** First user message, used as the session title in the UI. */
  title(): string {
    const first = this.messages.find((m) => m.role === "user" && !m.isMeta);
    if (!first) return "新会话";
    const text = first.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();
    return text.length > 60 ? text.slice(0, 60) + "..." : text || "新会话";
  }

  /**
   * Manual compaction (/compact). 和自动路径共用同一套阶梯，但真的会调模型写摘要 ——
   * 之前这里只做 micro+snip，"压缩"按钮在长会话上等于静默丢历史。
   */
  async compactNow(focus?: string): Promise<{ applied: string[]; before: number; after: number }> {
    const before = this.contextTokens();
    const applied: string[] = [];
    let messages = this.messages;

    // 手动压缩先摘要、后削工具噪声：用户主动要求"整理上下文"时，
    // 摘要应该看到完整的工具输出，而不是已经被 stub 过的版本。
    if (before > this.compaction.targetTokens) {
      const split = splitForSummary(messages, this.compaction.keepRecentMessages);
      const source = split.older.length ? split.older : messages;
      const summary = await summarizeTranscript(this.provider, this.model, source, {
        maxChars: summaryBudgetChars(this.contextWindow),
        focus,
        signal: new AbortController().signal,
      });
      if (summary) {
        messages = split.older.length ? applySummary(split, summary) : [summary];
        applied.push("summarize(" + source.length + " msgs)");
      }
    }

    // 无论摘要成功与否，尾部的大段工具输出都可以收一收。
    const micro = microcompact(messages, this.compaction.microcompactAge);
    if (micro.stubbed > 0 || micro.stubbedInputs > 0) {
      messages = micro.messages;
      applied.push("microcompact(" + micro.stubbed + " results, " + micro.stubbedInputs + " inputs)");
    }

    // 摘要不可用（没配 provider / 调用失败）时才退回丢消息。
    if (contextTokens(messages) > this.compaction.targetTokens) {
      const fallback = snip(messages, this.compaction.keepRecentMessages);
      if (fallback.dropped > 0) {
        messages = fallback.messages;
        applied.push("snip(" + fallback.dropped + ")");
      }
    }

    this.messages = messages;
    // 检查点写不进去 = 下次恢复会看到压缩前的历史（会重新摘要一次），
    // 不致命但要让人知道，所以走同一条告警通道。
    if (applied.length) {
      await this.store.appendCompact(this.sessionId, this.messages, before).catch((err: unknown) => {
        this.reportPersistError("compact", err);
      });
    }
    return { applied, before, after: this.contextTokens() };
  }

  clear(): void {
    this.messages = [];
  }

  private toolContext(depth = 0): ToolContext {
    return {
      workspaceRoot: this.workspaceRoot,
      cwd: this.cwd,
      sandbox: { mode: this.sandboxMode, workspaceRoot: this.workspaceRoot },
      signal: new AbortController().signal,
      logger: this.logger,
      depth,
      // 后台任务是真实进程：共享，父会话能看见/杀掉子 Agent 起的任务。
      jobs: this.jobs,
      // 待办是"谁的计划"：子 Agent 必须有自己的清单，否则它的 TodoWrite 会
      // 直接覆盖父会话的待办面板（实测确实覆盖过）。深度 0 才用会话的主清单。
      todos: depth === 0 ? this.todos : new TodoStore(),
      skills: this.skills,
      checkpoints: this.checkpoints,
      // 深度 1 才会被调用（子 Agent 的工具集里已经去掉了 Agent）；signal 透传用于取消。
      runSubagent: (prompt, o) => this.runSubagent(prompt, depth + 1, o, o?.signal),
      agentTypes: this.agentTypes,
    };
  }

  /** Run one user turn to completion, yielding events as they happen. */
  async *send(
    text: string,
    signal: AbortSignal,
    images?: { mediaType: string; data: string; name?: string }[],
    onLiveEvent?: (ev: HarnessEvent) => void,
  ): AsyncGenerator<HarnessEvent, void> {
    this.liveSink = onLiveEvent;
    const submit = await runHooks(
      this.hooks.UserPromptSubmit,
      { event: "UserPromptSubmit", sessionId: this.sessionId, cwd: this.cwd, prompt: text },
      { cwd: this.cwd, logger: this.logger, signal },
    );
    if (submit.decision === "deny") {
      yield { type: "notice", level: "warn", text: "prompt rejected by hook: " + (submit.reason ?? "") };
      return;
    }

    // 每轮重建系统提示：项目约定、记忆、技能索引都可能在会话进行中被改动。
    // 只在构造/换模型时构建的话，"记忆"要等下一次会话才生效 —— 那是个假功能。
    // 重建只在内容真的变化时才改变文本，所以对 prompt 缓存没有额外代价。
    this.systemPrompt = this.buildPrompt();

    const userMsg = images && images.length ? userMessageWithImages(text, images) : userMessage(text);
    this.messages = [...this.messages, userMsg];
    // 落盘失败不该杀掉这一轮：磁盘满、目录被删都会走到这里。
    await this.persist(userMsg);

    const tools = this.tools;
    const toolMap = new Map(tools.map((t) => [t.name, t]));

    const iterator = queryLoop({
      provider: this.provider,
      model: this.model,
      systemPrompt: this.systemPrompt,
      messages: this.messages,
      tools,
      preloadedToolMap: toolMap,
      permission: {
        mode: this.mode,
        rules: this.rules,
        sandboxMode: this.sandboxMode,
        workspaceRoot: this.workspaceRoot,
      },
      toolContext: this.toolContext(0),
      hooks: this.hooks,
      logger: this.logger,
      sessionId: this.sessionId,
      maxTurns: this.opts.settings.maxTurns ?? 60,
      maxTokens: this.opts.settings.maxTokens ?? 8192,
      temperature: this.opts.settings.temperature,
      compaction: this.compaction,
      contextWindow: this.contextWindow,
      // 同一 provider 内换模型：跨厂商需要独立的 Key/BaseURL，不做假配置。
      fallback: this.fallbackModel ? { provider: this.provider, model: this.fallbackModel } : undefined,
      toolHealth: this.toolHealth,
      // 日期与 git 状态每轮注入到最后一条消息，不进系统提示（见 runtimeSection）。
      ephemeralContext: runtimeSection(this.workspaceRoot),
      calibrator: this.calibrator,
      countTokens: process.env.HARNESS_COUNT_TOKENS === "off" ? "off" : "auto",
      signal,
      approve: this.opts.approve,
      onAlwaysAllow: this.opts.onAlwaysAllow,
      persist: (m) => {
        void this.persist(m);
      },
      onState: (m) => {
        this.messages = m;
      },
    });

    for await (const ev of iterator) {
      if (ev.type === "compaction") {
        // 循环里的**自动压缩**也要落一个检查点。
        // 以前只有手动 /compact（compactNow）写检查点，自动压缩只改内存 ——
        // 重启后就会重放压缩前的历史，白白再摘要一次，甚至再次超出窗口。
        await this.store
          .appendCompact(this.sessionId, this.messages, ev.tokensBefore)
          .catch((err: unknown) => this.reportPersistError("compact", err));
      } else if (ev.type === "assistant_message") {
        this.stats.turns++;
      } else if (ev.type === "tool_end") {
        this.recordTool(ev.name, ev.result.isError);
      } else if (ev.type === "timing") {
        this.stats.modelMs = ev.modelMs;
        this.stats.toolMs = ev.toolMs;
        this.stats.ttftAvgMs = ev.ttftAvgMs;
        this.stats.steps = ev.steps;
      } else if (ev.type === "usage") {
        this.stats.inputTokens = ev.totalInput;
        this.stats.outputTokens = ev.totalOutput;
        if (typeof (ev as { cacheRead?: number }).cacheRead === "number") {
          this.stats.cacheReadTokens = (ev as { cacheRead?: number }).cacheRead;
        }
        if (typeof (ev as { cacheCreation?: number }).cacheCreation === "number") {
          this.stats.cacheCreationTokens = (ev as { cacheCreation?: number }).cacheCreation;
        }
      }
      yield ev;
    }

    // 等这一轮的写入全部落盘：send() 返回之后，转录必须和内存里一致，
    // 否则"重启丢掉最后一轮回答"是随时会发生的。
    await this.flushPersist();
    // onState() kept this.messages in sync, including compaction substitutions.
    this.stats.contextTokens = this.contextTokens();
  }

  async runSubagent(
    prompt: string,
    depth: number,
    opts: { description?: string; type?: string } = {},
    parentSignal?: AbortSignal,
  ): Promise<SubagentOutcome> {
    const resolved = resolveAgentType(this.agentTypes, opts.type);
    if ("error" in resolved) return { summary: resolved.error, ok: false, reason: "unknown_type" };
    const type = resolved.type;
    const label = opts.description || type.name;
    const subId = this.sessionId + "-sub" + depth + "-" + Date.now().toString(36);
    const emit = (ev: HarnessEvent) => {
      try {
        this.liveSink?.(ev);
      } catch {
        /* 渲染失败不该影响子 Agent */
      }
    };
    emit({ type: "subagent_start", id: subId, label, agentType: type.name });
    this.logger.info("sub-agent started (depth " + depth + ", type " + type.name + ")");

    const messages: Message[] = [userMessage(prompt)];
    // 类型即能力边界：explore 类型的工具集里根本没有 Write/Edit/Bash ——
    // 这不是靠提示词自觉，是工具根本不在列表里，模型无从调用。
    const allowed = type.tools ? new Set(type.tools) : null;
    const tools = this.tools.filter((t) => t.name !== "Agent" && (!allowed || allowed.has(t.name)));
    const toolMap = new Map(tools.map((t) => [t.name, t]));
    let text = "";
    const controller = new AbortController();

    // 用户按停 / 父轮次被 abort 时，子 Agent 必须一起停 —— 否则它会继续烧 25 轮 token。
    const onParentAbort = () => controller.abort();
    if (parentSignal) {
      if (parentSignal.aborted) controller.abort();
      else parentSignal.addEventListener("abort", onParentAbort, { once: true });
    }
    // 独立的硬超时：即便没人 abort，也不允许一个子 Agent 无限跑下去。
    const timeoutMs = Math.max(1000, this.opts.settings.subagentTimeoutMs ?? 600_000);
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const systemPrompt =
      this.systemPrompt +
      "\n\n<subagent_brief>You are a sub-agent. Complete the delegated task, then reply with a concise " +
      "summary of what you found or changed. Your transcript is discarded; only your final reply reaches " +
      "the parent agent, so include every fact it needs.</subagent_brief>" +
      (type.systemPrompt ? "\n\n<subagent_type name=" + JSON.stringify(type.name) + ">\n" + type.systemPrompt + "\n</subagent_type>" : "");

    const iterator = queryLoop({
      provider: this.provider,
      // 优先级：类型自带模型 > 设置的 subagentModel > 主模型。
      model: type.model || this.opts.settings.subagentModel || this.model,
      systemPrompt,
      messages,
      tools,
      preloadedToolMap: toolMap,
      permission: {
        mode: this.mode,
        rules: this.rules,
        sandboxMode: this.sandboxMode,
        workspaceRoot: this.workspaceRoot,
      },
      toolContext: { ...this.toolContext(depth), signal: controller.signal },
      hooks: this.hooks,
      logger: this.logger,
      sessionId: this.sessionId + "-sub" + depth,
      maxTurns: Math.max(1, type.maxTurns ?? this.opts.settings.subagentMaxTurns ?? 25),
      maxTokens: this.opts.settings.maxTokens ?? 8192,
      compaction: this.compaction,
      signal: controller.signal,
      approve: this.opts.approve,
      onAlwaysAllow: this.opts.onAlwaysAllow,
    });

    let abortedByTimeout = false;
    // 用"增量"累加而不是直接赋值：并发跑两个子 Agent 时，各自的 totalInput
    // 会互相覆盖，成本面板就会少算。增量相加与并发无关。
    let prevIn = 0;
    let prevOut = 0;
    let prevRead = 0;
    let prevCreate = 0;
    let steps = 0;
    try {
      for await (const ev of iterator) {
        if (ev.type === "assistant_message") {
          const t = getText(ev.message.content);
          if (t.trim()) text += t + "\n";
        } else if (ev.type === "tool_end") {
          this.recordTool(ev.name, ev.result.isError);
          // 用 tool_end 而不是 tool_start 计步：并行批次只发 tool_end（不发 tool_start），
          // 只数 start 会把只读工具的进度漏掉 —— 而那恰恰是子 Agent 的主要动作。
          steps++;
          emit({ type: "subagent_progress", id: subId, label, step: steps, tool: ev.name });
        } else if (ev.type === "usage") {
          const read = (ev as { cacheRead?: number }).cacheRead ?? 0;
          const create = (ev as { cacheCreation?: number }).cacheCreation ?? 0;
          this.stats.inputTokens += Math.max(0, ev.totalInput - prevIn);
          this.stats.outputTokens += Math.max(0, ev.totalOutput - prevOut);
          this.stats.cacheReadTokens = (this.stats.cacheReadTokens ?? 0) + Math.max(0, read - prevRead);
          this.stats.cacheCreationTokens = (this.stats.cacheCreationTokens ?? 0) + Math.max(0, create - prevCreate);
          prevIn = ev.totalInput;
          prevOut = ev.totalOutput;
          prevRead = read;
          prevCreate = create;
        }
      }
    } finally {
      clearTimeout(timer);
      parentSignal?.removeEventListener("abort", onParentAbort);
    }
    let failedReason: SubagentOutcome["reason"];
    if (controller.signal.aborted) {
      // 被中止就是没完成 —— 哪怕它在被中止后又吐出了一段文本。
      // 之前只在"没有文本"时才判失败，于是超时的子 Agent 会被父模型当成成功。
      abortedByTimeout = true;
      failedReason = parentSignal?.aborted ? "cancelled" : "timeout";
      if (!text.trim()) {
        text = parentSignal?.aborted
          ? "(sub-agent cancelled: the parent turn was aborted)"
          : "(sub-agent timed out after " + Math.round(timeoutMs / 1000) + "s)";
      }
    }
    if (!text.trim()) {
      // 没有产出任何文本 = 子 Agent 失败了（模型报错、轮次用尽等）。
      failedReason = failedReason ?? "empty";
      text = abortedByTimeout ? "(sub-agent stopped early)" : "(sub-agent produced no final text)";
    }
    const ok = !failedReason;
    emit({ type: "subagent_end", id: subId, label, ok, steps });
    // 子 Agent 的摘要会整段进入父上下文：不设上限时，一个爱写长文的子 Agent
    // 能把父窗口一次吃掉。截断保头也保尾，并明确告诉父"被截过"。
    const clipped = truncateOutput(text.trim(), SUBAGENT_SUMMARY_CHARS);
    return { summary: clipped.content, ok, reason: failedReason };
  }
}

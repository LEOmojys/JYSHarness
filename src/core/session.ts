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
import { buildSystemPrompt } from "../context/systemPrompt.ts";
import { compactLocally, contextTokens, deriveCompaction, type CompactionConfig } from "../context/compaction.ts";
import { inferContextWindow } from "./configStore.ts";
import { runHooks, type HookDefinition, type HookEvent } from "../hooks/hooks.ts";
import { queryLoop, type ApprovalOutcome, type HarnessEvent } from "./query.ts";
import { SessionStore, newSessionId, type SessionMeta } from "../session/store.ts";
import { estimateTokens } from "../util/tokens.ts";
import { realResolve } from "../sandbox/paths.ts";
import { JobManager } from "./jobs.ts";
import { TodoStore } from "./todos.ts";
import { CheckpointStore } from "./checkpoints.ts";
import { discoverSkills, type SkillMeta } from "./skills.ts";
import { estimateCost } from "./cost.ts";

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
  }) => Promise<ApprovalOutcome>;
  onAlwaysAllow?: (toolName: string, input: Record<string, unknown>) => void;
  hooks?: Partial<Record<HookEvent, HookDefinition[]>>;
  compaction?: CompactionConfig;
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
  contextTokens: number;
  toolCalls: number;
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
  readonly tools: Tool[];
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
  private explicitWindow = false;
  stats: SessionStats;
  readonly jobs = new JobManager();
  readonly todos = new TodoStore();
  readonly checkpoints = new CheckpointStore();
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
    this.registry = buildDefaultRegistry({ enableSubagent: opts.enableSubagent !== false });
    this.fileSkills = discoverSkills(this.workspaceRoot);
    this.skills = this.fileSkills;
    this.tools = this.registry.assemble();
    this.stats = { turns: 0, inputTokens: 0, outputTokens: 0, contextTokens: 0, toolCalls: 0 };
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
    this.systemPrompt = this.buildPrompt();
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
    this.systemPrompt = this.buildPrompt();
  }

  refreshSkills(): SkillMeta[] {
    this.fileSkills = discoverSkills(this.workspaceRoot);
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
    if (this.messages.length === 0) await this.store.create(meta);
  }

  /** Apply permission/behavior settings to a live session. */
  applyBehavior(next: {
    permissionMode?: string;
    sandboxMode?: string;
    maxTurns?: number;
    maxTokens?: number;
    temperature?: number;
  }): void {
    if (next.permissionMode) this.mode = next.permissionMode as PermissionMode;
    if (next.sandboxMode) this.sandboxMode = next.sandboxMode as SandboxMode;
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

  cost(): { inputUsd: number; outputUsd: number; totalUsd: number } {
    const totalUsd = estimateCost(this.model, this.stats.inputTokens, this.stats.outputTokens);
    return { inputUsd: 0, outputUsd: 0, totalUsd };
  }

  /** First user message, used as the session title in the UI. */
  title(): string {
    const first = this.messages.find((m) => m.role === "user" && !m.isMeta);
    if (!first) return "新会话";
    const text = first.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();
    return text.length > 60 ? text.slice(0, 60) + "..." : text || "新会话";
  }

  compactNow(): { applied: string[]; before: number; after: number } {
    const before = this.contextTokens();
    const outcome = compactLocally(this.messages, { ...this.compaction, softLimit: 0 });
    this.messages = outcome.messages;
    return { applied: outcome.applied, before, after: this.contextTokens() };
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
      jobs: this.jobs,
      todos: this.todos,
      skills: this.skills,
      checkpoints: this.checkpoints,
      runSubagent: depth >= 2 ? undefined : (prompt, o) => this.runSubagent(prompt, depth + 1, o),
    };
  }

  /** Run one user turn to completion, yielding events as they happen. */
  async *send(
    text: string,
    signal: AbortSignal,
    images?: { mediaType: string; data: string; name?: string }[],
  ): AsyncGenerator<HarnessEvent, void> {
    const submit = await runHooks(
      this.hooks.UserPromptSubmit,
      { event: "UserPromptSubmit", sessionId: this.sessionId, cwd: this.cwd, prompt: text },
      { cwd: this.cwd, logger: this.logger, signal },
    );
    if (submit.decision === "deny") {
      yield { type: "notice", level: "warn", text: "prompt rejected by hook: " + (submit.reason ?? "") };
      return;
    }

    const userMsg = images && images.length ? userMessageWithImages(text, images) : userMessage(text);
    this.messages = [...this.messages, userMsg];
    await this.store.append(this.sessionId, userMsg);

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
      signal,
      approve: this.opts.approve,
      onAlwaysAllow: this.opts.onAlwaysAllow,
      persist: (m) => {
        void this.store.append(this.sessionId, m);
      },
      onState: (m) => {
        this.messages = m;
      },
    });

    for await (const ev of iterator) {
      if (ev.type === "assistant_message") {
        this.stats.turns++;
      } else if (ev.type === "tool_end") {
        this.stats.toolCalls++;
      } else if (ev.type === "usage") {
        this.stats.inputTokens = ev.totalInput;
        this.stats.outputTokens = ev.totalOutput;
      }
      yield ev;
    }

    // onState() kept this.messages in sync, including compaction substitutions.
    this.stats.contextTokens = this.contextTokens();
  }

  async runSubagent(
    prompt: string,
    depth: number,
    _opts: { description?: string },
  ): Promise<string> {
    this.logger.info("sub-agent started (depth " + depth + ")");
    const messages: Message[] = [userMessage(prompt)];
    const tools = this.tools.filter((t) => t.name !== "Agent");
    const toolMap = new Map(tools.map((t) => [t.name, t]));
    let text = "";
    const controller = new AbortController();

    const systemPrompt =
      this.systemPrompt +
      "\n\n<subagent_brief>You are a sub-agent. Complete the delegated task, then reply with a concise " +
      "summary of what you found or changed. Your transcript is discarded; only your final reply reaches " +
      "the parent agent, so include every fact it needs.</subagent_brief>";

    const iterator = queryLoop({
      provider: this.provider,
      model: this.model,
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
      maxTurns: 25,
      maxTokens: this.opts.settings.maxTokens ?? 8192,
      compaction: this.compaction,
      signal: controller.signal,
      approve: this.opts.approve,
      onAlwaysAllow: this.opts.onAlwaysAllow,
    });

    for await (const ev of iterator) {
      if (ev.type === "assistant_message") {
        const t = getText(ev.message.content);
        if (t.trim()) text += t + "\n";
      } else if (ev.type === "tool_end") {
        this.stats.toolCalls++;
      }
    }
    if (!text.trim()) text = "(sub-agent produced no final text)";
    return text.trim();
  }
}

/**
 * App configuration: non-secret settings live in settings.json (project or
 * user scope), API keys live ONLY in ~/.jysharness/secrets.json — never in a
 * project file that might be committed, and never echoed back to the UI.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export type ProviderName = "anthropic" | "openai" | "deepseek" | "compatible" | "mock";

export interface ModelConfig {
  provider: ProviderName;
  model: string;
  baseUrl?: string;
  /** Env var the key may also come from. */
  apiKeyEnv?: string;
  /** Context window in tokens; 0 means infer from the model name. */
  contextWindow: number;
}

/** Rough public context windows; only used to pick compaction thresholds. */
export function inferContextWindow(model: string): number {
  const table: [RegExp, number][] = [
    [/gpt-4[.]1/i, 1_000_000],
    [/gemini/i, 1_000_000],
    [/claude/i, 200_000],
    [/o[134](-|$)/i, 200_000],
    [/gpt-4o|gpt-4-turbo|gpt-5/i, 128_000],
    [/deepseek|qwen|kimi|moonshot|glm/i, 128_000],
    [/llama|mistral|mixtral|phi|gemma/i, 32_000],
  ];
  for (const [re, size] of table) if (re.test(model)) return size;
  return 128_000;
}

export interface BehaviorConfig {
  permissionMode: string;
  sandboxMode: string;
  maxTurns: number;
  maxTokens: number;
  temperature: number;
  /** 主模型不可用时切过去的模型（空 = 不切换）。 */
  fallbackModel?: string;
  /** 子 Agent 用的模型（空 = 跟随主模型）。 */
  subagentModel?: string;
  enableSubagent: boolean;
}

export interface McpServerView {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface AppConfig {
  model: ModelConfig;
  behavior: BehaviorConfig;
  mcpServers: McpServerView[];
  /** Where settings were read from (for display). */
  sources: string[];
}

export interface ConfigPatch {
  scope?: "user" | "workspace";
  provider?: string;
  model?: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  /** Only sent when the user types a new key. */
  apiKey?: string;
  /** 0 / undefined = infer from the model name. */
  contextWindow?: number;
  permissionMode?: string;
  sandboxMode?: string;
  maxTurns?: number;
  maxTokens?: number;
  temperature?: number;
  fallbackModel?: string;
  subagentMaxTurns?: number;
  subagentModel?: string;
  subagentTimeoutMs?: number;
  enableSubagent?: boolean;
  mcpServers?: McpServerView[];
}

export const PROVIDER_DEFAULTS: Record<ProviderName, { model: string; baseUrl: string; keyEnv: string }> = {
  anthropic: { model: "claude-sonnet-4-5", baseUrl: "https://api.anthropic.com", keyEnv: "ANTHROPIC_API_KEY" },
  openai: { model: "gpt-4.1", baseUrl: "https://api.openai.com/v1", keyEnv: "OPENAI_API_KEY" },
  deepseek: { model: "deepseek-chat", baseUrl: "https://api.deepseek.com/v1", keyEnv: "DEEPSEEK_API_KEY" },
  compatible: { model: "", baseUrl: "", keyEnv: "OPENAI_API_KEY" },
  mock: { model: "mock-1", baseUrl: "", keyEnv: "" },
};

/** Brand config directories. The legacy name is kept for one-way migration. */
export const CONFIG_DIR = ".jysharness";
export const LEGACY_CONFIG_DIR = ".mini-harness";

/**
 * Config home: HARNESS_HOME lets tests (and portable installs) redirect it.
 * On first run after the rename we move ~/.mini-harness over so existing
 * favorites, rules and API keys survive.
 */
export function configHome(): string {
  if (process.env.HARNESS_HOME && process.env.HARNESS_HOME.trim()) {
    return path.resolve(process.env.HARNESS_HOME);
  }
  const next = path.join(os.homedir(), CONFIG_DIR);
  const legacy = path.join(os.homedir(), LEGACY_CONFIG_DIR);
  if (!existsSync(next) && existsSync(legacy)) {
    try {
      renameSync(legacy, next);
    } catch {
      // Locked or read-only: keep using the old directory rather than losing data.
      return legacy;
    }
  }
  return next;
}

/** 机器级策略层：企业/管理员下发，优先级最高。 */
export function managedSettingsPath(): string {
  const override = process.env.JYS_MANAGED_SETTINGS;
  if (override && override.trim()) return path.resolve(override);
  const base = process.platform === "win32" ? process.env.ProgramData || "C:/ProgramData" : "/etc";
  return path.join(base, "jysharness", "settings.json");
}

/** 项目本地覆盖层：不进版本库的个人覆盖（.gitignore 里通常忽略）。 */
export function localSettingsPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, CONFIG_DIR, "settings.local.json");
}

export function userSettingsPath(): string {
  return path.join(configHome(), "settings.json");
}

export function userSecretsPath(): string {
  return path.join(configHome(), "secrets.json");
}

export function workspaceSettingsPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, CONFIG_DIR, "settings.json");
}

/** Pre-rename location, still read when the new file has not been created yet. */
export function legacyWorkspaceSettingsPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, LEGACY_CONFIG_DIR, "settings.json");
}

/** Prefer the current file, fall back to the legacy one, else the new path. */
export function resolveWorkspaceSettingsPath(workspaceRoot: string): string {
  const next = workspaceSettingsPath(workspaceRoot);
  if (existsSync(next)) return next;
  const legacy = legacyWorkspaceSettingsPath(workspaceRoot);
  return existsSync(legacy) ? legacy : next;
}

function readJson(file: string): Record<string, unknown> {
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function writeJson(file: string, data: unknown, privateFile = false): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 2) + "\n", "utf8");
  if (privateFile) {
    try {
      chmodSync(file, 0o600);
    } catch {
      /* best effort: Windows ACLs ignore POSIX modes */
    }
  }
}

/** Keys are stored per provider and never returned by the API. */
export function readSecrets(): Record<string, string> {
  const raw = readJson(userSecretsPath()) as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) if (typeof v === "string") out[k] = v;
  return out;
}

export function writeSecret(provider: string, apiKey: string): void {
  const secrets = readSecrets();
  if (apiKey.trim()) secrets[provider] = apiKey.trim();
  else delete secrets[provider];
  writeJson(userSecretsPath(), secrets, true);
}

export function maskKey(key: string | undefined): string | null {
  if (!key) return null;
  if (key.length <= 8) return "****";
  return key.slice(0, 4) + "…" + key.slice(-4);
}

export function resolveApiKey(provider: string, apiKeyEnv?: string): { key: string | null; from: "secrets" | "env" | "none" } {
  const secrets = readSecrets();
  if (secrets[provider]) return { key: secrets[provider], from: "secrets" };
  const envName = apiKeyEnv || PROVIDER_DEFAULTS[provider as ProviderName]?.keyEnv;
  if (envName && process.env[envName]) return { key: process.env[envName]!, from: "env" };
  return { key: null, from: "none" };
}

export interface ReadConfigOptions {
  workspaceRoot: string;
  /** Values already in effect for this process (CLI flags win over files). */
  overrides?: { provider?: string; model?: string; baseUrl?: string; apiKeyEnv?: string };
}

export function readAppConfig(opts: ReadConfigOptions): AppConfig {
  // 优先级（低 -> 高）：用户全局 < 项目共享 < 项目本地 < CLI 参数 < 机器策略。
  // 机器策略放最后是刻意的：企业下发的东西不该被本地 flag 绕开。
  const user = readJson(userSettingsPath());
  const project = readJson(resolveWorkspaceSettingsPath(opts.workspaceRoot));
  const local = readJson(localSettingsPath(opts.workspaceRoot));
  const managed = readJson(managedSettingsPath());
  const overrides = opts.overrides ?? {};
  const cli: Record<string, unknown> = {};
  if (overrides.provider) cli.provider = overrides.provider;
  if (overrides.model) cli.model = overrides.model;
  if (overrides.baseUrl) cli.baseUrl = overrides.baseUrl;
  if (overrides.apiKeyEnv) cli.apiKeyEnv = overrides.apiKeyEnv;

  const sources: string[] = [];
  if (Object.keys(user).length) sources.push(userSettingsPath());
  if (Object.keys(project).length) sources.push(resolveWorkspaceSettingsPath(opts.workspaceRoot));
  if (Object.keys(local).length) sources.push(localSettingsPath(opts.workspaceRoot));
  if (Object.keys(managed).length) sources.push(managedSettingsPath());
  const merged = { ...user, ...project, ...local, ...cli, ...managed } as Record<string, any>;

  const provider = (merged.provider ?? "anthropic") as ProviderName;
  const defaults = PROVIDER_DEFAULTS[provider] ?? PROVIDER_DEFAULTS.anthropic;

  const mcpRaw = (merged.mcpServers ?? {}) as Record<string, any>;
  const mcpServers: McpServerView[] = Object.entries(mcpRaw).map(([name, cfg]) => ({
    name,
    command: String(cfg?.command ?? ""),
    args: Array.isArray(cfg?.args) ? cfg.args.map(String) : [],
    env: (cfg?.env ?? {}) as Record<string, string>,
  }));

  return {
    model: {
      provider,
      model: merged.model ?? defaults.model,
      baseUrl: merged.baseUrl ?? defaults.baseUrl,
      apiKeyEnv: merged.apiKeyEnv ?? defaults.keyEnv,
      contextWindow: (() => {
        const explicit = Number(merged.contextWindow);
        if (explicit > 0) return explicit;
        return inferContextWindow(String(merged.model ?? defaults.model));
      })(),
    },
    behavior: {
      permissionMode: merged.permissionMode ?? "default",
      sandboxMode: merged.sandboxMode ?? "workspace-write",
      maxTurns: Number(merged.maxTurns ?? 60),
      maxTokens: Number(merged.maxTokens ?? 8192),
      temperature: Number(merged.temperature ?? 0.2),
      fallbackModel: typeof merged.fallbackModel === "string" ? merged.fallbackModel : undefined,
      subagentModel: typeof merged.subagentModel === "string" ? merged.subagentModel : undefined,
      enableSubagent: merged.enableSubagent !== false,
    },
    mcpServers,
    sources,
  };
}

/**
 * Persist a patch. Secrets always go to the user-level secrets file; model and
 * behaviour settings go to the chosen scope (workspace by default).
 */
export function saveAppConfig(workspaceRoot: string, patch: ConfigPatch): AppConfig {
  const scope = patch.scope === "user" ? "user" : "workspace";
  const file = scope === "user" ? userSettingsPath() : workspaceSettingsPath(workspaceRoot);
  const current = readJson(file);
  const existingProviders = ((current.mcpServers as Record<string, any>) ?? {});

  if (patch.provider) current.provider = patch.provider;
  if (patch.model !== undefined) current.model = patch.model;
  if (patch.baseUrl !== undefined) current.baseUrl = patch.baseUrl;
  if (patch.apiKeyEnv !== undefined) current.apiKeyEnv = patch.apiKeyEnv;
  if (patch.contextWindow !== undefined) current.contextWindow = patch.contextWindow;
  if (patch.permissionMode) current.permissionMode = patch.permissionMode;
  if (patch.sandboxMode) current.sandboxMode = patch.sandboxMode;
  if (patch.maxTurns !== undefined) current.maxTurns = patch.maxTurns;
  if (patch.maxTokens !== undefined) current.maxTokens = patch.maxTokens;
  if (patch.temperature !== undefined) current.temperature = patch.temperature;
  if (patch.fallbackModel !== undefined) current.fallbackModel = patch.fallbackModel;
  if (patch.enableSubagent !== undefined) current.enableSubagent = patch.enableSubagent;

  if (patch.mcpServers) {
    const next: Record<string, unknown> = { ...existingProviders };
    for (const server of patch.mcpServers) {
      if (!server.name) continue;
      next[server.name] = { command: server.command, args: server.args, ...(Object.keys(server.env ?? {}).length ? { env: server.env } : {}) };
    }
    // A server the user removed in the UI must disappear from the file too.
    for (const name of Object.keys(existingProviders)) {
      if (!patch.mcpServers.some((s) => s.name === name)) delete next[name];
    }
    current.mcpServers = next;
  }

  writeJson(file, current);
  if (patch.apiKey !== undefined && patch.provider) writeSecret(patch.provider, patch.apiKey);
  return readAppConfig({ workspaceRoot });
}

/** Everything the settings UI needs, with no secret material. */
export function describeConfig(workspaceRoot: string, overrides?: ReadConfigOptions["overrides"]) {
  const config = readAppConfig({ workspaceRoot, overrides });
  const resolved = resolveApiKey(config.model.provider, config.model.apiKeyEnv);
  return {
    ...config,
    key: {
      present: Boolean(resolved.key),
      from: resolved.from,
      hint: maskKey(resolved.key ?? undefined),
    },
    defaults: PROVIDER_DEFAULTS,
  };
}

/** Provider factory: one place where env vars and settings resolve to a model. */
import { readFileSync } from "node:fs";
import type { HarnessSettings } from "../core/config.ts";
import { resolveApiKey } from "../core/configStore.ts";
import { AnthropicProvider } from "./anthropic.ts";
import { MockProvider, type MockTurn } from "./mock.ts";
import { OpenAIProvider } from "./openai.ts";
import type { ModelProvider } from "./types.ts";

export * from "./types.ts";
export type { MockTurn } from "./mock.ts";

export interface ProviderResolution {
  provider: ModelProvider;
  model: string;
  /** Human note about where credentials came from (shown in /status). */
  note: string;
}

export function loadMockScript(absPath: string): MockTurn[] {
  // Notepad / PowerShell often write UTF-8 with a BOM; JSON.parse chokes on it.
  const raw = readFileSync(absPath, "utf8").replace(/^\uFEFF/, "");
  const parsed = JSON.parse(raw);
  if (Array.isArray(parsed)) return parsed as MockTurn[];
  if (parsed && Array.isArray(parsed.turns)) return parsed.turns as MockTurn[];
  throw new Error("mock script must be an array of turns or { turns: [...] }");
}

export function createProvider(opts: {
  settings: HarnessSettings;
  providerName?: string;
  model?: string;
  mockTurns?: MockTurn[];
}): ProviderResolution {
  const name = (opts.providerName ?? opts.settings.provider ?? "anthropic").toLowerCase();
  const model = opts.model ?? opts.settings.model ?? "";

  if (name === "mock") {
    const turns = opts.mockTurns ?? [];
    // A mock run must not inherit the configured real model id — it is confusing
    // in /status and would be sent in requests that are never actually made.
    const provider = new MockProvider(turns, opts.model || "mock-1");
    return { provider, model: provider.model, note: "mock provider (" + turns.length + " scripted turn(s))" };
  }

  if (name === "openai" || name === "deepseek" || name === "compatible") {
    const keyInfo = resolveApiKey(name, opts.settings.apiKeyEnv);
    const apiKey = keyInfo.key;
    if (!apiKey) {
      throw new Error(
        "缺少 API Key：请在设置里填写，或设置环境变量 " +
          (opts.settings.apiKeyEnv ?? (name === "deepseek" ? "DEEPSEEK_API_KEY" : "OPENAI_API_KEY")) +
          "。也可以先用 --provider mock 离线体验。",
      );
    }
    // 空字符串要当成"没填"，否则 ?? 不会回退，请求会发到空 URL —— 表现为
    // 一个毫无线索的 "fetch failed"。设置面板里把 Base URL 清空是很正常的操作。
    const configured = (opts.settings.baseUrl ?? "").trim();
    const baseUrl =
      configured || (name === "deepseek" ? "https://api.deepseek.com/v1" : "https://api.openai.com/v1");
    const provider = new OpenAIProvider({ apiKey, baseUrl, model: model || "gpt-4.1", id: name });
    return { provider, model: provider.model, note: "openai-compatible " + baseUrl + " (key from " + keyInfo.from + ")" };
  }

  const keyInfo = resolveApiKey("anthropic", opts.settings.apiKeyEnv);
  const apiKey = keyInfo.key;
  if (!apiKey) {
    throw new Error(
      "缺少 API Key：请在设置里填写，或设置环境变量 " +
        (opts.settings.apiKeyEnv ?? "ANTHROPIC_API_KEY") +
        "。也可以先用 --provider mock 离线体验。",
    );
  }
  const provider = new AnthropicProvider({ apiKey, baseUrl: opts.settings.baseUrl, model: model || "claude-sonnet-4-5" });
  return { provider, model: provider.model, note: "anthropic (key from " + keyInfo.from + ")" };
}

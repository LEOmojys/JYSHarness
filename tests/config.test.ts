import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Session } from "../src/core/session.ts";
import { MockProvider } from "../src/providers/mock.ts";
import { emptyRuleSet } from "../src/permissions/rules.ts";
import { Logger } from "../src/util/log.ts";
import { startServer } from "../src/server/app.ts";
import {
  describeConfig,
  maskKey,
  readAppConfig,
  readSecrets,
  resolveApiKey,
  saveAppConfig,
  userSecretsPath,
  userSettingsPath,
  workspaceSettingsPath,
} from "../src/core/configStore.ts";

const logger = new Logger("error");

async function tempRoot(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "mh-cfg-"));
}

async function withHome<T>(fn: () => Promise<T>): Promise<T> {
  const home = await tempRoot();
  const prev = process.env.HARNESS_HOME;
  process.env.HARNESS_HOME = home;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.HARNESS_HOME;
    else process.env.HARNESS_HOME = prev;
  }
}

test("config: secrets never land in settings files", async () => {
  await withHome(async () => {
    const ws = await tempRoot();
    saveAppConfig(ws, { scope: "workspace", provider: "deepseek", model: "deepseek-chat", apiKey: "sk-my-secret-123456" });

    const secrets = readSecrets();
    assert.equal(secrets.deepseek, "sk-my-secret-123456");

    const settingsFile = await readFile(workspaceSettingsPath(ws), "utf8");
    assert.ok(!settingsFile.includes("sk-my-secret-123456"), "key must not be in project settings");
    if (existsSync(userSettingsPath())) {
      const userFile = await readFile(userSettingsPath(), "utf8");
      assert.ok(!userFile.includes("sk-my-secret-123456"), "key must not be in user settings");
    }
    assert.ok(userSecretsPath().endsWith("secrets.json"));

    const resolved = resolveApiKey("deepseek");
    assert.equal(resolved.from, "secrets");
    assert.equal(resolved.key, "sk-my-secret-123456");
    assert.equal(maskKey(resolved.key!), "sk-m…3456");

    // 落盘后能读回来，且 UI 只拿得到提示不拿得到明文
    const described = describeConfig(ws);
    assert.equal(described.key.present, true);
    assert.equal(described.key.hint, "sk-m…3456");
    assert.ok(!JSON.stringify(described).includes("sk-my-secret-123456"));
  });
});

test("config: workspace scope overrides user scope", async () => {
  await withHome(async () => {
    const ws = await tempRoot();
    saveAppConfig(ws, { scope: "user", provider: "openai", model: "gpt-4.1" });
    assert.equal(readAppConfig({ workspaceRoot: ws }).model.provider, "openai");

    saveAppConfig(ws, { scope: "workspace", provider: "deepseek", model: "deepseek-reasoner" });
    const merged = readAppConfig({ workspaceRoot: ws });
    assert.equal(merged.model.provider, "deepseek");
    assert.equal(merged.model.model, "deepseek-reasoner");
    assert.equal(merged.sources.length, 2);
  });
});

test("config: behaviour and mcp servers persist", async () => {
  await withHome(async () => {
    const ws = await tempRoot();
    saveAppConfig(ws, {
      scope: "workspace",
      permissionMode: "plan",
      sandboxMode: "read-only",
      maxTurns: 12,
      temperature: 0.7,
      enableSubagent: false,
      mcpServers: [{ name: "echo", command: "node", args: ["srv.mjs"], env: {} }],
    });
    const cfg = readAppConfig({ workspaceRoot: ws });
    assert.equal(cfg.behavior.permissionMode, "plan");
    assert.equal(cfg.behavior.sandboxMode, "read-only");
    assert.equal(cfg.behavior.maxTurns, 12);
    assert.equal(cfg.behavior.temperature, 0.7);
    assert.equal(cfg.behavior.enableSubagent, false);
    assert.equal(cfg.mcpServers.length, 1);
    assert.equal(cfg.mcpServers[0].name, "echo");
    assert.deepEqual(cfg.mcpServers[0].args, ["srv.mjs"]);

    // 删除服务器要真的从文件里消失
    saveAppConfig(ws, { scope: "workspace", mcpServers: [] });
    const after = JSON.parse(await readFile(workspaceSettingsPath(ws), "utf8"));
    assert.deepEqual(after.mcpServers, {});
  });
});

async function bootServer(root: string) {
  const provider = new MockProvider([{ text: "ok", stopReason: "end_turn" }]);
  const session = new Session({
    workspaceRoot: root,
    settings: { permissionMode: "default", sandboxMode: "workspace-write", maxTurns: 8 },
    rules: emptyRuleSet(),
    provider,
    model: "mock-1",
    logger,
    approve: async () => "allow",
  });
  await session.init();
  const built: string[] = [];
  const server = await startServer({
    session,
    logger,
    port: 0,
    providerId: "mock",
    autoApprove: true,
    buildProvider: (cfg) => {
      built.push(cfg.provider + "/" + cfg.model);
      return { provider: new MockProvider([{ text: "pong", stopReason: "end_turn" }]), model: "stub-" + cfg.model, note: "stub" };
    },
  });
  return { server, session, built };
}

test("server: config endpoints hot-swap the model and guard missing keys", async () => {
  await withHome(async () => {
    const ws = await tempRoot();
    const { server, session, built } = await bootServer(ws);
    try {
      const cfg = await (await fetch(server.url + "api/config")).json();
      assert.equal(cfg.active.model, "mock-1");
      assert.equal(cfg.key.present, false);

      // 没有 key 时不允许切到需要密钥的服务商
      const rejected = await fetch(server.url + "api/config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "anthropic", model: "claude-sonnet-4-5" }),
      });
      assert.equal(rejected.status, 400);
      assert.equal(session.provider.id, "mock");

      // 带 key 保存：写密钥、热切换、行为同步生效
      const saved = await fetch(server.url + "api/config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider: "anthropic",
          model: "claude-sonnet-4-5",
          apiKey: "sk-test-abcdef123456",
          permissionMode: "plan",
          scope: "workspace",
        }),
      });
      assert.equal(saved.status, 200);
      assert.equal(session.model, "stub-claude-sonnet-4-5");
      assert.equal(session.mode, "plan");
      assert.ok(built.some((b) => b.startsWith("anthropic/")));

      const secrets = readSecrets();
      assert.equal(secrets.anthropic, "sk-test-abcdef123456");

      // 测试连接走同一个 buildProvider
      const tested = await (
        await fetch(server.url + "api/config/test", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ provider: "mock", model: "mock-1" }),
        })
      ).json();
      assert.equal(tested.ok, true);
    } finally {
      await server.close();
    }
  });
});

test("server: config validation rejects nonsense", async () => {
  await withHome(async () => {
    const ws = await tempRoot();
    const { server } = await bootServer(ws);
    try {
      const badTurns = await fetch(server.url + "api/config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "mock", maxTurns: 9999 }),
      });
      assert.equal(badTurns.status, 400);

      const badTemp = await fetch(server.url + "api/config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "mock", temperature: 9 }),
      });
      assert.equal(badTemp.status, 400);

      const compat = await fetch(server.url + "api/config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "compatible" }),
      });
      assert.equal(compat.status, 400);
    } finally {
      await server.close();
    }
  });
});
/* ---------------- 上下文窗口 ---------------- */

test("window: thresholds derive from the model context window", async () => {
  const { deriveCompaction } = await import("../src/context/compaction.ts");
  const big = deriveCompaction(200_000);
  assert.equal(big.softLimit, 150_000);
  assert.equal(big.targetTokens, 80_000);
  assert.equal(big.keepRecentMessages, 12);

  const small = deriveCompaction(8_000);
  assert.equal(small.softLimit, 6_000);
  assert.equal(small.targetTokens, 3_200);
  assert.equal(small.keepRecentMessages, 6);

  // 不合理的输入被夹住，不会退化成 0
  assert.equal(deriveCompaction(10).softLimit, 1_500);
});

test("window: inferred from the model name", async () => {
  const { inferContextWindow } = await import("../src/core/configStore.ts");
  assert.equal(inferContextWindow("claude-sonnet-4-5"), 200_000);
  assert.equal(inferContextWindow("gpt-4.1"), 1_000_000);
  assert.equal(inferContextWindow("deepseek-chat"), 128_000);
  assert.equal(inferContextWindow("llama-3-8b"), 32_000);
  assert.equal(inferContextWindow("unknown-model"), 128_000);
});

test("window: a live session recomputes its compaction thresholds", async () => {
  const root = await tempRoot();
  const session = new Session({
    workspaceRoot: root,
    settings: { permissionMode: "default", sandboxMode: "workspace-write", maxTurns: 4 },
    rules: emptyRuleSet(),
    provider: new MockProvider([{ text: "ok", stopReason: "end_turn" }]),
    model: "deepseek-chat",
    logger,
    approve: async () => "allow",
  });
  await session.init();

  // 未显式设置时，跟随模型名推断
  assert.equal(session.contextWindow, 128_000);
  assert.equal(session.compaction.softLimit, 96_000);

  session.setContextWindow(8_000);
  assert.equal(session.contextWindow, 8_000);
  assert.equal(session.compaction.softLimit, 6_000);
  assert.equal(session.compaction.targetTokens, 3_200);

  // 显式设置后，换模型不会覆盖它
  session.setProvider(new MockProvider([]), "claude-sonnet-4-5");
  assert.equal(session.contextWindow, 8_000);
  assert.equal(session.compaction.softLimit, 6_000);

  const usage = session.contextUsage();
  assert.equal(usage.window, 8_000);
  assert.ok(usage.ratio >= 0 && usage.ratio <= 1);
});

test("window: persisted in settings and pushed to live sessions", async () => {
  await withHome(async () => {
    const ws = await tempRoot();
    saveAppConfig(ws, { scope: "workspace", provider: "openai", model: "custom-small", contextWindow: 32_000 });
    assert.equal(readAppConfig({ workspaceRoot: ws }).model.contextWindow, 32_000);

    // 未设置时按模型推断
    saveAppConfig(ws, { scope: "workspace", contextWindow: 0 });
    assert.equal(readAppConfig({ workspaceRoot: ws }).model.contextWindow, 128_000);

    const { server, session } = await bootServer(ws);
    try {
      const res = await fetch(server.url + "api/config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "mock", contextWindow: 24_000 }),
      });
      assert.equal(res.status, 200);
      assert.equal(session.contextWindow, 24_000);
      assert.equal(session.compaction.softLimit, 18_000);

      const state = await (await fetch(server.url + "api/state")).json();
      assert.equal(state.contextWindow, 24_000);
      assert.equal(state.contextUsage.window, 24_000);
    } finally {
      await server.close();
    }
  });
});

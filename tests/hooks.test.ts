import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  clampHookTimeout,
  compileMatcher,
  describeHooks,
  matchesTool,
  MAX_HOOK_TIMEOUT_MS,
  runHooks,
  validateHooks,
  type HookPayload,
} from "../src/hooks/hooks.ts";
import { loadSettings } from "../src/core/config.ts";
import { Session } from "../src/core/session.ts";
import { MockProvider } from "../src/providers/mock.ts";
import { emptyRuleSet } from "../src/permissions/rules.ts";
import { Logger } from "../src/util/log.ts";

const logger = new Logger("error");
const payload: HookPayload = { event: "PreToolUse", sessionId: "s", cwd: process.cwd(), toolName: "Bash", toolInput: { command: "ls" } };
const ctx = { cwd: process.cwd(), logger };

test("hooks: a later allow cannot cancel an earlier deny", async () => {
  const r = await runHooks(
    [
      { handler: () => ({ decision: "deny", reason: "policy say no" }) },
      { handler: () => ({ decision: "allow" }) },
    ],
    payload,
    ctx,
  );
  assert.equal(r.decision, "deny", "deny must win regardless of order");
  assert.equal(r.reason, "policy say no");

  // 反向顺序也一样
  const reversed = await runHooks(
    [
      { handler: () => ({ decision: "allow" }) },
      { handler: () => ({ decision: "deny", reason: "late deny" }) },
    ],
    payload,
    ctx,
  );
  assert.equal(reversed.decision, "deny");
  assert.equal(reversed.reason, "late deny");

  // ask 高于 allow、低于 deny
  const asked = await runHooks(
    [
      { handler: () => ({ decision: "allow" }) },
      { handler: () => ({ decision: "ask" }) },
    ],
    payload,
    ctx,
  );
  assert.equal(asked.decision, "ask");
});

test("hooks: an invalid matcher does not throw, it just does not match", async () => {
  assert.equal(compileMatcher("(["), null);
  assert.equal(matchesTool({ matcher: "([", command: "x" }, "Bash"), false);
  const r = await runHooks([{ matcher: "([", handler: () => ({ decision: "deny" }) }], payload, ctx);
  assert.deepEqual(r, {}, "a broken matcher must not crash the turn");
  // 合法 matcher 仍然工作
  assert.equal(matchesTool({ matcher: "Ba.*", command: "x" }, "Bash"), true);
  assert.equal(matchesTool({ matcher: "Write", command: "x" }, "Bash"), false);
});

test("hooks: timeouts are clamped into a sane range", () => {
  assert.equal(clampHookTimeout(undefined), 10_000);
  assert.equal(clampHookTimeout(0), 100);
  assert.equal(clampHookTimeout(-5), 100);
  assert.equal(clampHookTimeout(1e9), MAX_HOOK_TIMEOUT_MS);
});

test("hooks: config validation rejects bad entries with actionable messages", () => {
  const { hooks, problems } = validateHooks({
    PreToolUse: [
      { command: "echo ok", matcher: "Bash" },
      { matcher: "([", command: "echo bad-regex" },
      { matcher: "Write" },
      "not-an-object",
    ],
    UserPromptSubmit: "should-be-array",
    NotAnEvent: [{ command: "echo x" }],
  });
  assert.deepEqual(Object.keys(hooks), ["PreToolUse"]);
  assert.equal(hooks.PreToolUse?.length, 1);
  assert.equal(hooks.PreToolUse?.[0].timeoutMs, 10_000, "timeout filled in");
  assert.ok(problems.some((p) => p.includes("不是合法正则")));
  assert.ok(problems.some((p) => p.includes("缺少 command")));
  assert.ok(problems.some((p) => p.includes("不是对象")));
  assert.ok(problems.some((p) => p.includes("必须是数组")));
  assert.ok(problems.some((p) => p.includes("不是已知事件名")));
});

test("hooks: settings.json hooks are data-driven and surface problems as warnings", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "jys-hookcfg2-"));
  mkdirSync(path.join(root, ".jysharness"), { recursive: true });
  writeFileSync(
    path.join(root, ".jysharness", "settings.json"),
    JSON.stringify({
      hooks: {
        PreToolUse: [{ matcher: "Bash", command: "echo hi", timeoutMs: 999999 }],
        Bogus: [{ command: "echo x" }],
      },
    }),
    "utf8",
  );
  const loaded = loadSettings(root);
  assert.equal(loaded.settings.hooks?.PreToolUse?.length, 1);
  assert.equal(loaded.settings.hooks?.PreToolUse?.[0].timeoutMs, MAX_HOOK_TIMEOUT_MS, "clamped");
  assert.ok(loaded.warnings.some((w) => w.includes("Bogus")), JSON.stringify(loaded.warnings));
  assert.equal(describeHooks(loaded.settings.hooks)[0].startsWith("PreToolUse[0] shell"), true);
});

test("hooks: a settings-defined shell hook really blocks a tool call", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "jys-hook-e2e-"));
  mkdirSync(path.join(root, ".jysharness"), { recursive: true });
  // exit 2 + stderr 是 Claude Code 约定的"阻断"协议
  writeFileSync(
    path.join(root, ".jysharness", "settings.json"),
    JSON.stringify({
      hooks: {
        // 用 shell 内建 exit 2：跨平台且正好是"阻断"协议，避免 PowerShell/bash 引号差异
        PreToolUse: [{ matcher: "Bash", command: "exit 2" }],
      },
    }),
    "utf8",
  );
  const loaded = loadSettings(root);
  const session = new Session({
    workspaceRoot: root,
    settings: { permissionMode: "bypassPermissions", sandboxMode: "workspace-write", maxTurns: 3, maxTokens: 256 },
    rules: emptyRuleSet(),
    provider: new MockProvider([
      { text: "run", toolCalls: [{ name: "Bash", input: { command: "echo should-not-run" } }] },
      { text: "done" },
    ]),
    model: "mock-1",
    logger,
    approve: async () => "allow",
    hooks: loaded.settings.hooks,
    enableSubagent: false,
  });
  await session.init();
  const events: any[] = [];
  for await (const ev of session.send("go", new AbortController().signal)) events.push(ev);
  const end = events.find((e) => e.type === "tool_end");
  assert.ok(end, "tool call must surface");
  assert.equal(end.result.isError, true, "hook exit 2 must block the call");
  assert.match(String(end.result.content), /Blocked by PreToolUse hook/);
});

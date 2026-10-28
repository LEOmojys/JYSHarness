import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { handleSlash } from "../src/cli/main.ts";
import { Session } from "../src/core/session.ts";
import { MockProvider } from "../src/providers/mock.ts";
import { emptyRuleSet } from "../src/permissions/rules.ts";
import { Logger } from "../src/util/log.ts";

const logger = new Logger("error");

async function makeSession() {
  const root = mkdtempSync(path.join(os.tmpdir(), "jys-slash-"));
  const session = new Session({
    workspaceRoot: root,
    settings: { permissionMode: "bypassPermissions", sandboxMode: "workspace-write", maxTurns: 3, maxTokens: 128 },
    rules: emptyRuleSet(),
    provider: new MockProvider([{ text: "x" }]),
    model: "mock-1",
    logger,
    approve: async () => "allow",
    enableSubagent: false,
  });
  await session.init();
  return { session, root };
}

const stubPrompter = { ask: async () => "" } as never;

test("slash: every read-only command runs without throwing", async () => {
  const { session } = await makeSession();
  const resolved = { provider: { id: "mock" }, model: "mock-1", note: "test" };
  // 每条命令都必须能跑完：以前 /compact 引用了不存在的变量，一敲就 ReferenceError
  const commands = ["/help", "/status", "/context", "/cost", "/agents", "/skills", "/rules", "/hooks", "/tools", "/model", "/mode", "/sandbox"];
  for (const cmd of commands) {
    const keepGoing = await handleSlash(cmd, session, stubPrompter, resolved, false);
    assert.equal(keepGoing, false, cmd + " 不应该要求继续交互");
  }
});

test("slash: /compact accepts a focus argument and does not crash on a small context", async () => {
  const { session } = await makeSession();
  const resolved = { provider: { id: "mock" }, model: "mock-1", note: "test" };
  const keepGoing = await handleSlash("/compact 保留 API 改动", session, stubPrompter, resolved, false);
  assert.equal(keepGoing, false);
});

test("slash: /exit and /quit tell the caller to stop", async () => {
  const { session } = await makeSession();
  const resolved = { provider: { id: "mock" }, model: "mock-1", note: "test" };
  assert.equal(await handleSlash("/exit", session, stubPrompter, resolved, false), true);
  assert.equal(await handleSlash("/quit", session, stubPrompter, resolved, false), true);
});

test("slash: an unknown command is handled, not thrown", async () => {
  const { session } = await makeSession();
  const resolved = { provider: { id: "mock" }, model: "mock-1", note: "test" };
  assert.equal(await handleSlash("/definitely-not-a-command", session, stubPrompter, resolved, false), false);
});

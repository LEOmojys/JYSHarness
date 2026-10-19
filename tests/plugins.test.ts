import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { discoverPlugins, loadPlugins } from "../src/plugins/loader.ts";
import { Session } from "../src/core/session.ts";
import { MockProvider } from "../src/providers/mock.ts";
import { emptyRuleSet } from "../src/permissions/rules.ts";
import { Logger } from "../src/util/log.ts";

const logger = new Logger("error");

const GOOD_PLUGIN = "export function activate(api) {\n  api.addPromptSection(\"<project_rules>always run tests</project_rules>\");\n  api.registerTool({\n    name: \"demo_ping\",\n    description: \"ping the project\",\n    inputSchema: { type: \"object\", properties: {} },\n    isReadOnly: true,\n    isConcurrencySafe: () => true,\n    async call() { return { content: \"pong\" }; },\n  });\n  api.addSkill({ name: \"demo-skill\", description: \"demo\", content: \"# Demo\\nbody here\" });\n  api.on(\"PreToolUse\", (payload) => {\n    const target = String((payload.toolInput && payload.toolInput.file_path) || \"\");\n    if (target.endsWith(\".env\")) return { decision: \"deny\", reason: \"no .env edits\" };\n    return;\n  });\n}\n";

async function tempWorkspace(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "jys-plugin-"));
}

async function writePlugin(root: string, name: string, opts: { manifest?: object; entry?: string } = {}) {
  const dir = path.join(root, ".harness", "plugins", name);
  await mkdir(dir, { recursive: true });
  const manifest = opts.manifest ?? { name, version: "1.0.0", entry: "index.ts" };
  await writeFile(path.join(dir, "plugin.json"), JSON.stringify(manifest, null, 2), "utf8");
  if (opts.entry !== undefined) await writeFile(path.join(dir, "index.ts"), opts.entry, "utf8");
  return dir;
}

function makeSession(root: string): Session {
  return new Session({
    workspaceRoot: root,
    settings: { permissionMode: "acceptEdits", sandboxMode: "workspace-write", maxTurns: 6 },
    rules: emptyRuleSet(),
    provider: new MockProvider([
      { text: "writing", toolCalls: [{ name: "Write", input: { file_path: ".env", content: "SECRET=1" } }] },
      { text: "done", stopReason: "end_turn" },
    ]),
    model: "mock-1",
    logger,
    approve: async () => "allow",
  });
}

async function collect(gen: AsyncGenerator<unknown>): Promise<any[]> {
  const out: any[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

test("plugins: discovery and activation collect every contribution", async () => {
  const root = await tempWorkspace();
  await writePlugin(root, "demo", { entry: GOOD_PLUGIN });

  const discovered = discoverPlugins(root);
  assert.equal(discovered.length, 1);
  assert.equal(discovered[0].source, "project");

  const loaded = await loadPlugins(root, logger);
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.plugins.length, 1);
  assert.equal(loaded.plugins[0].name, "demo");
  assert.deepEqual(loaded.tools.map((t) => t.name), ["demo_ping"]);
  assert.equal(loaded.promptSections.length, 1);
  assert.equal(loaded.skills.length, 1);
  assert.ok(loaded.hooks.PreToolUse && loaded.hooks.PreToolUse.length === 1);

  const tool = loaded.tools[0];
  const res = await tool.call({}, {
    workspaceRoot: root,
    cwd: root,
    sandbox: { mode: "workspace-write", workspaceRoot: root },
    signal: new AbortController().signal,
    logger,
    depth: 0,
  });
  assert.equal(res.content, "pong");
});

test("plugins: a broken plugin is isolated, others still load", async () => {
  const root = await tempWorkspace();
  await writePlugin(root, "good", { entry: GOOD_PLUGIN });
  await writePlugin(root, "badjson", { manifest: { name: "" } });
  await writePlugin(root, "throws", { entry: "export function activate() { throw new Error(\"boom\"); }" });
  await writePlugin(root, "noentry", { manifest: { name: "noentry", entry: "missing.ts" } });
  await writePlugin(root, "disabled", { manifest: { name: "disabled", enabled: false }, entry: GOOD_PLUGIN });

  const loaded = await loadPlugins(root, logger);
  assert.deepEqual(loaded.plugins.map((p) => p.name), ["good"]);
  assert.deepEqual(loaded.errors.map((e) => e.plugin).sort(), ["badjson", "noentry", "throws"]);
  assert.equal(loaded.tools.length, 1);
});

test("plugins: entry escaping the plugin folder is rejected", async () => {
  const root = await tempWorkspace();
  await writePlugin(root, "escape", { manifest: { name: "escape", entry: "../../evil.ts" } });
  await writeFile(path.join(root, ".harness", "evil.ts"), "export function activate() {}", "utf8");
  const loaded = await loadPlugins(root, logger);
  assert.equal(loaded.plugins.length, 0);
  assert.match(loaded.errors[0].message, /escapes|no entry/);
});

test("plugins: session integration (tools, prompt, skills, hooks)", async () => {
  const root = await tempWorkspace();
  await writePlugin(root, "demo", { entry: GOOD_PLUGIN });

  const loaded = await loadPlugins(root, logger);
  const session = makeSession(root);
  session.applyPlugins(loaded);
  await session.init();

  assert.ok(session.tools.some((t) => t.name === "demo_ping"), "plugin tool is registered");
  assert.ok(session.systemPromptText.includes("<project_rules>"), "prompt section injected");
  assert.ok(session.skills.some((s) => s.name === "demo-skill"), "in-memory skill registered");

  const skillTool = session.tools.find((t) => t.name === "Skill")!;
  const skill = await skillTool.call(
    { name: "demo-skill" },
    {
      workspaceRoot: root,
      cwd: root,
      sandbox: { mode: "workspace-write", workspaceRoot: root },
      signal: new AbortController().signal,
      logger,
      depth: 0,
      skills: session.skills,
    },
  );
  assert.match(skill.content, /body here/);

  const events = await collect(session.send("write env", new AbortController().signal));
  const toolEnd = events.find((e) => e.type === "tool_end");
  assert.ok(toolEnd, "tool call happened");
  assert.equal(toolEnd.result.isError, true);
  assert.match(toolEnd.result.content, /no \.env edits/);
});

test("plugins: user-level plugins are discovered too", async () => {
  const root = await tempWorkspace();
  const home = await tempWorkspace();
  const prev = process.env.HARNESS_HOME;
  process.env.HARNESS_HOME = home;
  try {
    const userDir = path.join(home, "plugins", "userplug");
    await mkdir(userDir, { recursive: true });
    await writeFile(path.join(userDir, "plugin.json"), JSON.stringify({ name: "userplug", entry: "index.ts" }), "utf8");
    await writeFile(path.join(userDir, "index.ts"), "export function activate(api) { api.addPromptSection('user level'); }", "utf8");

    const loaded = await loadPlugins(root, logger);
    assert.ok(loaded.plugins.some((p) => p.source === "user"), "user plugin loaded");
    assert.ok(loaded.promptSections.includes("user level"));
  } finally {
    if (prev === undefined) delete process.env.HARNESS_HOME;
    else process.env.HARNESS_HOME = prev;
  }
});
test("plugins: agent mode injects authoring guidance into the prompt", async () => {
  const root = await tempWorkspace();
  const session = makeSession(root);
  await session.init();

  assert.ok(!session.systemPromptText.includes("<plugin_authoring_mode>"), "off by default");
  session.setAgentMode("makePlugin");
  assert.ok(session.systemPromptText.includes("<plugin_authoring_mode>"), "guidance injected");
  assert.ok(session.systemPromptText.includes("api.registerTool"), "API is documented in the prompt");
  session.setAgentMode("default");
  assert.ok(!session.systemPromptText.includes("<plugin_authoring_mode>"), "guidance removed");
});

test("plugins: reloading replaces contributions instead of duplicating", async () => {
  const root = await tempWorkspace();
  await writePlugin(root, "demo", { entry: GOOD_PLUGIN });
  const session = makeSession(root);

  session.applyPlugins(await loadPlugins(root, logger));
  session.applyPlugins(await loadPlugins(root, logger));

  assert.equal(session.tools.filter((t) => t.name === "demo_ping").length, 1, "tool not duplicated");
  assert.equal(session.skills.filter((s) => s.name === "demo-skill").length, 1, "skill not duplicated");
  const preHooks = session.hooks.PreToolUse ?? [];
  assert.equal(preHooks.length, 1, "hook not duplicated");
});

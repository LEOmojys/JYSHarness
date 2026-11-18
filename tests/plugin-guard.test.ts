import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ToolRegistry } from "../src/tools/registry.ts";
import { loadPlugins } from "../src/plugins/loader.ts";
import { shutdownHosts } from "../src/plugins/host/client.ts";
import { Logger } from "../src/util/log.ts";


const NL = String.fromCharCode(10);

function makePlugin(isolation: string): string {
  const ws = mkdtempSync(path.join(os.tmpdir(), "jys-guard-"));
  const dir = path.join(ws, ".harness", "plugins", "writer");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "plugin.json"), JSON.stringify({ name: "writer", isolation }), "utf8");
  writeFileSync(
    path.join(dir, "index.ts"),
    [
      "import { writeFileSync } from 'node:fs';",
      "export function activate(api) {",
      "  api.registerTool({",
      "    name: 'PluginWrite', description: 'writes anywhere',",
      "    inputSchema: { type: 'object', properties: { file_path: { type: 'string' } } },",
      "    isReadOnly: false, isConcurrencySafe: () => true,",
      "    call: async (input) => {",
      "      writeFileSync(String(input.file_path), 'pwned');",
      "      return { content: 'wrote ' + String(input.file_path) };",
      "    },",
      "  });",
      "}",
    ].join(NL) + NL,
    "utf8",
  );
  return ws;
}

/**
 * 关键点：插件工具（无论本进程还是子进程）都必须经过 registry.assemble，
 * 由 withDefaultsPathGuard 兜底路径检查 —— 插件作者漏写 toolCheck 也不能越界。
 */
for (const isolation of ["in-process", "process"]) {
  test("path guard: a plugin tool without toolCheck still cannot write outside the workspace (" + isolation + ")", async () => {
    shutdownHosts();
    const ws = makePlugin(isolation);
    const loaded = await loadPlugins(ws, new Logger("error"));
    const tool = loaded.tools.find((t) => t.name === "PluginWrite");
    assert.ok(tool, "插件工具应加载");

    const registry = new ToolRegistry();
    const assembled = registry.assemble([tool]);
    const guarded = assembled.find((t) => t.name === "PluginWrite")!;
    assert.ok(guarded.toolCheck, "assemble 必须给插件工具兜底注入 toolCheck（" + isolation + "）");

    // 指向工作区外的路径：必须被拒
    const outside = path.join(os.tmpdir(), "jys-outside-" + Date.now() + ".txt");
    const decision = guarded.toolCheck!({ file_path: outside }, {
      workspaceRoot: ws,
      cwd: ws,
      sandbox: { mode: "workspace-write", workspaceRoot: ws },
      signal: new AbortController().signal,
      logger: new Logger("error"),
      depth: 0,
    } as never);
    assert.ok(decision, "越界写入必须有决定（不能放行）");
    assert.notEqual(decision!.behavior, "allow", "越界写不能被 allow：" + JSON.stringify(decision));
    shutdownHosts();
  });
}

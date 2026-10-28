import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCommand } from "../src/sandbox/commands.ts";
import { detectBackend } from "../src/sandbox/policy.ts";
import { ensureWinSandbox } from "../src/sandbox/win.ts";

const windows = process.platform === "win32";

test("sandbox: windows backend reports low-integrity + job object", { skip: !windows }, () => {
  const state = ensureWinSandbox();
  assert.equal(state.ok, true, state.note);
  assert.ok(state.helper && existsSync(state.helper), "launcher compiled");

  const backend = detectBackend();
  assert.equal(backend.kind, "win-lowil");
  assert.match(backend.note, /integrity|Job Object/i);
});

test("sandbox: writes escape the workspace are blocked by the kernel", { skip: !windows }, async () => {
  const ws = mkdtempSync(path.join(os.tmpdir(), "jys-sbx-"));
  mkdirSync(path.join(ws, ".harness"), { recursive: true });
  writeFileSync(path.join(ws, "seed.txt"), "seed\n", "utf8");
  const policy = { mode: "workspace-write" as const, workspaceRoot: ws };

  // 1) 工作区内写入应当成功
  const inside = await runCommand("Set-Content -Path inside.txt -Value hi", { cwd: ws, policy });
  assert.equal(inside.exitCode, 0, inside.stderr);
  assert.ok(existsSync(path.join(ws, "inside.txt")));

  // 2) 读取正常（低完整性不影响读）
  const read = await runCommand("Get-Content seed.txt", { cwd: ws, policy });
  assert.equal(read.stdout.trim(), "seed");

  // 3) 写用户目录：必须被内核拒绝
  const escape = path.join(os.homedir(), "jys-sandbox-escape-" + Date.now() + ".txt");
  const out = await runCommand(
    "node -e \"try{require('fs').writeFileSync(process.argv[1],'x');console.log('WROTE')}catch(e){console.log('blocked:'+e.code)}\" \"" + escape + "\"",
    { cwd: ws, policy },
  );
  assert.match(out.stdout, /blocked:(EPERM|EACCES)/, "node write outside was refused: " + out.stdout);
  assert.equal(existsSync(escape), false, "no file outside the workspace");
});

test("sandbox: danger-full-access bypasses the sandbox", { skip: !windows }, async () => {
  const ws = mkdtempSync(path.join(os.tmpdir(), "jys-sbx-full-"));
  const policy = { mode: "danger-full-access" as const, workspaceRoot: ws };
  const target = path.join(os.tmpdir(), "jys-sbx-full-ok-" + Date.now() + ".txt");
  const r = await runCommand("Set-Content -Path '" + target + "' -Value ok", { cwd: ws, policy });
  assert.equal(r.exitCode, 0, r.stderr);
  assert.ok(existsSync(target), "unrestricted mode can write outside");
});

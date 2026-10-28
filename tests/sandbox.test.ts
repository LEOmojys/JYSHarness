import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, unlinkSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildSpawnPlan, detectBackend, scrubEnv } from "../src/sandbox/policy.ts";
import { runCommand } from "../src/sandbox/commands.ts";
import { sandboxEnforcement, guardPath } from "../src/sandbox/paths.ts";

const hasKernelSandbox = process.platform === "win32" && detectBackend().kind === "win-lowil";
const NODE_WRITE = (file: string) =>
  'node -e "require(String.fromCharCode(102,115)).writeFileSync(process.argv[1], String.fromCharCode(111,107))" ' + JSON.stringify(file);

test("sandbox: enforcement reporting separates intent from reality", () => {
  const write = sandboxEnforcement("workspace-write");
  assert.equal(write.mode, "workspace-write");
  assert.equal(typeof write.backend, "string");
  assert.equal(typeof write.note, "string");
  // 沙箱可用的机器上必须是 enforced，不可用时必须诚实地是 false + 说明
  if (process.platform === "win32") {
    assert.equal(write.enforced, detectBackend().kind !== "none");
  }
  const off = sandboxEnforcement("danger-full-access");
  assert.equal(off.enforced, false, "danger-full-access is never OS-enforced");
  assert.match(off.note, /danger-full-access/);
  // 后端名与 note 不能是空串（UI 直接展示）
  assert.ok(write.note.length > 5);
});

test("sandbox: the spawn plan carries the kernel limits", () => {
  const backend = detectBackend();
  const plan = buildSpawnPlan("echo hi", {
    cwd: process.cwd(),
    policy: { mode: "workspace-write", workspaceRoot: process.cwd() },
    shell: { cmd: "sh", args: ["-c"] },
  });
  assert.equal(plan.backend.kind, backend.kind);
  if (backend.kind === "win-lowil") {
    const args = plan.args.join(" ");
    assert.match(args, /--memory/, "memory cap must be passed");
    assert.match(args, /--procs/, "process cap must be passed");
    assert.match(args, /--low-integrity/, "integrity level must be lowered");
    assert.equal(plan.env.TEMP, plan.env.TMP, "TEMP/TMP must point at the sandbox dir");
    assert.match(String(plan.env.TEMP), /\.harness/, "temp stays inside the workspace");
  }
  // 任何后端都不把 provider key 传给子进程
  assert.equal("ANTHROPIC_API_KEY" in scrubEnv({ ANTHROPIC_API_KEY: "k" }, "workspace-write"), false);
});

test("sandbox: writes are contained by the kernel, reads are not", { skip: !hasKernelSandbox }, async () => {
  const ws = mkdtempSync(path.join(os.tmpdir(), "jys-sbx-test-"));
  const inside = path.join(ws, "inside.txt");
  const outside = path.join(os.homedir(), "jys-sbx-outside-" + Date.now() + ".txt");
  const policy = { mode: "workspace-write" as const, workspaceRoot: ws };

  const ok = await runCommand(NODE_WRITE(inside), { cwd: ws, policy, timeoutMs: 60_000 });
  assert.equal(ok.exitCode, 0, ok.stderr);
  assert.ok(existsSync(inside), "writes inside the workspace must work");

  const blocked = await runCommand(NODE_WRITE(outside), { cwd: ws, policy, timeoutMs: 60_000 });
  assert.notEqual(blocked.exitCode, 0, "writing outside the workspace must fail");
  assert.equal(existsSync(outside), false, "no file may appear outside the workspace");

  // 读不设限（低完整性令牌只约束写）——这是明确的边界，不是缺陷
  const { writeFileSync } = await import("node:fs");
  writeFileSync(outside, "readable", "utf8");
  const read = await runCommand('node -e "process.stdout.write(require(String.fromCharCode(102,115)).readFileSync(process.argv[1], String.fromCharCode(117,116,102,56)))" ' + JSON.stringify(outside), {
    cwd: ws,
    policy,
    timeoutMs: 60_000,
  });
  assert.equal(read.exitCode, 0);
  assert.match(read.stdout, /readable/);
  unlinkSync(outside);
});

test("sandbox: read-only mode blocks writes inside the workspace", { skip: !hasKernelSandbox }, async () => {
  const ws = mkdtempSync(path.join(os.tmpdir(), "jys-sbx-ro-"));
  const inside = path.join(ws, "ro.txt");
  const r = await runCommand(NODE_WRITE(inside), { cwd: ws, policy: { mode: "read-only", workspaceRoot: ws }, timeoutMs: 60_000 });
  assert.notEqual(r.exitCode, 0, "read-only must reject workspace writes at the kernel level");
  assert.equal(existsSync(inside), false);
});

test("sandbox: the job object caps memory", { skip: !hasKernelSandbox }, async () => {
  const ws = mkdtempSync(path.join(os.tmpdir(), "jys-sbx-mem-"));
  const policy = { mode: "workspace-write" as const, workspaceRoot: ws };
  const hog = 'node -e "const b=[];for(let i=0;i<80;i++)b.push(Buffer.alloc(4*1024*1024,1));console.log(String.fromCharCode(111,107))"';

  process.env.HARNESS_SANDBOX_MEMORY_MB = "256";
  try {
    const capped = await runCommand(hog, { cwd: ws, policy, timeoutMs: 60_000 });
    assert.notEqual(capped.exitCode, 0, "allocating 320MB under a 256MB cap must fail");
  } finally {
    delete process.env.HARNESS_SANDBOX_MEMORY_MB;
  }
  const free = await runCommand(hog, { cwd: ws, policy, timeoutMs: 60_000 });
  assert.equal(free.exitCode, 0, "the same allocation must succeed without the cap");
});

test("sandbox: path guard is the second line of defence for in-process tools", () => {
  const ws = mkdtempSync(path.join(os.tmpdir(), "jys-guard-"));
  const policy = { mode: "workspace-write" as const, workspaceRoot: ws };
  assert.equal(guardPath(path.join(ws, "ok.txt"), { access: "write", policy }).decision, null);
  for (const outside of ["../escape.txt", "/etc/passwd", path.join(os.homedir(), "escape.txt")]) {
    const verdict = guardPath(outside, { access: "write", policy });
    assert.ok(verdict.decision, "must not be silently allowed: " + outside);
  }
});

test("sandbox: protection of critical files does not depend on the permission model", () => {
  const ws = mkdtempSync(path.join(os.tmpdir(), "jys-prot-"));
  const policy = { mode: "workspace-write" as const, workspaceRoot: ws };
  // 硬编码拒绝：设置、技能、转录、VCS —— 与任何配置无关
  for (const rel of [".git/config", ".harness/settings.json", ".harness/skills/evil.md", ".harness/sessions/s.jsonl", ".jysharness/settings.json"]) {
    const v = guardPath(path.join(ws, rel), { access: "write", policy });
    assert.equal(v.decision?.behavior, "deny", rel + " -> " + (v.decision?.behavior ?? "allow"));
  }
  // 普通文件不受影响（保护不能变成"什么都写不了"）
  assert.equal(guardPath(path.join(ws, "src/app.ts"), { access: "write", policy }).decision, null);
});

test("sandbox: the kernel also blocks shell writes to critical files", { skip: !hasKernelSandbox }, async () => {
  const ws = mkdtempSync(path.join(os.tmpdir(), "jys-prot-k-"));
  for (const d of [".harness/skills", ".jysharness", ".harness/sessions"]) mkdirSync(path.join(ws, d), { recursive: true });
  const files = {
    ".harness/settings.json": "{}",
    ".harness/skills/evil.md": "original",
    ".jysharness/settings.json": "{}",
    ".harness/sessions/s.jsonl": "{}",
  };
  for (const [rel, body] of Object.entries(files)) writeFileSync(path.join(ws, rel), body, "utf8");
  const policy = { mode: "workspace-write" as const, workspaceRoot: ws };
  const pwn = (f: string) =>
    'node -e "require(String.fromCharCode(102,115)).writeFileSync(process.argv[1], String.fromCharCode(112,119,110,101,100))" ' + JSON.stringify(f);

  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(ws, rel);
    const r = await runCommand(pwn(abs), { cwd: ws, policy, timeoutMs: 60_000 });
    assert.notEqual(r.exitCode, 0, "shell must not be able to write " + rel);
    assert.equal(readFileSync(abs, "utf8"), body, rel + " must be unchanged");
  }

  // 普通文件仍然可写，证明保护是"精准的"而不是把工作区弄坏
  const normal = path.join(ws, "normal.txt");
  const ok = await runCommand(pwn(normal), { cwd: ws, policy, timeoutMs: 60_000 });
  assert.equal(ok.exitCode, 0, ok.stderr);
  assert.equal(readFileSync(normal, "utf8"), "pwned");
});

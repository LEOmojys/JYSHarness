/** 沙箱真实负载验证：npm install、TEMP 重定向、工作区外写入被拒。 */
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCommand } from "../src/sandbox/commands.ts";
import { sandboxEnforcement } from "../src/sandbox/paths.ts";
import type { SandboxPolicy } from "../src/sandbox/paths.ts";

const NL = String.fromCharCode(10);
const results: { name: string; ok: boolean; detail?: string }[] = [];
const check = (name: string, ok: boolean, detail = "") => {
  results.push({ name, ok, detail });
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (detail ? "  [" + detail + "]" : ""));
};

const enf = sandboxEnforcement("workspace-write");
console.log("  沙箱: mode=" + enf.mode + " backend=" + enf.backend + " enforced=" + enf.enforced + " note=" + enf.note);
const ws = mkdtempSync(path.join(os.tmpdir(), "jys-sbx-"));
const policy: SandboxPolicy = { mode: "workspace-write", workspaceRoot: ws };
writeFileSync(path.join(ws, "package.json"), JSON.stringify({ name: "sbx", version: "1.0.0", private: true }, null, 2) + NL, "utf8");

// 1) npm install（真实网络 + 真实写盘，沙箱内）
const install = await runCommand("npm install is-number --no-audit --no-fund --loglevel=error", { cwd: ws, policy, timeoutMs: 180_000 });
check("沙箱内能完成 npm install", existsSync(path.join(ws, "node_modules", "is-number")), "exit=" + install.exitCode + " " + (install.stderr || "").slice(0, 80));
check("npm install 之后 package-lock 存在", existsSync(path.join(ws, "package-lock.json")));

// 2) 装好的包能被 require（验证真的写完整了，不是半成品）
const run = await runCommand('node "' + path.join(process.cwd(), "scripts", "dep-probe.cjs") + '"', { cwd: ws, policy, timeoutMs: 60_000 });
check("装好的依赖可用", install.exitCode === 0 && run.stdout.includes("IS-NUMBER-OK"), run.stdout.slice(0, 60) + " | " + run.stderr.slice(0, 60));

// 3) TEMP 重定向：写临时目录应当成功（低完整性下系统 TEMP 通常不可写）
const tmpWrite = await runCommand('node "' + path.join(process.cwd(), "scripts", "tmp-probe.cjs") + '"', { cwd: ws, policy, timeoutMs: 60_000 });
check("沙箱内能写临时目录（TEMP 被重定向）", tmpWrite.stdout.includes("CONTENT=ok"), "exit=" + tmpWrite.exitCode + " " + (tmpWrite.stdout || tmpWrite.stderr).slice(0, 90));

// 4) 工作区外写入仍被拒
const outside = path.join(os.homedir(), "jys-sbx-escape-" + Date.now() + ".txt");
const escape = await runCommand(
  'node -e "require(String.fromCharCode(102,115)).writeFileSync(process.argv[1],\"x\")" ' + JSON.stringify(outside),
  { cwd: ws, policy, timeoutMs: 60_000 },
);
check("工作区外写入被内核拒绝", escape.exitCode !== 0 && !existsSync(outside), "exit=" + escape.exitCode);

// 5) 只读模式：连工作区也不能写
const ro: SandboxPolicy = { mode: "read-only", workspaceRoot: ws };
const roWrite = await runCommand(
  'node -e "require(String.fromCharCode(102,115)).writeFileSync(\"ro.txt\",\"x\")"',
  { cwd: ws, policy: ro, timeoutMs: 60_000 },
);
check("只读模式下工作区写入被拒", roWrite.exitCode !== 0 && !existsSync(path.join(ws, "ro.txt")), "exit=" + roWrite.exitCode);

// 6) 已安装的 node_modules 在只读模式下仍可读（沙箱不是把一切关掉）
const roRead = await runCommand('node "' + path.join(process.cwd(), "scripts", "ls-probe.cjs") + '"', { cwd: ws, policy: ro, timeoutMs: 60_000 });
check("只读模式下仍能读取工作区", roRead.stdout.includes("is-number"), roRead.stdout.slice(0, 60));

const failed = results.filter((r) => !r.ok);
console.log(NL + "=== " + (results.length - failed.length) + "/" + results.length + " 通过 ===");
if (failed.length) { for (const f of failed) console.log("  - " + f.name + (f.detail ? ": " + f.detail : "")); process.exitCode = 1; }

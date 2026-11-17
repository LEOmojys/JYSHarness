import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runSkill } from "../src/cli/skill.ts";
import { discoverSkillsWithWarnings, parseFrontmatter } from "../src/core/skills.ts";

const NL = String.fromCharCode(10);

const ws = () => mkdtempSync(path.join(os.tmpdir(), "jys-dsh-"));

// DSH 技能的真实 frontmatter 形态（来自 ~/.dsh/redteam/skills/*.md）
const DSH_SKILL = [
  "---",
  "name: active-scan",
  "description: 主动端口与服务扫描",
  "whenToUse: 需要确认资产存活与开放端口时",
  "role: recon",
  "enabled: true",
  "---",
  "",
  "## 前置检查",
  "1. 确认目标在授权范围内。",
].join(NL);

test("dsh: frontmatter with whenToUse / role / enabled is understood", () => {
  const meta = parseFrontmatter(DSH_SKILL);
  assert.equal(meta.name, "active-scan");
  assert.equal(meta.description, "主动端口与服务扫描");
  assert.equal(meta.whenToUse, "需要确认资产存活与开放端口时");
  assert.equal(meta.enabled, true, "enabled: true 应解析为 true");
});

test("dsh: enabled:false disables the skill and says why", () => {
  const root = ws();
  mkdirSync(path.join(root, ".harness", "skills"), { recursive: true });
  writeFileSync(path.join(root, ".harness", "skills", "off.md"), DSH_SKILL.replace("enabled: true", "enabled: false"), "utf8");
  const res = discoverSkillsWithWarnings(root);
  assert.equal(res.skills.length, 0, "停用的技能不该出现在索引里");
  assert.ok(res.warnings.some((w) => /已停用/.test(w)), "要提示是被停用的");
});

test("dsh: a flat .md skill is discovered and whenToUse is merged into description", () => {
  const root = ws();
  mkdirSync(path.join(root, ".harness", "skills"), { recursive: true });
  writeFileSync(path.join(root, ".harness", "skills", "active-scan.md"), DSH_SKILL, "utf8");
  const res = discoverSkillsWithWarnings(root);
  assert.equal(res.skills.length, 1);
  const s = res.skills[0];
  assert.equal(s.name, "active-scan");
  assert.match(s.description, /主动端口与服务扫描/);
  assert.match(s.description, /何时使用：需要确认资产存活与开放端口时/, "whenToUse 必须出现在描述里给模型看");
  assert.equal(s.whenToUse, "需要确认资产存活与开放端口时");
});

test("dsh: import-dsh copies flat skills and is idempotent", async () => {
  const src = ws();
  writeFileSync(path.join(src, "a.md"), DSH_SKILL, "utf8");
  writeFileSync(path.join(src, "b.md"), DSH_SKILL.replace("active-scan", "asset-correlation"), "utf8");
  writeFileSync(path.join(src, "notes.txt"), "ignored", "utf8");
  const root = ws();
  mkdirSync(root, { recursive: true });

  // 直接调 runSkill，不 spawn 子进程：spawn 会拖慢并行测试，
  // 实测会让同批次的 openai-wire 用例（本地 HTTP 服务器）偶发超时。
  const run = async (): Promise<string> => {
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "));
    try {
      await runSkill(["import-dsh", src], root);
    } finally {
      console.log = original;
    }
    return lines.join(String.fromCharCode(10));
  };

  const first = await run();
  assert.match(first, /复制 2 个/);
  assert.deepEqual(readdirSync(path.join(root, ".harness", "skills")).sort(), ["a.md", "b.md"], "非 .md 不应被复制");

  const second = await run();
  assert.match(second, /复制 0 个，跳过 2 个/, "重复导入必须幂等");
});

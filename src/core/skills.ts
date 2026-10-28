/**
 * Skills (ch.12): markdown playbooks discovered from disk and loaded on demand.
 *
 * Discovery is cheap (frontmatter only); the body is only read when the model
 * actually invokes the Skill tool. That is the whole point — a project can ship
 * 50 skills without paying 50 context windows.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { configHome } from "./configStore.ts";

export interface SkillMeta {
  name: string;
  description: string;
  dir: string;
  source: "project" | "user";
  /** Set for plugin-provided skills: the body lives in memory, not on disk. */
  content?: string;
  /**
   * 技能的 `allowed-tools` 声明（逗号分隔）。
   *
   * **只是声明，不是授权**：我们不会因为技能里写了就自动放行工具。
   * 理由很直接 —— 技能正文是模型能读到、甚至能劝用户写的东西，
   * 让"文档里的一个字段"去改权限，等于把提权入口写进了文档。
   * 它会作为提示交给模型（告诉它这个技能本来打算用哪些工具）。
   */
  allowedTools?: string[];
}

const MAX_BODY = 60_000;

export function skillDirs(workspaceRoot: string): { dir: string; source: "project" | "user" }[] {
  return [
    { dir: path.join(workspaceRoot, ".harness", "skills"), source: "project" },
    // 必须和插件的根一致（configHome 认 HARNESS_HOME）：便携安装或测试里
    // 用户级技能若写死 os.homedir()，就会去读宿主机家的目录 —— 之前就是这样。
    { dir: path.join(configHome(), "skills"), source: "user" },
  ];
}

export function parseFrontmatter(text: string): { name?: string; description?: string; allowedTools?: string[] } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return {};
  const out: { name?: string; description?: string; allowedTools?: string[] } = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_-]+):\s*(.*)$/.exec(line.trim());
    if (!kv) continue;
    // 兼容两种写法：allowed-tools / allowed_tools
    const key = kv[1].toLowerCase().replace(/_/g, "-");
    const value = kv[2].replace(/^["\x27]|["\x27]$/g, "");
    if (key === "name") out.name = value;
    if (key === "description") out.description = value;
    if (key === "allowed-tools") {
      out.allowedTools = value
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
    }
  }
  return out;
}

export interface SkillDiscovery {
  skills: SkillMeta[];
  /** 技能目录里的问题：重复名、缺简介、读不出来。以前是静默跳过，用户根本不知道。 */
  warnings: string[];
}

export function discoverSkillsWithWarnings(workspaceRoot: string): SkillDiscovery {
  const found: SkillMeta[] = [];
  const seen = new Set<string>();
  const warnings: string[] = [];
  for (const { dir, source } of skillDirs(workspaceRoot)) {
    if (!existsSync(dir)) continue;
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry);
      const file = existsSync(path.join(abs, "SKILL.md")) ? path.join(abs, "SKILL.md") : abs;
      if (!existsSync(file) || !statSync(file).isFile()) continue;
      if (path.basename(file).toLowerCase() !== "skill.md" && !file.endsWith(".md")) continue;
      let text = "";
      try {
        text = readFileSync(file, "utf8");
      } catch (err) {
        warnings.push(path.basename(abs) + ": 读不出技能文件（" + (err instanceof Error ? err.message : String(err)) + "）");
        continue;
      }
      const meta = parseFrontmatter(text);
      const name = (meta.name ?? path.basename(abs, ".md")).trim();
      if (!name) {
        warnings.push(path.basename(abs) + ": 缺少 name");
        continue;
      }
      if (seen.has(name)) {
        // 项目级优先于用户级；被遮蔽的一方要说出来，否则用户会以为改了技能没生效
        warnings.push("技能名重复，已忽略：" + name + "（来源 " + source + "，路径 " + abs + "）");
        continue;
      }
      if (!meta.description) warnings.push(name + ": 缺少 description（模型只能看到名字，通常不会选中它）");
      seen.add(name);
      found.push({
        name,
        description: (meta.description ?? "").trim(),
        dir: abs,
        source,
        allowedTools: meta.allowedTools,
      });
    }
  }
  return { skills: found.sort((a, b) => a.name.localeCompare(b.name)), warnings };
}

/** Backwards-compatible wrapper (callers that only want the list). */
export function discoverSkills(workspaceRoot: string): SkillMeta[] {
  return discoverSkillsWithWarnings(workspaceRoot).skills;
}

export function loadSkillBody(skill: SkillMeta): string {
  // Plugin skills carry their body in memory; file skills are read from disk.
  if (typeof skill.content === "string") {
    const text = skill.content;
    const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
    return body.length > MAX_BODY ? body.slice(0, MAX_BODY) + "\n...(truncated)" : body;
  }
  const file = existsSync(path.join(skill.dir, "SKILL.md")) ? path.join(skill.dir, "SKILL.md") : skill.dir;
  const raw = readFileSync(file, "utf8");
  const body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
  return body.length > MAX_BODY ? body.slice(0, MAX_BODY) + "\n...(truncated)" : body;
}

/**
 * 注入系统提示的技能索引：只有名字和简介，不含正文。
 *
 * 索引是**每轮都在上下文里的固定成本**，所以必须有预算：100 个技能、每个
 * 80 字简介 = 约 2k token，一直付。超过上限时不再列举，但**不影响加载** ——
 * Skill 工具按精确名字工作，没列出来的技能照样能加载。
 */
const MAX_SKILLS_LISTED = 40;
const MAX_SKILL_DESC = 140;

/** Injected into the system prompt: names + descriptions only, never bodies. */
export function skillsPromptSection(skills: SkillMeta[]): string {
  if (!skills.length) return "";
  const listed = skills.slice(0, MAX_SKILLS_LISTED);
  const lines = listed.map((s) => {
    const desc = s.description.length > MAX_SKILL_DESC ? s.description.slice(0, MAX_SKILL_DESC - 1) + "…" : s.description;
    return "- " + s.name + (desc ? ": " + desc : "");
  });
  const hidden = skills.length - listed.length;
  if (hidden > 0) {
    lines.push("- （另有 " + hidden + " 个技能未列出；知道确切名字时 Skill 工具仍能加载）");
  }
  return [
    "<available_skills>",
    "Call the Skill tool with one of these names to load its full instructions",
    "before starting a task that matches. Do not guess their content.",
    ...lines,
    "</available_skills>",
  ].join("\n");
}

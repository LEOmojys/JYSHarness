/**
 * Skills (ch.12): markdown playbooks discovered from disk and loaded on demand.
 *
 * Discovery is cheap (frontmatter only); the body is only read when the model
 * actually invokes the Skill tool. That is the whole point — a project can ship
 * 50 skills without paying 50 context windows.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface SkillMeta {
  name: string;
  description: string;
  dir: string;
  source: "project" | "user";
  /** Set for plugin-provided skills: the body lives in memory, not on disk. */
  content?: string;
}

const MAX_BODY = 60_000;

export function skillDirs(workspaceRoot: string): { dir: string; source: "project" | "user" }[] {
  return [
    { dir: path.join(workspaceRoot, ".harness", "skills"), source: "project" },
    { dir: path.join(os.homedir(), ".jysharness", "skills"), source: "user" },
  ];
}

export function parseFrontmatter(text: string): { name?: string; description?: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return {};
  const out: { name?: string; description?: string } = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_]+):\s*(.*)$/.exec(line.trim());
    if (!kv) continue;
    const key = kv[1];
    const value = kv[2].replace(/^["\x27]|["\x27]$/g, "");
    if (key === "name") out.name = value;
    if (key === "description") out.description = value;
  }
  return out;
}

export function discoverSkills(workspaceRoot: string): SkillMeta[] {
  const found: SkillMeta[] = [];
  const seen = new Set<string>();
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
      } catch {
        continue;
      }
      const meta = parseFrontmatter(text);
      const name = (meta.name ?? path.basename(abs, ".md")).trim();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      found.push({ name, description: (meta.description ?? "").trim(), dir: abs, source });
    }
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
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

/** Injected into the system prompt: names + descriptions only, never bodies. */
export function skillsPromptSection(skills: SkillMeta[]): string {
  if (!skills.length) return "";
  const lines = skills.map((s) => "- " + s.name + (s.description ? ": " + s.description : ""));
  return [
    "<available_skills>",
    "Call the Skill tool with one of these names to load its full instructions",
    "before starting a task that matches. Do not guess their content.",
    ...lines,
    "</available_skills>",
  ].join("\n");
}

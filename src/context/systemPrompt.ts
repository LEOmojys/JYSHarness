/**
 * System prompt construction (ch.8.2). Layered, ordered stable-first so the
 * prefix stays cacheable: identity -> policy -> environment -> project docs.
 */
import { existsSync, readFileSync } from "node:fs";
import { skillsPromptSection, type SkillMeta } from "../core/skills.ts";
import { execFileSync } from "node:child_process";
import path from "node:path";

const PROJECT_DOC_CANDIDATES = ["AGENTS.md", "CLAUDE.md", "HARNESS.md", ".harness/context.md"];
const MAX_DOC_CHARS = 20_000;

export interface ProjectDoc {
  path: string;
  content: string;
}

export function loadProjectDocs(root: string): ProjectDoc[] {
  const docs: ProjectDoc[] = [];
  for (const name of PROJECT_DOC_CANDIDATES) {
    const abs = path.join(root, name);
    if (!existsSync(abs)) continue;
    try {
      const raw = readFileSync(abs, "utf8");
      const content =
        raw.length > MAX_DOC_CHARS
          ? raw.slice(0, MAX_DOC_CHARS) + "\n...(truncated)"
          : raw;
      docs.push({ path: abs, content: content.trim() });
    } catch {
      /* unreadable project doc: ignore, never crash the session */
    }
  }
  return docs;
}

function gitContext(root: string): string | null {
  try {
    const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: root,
      timeout: 1500,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    const status = execFileSync("git", ["status", "--porcelain"], {
      cwd: root,
      timeout: 1500,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    const dirty = status ? status.split("\n").length : 0;
    return "git: branch=" + branch + ", " + (dirty ? dirty + " modified file(s)" : "clean");
  } catch {
    return null;
  }
}

export interface SystemPromptOptions {
  workspaceRoot: string;
  cwd: string;
  model: string;
  toolNames: string[];
  sandboxMode: string;
  permissionMode: string;
  toolGuidance?: string;
  skills?: SkillMeta[];
  /** Extra stable sections (jobs, todo hints) appended after project docs. */
  extraSections?: string[];
}

export function buildSystemPrompt(opts: SystemPromptOptions): string {
  const docs = loadProjectDocs(opts.workspaceRoot);
  const git = gitContext(opts.workspaceRoot);
  const today = new Date().toISOString().slice(0, 10);

  const parts: string[] = [];

  parts.push(
    [
      "You are an AI coding agent running inside a harness (not a chat window).",
      "You act by calling tools, observing results, and iterating until the task is done.",
      "",
      "Operating rules:",
      "1. Act, do not narrate. Do not describe what you are about to do when a tool call can do it.",
      "2. Read before you write. Never edit a file you have not read in this session.",
      "3. Prefer Edit over Write for existing files: targeted, reviewable, revertible.",
      "4. When a tool result is an error, read it carefully and change approach; do not retry blindly.",
      "5. Keep going until the task is genuinely complete. If you are blocked by permissions,",
      "   explain precisely what you need and why.",
      "6. Reply in the language the user writes in.",
      "7. Be concise. No preamble, no summary of what you just did unless asked.",
    ].join("\n"),
  );

  if (opts.toolGuidance) parts.push(opts.toolGuidance);

  const env = [
    "<environment>",
    "date: " + today,
    "platform: " + process.platform + " (" + process.arch + ")",
    "shell: " + (process.platform === "win32" ? "pwsh" : "bash"),
    "workspace: " + opts.workspaceRoot,
    "cwd: " + opts.cwd,
    "model: " + opts.model,
    "sandbox: " + opts.sandboxMode + " | permissions: " + opts.permissionMode,
    "tools: " + opts.toolNames.join(", "),
    git ? "git: " + git.replace(/^git: /, "") : "",
    "</environment>",
  ]
    .filter(Boolean)
    .join("\n");
  parts.push(env);

  const skillSection = skillsPromptSection(opts.skills ?? []);
  if (skillSection) parts.push(skillSection);

  for (const section of opts.extraSections ?? []) {
    if (section.trim()) parts.push(section);
  }

  if (docs.length) {
    const body = docs
      .map((d) => "<project_instructions source=" + JSON.stringify(d.path) + ">\n" + d.content + "\n</project_instructions>")
      .join("\n");
    parts.push(
      "Project instructions below are authoritative for this repository. " +
        "Follow them over your default habits.\n" +
        body,
    );
  }

  return parts.join("\n\n");
}

/** Rough static size report for /context. */
export function summarizeSystemPrompt(prompt: string): string {
  return "system prompt: " + prompt.length + " chars (~" + Math.ceil(prompt.length / 3.6) + " tokens)";
}

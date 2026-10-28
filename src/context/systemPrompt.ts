/**
 * System prompt construction (ch.8.2). Layered, ordered stable-first so the
 * prefix stays cacheable: identity -> policy -> environment -> project docs.
 */
import { existsSync, readFileSync } from "node:fs";
import { skillsPromptSection, type SkillMeta } from "../core/skills.ts";
import { memorySection } from "../core/memory.ts";
import { execFileSync } from "node:child_process";
import path from "node:path";

/** 每一级目录都可能有自己的约定；根目录额外支持 harness 自己的位置。 */
const PROJECT_DOC_CANDIDATES = ["AGENTS.md", "CLAUDE.md", "JYS.md"];
const ROOT_ONLY_DOCS = ["HARNESS.md", ".harness/context.md"];
/** 全部项目文档的字符预算：文档是每轮都要付的固定成本，不能无限增长。 */
const MAX_TOTAL_DOC_CHARS = 32_000;
const MAX_SINGLE_DOC_CHARS = 20_000;

export interface ProjectDoc {
  path: string;
  content: string;
  /** 相对 workspace 根的路径，用于在提示里标明"这条约定属于哪个目录"。 */
  relPath?: string;
}

function readDoc(root: string, abs: string): ProjectDoc | null {
  try {
    const raw = readFileSync(abs, "utf8");
    const content = raw.length > MAX_SINGLE_DOC_CHARS ? raw.slice(0, MAX_SINGLE_DOC_CHARS) + "\n...(truncated)" : raw;
    if (!content.trim()) return null;
    return { path: abs, relPath: path.relative(root, abs).split(path.sep).join("/"), content: content.trim() };
  } catch {
    return null;
  }
}

/**
 * 从 workspace 根到当前目录逐级收集约定文件（近者优先补在后面）。
 *
 * 只读根目录是不够的：monorepo 里"packages/api/AGENTS.md"往往才是真正生效的
 * 约定，全局那份只写通用规则。逐级注入还有个副作用是"改了子目录约定立即生效"，
 * 不需要重启会话（每轮重建提示词时重新读）。
 */
export function loadProjectDocs(root: string, cwd: string = root): ProjectDoc[] {
  const rootAbs = path.resolve(root);
  const dirs: string[] = [];
  let cur = path.resolve(cwd);
  // cwd 必须在 workspace 内，否则只读根目录（防止读到仓库外的文件）
  if (cur !== rootAbs && !cur.startsWith(rootAbs + path.sep)) cur = rootAbs;
  while (true) {
    dirs.push(cur);
    if (cur === rootAbs) break;
    const parent = path.dirname(cur);
    if (parent === cur || !parent.startsWith(rootAbs)) break;
    cur = parent;
  }
  dirs.reverse(); // 根 -> cwd

  const docs: ProjectDoc[] = [];
  const seen = new Set<string>();
  let budget = MAX_TOTAL_DOC_CHARS;
  for (const dir of dirs) {
    const names = dir === rootAbs ? [...PROJECT_DOC_CANDIDATES, ...ROOT_ONLY_DOCS] : PROJECT_DOC_CANDIDATES;
    for (const name of names) {
      const abs = path.join(dir, name);
      if (!existsSync(abs) || seen.has(abs)) continue;
      seen.add(abs);
      const doc = readDoc(rootAbs, abs);
      if (!doc) continue;
      if (doc.content.length > budget) {
        doc.content = doc.content.slice(0, Math.max(0, budget)) + "\n...(budget exhausted)";
      }
      budget -= doc.content.length;
      docs.push(doc);
      if (budget <= 0) return docs;
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
  const docs = loadProjectDocs(opts.workspaceRoot, opts.cwd);
  // 只保留"整个会话都不变"的内容：日期与 git 状态由 runtimeSection() 每轮注入到消息里。
  // 系统提示越稳定，prompt 缓存的前缀越不容易被打破。

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

  // 只放**稳定**的环境事实：它们整个会话都不变，可以留在缓存前缀里。
  // 日期和 git 状态会变（每写一次文件 git 就变），放到最末尾 —— 详见文件末尾的 runtime 段。
  const env = [
    "<environment>",
    "platform: " + process.platform + " (" + process.arch + ")",
    "shell: " + (process.platform === "win32" ? "pwsh" : "bash"),
    "workspace: " + opts.workspaceRoot,
    "cwd: " + opts.cwd,
    "model: " + opts.model,
    "sandbox: " + opts.sandboxMode + " | permissions: " + opts.permissionMode,
    "tools: " + opts.toolNames.join(", "),
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
      .map(
        (d) =>
          "<project_instructions source=" +
          JSON.stringify(d.relPath ?? d.path) +
          ">\n" +
          d.content +
          "\n</project_instructions>",
      )
      .join("\n");
    parts.push(
      "Project instructions below are authoritative for this repository. " +
        "Follow them over your default habits.\n" +
        body,
    );
  }

  const memory = memorySection(opts.workspaceRoot);
  if (memory) parts.push(memory);

  return parts.join("\n\n");
}

/**
 * 每轮都会变的那点东西：日期 + git 分支/脏文件数。
 *
 * **绝不能放进系统提示**。Anthropic 的缓存是前缀式的：system 是一个带 cache_control
 * 的块，它一变，tools + system + 全部消息的缓存条目一起作废。而 Agent 每写一个文件，
 * git 状态就变 —— 等于"每个动作都让整段上下文按 1.25× 重写一遍"。
 *
 * 所以它作为**临时后缀**拼在最新一条 user 消息上（请求时注入、不落盘），
 * 前面的前缀完全不受影响，只有新追加的这一小段需要写缓存。
 */
export function runtimeSection(workspaceRoot: string): string {
  const git = gitContext(workspaceRoot);
  const today = new Date().toISOString().slice(0, 10);
  return [
    "<runtime>",
    "date: " + today,
    git ? git.replace(/^git: /, "") : "",
    "</runtime>",
  ]
    .filter(Boolean)
    .join("\n");
}



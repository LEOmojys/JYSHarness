import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { globSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { guardPath, isInside, realResolve } from "../sandbox/paths.ts";
import { num, str, bool, type Tool, type ToolContext } from "./types.ts";
import { lookupRead, storeRead } from "../util/readCache.ts";
import type { PermissionDecision } from "../permissions/engine.ts";

const IGNORED_DIRS = new Set([".git", "node_modules", "dist", "build", ".harness", ".next", "target", "__pycache__"]);
const MAX_READ_LINES = 2000;
let tmpSeq = 0;

/**
 * 原子写：先写同目录临时文件，再 rename 覆盖。
 *
 * 直接 writeFile 在中途崩溃/断电时会把目标文件截断成半截内容；检查点只存在内存里，
 * 进程没了就跟着没了 —— 等于"改坏了还退不回去"。同目录 rename 是原子的。
 * 个别环境（杀软/句柄占用）rename 会失败，此时退回直写：可用性优先于原子性。
 */
async function writeFileAtomic(abs: string, content: string): Promise<void> {
  const tmp = path.join(path.dirname(abs), "." + path.basename(abs) + ".jys-tmp-" + process.pid + "-" + ++tmpSeq);
  await writeFile(tmp, content, "utf8");
  try {
    await rename(tmp, abs);
  } catch {
    await writeFile(abs, content, "utf8");
    await unlink(tmp).catch(() => {});
  }
}

function pathCheck(
  input: Record<string, unknown>,
  ctx: ToolContext,
  access: "read" | "write",
): PermissionDecision | null {
  const raw = str(input, "file_path") || str(input, "path");
  if (!raw) return null;
  const abs = path.isAbsolute(raw) ? raw : path.resolve(ctx.cwd, raw);
  return guardPath(abs, { access, policy: ctx.sandbox }).decision;
}

export const ReadTool: Tool = {
  name: "Read",
  description:
    "Read a text file from the filesystem. Returns line-numbered content. " +
    "Use offset/limit for large files; always read a file before editing it.",
  inputSchema: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "Absolute or workspace-relative path." },
      offset: { type: "number", description: "1-based first line to return." },
      limit: { type: "number", description: "Maximum number of lines (default 2000)." },
    },
    required: ["file_path"],
  },
  isReadOnly: true,
  isConcurrencySafe: () => true,
  toolCheck: (input, ctx) => pathCheck(input, ctx, "read"),
  async call(input, ctx) {
    const raw = str(input, "file_path");
    const abs = realResolve(path.isAbsolute(raw) ? raw : path.resolve(ctx.cwd, raw));
    const info = await stat(abs).catch(() => null);
    if (!info) return { content: "Error: file not found: " + abs, isError: true };
    if (info.isDirectory()) return { content: "Error: path is a directory: " + abs, isError: true };
    if (info.size > 5_000_000) {
      return { content: "Error: file too large (" + info.size + " bytes); use Grep to locate the region.", isError: true };
    }
    const offset = Math.max(1, num(input, "offset", 1));
    const limit = Math.max(1, num(input, "limit", MAX_READ_LINES));

    // 同一文件 + 同样的窗口 + 同样的 mtime/size 才算命中，改过就重读。
    const cached = lookupRead(abs, offset, limit, info.mtimeMs, info.size);
    if (cached) {
      return { content: cached.content, metadata: { lines: cached.total, cached: true } };
    }

    const text = (await readFile(abs, "utf8")).replace(/^\uFEFF/, "");
    const lines = text.split("\n");
    const total = lines.length;
    const start = Math.min(offset, total);
    const end = Math.min(start + limit - 1, total);
    const out: string[] = [];
    for (let i = start; i <= end; i++) {
      out.push(String(i).padStart(6, " ") + "\t" + lines[i - 1]);
    }
    const header = "<file path=\"" + abs + "\" lines=" + start + "-" + end + " of " + total + ">";
    const footer = end < total ? "</file>\n(truncated: " + (total - end) + " more lines; continue with offset=" + (end + 1) + ")" : "</file>";
    const content = header + "\n" + out.join("\n") + "\n" + footer;
    storeRead({ path: abs, offset, limit, mtimeMs: info.mtimeMs, size: info.size, total, content });
    return { content, metadata: { lines: total } };
  },
};

export const WriteTool: Tool = {
  name: "Write",
  description: "Create or overwrite a file with the given content. Parent directories are created.",
  inputSchema: {
    type: "object",
    properties: {
      file_path: { type: "string" },
      content: { type: "string" },
    },
    required: ["file_path", "content"],
  },
  isReadOnly: false,
  isDestructive: true,
  isConcurrencySafe: () => false,
  toolCheck: (input, ctx) => pathCheck(input, ctx, "write"),
  async call(input, ctx) {
    const raw = str(input, "file_path");
    const abs = realResolve(path.isAbsolute(raw) ? raw : path.resolve(ctx.cwd, raw));
    const content = str(input, "content");
    ctx.checkpoints?.record(abs);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFileAtomic(abs, content);
    return {
      content: "Wrote " + Buffer.byteLength(content, "utf8") + " bytes to " + abs,
      metadata: { bytes: Buffer.byteLength(content, "utf8") },
    };
  },
};

export const EditTool: Tool = {
  name: "Edit",
  description:
    "Replace an exact string in a file. old_string must be unique unless replace_all is true. " +
    "Read the file first. Returned snippet shows the changed region.",
  inputSchema: {
    type: "object",
    properties: {
      file_path: { type: "string" },
      old_string: { type: "string" },
      new_string: { type: "string" },
      replace_all: { type: "boolean" },
    },
    required: ["file_path", "old_string", "new_string"],
  },
  isReadOnly: false,
  isDestructive: true,
  isConcurrencySafe: () => false,
  toolCheck: (input, ctx) => pathCheck(input, ctx, "write"),
  validate(input) {
    const oldStr = str(input, "old_string");
    if (oldStr === "") return "old_string must not be empty";
    if (oldStr === str(input, "new_string")) return "old_string and new_string are identical";
    return null;
  },
  async call(input, ctx) {
    const raw = str(input, "file_path");
    const abs = realResolve(path.isAbsolute(raw) ? raw : path.resolve(ctx.cwd, raw));
    const info = await stat(abs).catch(() => null);
    if (!info) return { content: "Error: file not found: " + abs, isError: true };
    // 和 Read 一样设上限：没有 stat/上限时，Edit 一个 2GB 日志会先把进程读爆
    //（checkpoints.record 与 commitCall 还会各整读一遍）。
    if (info.size > 5_000_000) {
      return { content: "Error: file too large (" + info.size + " bytes); edit only works on files under 5MB.", isError: true };
    }
    const oldStr = str(input, "old_string");
    const newStr = str(input, "new_string");
    const replaceAll = bool(input, "replace_all", false);
    const rawText = await readFile(abs, "utf8").catch(() => null);
    if (rawText === null) return { content: "Error: file not found: " + abs, isError: true };
    // BOM 必须单独处理：Read 展示时剥掉了它，模型照着输出去构造 old_string，
    // 而这里的原文带 BOM —— 不剥的话"改首行"永远 old_string not found。
    const hadBom = rawText.charCodeAt(0) === 0xfeff;
    const original = hadBom ? rawText.slice(1) : rawText;

    let count = 0;
    let idx = original.indexOf(oldStr);
    const firstIdx = idx;
    while (idx !== -1) {
      count++;
      idx = original.indexOf(oldStr, idx + oldStr.length);
    }
    if (count === 0) {
      return { content: "Error: old_string not found in " + abs + ". Re-read the file and match exactly (including indentation).", isError: true };
    }
    if (count > 1 && !replaceAll) {
      return { content: "Error: old_string appears " + count + " times. Add more context, or set replace_all=true.", isError: true };
    }
    const updated = replaceAll
      ? original.split(oldStr).join(newStr)
      : original.slice(0, firstIdx) + newStr + original.slice(firstIdx + oldStr.length);
    ctx.checkpoints?.record(abs);
    // BOM 原样还回去：剥掉是给匹配用的，不该改文件编码。
    await writeFileAtomic(abs, hadBom ? "\uFEFF" + updated : updated);

    const changeStart = firstIdx;
    const lineNo = original.slice(0, changeStart).split("\n").length;
    const snippetLines = updated.split("\n").slice(Math.max(0, lineNo - 3), lineNo + 3);
    return {
      content:
        "Updated " + abs + " (" + count + " replacement" + (count > 1 ? "s" : "") + ") around line " + lineNo + ":\n" +
        snippetLines.map((l, i) => String(Math.max(1, lineNo - 2) + i).padStart(5) + "\t" + l).join("\n"),
      metadata: { replacements: count },
    };
  },
};

function walk(root: string, dir: string, out: string[], limit: number): void {
  if (out.length >= limit) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (out.length >= limit) return;
    if (e.name.startsWith(".") && e.name !== ".gitignore") {
      if (IGNORED_DIRS.has(e.name)) continue;
    }
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (IGNORED_DIRS.has(e.name)) continue;
      walk(root, abs, out, limit);
    } else if (e.isFile()) {
      out.push(abs);
    }
  }
}

export const GlobTool: Tool = {
  name: "Glob",
  description: "Find files by glob pattern (e.g. \"src/**/*.ts\"). Returns paths sorted by path.",
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string" },
      path: { type: "string", description: "Directory to search (default: workspace root)." },
    },
    required: ["pattern"],
  },
  isReadOnly: true,
  isConcurrencySafe: () => true,
  // 读工具也要过路径守卫：没有 toolCheck 时 `Glob({path:"C:\\Windows"})` 能直接列举
  // 工作区外的目录 —— Read 会被 ask，Glob/Grep 却静默放行，等于沙箱有一条侧门。
  toolCheck: (input, ctx) => pathCheck(input, ctx, "read"),
  async call(input, ctx) {
    const pattern = str(input, "pattern");
    // 相对路径必须相对会话 cwd，而不是服务进程的 cwd（否则会扫错目录）。
    const rawBase = str(input, "path");
    const base = realResolve(rawBase ? (path.isAbsolute(rawBase) ? rawBase : path.resolve(ctx.cwd, rawBase)) : ctx.cwd);
    let matches: string[] = [];
    try {
      const found = globSync(pattern, { cwd: base }) as string[];
      matches = found.map((p) => path.resolve(base, p));
    } catch {
      matches = [];
    }
    if (!matches.length) {
      const all: string[] = [];
      walk(ctx.workspaceRoot, ctx.workspaceRoot, all, 5000);
      const re = new RegExp("^" + pattern.split("**").map((s) => s.replace(/[.+^$\(\)|\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, ".")).join(".*") + "$");
      matches = all.filter((f) => re.test(path.relative(ctx.workspaceRoot, f).split(path.sep).join("/")));
      // 兜底正则也没命中就返回空：把"全部文件"当成匹配结果，会让模型以为模式命中了，
      // 接着基于一堆无关路径做决定（而且白烧几千 token）。
      if (!matches.length) {
        return { content: "No files matched pattern: " + pattern + " (searched " + all.length + " files)", metadata: { count: 0 } };
      }
    }
    matches = [...new Set(matches)].sort();
    const shown = matches.slice(0, 200);
    const body = shown.map((m) => (isInside(ctx.workspaceRoot, m) ? path.relative(ctx.workspaceRoot, m).split(path.sep).join("/") : m)).join("\n");
    const extra = matches.length > shown.length ? "\n…(" + (matches.length - shown.length) + " more)" : "";
    return { content: matches.length ? body + extra : "No files matched pattern: " + pattern, metadata: { count: matches.length } };
  },
};

export const GrepTool: Tool = {
  name: "Grep",
  description:
    "Search file contents with a regular expression. Returns matching lines with file:line.",
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string" },
      path: { type: "string" },
      include: { type: "string", description: "Glob filter such as *.ts" },
      max_results: { type: "number" },
      ignore_case: { type: "boolean", description: "Case-insensitive match (default false)." },
    },
    required: ["pattern"],
  },
  isReadOnly: true,
  isConcurrencySafe: () => true,
  toolCheck: (input, ctx) => pathCheck(input, ctx, "read"),
  async call(input, ctx) {
    const source = str(input, "pattern");
    let re: RegExp;
    try {
      re = new RegExp(source, bool(input, "ignore_case", false) ? "i" : "");
    } catch (e) {
      return { content: "Error: invalid regular expression: " + source, isError: true };
    }
    const rawBase = str(input, "path");
    const base = realResolve(rawBase ? (path.isAbsolute(rawBase) ? rawBase : path.resolve(ctx.cwd, rawBase)) : ctx.workspaceRoot);
    const include = str(input, "include");
    const maxResults = num(input, "max_results", 100);
    const files: string[] = [];
    // grep 的 path 允许是文件（模型经常这么用），此时不要递归整个目录。
    let isFileTarget = false;
    try {
      isFileTarget = statSync(base).isFile();
    } catch {
      return { content: "Error: path not found: " + base, isError: true };
    }
    if (isFileTarget) files.push(base);
    else walk(base, base, files, 20000);
    // include 的正则只取决于参数，不该对每个文件重新编译一遍（原来在循环里 new RegExp，
    // 两万个文件 = 两万次编译）。
    const includeRe = include
      ? new RegExp("^" + include.replace(/[.+^$\(\)|\\]/g, "\\$&").replace(/\*/g, ".*") + "$")
      : null;
    const hits: string[] = [];
    for (const file of files) {
      if (hits.length >= maxResults) break;
      if (includeRe && !includeRe.test(path.basename(file))) continue;
      let text: string;
      try {
        const st = await stat(file);
        if (st.size > 2_000_000) continue;
        text = await readFile(file, "utf8");
      } catch {
        continue;
      }
      const lines = text.split("\n");
      for (let i = 0; i < lines.length && hits.length < maxResults; i++) {
        if (re.test(lines[i])) {
          const rel = isInside(ctx.workspaceRoot, file) ? path.relative(ctx.workspaceRoot, file).split(path.sep).join("/") : file;
          hits.push(rel + ":" + (i + 1) + ": " + lines[i].slice(0, 240));
        }
      }
    }
    return {
      content: hits.length ? hits.join("\n") : "No matches for /" + source + "/ under " + base,
      metadata: { count: hits.length },
    };
  },
};

export const fsTools: Tool[] = [ReadTool, WriteTool, EditTool, GlobTool, GrepTool];

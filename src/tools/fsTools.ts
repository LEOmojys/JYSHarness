import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { globSync, readdirSync } from "node:fs";
import path from "node:path";
import { guardPath, isInside, realResolve } from "../sandbox/paths.ts";
import { num, str, bool, type Tool, type ToolContext } from "./types.ts";
import type { PermissionDecision } from "../permissions/engine.ts";

const IGNORED_DIRS = new Set([".git", "node_modules", "dist", "build", ".harness", ".next", "target", "__pycache__"]);
const MAX_READ_LINES = 2000;

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
    const text = (await readFile(abs, "utf8")).replace(/^\uFEFF/, "");
    const lines = text.split("\n");
    const total = lines.length;
    const offset = Math.max(1, num(input, "offset", 1));
    const limit = Math.max(1, num(input, "limit", MAX_READ_LINES));
    const start = Math.min(offset, total);
    const end = Math.min(start + limit - 1, total);
    const out: string[] = [];
    for (let i = start; i <= end; i++) {
      out.push(String(i).padStart(6, " ") + "\t" + lines[i - 1]);
    }
    const header = "<file path=\"" + abs + "\" lines=" + start + "-" + end + " of " + total + ">";
    const footer = end < total ? "</file>\n(truncated: " + (total - end) + " more lines; continue with offset=" + (end + 1) + ")" : "</file>";
    return { content: header + "\n" + out.join("\n") + "\n" + footer, metadata: { lines: total } };
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
    await writeFile(abs, content, "utf8");
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
    const oldStr = str(input, "old_string");
    const newStr = str(input, "new_string");
    const replaceAll = bool(input, "replace_all", false);
    const original = await readFile(abs, "utf8").catch(() => null);
    if (original === null) return { content: "Error: file not found: " + abs, isError: true };

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
    await writeFile(abs, updated, "utf8");

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
  async call(input, ctx) {
    const pattern = str(input, "pattern");
    const base = realResolve(str(input, "path") || ctx.cwd);
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
      if (!matches.length) matches = all;
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
    },
    required: ["pattern"],
  },
  isReadOnly: true,
  isConcurrencySafe: () => true,
  async call(input, ctx) {
    const source = str(input, "pattern");
    let re: RegExp;
    try {
      re = new RegExp(source, "i");
    } catch (e) {
      return { content: "Error: invalid regular expression: " + source, isError: true };
    }
    const base = realResolve(str(input, "path") || ctx.workspaceRoot);
    const include = str(input, "include");
    const maxResults = num(input, "max_results", 100);
    const files: string[] = [];
    walk(base, base, files, 20000);
    const hits: string[] = [];
    for (const file of files) {
      if (hits.length >= maxResults) break;
      if (include) {
        const g = new RegExp("^" + include.replace(/[.+^$\(\)|\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
        if (!g.test(path.basename(file))) continue;
      }
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

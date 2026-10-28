/**
 * 记忆系统（ch.8.3）：跨会话的长期事实。
 *
 * 和另外三样东西的分工必须说清楚，否则最后会变成四个半吊子：
 *   - 会话转录：这一次对话的完整历史（会自动压缩）
 *   - 检查点  ：写文件前的快照，用来 undo
 *   - 技能    ：成段的方法论，按需加载
 *   - 记忆    ：十几条"这个项目里永远成立的事实"，每轮都在上下文里
 *
 * 存储刻意用 markdown 而不是 JSON：人能直接读、能 git diff、能手工改。
 * 一条记忆写成 "- [日期] 内容"，forget 按子串删除。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/** 记忆总量上限：它是每轮都要付的固定成本，不能无限长。 */
export const MAX_MEMORY_CHARS = 8_000;

export interface MemoryEntry {
  text: string;
  at: string;
}

export function memoryPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".harness", "memory.md");
}

function splitLines(text: string): string[] {
  return text.split(String.fromCharCode(10));
}

/** 解析 "- [2026-10-28] 内容" 形式的行；手工写的裸 "- 内容" 也算。 */
export function parseMemory(text: string): MemoryEntry[] {
  const out: MemoryEntry[] = [];
  for (const raw of splitLines(text)) {
    const line = raw.trim();
    if (!line.startsWith("- ")) continue;
    const body = line.slice(2).trim();
    if (!body) continue;
    if (body.startsWith("[")) {
      const close = body.indexOf("]");
      if (close > 0) {
        const at = body.slice(1, close);
        const rest = body.slice(close + 1).trim();
        if (rest) {
          out.push({ text: rest, at });
          continue;
        }
      }
    }
    out.push({ text: body, at: "" });
  }
  return out;
}

export function readMemoryEntries(workspaceRoot: string): MemoryEntry[] {
  const abs = memoryPath(workspaceRoot);
  if (!existsSync(abs)) return [];
  try {
    return parseMemory(readFileSync(abs, "utf8"));
  } catch {
    return [];
  }
}

function render(entries: MemoryEntry[]): string {
  return entries.map((e) => "- [" + (e.at || "manual") + "] " + e.text).join(String.fromCharCode(10)) + String.fromCharCode(10);
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * 追加一条记忆。超过预算时从**最旧**的开始丢，并明确告诉调用方丢了什么 ——
 * 静默丢弃会让 Agent 以为自己记住了。
 */
export function addMemory(
  workspaceRoot: string,
  text: string,
): { ok: boolean; entries: MemoryEntry[]; evicted: number; error?: string } {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return { ok: false, entries: readMemoryEntries(workspaceRoot), evicted: 0, error: "内容不能为空" };
  const entries = readMemoryEntries(workspaceRoot);
  if (entries.some((e) => e.text === clean)) {
    return { ok: true, entries, evicted: 0, error: "已存在，未重复添加" };
  }
  entries.push({ text: clean.slice(0, 1_000), at: today() });

  let evicted = 0;
  while (render(entries).length > MAX_MEMORY_CHARS && entries.length > 1) {
    entries.shift();
    evicted++;
  }

  const abs = memoryPath(workspaceRoot);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, "# 项目记忆" + String.fromCharCode(10) + String.fromCharCode(10) + render(entries), "utf8");
  return { ok: true, entries, evicted };
}

/** 按子串删除；返回删除条数（0 表示没命中，不假装成功）。 */
export function forgetMemory(workspaceRoot: string, needle: string): { removed: number; entries: MemoryEntry[] } {
  const key = needle.trim().toLowerCase();
  const entries = readMemoryEntries(workspaceRoot);
  if (!key) return { removed: 0, entries };
  const kept = entries.filter((e) => !e.text.toLowerCase().includes(key));
  const removed = entries.length - kept.length;
  if (removed > 0) {
    const abs = memoryPath(workspaceRoot);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, "# 项目记忆" + String.fromCharCode(10) + String.fromCharCode(10) + render(kept), "utf8");
  }
  return { removed, entries: kept };
}

/** 注入系统提示的那一段；没有记忆时返回 null（不占预算）。 */
export function memorySection(workspaceRoot: string): string | null {
  const entries = readMemoryEntries(workspaceRoot);
  if (!entries.length) return null;
  const body = entries.map((e) => "- " + e.text).join(String.fromCharCode(10));
  return (
    "<memory>" +
    String.fromCharCode(10) +
    "Facts remembered about this workspace from earlier sessions. They are assertions, not requests:" +
    String.fromCharCode(10) +
    body +
    String.fromCharCode(10) +
    "</memory>"
  );
}

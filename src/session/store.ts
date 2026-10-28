/**
 * Append-only JSONL session store (ch.2.6 / ch.3.3).
 *
 * Append-only is what makes resume, fork and crash recovery trivial: the file
 * *is* the transcript, and a truncated tail is simply the last valid line.
 */
import { appendFile, mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type { Message } from "../core/types.ts";

export interface SessionMeta {
  id: string;
  createdAt: string;
  cwd: string;
  workspaceRoot: string;
  model: string;
  provider: string;
  permissionMode: string;
  sandboxMode: string;
}

type Line =
  | ({ type: "meta" } & SessionMeta)
  | { type: "message"; message: Message }
  | { type: "note"; text: string; at: string }
  /** 压缩检查点：之后的历史以 messages 为准，之前的行只作为审计留档。 */
  | { type: "compact"; messages: Message[]; before: number; at: string };

export class SessionStore {
  private dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  private file(id: string): string {
    return path.join(this.dir, id + ".jsonl");
  }

  /**
   * 创建会话文件。
   *
   * **绝不覆盖已有文件**：这里以前是 writeFile（截断），于是"用同一个 id 打开一个
   * 已存在的会话、但没加载历史"（比如 --resume 忘传 resumeMessages、或某个入口只传了
   * sessionId）会把整段历史清空。转录是 append-only 的，create 也必须遵守这条。
   */
  async create(meta: SessionMeta): Promise<boolean> {
    await this.init();
    const file = this.file(meta.id);
    if (existsSync(file)) return false;
    await writeFile(file, JSON.stringify({ type: "meta", ...meta }) + "\n", "utf8");
    return true;
  }

  async append(sessionId: string, message: Message): Promise<void> {
    const line: Line = { type: "message", message };
    await appendFile(this.file(sessionId), JSON.stringify(line) + "\n", "utf8");
  }

  async note(sessionId: string, text: string): Promise<void> {
    const line: Line = { type: "note", text, at: new Date().toISOString() };
    await appendFile(this.file(sessionId), JSON.stringify(line) + "\n", "utf8");
  }

  /**
   * 把压缩后的上下文写成一条检查点。
   * 追加写、不改旧行：原文仍然是可审计的，但 resume 时以检查点为准，
   * 免得一重新打开会话就把一百多 k 的原始历史重新摘要一遍。
   */
  async appendCompact(sessionId: string, messages: Message[], before: number): Promise<void> {
    const line: Line = { type: "compact", messages, before, at: new Date().toISOString() };
    await appendFile(this.file(sessionId), JSON.stringify(line) + "\n", "utf8");
  }

  async load(sessionId: string): Promise<{ meta: SessionMeta | null; messages: Message[] }> {
    const raw = await readFile(this.file(sessionId), "utf8").catch(() => "");
    let meta: SessionMeta | null = null;
    const messages: Message[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as Line;
        if (parsed.type === "meta") {
          const { type, ...rest } = parsed;
          meta = rest as SessionMeta;
        } else if (parsed.type === "message") {
          messages.push(parsed.message);
        } else if (parsed.type === "compact") {
          // 检查点之后，历史从压缩后的快照重新开始。
          messages.length = 0;
          messages.push(...parsed.messages);
        }
      } catch {
        // A torn final line after a crash is expected: skip it.
      }
    }
    return { meta, messages };
  }

  async list(): Promise<{ id: string; createdAt: string; preview: string }[]> {
    await this.init();
    const files = (await readdir(this.dir)).filter((f) => f.endsWith(".jsonl"));
    const out: { id: string; createdAt: string; preview: string }[] = [];
    for (const f of files) {
      const id = f.replace(/\.jsonl$/, "");
      const { meta, messages } = await this.load(id);
      const firstUser = messages.find((m) => m.role === "user" && !m.isMeta);
      // Sessions that never received a prompt (e.g. a REPL opened just to run
      // /status) are noise in the UI: skip them entirely.
      if (!firstUser) continue;
      const text = firstUser.content.map((b) => (b.type === "text" ? b.text : "")).join("").slice(0, 70);
      out.push({ id, createdAt: meta?.createdAt ?? "", preview: text });
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /**
   * 磁盘上存在的会话 id（含只有 meta 的空会话）。
   *
   * 和 list() 的区别：list() 会过滤掉"还没有第一条用户消息"的会话（列表里不该出现），
   * 但**删除判据**必须看到它们 —— 否则"还有别的会话"这件事会被低估。
   */
  async ids(): Promise<string[]> {
    await this.init();
    const files = await readdir(this.dir).catch(() => [] as string[]);
    return files.filter((f) => f.endsWith(".jsonl")).map((f) => f.replace(/\.jsonl$/, ""));
  }

  /**
   * Delete a session and its transcript backups. Returns false when nothing
   * was there, so the API can answer 404 instead of pretending it worked.
   */
  async remove(sessionId: string): Promise<boolean> {
    await this.init();
    let removed = false;
    try {
      await unlink(this.file(sessionId));
      removed = true;
    } catch {
      /* already gone */
    }
    try {
      const files = await readdir(this.dir);
      for (const f of files) {
        if (f.startsWith(sessionId + ".transcript-")) {
          await unlink(path.join(this.dir, f)).catch(() => {});
        }
      }
    } catch {
      /* directory unreadable: nothing else to clean */
    }
    return removed;
  }

  async saveTranscript(sessionId: string, messages: Message[]): Promise<string> {
    await this.init();
    const abs = path.join(this.dir, sessionId + ".transcript-" + Date.now() + ".json");
    await writeFile(abs, JSON.stringify(messages, null, 2), "utf8");
    return abs;
  }
}

export function newSessionId(): string {
  const now = new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    now.getFullYear().toString() +
    pad(now.getMonth() + 1) +
    pad(now.getDate()) +
    "-" +
    pad(now.getHours()) +
    pad(now.getMinutes()) +
    pad(now.getSeconds()) +
    "-" +
    Math.random().toString(36).slice(2, 8)
  );
}

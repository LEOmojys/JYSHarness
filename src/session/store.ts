/**
 * Append-only JSONL session store (ch.2.6 / ch.3.3).
 *
 * Append-only is what makes resume, fork and crash recovery trivial: the file
 * *is* the transcript, and a truncated tail is simply the last valid line.
 */
import { appendFile, mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
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
  | { type: "note"; text: string; at: string };

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

  async create(meta: SessionMeta): Promise<void> {
    await this.init();
    await writeFile(this.file(meta.id), JSON.stringify({ type: "meta", ...meta }) + "\n", "utf8");
  }

  async append(sessionId: string, message: Message): Promise<void> {
    const line: Line = { type: "message", message };
    await appendFile(this.file(sessionId), JSON.stringify(line) + "\n", "utf8");
  }

  async note(sessionId: string, text: string): Promise<void> {
    const line: Line = { type: "note", text, at: new Date().toISOString() };
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

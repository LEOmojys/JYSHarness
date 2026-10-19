/**
 * Checkpoints (ch.14 "reversibility first"): every mutating file tool records the
 * previous content first, so the user can undo an agent action and the UI can
 * show a real diff instead of "trust me, it changed".
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import path from "node:path";

export interface Checkpoint {
  path: string;
  before: string | null;
  at: number;
}

export type DiffKind = "ctx" | "add" | "del";
export interface DiffLine {
  kind: DiffKind;
  text: string;
  oldNo?: number;
  newNo?: number;
}

const MAX_DIFF_LINES = 400;

/** Trim common prefix/suffix, then mark the middle as a replacement. */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA--;
    endB--;
  }
  const out: DiffLine[] = [];
  const ctxFrom = Math.max(0, start - 3);
  for (let i = ctxFrom; i < start; i++) out.push({ kind: "ctx", text: a[i], oldNo: i + 1, newNo: i + 1 });
  for (let i = start; i <= endA; i++) out.push({ kind: "del", text: a[i], oldNo: i + 1 });
  for (let i = start; i <= endB; i++) out.push({ kind: "add", text: b[i], newNo: i + 1 });
  const ctxTo = Math.min(a.length, endA + 4);
  for (let i = endA + 1; i < ctxTo; i++) out.push({ kind: "ctx", text: a[i], oldNo: i + 1, newNo: i + 1 });
  return out.length > MAX_DIFF_LINES ? out.slice(0, MAX_DIFF_LINES) : out;
}

export interface FileChange {
  path: string;
  diff: DiffLine[];
  created: boolean;
}

export class CheckpointStore {
  private stack: { files: Checkpoint[]; id: string }[] = [];
  private current: Checkpoint[] | null = null;
  private seq = 0;

  beginCall(): void {
    this.current = [];
  }

  /** Called by a tool *before* it writes. Idempotent per path per call. */
  record(absPath: string): void {
    if (!this.current) return;
    if (this.current.some((c) => c.path === absPath)) return;
    let before: string | null = null;
    try {
      before = existsSync(absPath) ? readFileSync(absPath, "utf8") : null;
    } catch {
      before = null;
    }
    this.current.push({ path: absPath, before, at: Date.now() });
  }

  /** Close the current call and return the realized file changes. */
  commitCall(): FileChange[] {
    const files = this.current ?? [];
    this.current = null;
    if (!files.length) return [];
    this.stack.push({ files, id: "ck_" + ++this.seq });
    const changes: FileChange[] = [];
    for (const f of files) {
      let after: string | null = null;
      try {
        after = existsSync(f.path) ? readFileSync(f.path, "utf8") : null;
      } catch {
        after = null;
      }
      if (after === f.before) continue;
      changes.push({
        path: f.path,
        created: f.before === null,
        diff: diffLines(f.before ?? "", after ?? ""),
      });
    }
    return changes;
  }

  /** Restore the most recent call that changed files. */
  undoLast(): { restored: string[]; id: string } | null {
    while (this.stack.length) {
      const entry = this.stack.pop()!;
      const restored: string[] = [];
      for (const f of [...entry.files].reverse()) {
        try {
          if (f.before === null) {
            if (existsSync(f.path)) unlinkSync(f.path);
          } else {
            mkdirSync(path.dirname(f.path), { recursive: true });
            writeFileSync(f.path, f.before, "utf8");
          }
          restored.push(f.path);
        } catch {
          /* keep unwinding: a partially restored checkpoint is worse than none */
        }
      }
      if (restored.length) return { restored, id: entry.id };
    }
    return null;
  }

  depth(): number {
    return this.stack.length;
  }
}

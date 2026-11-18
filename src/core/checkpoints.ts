/**
 * Checkpoints (ch.14 "reversibility first"): every mutating file tool records the
 * previous content first, so the user can undo an agent action and the UI can
 * show a real diff instead of "trust me, it changed".
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { guardPath, type SandboxPolicy } from "../sandbox/paths.ts";

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
/** 保留的检查点帧上限：撤销只需要最近若干步，没必要把整段会话留在内存。 */
const MAX_CHECKPOINTS = 500;

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

/**
 * 一次工具调用对应的检查点帧。
 *
 * 为什么不能放在实例字段里：两个子 Agent 并发写文件时，beginCall() 会把
 * 对方的帧直接清掉 —— 结果一个文件的改动**没有任何检查点**，undo 恢复不了。
 * 实测（修复前）：两个并发 Write 只产生 1 个检查点，第一个调用的 changes 是 null。
 *
 * 所以帧跟着**异步上下文**走（AsyncLocalStorage），而不是跟着 store 实例走。
 */
export type CheckpointFrame = Checkpoint[];

const frames = new AsyncLocalStorage<CheckpointFrame>();

export class CheckpointStore {
  private stack: { files: Checkpoint[]; id: string }[] = [];
  private seq = 0;

  /** 开一帧（只是一个新数组，不碰任何共享状态）。 */
  beginCall(): CheckpointFrame {
    return [];
  }

  /** 在该帧的异步上下文里执行工具：并发调用各自独立，嵌套调用也能正确分层。 */
  track<T>(frame: CheckpointFrame, fn: () => Promise<T>): Promise<T> {
    return frames.run(frame, fn);
  }

  /** Called by a tool *before* it writes. Idempotent per path per call. */
  record(absPath: string): void {
    // 用异步上下文里的帧；没有上下文（工具被直接调用）就不记录 ——
    // 以前这里还有一个实例级 `current` 兜底，但它从来没有被赋过非 null 值。
    const frame = frames.getStore();
    if (!frame) return;
    if (frame.some((c) => c.path === absPath)) return;
    let before: string | null = null;
    try {
      before = existsSync(absPath) ? readFileSync(absPath, "utf8") : null;
    } catch {
      before = null;
    }
    frame.push({ path: absPath, before, at: Date.now() });
  }

  /** Close the given call frame and return the realized file changes. */
  commitCall(frame?: CheckpointFrame): FileChange[] {
    const files = frame ?? frames.getStore() ?? [];
    if (!files.length) return [];
    this.stack.push({ files, id: "ck_" + ++this.seq });
    // 长会话里每次写文件都入栈，无界增长会把整段历史留在内存里。
    // 保留最近 N 帧足够用（更早的撤销价值远低于内存成本）。
    if (this.stack.length > MAX_CHECKPOINTS) this.stack.splice(0, this.stack.length - MAX_CHECKPOINTS);
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

  /**
   * Restore the most recent call that changed files.
   *
   * 传 policy 时回滚写入也要过沙箱守卫：`/undo` 是服务端直接暴露的写入路径，
   * 不检查的话 read-only 模式照样能把文件写回去。
   */
  undoLast(policy?: SandboxPolicy): { restored: string[]; id: string; skipped?: string[] } | null {
    const entry = this.stack.pop();
    if (!entry) return null;
    const restored: string[] = [];
    const skipped: string[] = [];
    const remaining: Checkpoint[] = [];
    for (const f of [...entry.files].reverse()) {
      if (policy && guardPath(f.path, { access: "write", policy }).decision !== null) {
        skipped.push(f.path);
        remaining.push(f);
        continue;
      }
      try {
        if (f.before === null) {
          if (existsSync(f.path)) unlinkSync(f.path);
        } else {
          mkdirSync(path.dirname(f.path), { recursive: true });
          writeFileSync(f.path, f.before, "utf8");
        }
        restored.push(f.path);
      } catch {
        // 保留失败项供用户修复权限/占用后再次 undo；其他文件仍可先恢复。
        skipped.push(f.path);
        remaining.push(f);
      }
    }
    // 整帧都恢复失败或被策略拒绝：放回原帧，下一次仍可重试。
    if (!restored.length) {
      this.stack.push(entry);
      return skipped.length ? { restored, id: entry.id, skipped } : null;
    }
    // 部分恢复成功时只保留失败文件，已恢复的路径不能再次写旧快照覆盖后续编辑。
    if (remaining.length) this.stack.push({ ...entry, files: remaining.reverse() });
    return skipped.length ? { restored, id: entry.id, skipped } : { restored, id: entry.id };
  }

  depth(): number {
    return this.stack.length;
  }
}

/**
 * Background job manager. A long build or a dev server must not block the
 * agent loop, but its output still has to reach the model on demand.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { shellForPlatform } from "../sandbox/commands.ts";
import { buildSpawnPlan } from "../sandbox/policy.ts";
import type { SandboxPolicy } from "../sandbox/paths.ts";

export type JobStatus = "running" | "done" | "failed" | "killed";

export interface Job {
  id: string;
  command: string;
  startedAt: number;
  finishedAt?: number;
  status: JobStatus;
  exitCode?: number;
  output: string;
  truncated: boolean;
  child: ChildProcess;
}

const MAX_OUTPUT = 200_000;
/** 保留的后台任务上限：每个 job 带着最多 200KB 输出和一个 child 引用，不能只增不减。 */
const MAX_JOBS = 32;

export class JobManager {
  private jobs = new Map<string, Job>();
  private seq = 0;

  start(command: string, opts: { cwd: string; policy: SandboxPolicy; env?: Record<string, string> }): Job {
    const id = "job_" + ++this.seq;
    const shell = shellForPlatform();
    const plan = buildSpawnPlan(command, { cwd: opts.cwd, policy: opts.policy, shell, env: opts.env });
    const child = spawn(plan.command, plan.args, {
      cwd: opts.cwd,
      env: plan.env as Record<string, string>,
      windowsHide: true,
    });
    const job: Job = { id, command, startedAt: Date.now(), status: "running", output: "", truncated: false, child };
    this.jobs.set(id, job);
    this.evictFinished();

    const omission = "\n...[earlier output omitted]...\n";
    const headLimit = Math.floor((MAX_OUTPUT - omission.length) / 2);
    const tailLimit = MAX_OUTPUT - omission.length - headLimit;
    const safeTail = (chunk: Buffer): string => {
      let start = Math.max(0, chunk.length - tailLimit);
      while (start < chunk.length && (chunk[start]! & 0xc0) === 0x80) start++;
      return chunk.subarray(start).toString("utf8");
    };
    const safeHead = (chunk: Buffer): string => {
      let end = Math.min(headLimit, chunk.length);
      while (end > 0 && end < chunk.length && (chunk[end]! & 0xc0) === 0x80) end--;
      return chunk.subarray(0, end).toString("utf8");
    };
    const append = (chunk: Buffer) => {
      if (!job.truncated && job.output.length + chunk.length <= MAX_OUTPUT) {
        job.output += chunk.toString("utf8");
        return;
      }
      job.truncated = true;
      // 若单个 data 块本身巨大，只对首尾小窗口做解码；不先把整块转成字符串。
      if (chunk.length > MAX_OUTPUT) {
        const head = job.output ? job.output.slice(0, headLimit) : safeHead(chunk);
        const tail = safeTail(chunk);
        job.output = head + omission + tail;
        return;
      }
      const marker = job.output.indexOf(omission);
      const head = marker >= 0 ? job.output.slice(0, marker) : job.output.slice(0, headLimit);
      const oldTail = marker >= 0 ? job.output.slice(marker + omission.length) : job.output.slice(headLimit);
      const tail = (oldTail + chunk.toString("utf8")).slice(-tailLimit);
      job.output = head + omission + tail;
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.on("error", (err) => {
      job.status = "failed";
      job.finishedAt = Date.now();
      append(Buffer.from("\n[spawn error] " + err.message));
      this.evictFinished();
    });
    child.on("close", (code) => {
      if (job.status !== "killed") {
        job.exitCode = code ?? 1;
        job.status = code === 0 ? "done" : "failed";
        job.finishedAt = Date.now();
      }
      this.evictFinished();
    });
    return job;
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  /** 回收已结束的最旧任务；运行中的不动（它们还可能在写输出）。 */
  private evictFinished(): void {
    if (this.jobs.size <= MAX_JOBS) return;
    const finished = [...this.jobs.values()]
      .filter((j) => j.status !== "running")
      .sort((a, b) => a.startedAt - b.startedAt);
    for (const job of finished) {
      if (this.jobs.size <= MAX_JOBS) break;
      this.jobs.delete(job.id);
    }
  }

  list(): Job[] {
    return [...this.jobs.values()].sort((a, b) => b.startedAt - a.startedAt);
  }

  kill(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job || job.status !== "running") return false;
    job.status = "killed";
    job.finishedAt = Date.now();
    job.child.kill("SIGKILL");
    this.evictFinished();
    return true;
  }

  killAll(): void {
    for (const job of this.jobs.values()) {
      if (job.status === "running") {
        job.status = "killed";
        job.finishedAt = Date.now();
        job.child.kill("SIGKILL");
      }
    }
    this.evictFinished();
  }

  async waitFor(id: string, timeoutMs: number): Promise<Job | undefined> {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    const started = Date.now();
    while (job.status === "running" && Date.now() - started < timeoutMs) {
      await new Promise((r) => setTimeout(r, 100));
    }
    return job;
  }
}

export function formatJob(job: Job, full = false): string {
  const elapsed = ((job.finishedAt ?? Date.now()) - job.startedAt) / 1000;
  const head = [
    "job_id=" + job.id,
    "status=" + job.status,
    job.exitCode !== undefined ? "exit_code=" + job.exitCode : "",
    "elapsed=" + elapsed.toFixed(1) + "s",
  ]
    .filter(Boolean)
    .join(" ");
  const body = full ? job.output : job.output.slice(-8000);
  const note = job.truncated ? "\n[output truncated]" : "";
  return head + "\n" + (body.trim() || "(no output yet)") + note;
}

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

    const append = (chunk: Buffer) => {
      if (job.output.length > MAX_OUTPUT) {
        job.truncated = true;
        job.output = job.output.slice(-Math.floor(MAX_OUTPUT / 2));
      }
      job.output += chunk.toString("utf8");
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.on("error", (err) => {
      job.status = "failed";
      job.finishedAt = Date.now();
      job.output += "\n[spawn error] " + err.message;
    });
    child.on("close", (code) => {
      if (job.status === "killed") return;
      job.exitCode = code ?? 1;
      job.status = code === 0 ? "done" : "failed";
      job.finishedAt = Date.now();
    });
    return job;
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
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
    return true;
  }

  killAll(): void {
    for (const job of this.jobs.values()) {
      if (job.status === "running") {
        job.status = "killed";
        job.child.kill("SIGKILL");
      }
    }
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

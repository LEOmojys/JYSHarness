/** Tools added in the product build: jobs, todos, web fetch, skills. */
import { loadSkillBody } from "../core/skills.ts";
import { formatJob } from "../core/jobs.ts";
import { bool, num, str, type Tool } from "./types.ts";

export const JobOutputTool: Tool = {
  name: "JobOutput",
  description:
    "Read the output of a background job started with Bash (run_in_background). " +
    "Set wait_ms to block until the job finishes or the timeout elapses.",
  inputSchema: {
    type: "object",
    properties: {
      job_id: { type: "string" },
      wait_ms: { type: "number", description: "Block up to this long (max 120000)." },
      offset: { type: "number", description: "Unused; kept for future paging." },
    },
    required: ["job_id"],
  },
  isReadOnly: true,
  isConcurrencySafe: () => true,
  async call(input, ctx) {
    if (!ctx.jobs) return { content: "Background jobs are not enabled.", isError: true };
    const id = str(input, "job_id");
    const waitMs = Math.min(120_000, Math.max(0, num(input, "wait_ms", 0)));
    const job = waitMs > 0 ? await ctx.jobs.waitFor(id, waitMs) : ctx.jobs.get(id);
    if (!job) return { content: "No such job: " + id + ". Running: " + ctx.jobs.list().map((j) => j.id).join(", "), isError: true };
    return { content: formatJob(job) };
  },
};

export const JobKillTool: Tool = {
  name: "JobKill",
  description: "Stop a running background job.",
  inputSchema: { type: "object", properties: { job_id: { type: "string" } }, required: ["job_id"] },
  isReadOnly: false,
  isConcurrencySafe: () => false,
  async call(input, ctx) {
    if (!ctx.jobs) return { content: "Background jobs are not enabled.", isError: true };
    const id = str(input, "job_id");
    const ok = ctx.jobs.kill(id);
    return { content: ok ? "killed " + id : "job not running: " + id, isError: !ok };
  },
};

export const JobListTool: Tool = {
  name: "JobList",
  description: "List background jobs with status and age.",
  inputSchema: { type: "object", properties: {} },
  isReadOnly: true,
  isConcurrencySafe: () => true,
  async call(_input, ctx) {
    if (!ctx.jobs) return { content: "Background jobs are not enabled.", isError: true };
    const jobs = ctx.jobs.list();
    if (!jobs.length) return { content: "no background jobs" };
    return {
      content: jobs.map((j) => j.id + "\t" + j.status + "\t" + Math.round((Date.now() - j.startedAt) / 1000) + "s\t" + j.command.slice(0, 80)).join("\n"),
    };
  },
};

export const TodoWriteTool: Tool = {
  name: "TodoWrite",
  description:
    "Record or update the task list for multi-step work. Send the COMPLETE list every time; " +
    "it replaces the previous one. Keep exactly one item in_progress while working.",
  inputSchema: {
    type: "object",
    properties: {
      todos: {
        type: "array",
        description: "Items: { content: string, status: pending|in_progress|completed }",
      },
    },
    required: ["todos"],
  },
  isReadOnly: false,
  isConcurrencySafe: () => false,
  validate(input) {
    if (!Array.isArray(input.todos)) return "todos must be an array";
    for (const t of input.todos as { content?: unknown; status?: unknown }[]) {
      if (typeof t?.content !== "string" || !t.content.trim()) return "every todo needs a non-empty content";
      if (!["pending", "in_progress", "completed"].includes(String(t?.status))) {
        return "invalid status " + String(t?.status) + " (use pending, in_progress or completed)";
      }
    }
    return null;
  },
  async call(input, ctx) {
    const items = (input.todos as { content: string; status: "pending" | "in_progress" | "completed" }[]).map((t) => ({
      content: t.content.trim(),
      status: t.status,
    }));
    ctx.todos?.set(items);
    const render = items.map((t) => (t.status === "completed" ? "[x] " : t.status === "in_progress" ? "[~] " : "[ ] ") + t.content).join("\n");
    return {
      content: "todo list updated:\n" + render,
      metadata: { todos: items },
    };
  },
};

const BLOCKED_HOSTS = [/^localhost$/i, /^127\./, /^0\.0\.0\.0$/, /^10\./, /^192\.168\./, /^169\.254\./, /^172\.(1[6-9]|2\d|3[01])\./, /^\[?::1\]?$/, /\.local$/i, /\.internal$/i];

export const WebFetchTool: Tool = {
  name: "WebFetch",
  description:
    "Fetch an http(s) URL and return readable text (HTML is stripped). " +
    "Private/loopback hosts are blocked. Output is capped; use it for docs and pages.",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string" },
      max_chars: { type: "number", description: "Cap on returned characters (default 20000)." },
    },
    required: ["url"],
  },
  isReadOnly: true,
  isConcurrencySafe: () => true,
  validate(input) {
    const url = str(input, "url");
    if (!/^https?:\/\//i.test(url)) return "url must start with http:// or https://";
    return null;
  },
  async call(input, ctx) {
    const raw = str(input, "url");
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      return { content: "invalid url: " + raw, isError: true };
    }
    if (BLOCKED_HOSTS.some((re) => re.test(parsed.hostname))) {
      return { content: "refusing to fetch a private/loopback host: " + parsed.hostname, isError: true };
    }
    const maxChars = Math.min(80_000, Math.max(1000, num(input, "max_chars", 20_000)));
    try {
      const res = await fetch(parsed, {
        signal: ctx.signal,
        headers: { "user-agent": "JYSHarness/0.2 (+https://localhost)", accept: "text/html,text/plain,*/*" },
        redirect: "follow",
      });
      const type = res.headers.get("content-type") ?? "";
      const body = await res.text();
      const text = /html/i.test(type) ? htmlToText(body) : body;
      const clipped = text.length > maxChars ? text.slice(0, maxChars) + "\n...[truncated]" : text;
      return {
        content: "status=" + res.status + " url=" + res.url + "\n" + clipped,
        metadata: { status: res.status, bytes: body.length },
      };
    } catch (err) {
      return { content: "fetch failed: " + (err instanceof Error ? err.message : String(err)), isError: true };
    }
  },
};

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|section|article|li|tr|h[1-6]|br)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\x22")
    .replace(/&#39;/g, "\x27")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export const SkillTool: Tool = {
  name: "Skill",
  description:
    "Load the full instructions of a skill listed in <available_skills>. " +
    "Call it before starting a task the skill covers, then follow the instructions.",
  inputSchema: {
    type: "object",
    properties: { name: { type: "string", description: "Exact skill name." } },
    required: ["name"],
  },
  isReadOnly: true,
  isConcurrencySafe: () => true,
  async call(input, ctx) {
    const name = str(input, "name");
    const skills = ctx.skills ?? [];
    const skill = skills.find((s) => s.name === name);
    if (!skill) {
      return {
        content: "No such skill: " + name + (skills.length ? ". Available: " + skills.map((s) => s.name).join(", ") : ". No skills installed."),
        isError: true,
      };
    }
    try {
      return { content: "<skill name=" + JSON.stringify(skill.name) + ">\n" + loadSkillBody(skill) + "\n</skill>" };
    } catch (err) {
      return { content: "failed to load skill: " + (err instanceof Error ? err.message : String(err)), isError: true };
    }
  },
};

export const extraTools: Tool[] = [JobOutputTool, JobKillTool, JobListTool, TodoWriteTool, WebFetchTool, SkillTool];

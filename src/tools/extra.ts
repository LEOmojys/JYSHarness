/** Tools added in the product build: jobs, todos, web fetch, skills. */
import { loadSkillBody } from "../core/skills.ts";
import { addMemory, forgetMemory, MAX_MEMORY_CHARS, readMemoryEntries } from "../core/memory.ts";
import { checkUrl, MAX_REDIRECTS } from "../util/net.ts";
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

// 地址校验统一放在 util/net.ts：字面黑名单 + DNS 解析后的 IP 检查 + 重定向逐跳校验。

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
  maxOutputChars: 60_000,
  // 对端不响应时不能让整个循环等下去
  timeoutMs: 30_000,
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
    const start = await checkUrl(parsed);
    if (!start.ok) return { content: start.reason ?? "blocked url", isError: true };

    const maxChars = Math.min(80_000, Math.max(1000, num(input, "max_chars", 20_000)));
    try {
      // 自己跟重定向：只校验初始 URL 是假的，一个 302 就能把请求引到内网。
      let current = parsed;
      let res: Response | null = null;
      for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        res = await fetch(current, {
          signal: ctx.signal,
          headers: { "user-agent": "JYSHarness/0.2 (+https://localhost)", accept: "text/html,text/plain,*/*" },
          redirect: "manual",
        });
        if (res.status < 300 || res.status >= 400) break;
        const location = res.headers.get("location");
        if (!location) break;
        const next = new URL(location, current);
        const check = await checkUrl(next);
        if (!check.ok) {
          return { content: "redirect blocked: " + (check.reason ?? "unsafe target") + " (from " + current.href + ")", isError: true };
        }
        current = next;
        res = null;
      }
      if (!res) {
        return { content: "too many redirects (limit " + MAX_REDIRECTS + ")", isError: true };
      }
      const type = res.headers.get("content-type") ?? "";
      const body = await res.text();
      const text = /html/i.test(type) ? htmlToText(body) : body;
      const clipped = text.length > maxChars ? text.slice(0, maxChars) + "\n...[truncated]" : text;
      return {
        content: "status=" + res.status + " url=" + current.href + "\n" + clipped,
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
      // allowed-tools 只是**声明**：我们不会因此放行任何工具（那是提权入口）。
      // 交给模型是为了让它按技能作者的意图挑工具，而不是拿它当许可证。
      const hint = skill.allowedTools?.length
        ? " allowed-tools=" + JSON.stringify(skill.allowedTools.join(","))
        : "";
      return {
        content:
          "<skill name=" + JSON.stringify(skill.name) + hint + ">\n" + loadSkillBody(skill) + "\n</skill>",
      };
    } catch (err) {
      return { content: "failed to load skill: " + (err instanceof Error ? err.message : String(err)), isError: true };
    }
  },
};

export const MemoryTool: Tool = {
  name: "Memory",
  description:
    "Remember a durable fact about this workspace across sessions (e.g. \"tests run with node --test\", " +
    "\"the API key lives in .env.local\"). Use action=list to review, action=forget to drop matching entries. " +
    "Only store what stays true; do not store task progress.",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", description: "add | list | forget" },
      text: { type: "string", description: "Fact to remember (action=add)." },
      match: { type: "string", description: "Substring to delete (action=forget)." },
    },
    required: ["action"],
  },
  isReadOnly: false,
  isConcurrencySafe: () => false,
  async call(input, ctx) {
    const action = str(input, "action", "list");
    if (action === "list") {
      const entries = readMemoryEntries(ctx.workspaceRoot);
      if (!entries.length) return { content: "no remembered facts yet" };
      return { content: entries.map((e) => "- " + e.text).join(String.fromCharCode(10)) };
    }
    if (action === "forget") {
      const match = str(input, "match");
      if (!match) return { content: "action=forget needs match", isError: true };
      const res = forgetMemory(ctx.workspaceRoot, match);
      return { content: res.removed ? "removed " + res.removed + " entr(y/ies)" : "nothing matched: " + match, isError: false };
    }
    const text = str(input, "text");
    if (!text) return { content: "action=add needs text", isError: true };
    const res = addMemory(ctx.workspaceRoot, text);
    if (!res.ok) return { content: res.error ?? "failed", isError: true };
    const lines = ["remembered: " + text];
    if (res.error) lines.push("note: " + res.error);
    if (res.evicted) lines.push("注意：超出 " + MAX_MEMORY_CHARS + " 字符预算，淘汰了最旧的 " + res.evicted + " 条");
    return { content: lines.join(String.fromCharCode(10)) };
  },
};


export const extraTools: Tool[] = [JobOutputTool, JobKillTool, JobListTool, TodoWriteTool, WebFetchTool, SkillTool, MemoryTool];
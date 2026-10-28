/**
 * Sub-agent tool (ch.11). The child starts from an EMPTY message list, gets its
 * own tool loop and its own budget, and returns only a summary. That isolation
 * is the point: exploratory noise never enters the parent transcript.
 */
import { str, type Tool } from "./types.ts";
import { resolveAgentType } from "../core/agents.ts";

export const AgentTool: Tool = {
  name: "Agent",
  description:
    "Delegate a self-contained task to a sub-agent with a fresh context. " +
    "Use it for research or scoped implementation so the main conversation stays clean. " +
    "The sub-agent cannot see this conversation; state everything it needs in the prompt.",
  inputSchema: {
    type: "object",
    properties: {
      description: { type: "string", description: "3-5 word task label." },
      prompt: { type: "string", description: "Complete, self-contained instructions." },
      type: {
        type: "string",
        description:
          "Preset agent type: 'explore' (read-only) / 'plan' (read-only + todos) / 'general' (all tools). " +
          "Project types can be added in .harness/agents/*.md.",
      },
    },
    required: ["prompt"],
  },
  isReadOnly: false,
  isDestructive: false,
  isConcurrencySafe: () => true,
  validate(input) {
    if (!str(input, "prompt").trim()) return "prompt must not be empty";
    return null;
  },
  async call(input, ctx) {
    if (!ctx.runSubagent) {
      return { content: "Error: sub-agents are not enabled in this session.", isError: true };
    }
    if (ctx.depth >= 2) {
      return { content: "Error: maximum sub-agent depth (2) reached.", isError: true };
    }
    const prompt = str(input, "prompt");
    const description = str(input, "description", "sub-agent");
    const type = str(input, "type", "general") || "general";

    // 类型必须在可用列表里：拼错就报错并列出可用项，而不是静默用 general
    // （静默退化会让用户以为自己在用只读 Agent，实际拿到了全部工具）。
    const known = ctx.agentTypes ?? [];
    const resolved = known.length ? resolveAgentType(known, type) : null;
    if (resolved && "error" in resolved) return { content: resolved.error, isError: true };
    const typeName = resolved && "type" in resolved ? resolved.type.name : type;

    const started = Date.now();
    try {
      // 把父轮次的 signal 传下去：用户按停时子 Agent 必须一起停。
      const out = await ctx.runSubagent(prompt, { description, signal: ctx.signal, type: typeName });
      const outcome = typeof out === "string" ? { summary: out, ok: true } : out;
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      const head = outcome.ok ? "subagent_result" : "subagent_failure";
      const reason = outcome.ok ? "" : " reason=" + JSON.stringify(outcome.reason ?? "failed");
      const content =
        "<" + head + " duration=" + JSON.stringify(secs + "s") + reason + ">\n" + outcome.summary + "\n</" + head + ">";
      // 失败必须是 isError：否则父模型会以为"子 Agent 说完了"而继续往下走。
      return { content, isError: !outcome.ok, metadata: { durationMs: Date.now() - started, subagentOk: outcome.ok } };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: "Sub-agent failed: " + message, isError: true };
    }
  },
};

export const agentTools: Tool[] = [AgentTool];

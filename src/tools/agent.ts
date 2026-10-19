/**
 * Sub-agent tool (ch.11). The child starts from an EMPTY message list, gets its
 * own tool loop and its own budget, and returns only a summary. That isolation
 * is the point: exploratory noise never enters the parent transcript.
 */
import { str, type Tool } from "./types.ts";

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
    const started = Date.now();
    try {
      const summary = await ctx.runSubagent(prompt, { description });
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      const content =
        "<subagent_result duration=" + JSON.stringify(secs + "s") + ">\n" + summary + "\n</subagent_result>";
      return { content, metadata: { durationMs: Date.now() - started } };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: "Sub-agent failed: " + message, isError: true };
    }
  },
};

export const agentTools: Tool[] = [AgentTool];

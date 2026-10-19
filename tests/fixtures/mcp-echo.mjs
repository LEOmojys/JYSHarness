#!/usr/bin/env node
/** Minimal MCP stdio server used by the test suite (newline-delimited JSON-RPC). */
let buf = "";
process.stdin.on("end", () => process.exit(0));
process.stdin.on("data", (d) => {
  buf += d.toString("utf8");
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    handle(msg);
  }
});

function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}

function handle(msg) {
  if (msg.method === "initialize") {
    return reply(msg.id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "echo-server", version: "0.0.1" },
    });
  }
  if (msg.method === "notifications/initialized") return;
  if (msg.method === "tools/list") {
    return reply(msg.id, {
      tools: [
        {
          name: "echo",
          description: "Echo the given text back.",
          inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
          annotations: { readOnlyHint: true },
        },
        {
          name: "add",
          description: "Add two numbers.",
          inputSchema: {
            type: "object",
            properties: { a: { type: "number" }, b: { type: "number" } },
            required: ["a", "b"],
          },
        },
        {
          name: "explode",
          description: "Always fails (isError path).",
          inputSchema: { type: "object", properties: {} },
        },
      ],
    });
  }
  if (msg.method === "tools/call") {
    const { name, arguments: args } = msg.params || {};
    if (name === "echo") {
      return reply(msg.id, { content: [{ type: "text", text: "echo: " + (args?.text ?? "") }] });
    }
    if (name === "add") {
      return reply(msg.id, { content: [{ type: "text", text: String((args?.a ?? 0) + (args?.b ?? 0)) }] });
    }
    if (name === "explode") {
      return reply(msg.id, { content: [{ type: "text", text: "boom" }], isError: true });
    }
    return reply(msg.id, { content: [{ type: "text", text: "unknown tool" }], isError: true });
  }
  if (msg.id !== undefined) {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "unknown method" } }) + "\n");
  }
}

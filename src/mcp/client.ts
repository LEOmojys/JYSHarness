/**
 * Minimal MCP client (ch.10): stdio transport, newline-delimited JSON-RPC 2.0.
 *
 * Scope on purpose: initialize -> tools/list -> tools/call. That is the subset
 * that turns "40 tools in Claude Code" into "unbounded tools in this harness".
 * Resources/prompts/sampling can be added without touching the loop.
 */
import { spawn, type ChildProcess } from "node:child_process";
import type { JSONSchema } from "../providers/types.ts";
import type { Logger } from "../util/log.ts";

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema?: JSONSchema;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
}

export interface McpCallResult {
  content: string;
  isError: boolean;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

const REQUEST_TIMEOUT_MS = 20_000;

export class McpClient {
  readonly name: string;
  private child: ChildProcess;
  private pending = new Map<number, Pending>();
  private seq = 0;
  private buffer = "";
  private closed = false;
  tools: McpToolDefinition[] = [];
  serverInfo: { name?: string; version?: string } = {};

  private constructor(name: string, child: ChildProcess) {
    this.name = name;
    this.child = child;
    // A dying child turns every subsequent write into EPIPE; swallow those so a
    // broken MCP server never takes the whole harness down.
    child.stdin?.on("error", () => {});
    child.stdout?.on("error", () => {});
    child.stderr?.on("error", () => {});
    child.stdout?.on("data", (d: Buffer) => this.onData(d.toString("utf8")));
    child.stderr?.on("data", (d: Buffer) => {
      const text = d.toString("utf8").trim();
      if (text) process.stderr.write("[mcp:" + name + "] " + text + "\n");
    });
    child.on("error", (err) => {
      this.closed = true;
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(err instanceof Error ? err : new Error(String(err)));
      }
      this.pending.clear();
    });
    child.on("close", () => {
      this.closed = true;
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error("MCP server " + name + " exited"));
      }
      this.pending.clear();
    });
  }

  static async connect(name: string, cfg: McpServerConfig, logger: Logger): Promise<McpClient> {
    const child = spawn(cfg.command, cfg.args ?? [], {
      cwd: cfg.cwd ?? process.cwd(),
      env: { ...process.env, ...(cfg.env ?? {}) } as Record<string, string>,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const client = new McpClient(name, child);
    try {
      return await McpClient.handshake(client, logger);
    } catch (err) {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      throw err;
    }
  }

  private static async handshake(client: McpClient, logger: Logger): Promise<McpClient> {
    const name = client.name;
    const init = (await client.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      clientInfo: { name: "JYSHarness", version: "0.2.0" },
    })) as { serverInfo?: { name?: string; version?: string } };
    client.serverInfo = init?.serverInfo ?? {};
    client.notify("notifications/initialized", {});
    const listed = (await client.request("tools/list", {})) as { tools?: McpToolDefinition[] };
    client.tools = listed?.tools ?? [];
    logger.info("mcp " + name + ": " + client.tools.length + " tools");
    return client;
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof msg.id === "number" && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        clearTimeout(p.timer);
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
        else p.resolve(msg.result);
      }
    }
  }

  private send(payload: unknown): void {
    if (this.closed) throw new Error("MCP server " + this.name + " is closed");
    this.child.stdin!.write(JSON.stringify(payload) + "\n");
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("MCP request timed out: " + method));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ jsonrpc: "2.0", id, method, params });
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private notify(method: string, params: unknown): void {
    try {
      this.send({ jsonrpc: "2.0", method, params });
    } catch {
      /* notifications are best-effort */
    }
  }

  async callTool(toolName: string, args: Record<string, unknown>): Promise<McpCallResult> {
    const result = (await this.request("tools/call", { name: toolName, arguments: args })) as {
      content?: { type: string; text?: string }[];
      isError?: boolean;
    };
    const text = (result?.content ?? [])
      .map((c) => (c.type === "text" ? (c.text ?? "") : "[" + c.type + " content]"))
      .join("\n");
    return { content: text || "(empty result)", isError: Boolean(result?.isError) };
  }

  /**
   * Graceful shutdown: MCP servers exit when stdin closes. SIGKILL is only a
   * fallback — killing a child while its stdio callbacks are in flight can
   * crash the parent on Windows.
   */
  close(): void {
    this.closed = true;
    try {
      this.child.stdin?.end();
    } catch {
      /* already closed */
    }
    // No fallback kill timer: an unref-d timer firing after the host test or
    // server has torn down its async context trips a Node assertion on Windows.
    // A server that ignores stdin close is a broken server; the OS reclaims it
    // when this process exits.
    this.child.once("exit", () => {
      this.closed = true;
    });
  }
}

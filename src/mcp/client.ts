/**
 * Minimal MCP client (ch.10): stdio transport, newline-delimited JSON-RPC 2.0.
 *
 * Scope on purpose: initialize -> tools/list -> tools/call. That is the subset
 * that turns "40 tools in Claude Code" into "unbounded tools in this harness".
 * Resources/prompts/sampling can be added without touching the loop.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { JSONSchema } from "../providers/types.ts";
import type { Logger } from "../util/log.ts";
import { scrubProviderKeys } from "../util/secrets.ts";

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

/** 握手/列举用短超时；工具调用用长超时（对齐工具层的 timeoutMs）。 */
const HANDSHAKE_TIMEOUT_MS = 20_000;
const CALL_TIMEOUT_MS = 120_000;
/** 单行缓冲上限：server 不换行地灌数据时必须能自保，而不是把内存吃光。 */
const MAX_BUFFER_CHARS = 8 * 1024 * 1024;
/** 单个 server 的 stderr 最多转发这么多字节，之后只在 debug 里计数。 */
const MAX_STDERR_CHARS = 64 * 1024;
/** tools/list 分页上限，防止 server 用永不重复的 cursor 让我们无限翻。 */
const MAX_LIST_PAGES = 20;

export class McpClient {
  readonly name: string;
  private child: ChildProcess;
  private pending = new Map<number, Pending>();
  private seq = 0;
  private buffer = "";
  private closed = false;
  /**
   * UTF-8 跨分帧解码器。
   *
   * 之前用 chunk.toString("utf8")：一个中文字被管道从中间切开时，
   * 两半各自解码都变成替换字符 —— 实测 "中文" 会变成 "���"。中文输出是
   * 常态，这不是边界情况。StringDecoder 会把不完整的字节留到下一次。
   */
  private decoder = new StringDecoder("utf8");
  private stderrChars = 0;
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
    child.stdout?.on("data", (d: Buffer) => this.onData(this.decoder.write(d)));
    child.stderr?.on("data", (d: Buffer) => {
      // 有上限地转发：话多的 server 不该把终端刷满
      if (this.stderrChars > MAX_STDERR_CHARS) return;
      this.stderrChars += d.length;
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
      // 第三方 MCP server 不该收到 harness 的 provider key：它只需要自己的凭据。
      env: scrubProviderKeys({ ...process.env, ...(cfg.env ?? {}) }),
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
    // 分页：MCP 的 tools/list 用 nextCursor 翻页。只取第一页的话，工具多的
    // server 会静默少掉一半工具 —— 之前就是只请求了一次。
    const collected: McpToolDefinition[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const listed = (await client.request("tools/list", cursor ? { cursor } : {})) as {
        tools?: McpToolDefinition[];
        nextCursor?: string;
      };
      for (const tool of listed?.tools ?? []) {
        if (tool?.name && !collected.some((t) => t.name === tool.name)) collected.push(tool);
      }
      const next = listed?.nextCursor;
      if (!next || seenCursors.has(next)) break;
      seenCursors.add(next);
      cursor = next;
    }
    client.tools = collected;
    logger.info("mcp " + name + ": " + client.tools.length + " tools");
    return client;
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > MAX_BUFFER_CHARS) {
      // 协议已经不可信了：继续攒只会吃光内存，直接断开并让上层看到错误。
      this.buffer = "";
      this.fail(new Error("MCP server " + this.name + " sent " + MAX_BUFFER_CHARS + "+ chars without a newline"));
      return;
    }
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

  /** 把所有在途请求一起失败（进程死了 / 协议违规）。 */
  private fail(err: Error): void {
    this.closed = true;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
    try {
      this.child.kill();
    } catch {
      /* already gone */
    }
  }

  private send(payload: unknown): void {
    if (this.closed) throw new Error("MCP server " + this.name + " is closed");
    this.child.stdin!.write(JSON.stringify(payload) + "\n");
  }

  private request(method: string, params: unknown, timeoutMs = HANDSHAKE_TIMEOUT_MS): Promise<unknown> {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("MCP request timed out after " + Math.round(timeoutMs / 1000) + "s: " + method));
      }, timeoutMs);
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

  /** 进程还活着吗？重连逻辑靠它判断"该不该重启"。 */
  get alive(): boolean {
    if (this.closed) return false;
    // exitCode 非 null 表示子进程已经退出但 close 回调还没跑到
    return this.child.exitCode === null && !this.child.killed;
  }

  async callTool(
    toolName: string,
    args: Record<string, unknown>,
    timeoutMs = CALL_TIMEOUT_MS,
  ): Promise<McpCallResult> {
    const result = (await this.request("tools/call", { name: toolName, arguments: args }, timeoutMs)) as {
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
    // 一个忽略 stdin 关闭的 server 不应该把 harness 的进程钉住：
    // unref 之后事件循环可以正常退出，孤儿进程由操作系统回收。
    // 只有子进程句柄本身可以 unref；stdio 流没有这个能力（类型检查指出的）。
    try {
      this.child.unref();
    } catch {
      /* 某些平台上不可用 */
    }
  }
}

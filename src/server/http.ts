/**
 * HTTP 基础设施：请求体读取、JSON 响应、静态文件。
 *
 * 从 app.ts 抽出来的原因：这几件事都与业务无关，但**错了会出事**
 * （UTF-8 分帧、超限语义、状态码分类、静态文件路径），值得单独成文件并被单独测试。
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";

export const UI_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "ui");

export const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

/**
 * 带 HTTP 状态码的错误：catch 里据此回不同状态码。
 * 以前所有客户端错误（坏 JSON、超限、坏 URL）都统一变成 500 + "internal error"，
 * 调用方既拿不到原因，也没法区分"我发错了"和"服务端炸了"。
 */
export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

/** 请求体上限（字节，不是字符数）。图片走 base64，一张 6MB 图约 8MB 文本。 */
export const MAX_BODY_BYTES = 32 * 1024 * 1024;
/** 超过这个值就不再客气：一直读下去等于帮攻击者做内存/带宽消耗。 */
const HARD_BODY_BYTES = MAX_BODY_BYTES * 4;

/**
 * 读 JSON 请求体。
 *
 * 两个坑都要避开：
 *   1. 逐 chunk 调 `toString("utf8")` 会在多字节字符被 64KB 边界切开时插入 U+FFFD ——
 *      一段中文长消息会在转录里永久损坏（而且已经落盘，恢复不回来）。所以先收集
 *      Buffer，最后整体解码。
 *   2. 超限不能直接 `req.destroy()`：客户端只会看到 ECONNRESET，前端于是"静默丢消息"。
 *      正确做法是停止累积、把剩余数据读掉、正常回 413。
 */
export function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let tooLarge = false;
    req.on("data", (d: Buffer) => {
      total += d.length;
      if (total > HARD_BODY_BYTES) {
        // 真正的洪水：这时候没必要继续读完
        reject(new HttpError(413, "payload too large"));
        req.destroy();
        return;
      }
      if (total > MAX_BODY_BYTES) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(d);
    });
    req.on("end", () => {
      if (tooLarge) return reject(new HttpError(413, "payload too large (max " + MAX_BODY_BYTES + " bytes)"));
      const buf = Buffer.concat(chunks).toString("utf8");
      if (!buf.trim()) return resolve({});
      try {
        resolve(JSON.parse(buf));
      } catch {
        reject(new HttpError(400, "invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

export function text(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(body);
}

export function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

export async function serveStatic(res: ServerResponse, rel: string): Promise<void> {
  const safe = path.normalize(rel).replace(/^([.][.][\\/])+/, "");
  const abs = path.join(UI_DIR, safe);
  if (!abs.startsWith(UI_DIR)) {
    res.writeHead(403).end("forbidden");
    return;
  }
  try {
    const data = await readFile(abs);
    res.writeHead(200, {
      "content-type": MIME[path.extname(abs)] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(data);
  } catch {
    res.writeHead(404).end("not found");
  }
}

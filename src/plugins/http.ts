/**
 * 把插件的"能力面"挂到 HTTP 服务上（对照 DSH 的 host 半 + client 半）。
 *
 * 三条路径：
 *   /api/plugins                 列表（含每个插件贡献了什么）
 *   /plugin/<id>/<path>          插件自己注册的 API 路由
 *   /plugin-assets/<id>/<file>   插件的浏览器侧资产（面板 JS/CSS）
 *
 * 安全：资产读取必须做**目录包含校验**，否则 `..%2f..%2fetc/passwd` 就能读任意文件。
 */
import { createReadStream, existsSync, statSync } from "node:fs";
import path from "node:path";
import type { PluginRuntime } from "./types.ts";

export const PLUGIN_ROUTE_PREFIX = "/plugin/";
export const PLUGIN_ASSET_PREFIX = "/plugin-assets/";

/** 从 /plugin/<id>/<rest> 里解析出 id 与 rest；不是插件路由就返回 null。 */
export function parsePluginRoute(pathname: string): { id: string; rest: string } | null {
  if (!pathname.startsWith(PLUGIN_ROUTE_PREFIX)) return null;
  const tail = pathname.slice(PLUGIN_ROUTE_PREFIX.length);
  const slash = tail.indexOf("/");
  const id = decodeURIComponent(slash < 0 ? tail : tail.slice(0, slash));
  const rest = slash < 0 ? "" : tail.slice(slash + 1);
  if (!id) return null;
  return { id, rest };
}

export function parsePluginAsset(pathname: string): { id: string; file: string } | null {
  if (!pathname.startsWith(PLUGIN_ASSET_PREFIX)) return null;
  const tail = pathname.slice(PLUGIN_ASSET_PREFIX.length);
  const slash = tail.indexOf("/");
  const id = decodeURIComponent(slash < 0 ? tail : tail.slice(0, slash));
  const file = slash < 0 ? "" : tail.slice(slash + 1);
  if (!id) return null;
  return { id, file };
}

/** 资产路径解析：必须落在插件 ui 目录内，否则返回 null（防目录穿越）。 */
export function resolveAssetPath(runtime: PluginRuntime | undefined, file: string): string | null {
  if (!runtime?.uiDir || !file) return null;
  const abs = path.resolve(runtime.uiDir, file);
  const rel = path.relative(runtime.uiDir, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  if (!existsSync(abs) || !statSync(abs).isFile()) return null;
  return abs;
}

const MIME: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".html": "text/html; charset=utf-8",
};

export function mimeFor(file: string): string {
  return MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream";
}

/** 资产响应（流式，避免把大文件整块读进内存）。 */
export function pipeAsset(abs: string, res: import("node:http").ServerResponse): void {
  res.writeHead(200, {
    "content-type": mimeFor(abs),
    // 插件资产必须禁缓存：开发期改了 JS 要立刻生效
    "cache-control": "no-store",
  });
  createReadStream(abs).pipe(res);
}

/**
 * Read 工具的跨轮缓存。
 *
 * 为什么值得做：长会话里模型会把同一份文件读三遍（先看、改完再看、报错再确认），
 * 每次都是几百到几千 token。缓存把重复的读变成零成本。
 *
 * 为什么安全：键里带 mtime + size，每次调用都重新 stat。文件变了自然失效，
 * 不依赖"写完主动清缓存"这种容易漏的约定。
 */
const MAX_ENTRIES = 32;
const MAX_BYTES = 8 * 1024 * 1024;

export interface ReadCacheEntry {
  path: string;
  offset: number;
  limit: number;
  mtimeMs: number;
  size: number;
  total: number;
  content: string;
  at: number;
}

const cache = new Map<string, ReadCacheEntry>();
let bytes = 0;

function keyOf(p: string, offset: number, limit: number): string {
  return p + "|" + offset + "|" + limit;
}

export function lookupRead(
  p: string,
  offset: number,
  limit: number,
  mtimeMs: number,
  size: number,
): ReadCacheEntry | null {
  const hit = cache.get(keyOf(p, offset, limit));
  if (!hit) return null;
  // 文件被改过（或替换成同尺寸的新文件）就重新读
  if (hit.mtimeMs !== mtimeMs || hit.size !== size) {
    cache.delete(keyOf(p, offset, limit));
    bytes -= hit.content.length;
    return null;
  }
  // 命中即刷新 LRU 顺序
  cache.delete(keyOf(p, offset, limit));
  cache.set(keyOf(p, offset, limit), hit);
  return hit;
}

export function storeRead(entry: Omit<ReadCacheEntry, "at">): void {
  const key = keyOf(entry.path, entry.offset, entry.limit);
  const previous = cache.get(key);
  if (previous) bytes -= previous.content.length;
  cache.set(key, { ...entry, at: Date.now() });
  bytes += entry.content.length;
  // 淘汰最旧（Map 的插入顺序就是 LRU 顺序）
  while ((cache.size > MAX_ENTRIES || bytes > MAX_BYTES) && cache.size > 1) {
    const oldest = cache.keys().next().value as string | undefined;
    if (!oldest) break;
    const dropped = cache.get(oldest);
    cache.delete(oldest);
    if (dropped) bytes -= dropped.content.length;
  }
}

export function clearReadCache(): void {
  cache.clear();
  bytes = 0;
}

export function readCacheStats(): { entries: number; bytes: number } {
  return { entries: cache.size, bytes };
}

/**
 * 并发闸门：把"一次开 20 个"变成"最多同时 N 个"。
 *
 * 为什么需要：只读工具批量并行是好事，但没有上限时，一次 20 个 Read/Grep
 * 会同时打开 20 个文件句柄（Windows 上还可能撞杀软扫描），内存和句柄一起抖。
 * 顺序必须保持：结果按输入下标回填，调用方不感知调度。
 */
/** 稳定序列化：用于"同一调用"的判重，键顺序不同也算同一个。 */
export function stableKey(value: unknown): string {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const obj = v as Record<string, unknown>;
      return Object.keys(obj)
        .sort()
        .reduce<Record<string, unknown>>((acc, k) => {
          acc[k] = walk(obj[k]);
          return acc;
        }, {});
    }
    return v;
  };
  return JSON.stringify(walk(value));
}

export async function mapWithLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const size = Math.max(1, Math.min(limit, items.length));
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: size }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

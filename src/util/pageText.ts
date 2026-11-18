/**
 * 抓一个 http(s) 页面并转成可读文本。
 *
 * 抽成独立模块的原因：WebFetch 和 WebSearch 都要抓正文（前者抓用户给的 URL，
 * 后者抓检索结果的前几条）。留在 extra.ts 里会让两个工具互相 import 成环。
 *
 * 安全约束都在这里：初始地址校验、逐跳重定向校验（302 也能把请求引到内网）。
 */
import { checkUrl, MAX_REDIRECTS } from "./net.ts";

export interface PageTextResult {
  ok: boolean;
  /** 失败原因（ok=false 时有值）。 */
  reason?: string;
  status?: number;
  /** 最终地址（跟随重定向之后）。 */
  url?: string;
  text?: string;
  bytes?: number;
  /** 正文总长度（截断前）。用来告诉调用方"还有多少没给"。 */
  totalChars?: number;
  /** 本次返回的起始偏移。 */
  offset?: number;
  /** 下一次该传的 offset；null 表示当前已读取的正文前缀取完。 */
  nextOffset?: number | null;
  /** 响应体超过读取上限时为 true；totalChars 仅代表已读取前缀，不是整页长度。 */
  truncated?: boolean;
}

/**
 * 抽正文区：先砍掉导航/页头/页脚/侧栏/分享这些模板噪音，再优先取 article 或 main。
 *
 * 不这么做的话，抓 nodejs.org 得到的所谓正文是「学习 关于 下载 博客 文档」—— 导航栏。
 * 那种正文比没有更糟：模型会以为页面在讲导航。
 *
 * 这里只按**标签**剥离（nav/header/footer/aside…）。旧实现还有一条"class/id 命中
 * nav/menu/cookie… 就整块删掉"的正则，它对未闭合标签是超线性的，而且和按标签剥离
 * 大面积重叠 —— 去掉它换来的是可预测的最坏耗时。
 */
/**
 * 线性剥掉成块的标签（script/style/nav/…）。
 *
 * 为什么不用正则：`/<script[\s\S]*?<\/script>/g` 在页面里出现 N 个**未闭合**的
 * `<script` 时，每个起点都要扫到文件尾，总代价 O(n²)。实测未闭合的 1.25MB 页面
 * 会同步卡死 26 秒（事件循环被独占，AbortSignal 完全无效）—— 而 WebFetch 默认
 * 抓正文，任意 URL 都能触发。这里用 indexOf 单向扫描，from 永远前进。
 *
 * 未闭合时**保留内容**（旧正则在那种情况下也不匹配），语义不变、只快不慢。
 */
function stripBlocks(html: string, tags: string[]): string {
  const lower = html.toLowerCase();
  const out: string[] = [];
  let from = 0;
  while (from < html.length) {
    let best = -1;
    let bestTag = "";
    for (const tag of tags) {
      const at = lower.indexOf("<" + tag, from);
      if (at >= 0 && (best < 0 || at < best)) {
        best = at;
        bestTag = tag;
      }
    }
    if (best < 0) break;
    const openEnd = lower.indexOf(">", best);
    if (openEnd < 0) break;
    const close = lower.indexOf("</" + bestTag, openEnd);
    if (close < 0) {
      // 未闭合：把开始标签留下（后面还会被 <[^>]+> 去掉），继续往后找
      out.push(html.slice(from, openEnd + 1));
      from = openEnd + 1;
      continue;
    }
    const closeEnd = lower.indexOf(">", close);
    out.push(html.slice(from, best), " ");
    from = closeEnd < 0 ? html.length : closeEnd + 1;
  }
  out.push(html.slice(from));
  return out.join("");
}

/** 线性剥注释：同样避开 `<!--[\s\S]*?-->` 的超线性回扫。 */
function stripComments(html: string): string {
  const out: string[] = [];
  let from = 0;
  while (from < html.length) {
    const start = html.indexOf("<!--", from);
    if (start < 0) break;
    out.push(html.slice(from, start), " ");
    const end = html.indexOf("-->", start + 4);
    from = end < 0 ? html.length : end + 3;
  }
  out.push(html.slice(from));
  return out.join("");
}

/** 对越界码点一律返回空串：`&#x110000;` 会让 String.fromCodePoint 抛 RangeError，
 *  异常冲出 htmlToText 后整页被记成"抓取失败"—— 页面里一个实体就能让工具失效。 */
function codePointToString(cp: number): string {
  if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff) return "";
  if (cp >= 0xd800 && cp <= 0xdfff) return "";
  return String.fromCodePoint(cp);
}

export function extractMainText(html: string): string {
  const stripped = stripBlocks(stripComments(html), ["script", "style", "noscript", "nav", "header", "footer", "aside", "svg", "iframe"]);
  const trimmed = stripped;
  const article = /<article[\s\S]*?<\/article>/i.exec(trimmed);
  const mainTag = /<main[\s\S]*?<\/main>/i.exec(trimmed);
  const body = /<body[\s\S]*?<\/body>/i.exec(trimmed);
  const picked = article?.[0] ?? mainTag?.[0] ?? body?.[0] ?? trimmed;
  const text = htmlToText(picked);
  // 没有 article/main 时只留最长的几段：宁可短，不要噪音
  const paragraphs = text.split("\n\n").map((s) => s.trim()).filter((s) => s.length > 60);
  if (article || mainTag) return text;
  if (paragraphs.length >= 2) return paragraphs.slice(0, 12).join("\n\n");
  // 只有一段（比如整页一个长段落）就原样返回：上面那条只用于"多段但大多是模板"的情况
  return text;
}

export function htmlToText(html: string): string {
  return stripBlocks(stripComments(html), ["script", "style"])
    .replace(/<\/(p|div|section|article|li|tr|h[1-6]|br)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, String.fromCharCode(34))
    .replace(/&apos;/g, String.fromCharCode(39))
    // 数字实体：有的站点用 &#x27; 而不是 &#39;，不处理就会留在正文里。
    // 正则限长 + 码点钳制：超长/越界实体一律降级成空串，绝不抛异常。
    .replace(/&#x([0-9a-fA-F]{1,8});/g, (_m, h: string) => codePointToString(parseInt(h, 16)))
    .replace(/&#(\d{1,10});/g, (_m, d: string) => codePointToString(Number(d)))
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")

    .trim();
}

/**
 * 按预算切片，但**不切在句子/段落中间**。
 *
 * 以前的硬切（text.slice(0, max)）会把句子拦腰砍断，模型看到半句话会误判内容完整性。
 * 现在在预算的最后 20% 窗口里往回找段落/行/句号边界；找不到边界才退回硬边界。
 * 同时返回 nextOffset：长页面可以分段取回，一点内容都不丢。
 */
export function sliceForBudget(
  text: string,
  offset: number,
  budget: number,
): { slice: string; nextOffset: number | null; total: number } {
  const total = text.length;
  const start = Math.max(0, Math.min(offset, total));
  if (start >= total) return { slice: "", nextOffset: null, total };
  const hardEnd = Math.min(total, start + budget);
  if (hardEnd >= total) return { slice: text.slice(start), nextOffset: null, total };

  // 只在实际预算靠后处找边界，避免切得过短
  const floor = start + Math.max(200, Math.floor(budget * 0.8));
  let cut = -1;
  const separators = ["\n\n", "\n", "。", ". ", "！", "？"];
  for (const sep of separators) {
    const idx = text.lastIndexOf(sep, hardEnd);
    if (idx >= floor) {
      cut = idx + sep.length;
      break;
    }
  }
  if (cut < 0) cut = hardEnd;
  return { slice: text.slice(start, cut), nextOffset: cut < total ? cut : null, total };
}
/** 页面正文的读取上限：没有上限时，一个 chunked 的 8GB 响应就能把进程内存打爆。 */
const MAX_PAGE_BYTES = 4_000_000;

async function readBodyCapped(res: Response, limit: number): Promise<{ text: string; bytes: number; truncated: boolean }> {
  const reader = res.body?.getReader();
  if (!reader) {
    const full = await res.text();
    const bytes = Buffer.from(full, "utf8");
    if (bytes.length <= limit) return { text: full, bytes: bytes.length, truncated: false };
    const text = new TextDecoder().decode(bytes.subarray(0, limit), { stream: true });
    return { text, bytes: limit, truncated: true };
  }
  const decoder = new TextDecoder();
  let text = "";
  let total = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        text += decoder.decode();
        break;
      }
      if (!value) continue;
      const remaining = limit - total;
      if (value.byteLength > remaining) {
        if (remaining > 0) text += decoder.decode(value.subarray(0, remaining), { stream: true });
        total = limit;
        truncated = true;
        await reader.cancel().catch(() => {});
        // 不 flush decoder：若上限刚好切在多字节字符中间，丢掉不完整尾字符。
        break;
      }
      total += value.byteLength;
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  }
  return { text, bytes: total, truncated };
}

export async function fetchReadableText(
  rawUrl: string,
  opts: { maxChars?: number; signal?: AbortSignal; main?: boolean; offset?: number } = {},
): Promise<PageTextResult> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "invalid url: " + rawUrl };
  }
  const start = await checkUrl(parsed);
  if (!start.ok) return { ok: false, reason: start.reason ?? "blocked url" };

  const maxChars = Math.max(200, Math.min(80_000, opts.maxChars ?? 20_000));
  try {
    let current = parsed;
    let res: Response | null = null;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      res = await fetch(current, {
        signal: opts.signal,
        headers: { "user-agent": "JYSHarness/0.2 (+https://localhost)", accept: "text/html,text/plain,*/*" },
        redirect: "manual",
      });
      if (res.status < 300 || res.status >= 400) break;
      const location = res.headers.get("location");
      if (!location) break;
      const next = new URL(location, current);
      const check = await checkUrl(next);
      if (!check.ok) {
        return { ok: false, reason: "redirect blocked: " + (check.reason ?? "unsafe target") + " (from " + current.href + ")" };
      }
      current = next;
      res = null;
    }
    if (!res) return { ok: false, reason: "too many redirects (limit " + MAX_REDIRECTS + ")" };
    const type = res.headers.get("content-type") ?? "";
    const body = await readBodyCapped(res, MAX_PAGE_BYTES);
    const content = /html/i.test(type) ? (opts.main ? extractMainText(body.text) : htmlToText(body.text)) : body.text;
    // 不再硬切：按段落/句子边界切，并给出下一次的 offset，让调用方可以分段取回全文。
    const part = sliceForBudget(content, Math.max(0, opts.offset ?? 0), maxChars);
    return {
      ok: true,
      status: res.status,
      url: current.href,
      text: part.slice,
      bytes: body.bytes,
      totalChars: part.total,
      offset: Math.max(0, opts.offset ?? 0),
      nextOffset: body.truncated && part.nextOffset == null ? null : part.nextOffset,
      truncated: body.truncated,
    };
  } catch (err) {
    return { ok: false, reason: "fetch failed: " + (err instanceof Error ? err.message : String(err)) };
  }
}

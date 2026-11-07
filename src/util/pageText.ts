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
}

/**
 * 抽正文区：先砍掉导航/页头/页脚/侧栏/分享这些模板噪音，再优先取 article 或 main。
 *
 * 不这么做的话，抓 nodejs.org 得到的所谓正文是「学习 关于 下载 博客 文档」—— 导航栏。
 * 那种正文比没有更糟：模型会以为页面在讲导航。
 */
export function extractMainText(html: string): string {
  const trimmed = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<(nav|header|footer|aside|form|iframe|svg)[\s\S]*?<\/(nav|header|footer|aside|form|iframe|svg)>/gi, " ")
    .replace(/<[^>]+(class|id)="[^"]*(nav|menu|header|footer|sidebar|breadcrumb|cookie|share|social|comment|related|banner|promo|ads?)[^"]*"[^>]*>[\s\S]*?<\/\w+>/gi, " ");

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
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|section|article|li|tr|h[1-6]|br)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, String.fromCharCode(34))
    .replace(/&apos;/g, String.fromCharCode(39))
    // 数字实体：有的站点用 &#x27; 而不是 &#39;，不处理就会留在正文里
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d)))
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")

    .trim();
}

export async function fetchReadableText(
  rawUrl: string,
  opts: { maxChars?: number; signal?: AbortSignal; main?: boolean } = {},
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
    const body = await res.text();
    const text = /html/i.test(type) ? (opts.main ? extractMainText(body) : htmlToText(body)) : body;
    const clipped = text.length > maxChars ? text.slice(0, maxChars) + "\n...[truncated]" : text;
    return { ok: true, status: res.status, url: current.href, text: clipped, bytes: body.length };
  } catch (err) {
    return { ok: false, reason: "fetch failed: " + (err instanceof Error ? err.message : String(err)) };
  }
}

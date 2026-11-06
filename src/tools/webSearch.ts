/**
 * WebSearch：按关键词搜网页。
 *
 * 为什么不让模型自己 WebFetch 了事：模型不知道 URL。没有检索，它只能凭记忆回答 ——
 * 这正是"能抓页面"和"能查资料"的差别。
 *
 * 后端有序降级：
 *   1. 配了 key 的正规 API（Tavily / Brave / Serper）—— 有配额、稳定，优先；
 *   2. Bing 的 RSS 输出 —— 免 key，本机实测可用（www 版被地域降级，cn 版正常）；
 *   3. DuckDuckGo 的 HTML 版 —— 部分网络可达。
 * 免 key 后端精度有限：实测 Bing RSS 会忽略 site: 操作符、长查询还可能返回无关内容。
 * 所以这里自己也做两件事：按查询词打分筛掉垃圾、自己实现 site 过滤；
 * 一条相关结果都没有时仍然返回，但显式警告，绝不假装搜到了。
 */
import type { Tool, ToolResult, ToolContext } from "./types.ts";
import { num, str } from "./types.ts";

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

/** 可注入的 fetch：测试里换成固定响应，不必真的联网。 */
export type FetchLike = (
  url: string,
  init: { headers: Record<string, string>; signal?: AbortSignal; method?: string; body?: string },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export function decodeEntities(input: string): string {
  const named: Record<string, string> = {
    nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", mdash: "—",
    ndash: "–", hellip: "…", middot: "·",
  };
  return input
    .replace(/&#x([0-9a-f]+);/gi, (_m, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n: string) => named[n.toLowerCase()] ?? m);
}

/**
 * 先解码再剥标签，然后再解码一次。
 *
 * 顺序很重要：RSS 的描述字段常常是 "&lt;em&gt;collections&lt;/em&gt;"。
 * 如果先剥标签（这时 <em> 还不存在）再解码，标签就会留在结果里 —— 实测确实留了。
 */
export function stripTags(input: string): string {
  const once = decodeEntities(input)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]*>/g, " ");
  return decodeEntities(once).replace(/\s+/g, " ").trim();
}

/** Bing 的 RSS 输出：item / title / link / description。 */
export function parseRssItems(xml: string, limit: number): SearchHit[] {
  const out: SearchHit[] = [];
  for (const raw of xml.split(/<item>/i).slice(1)) {
    const body = raw.split(/<\/item>/i)[0];
    const title = stripTags(/<title>([\s\S]*?)<\/title>/i.exec(body)?.[1] ?? "");
    const url = decodeEntities((/<link>([\s\S]*?)<\/link>/i.exec(body)?.[1] ?? "").trim());
    const snippet = stripTags(/<description>([\s\S]*?)<\/description>/i.exec(body)?.[1] ?? "");
    if (!url || !/^https?:\/\//i.test(url)) continue;
    out.push({ title, url, snippet });
    if (out.length >= limit) break;
  }
  return out;
}

/** DuckDuckGo HTML 版：result__a / result__snippet（lite 版是 result-link / result-snippet）。 */
export function parseDuckDuckGoHtml(html: string, limit: number): SearchHit[] {
  const out: SearchHit[] = [];
  const re = /<a[^>]*class="[^"]*result(?:__a|-link)[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const anchors = [...html.matchAll(re)];
  for (let i = 0; i < anchors.length; i++) {
    const m = anchors[i];
    const rawUrl = decodeEntities(m[1]);
    // 跳转链接必须先还原再校验协议：DDG 给的是 //duckduckgo.com/l/?uddg=<encoded>，
    // 直接拿它去匹配 ^https?: 会被当成非法链接丢掉（实测就丢了一条）。
    const uddg = /[?&]uddg=([^&]+)/.exec(rawUrl);
    const url = uddg ? decodeURIComponent(uddg[1]) : rawUrl;
    if (!/^https?:\/\//i.test(url)) continue;
    // 摘要取本条标题到下一个标题之间的窗口：跨 div 边界的结构也能命中
    const from = (m.index ?? 0) + m[0].length;
    const to = i + 1 < anchors.length ? (anchors[i + 1].index ?? html.length) : html.length;
    const window = html.slice(from, Math.min(to, from + 4000));
    const snippet = stripTags(
      /class="[^"]*result(?:__snippet|-snippet)[^"]*"[^>]*>([\s\S]*?)<\/(?:a|span|div|p)>/i.exec(window)?.[1] ??
        /<p[^>]*>([\s\S]*?)<\/p>/i.exec(window)?.[1] ??
        "",
    );
    out.push({ title: stripTags(m[2]), url, snippet });
    if (out.length >= limit) break;
  }
  return out;
}

/** 查询词：去掉 site: 与引号，取长度 >= 2 的词（小写）。 */
export function queryTerms(query: string): string[] {
  return query
    .replace(/site:\S+/gi, " ")
    .replace(/"/g, " ")
    .toLowerCase()
    .split(/[^\p{L}\p{N}_.+\-#]+/u)
    .filter((t) => t.length >= 2);
}

/**
 * 结果与查询词的相关度 = 命中的不同查询词数量（标题命中权重更高）。
 *
 * 为什么需要它：免 key 的 Bing RSS 对长查询解析很差（实测连 site: 都不生效，
 * node.js streams 会返回完全无关的内容）。与其把垃圾当事实交给模型，
 * 不如先按词打分，宁可少给几条。
 */
export function scoreHit(hit: SearchHit, terms: string[]): number {
  if (!terms.length) return 1;
  const title = hit.title.toLowerCase();
  const body = (hit.title + " " + hit.snippet + " " + hit.url).toLowerCase();
  let score = 0;
  for (const t of terms) {
    if (title.includes(t)) score += 2;
    else if (body.includes(t)) score += 1;
  }
  return score;
}

/** 自己实现 site 过滤：不能指望后端遵守 site: 操作符（实测被忽略）。 */
export function filterBySite(hits: SearchHit[], site: string): SearchHit[] {
  if (!site) return hits;
  const want = site.toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  return hits.filter((h) => {
    try {
      const host = new URL(h.url).hostname.toLowerCase();
      return host === want || host.endsWith("." + want);
    } catch {
      return false;
    }
  });
}

export interface SearchBackend {
  name: string;
  /** 是否可用（例如没配 key 的 API 后端直接跳过）。 */
  available(): boolean;
  run(query: string, count: number, signal: AbortSignal | undefined, doFetch: FetchLike): Promise<SearchHit[]>;
}

const jsonFetch: FetchLike = async (url, init) => {
  const res = await fetch(url, {
    headers: init.headers,
    signal: init.signal,
    method: init.method ?? "GET",
    body: init.body,
  });
  return { ok: res.ok, status: res.status, text: () => res.text() };
};

async function postJson(url: string, headers: Record<string, string>, body: unknown, signal?: AbortSignal) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal,
  });
  const text = await res.text();
  try {
    return { status: res.status, json: JSON.parse(text) as unknown };
  } catch {
    return { status: res.status, json: null as unknown };
  }
}

/** 有 key 的正规 API。没有 key 就 available()=false，直接跳过。 */
export function apiBackends(env: Record<string, string | undefined> = process.env): SearchBackend[] {
  const out: SearchBackend[] = [];
  if (env.HARNESS_TAVILY_KEY) {
    out.push({
      name: "tavily",
      available: () => true,
      async run(query, count, signal) {
        const r = await postJson(
          "https://api.tavily.com/search",
          {},
          { api_key: env.HARNESS_TAVILY_KEY, query, max_results: count, search_depth: "basic" },
          signal,
        );
        const results = (r.json as { results?: { title?: string; url?: string; content?: string }[] } | null)?.results ?? [];
        return results.map((x) => ({
          title: x.title ?? "",
          url: x.url ?? "",
          snippet: stripTags(x.content ?? "").slice(0, 220),
        }));
      },
    });
  }
  if (env.HARNESS_BRAVE_KEY) {
    out.push({
      name: "brave",
      available: () => true,
      async run(query, count, signal, doFetch) {
        const url =
          "https://api.search.brave.com/res/v1/web/search?q=" + encodeURIComponent(query) + "&count=" + count;
        const res = await doFetch(url, {
          headers: { accept: "application/json", "x-subscription-token": env.HARNESS_BRAVE_KEY ?? "" },
          signal,
        });
        const body = JSON.parse(await res.text()) as {
          web?: { results?: { title?: string; url?: string; description?: string }[] };
        };
        return (body.web?.results ?? []).map((x) => ({
          title: x.title ?? "",
          url: x.url ?? "",
          snippet: stripTags(x.description ?? "").slice(0, 220),
        }));
      },
    });
  }
  if (env.HARNESS_SERPER_KEY) {
    out.push({
      name: "serper",
      available: () => true,
      async run(query, count, signal) {
        const r = await postJson(
          "https://google.serper.dev/search",
          { "x-api-key": env.HARNESS_SERPER_KEY ?? "" },
          { q: query, num: count },
          signal,
        );
        const organic =
          (r.json as { organic?: { title?: string; link?: string; snippet?: string }[] } | null)?.organic ?? [];
        return organic.map((x) => ({
          title: x.title ?? "",
          url: x.link ?? "",
          snippet: stripTags(x.snippet ?? "").slice(0, 220),
        }));
      },
    });
  }
  return out;
}

/** 免 key 后端：Bing RSS（cn 优先）+ DuckDuckGo HTML。 */
export function freeBackends(): SearchBackend[] {
  const bing = (host: string, name: string): SearchBackend => ({
    name,
    available: () => true,
    async run(query, count, signal, doFetch) {
      const url = "https://" + host + "/search?format=rss&count=" + count + "&q=" + encodeURIComponent(query);
      const res = await doFetch(url, {
        headers: {
          "user-agent": UA,
          accept: "application/rss+xml,text/xml,*/*",
          "accept-language": "en-US,en;q=0.9",
        },
        signal,
      });
      const xml = await res.text();
      if (!res.ok) throw new Error("HTTP " + res.status);
      return parseRssItems(xml, count);
    },
  });
  return [
    bing("cn.bing.com", "bing-cn-rss"),
    bing("www.bing.com", "bing-rss"),
    {
      name: "duckduckgo-html",
      available: () => true,
      async run(query, count, signal, doFetch) {
        const res = await doFetch("https://html.duckduckgo.com/html/?q=" + encodeURIComponent(query), {
          headers: { "user-agent": UA, accept: "text/html,*/*", "accept-language": "en-US,en;q=0.9" },
          signal,
        });
        const html = await res.text();
        if (!res.ok) throw new Error("HTTP " + res.status);
        return parseDuckDuckGoHtml(html, count);
      },
    },
  ];
}

export function formatHits(hits: SearchHit[], backend: string, query: string): string {
  const lines = ["query: " + query + "  (backend: " + backend + ", " + hits.length + " 条)"];
  hits.forEach((h, i) => {
    lines.push(i + 1 + ". " + (h.title || "(无标题)"));
    lines.push("   " + h.url);
    if (h.snippet) lines.push("   " + h.snippet);
  });
  return lines.join("\n");
}

export const WebSearchTool: Tool = {
  name: "WebSearch",
  description:
    "Search the web for a query and return the top results (title, url, snippet). " +
    "Use it to find pages you do not know the URL of, then WebFetch the best result for details. " +
    "Backends: Tavily/Brave/Serper when a key is set, otherwise Bing RSS and DuckDuckGo. " +
    "Results are filtered by keyword relevance; if the backend ignores the query you get an explicit warning.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search keywords (natural language works)." },
      count: { type: "number", description: "How many results (default 5, max 10)." },
      site: { type: "string", description: "Optional domain filter, e.g. github.com." },
    },
    required: ["query"],
  },
  isReadOnly: true,
  isConcurrencySafe: () => true,
  maxOutputChars: 20_000,
  timeoutMs: 30_000,
  retries: 1,
  validate(input) {
    const q = str(input, "query").trim();
    if (!q) return "query must not be empty";
    if (q.length > 500) return "query is too long (max 500 chars)";
    return null;
  },
  async call(input, ctx: ToolContext): Promise<ToolResult> {
    const queryRaw = str(input, "query").trim();
    const site = str(input, "site").trim();
    const query = site ? queryRaw + " site:" + site : queryRaw;
    const count = Math.min(10, Math.max(1, num(input, "count", 5)));
    const terms = queryTerms(queryRaw);
    const backends = [...apiBackends(), ...freeBackends()].filter((b) => b.available());
    const failures: string[] = [];
    let best: { backend: string; hits: SearchHit[]; score: number } | null = null;
    for (const backend of backends) {
      try {
        // 每个后端单独限时：不可达的后端（如被墙的 DDG）不该把整次搜索拖到 10 秒以上。
        // 同时并上 ctx.signal —— 用户按 Esc 要能立刻停。
        const budget = AbortSignal.timeout(8_000);
        const signal = AbortSignal.any ? AbortSignal.any([ctx.signal, budget]) : budget;
        let raw = await backend.run(query, count, signal, jsonFetch);
        let hits = filterBySite(raw, site);
        if (!hits.length && site) {
          // 后端忽略了 site: 操作符（实测 Bing RSS 就是）。退一步：把域名当普通查询词，
          // 通常仍能把该站点的页面顶上来，然后再过滤一次。
          raw = await backend.run(queryRaw + " " + site, count, signal, jsonFetch);
          hits = filterBySite(raw, site);
        }
        if (!hits.length) {
          failures.push(backend.name + (site ? "：加了域名重试仍 0 条" : "：0 条"));
          continue;
        }
        const scored = hits.map((h) => ({ h, s: scoreHit(h, terms) }));
        const total = scored.reduce((acc, x) => acc + x.s, 0);
        const relevant = scored.filter((x) => x.s > 0).length;
        if (!best || total > best.score) best = { backend: backend.name, hits, score: total };
        // 命中够多就采用，不再试后面的后端（省一次网络往返）
        if (relevant >= Math.min(3, count) && total > 0) {
          best = { backend: backend.name, hits, score: total };
          break;
        }
        failures.push(backend.name + "：" + relevant + "/" + hits.length + " 条与查询词相关");
      } catch (err) {
        failures.push(backend.name + "：" + (err instanceof Error ? err.message : String(err)).slice(0, 80));
      }
    }
    if (best) {
      const scored = best.hits.map((h) => ({ h, s: scoreHit(h, terms) }));
      const keep = scored.filter((x) => x.s > 0).map((x) => x.h);
      const use = keep.length ? keep : best.hits;
      const warn = keep.length
        ? ""
        : "⚠ 没有找到与查询词相关的结果。后端返回的内容与查询无关（可能忽略了查询），" +
          "下面是原文照列，**不要当作检索结果引用**；请改用更具体的关键词、或直接 WebFetch 已知 URL。\n\n";
      return {
        content: warn + formatHits(use, best.backend, query),
        metadata: { backend: best.backend, hits: use.length, relevant: keep.length, terms },
        isError: keep.length === 0 && best.score === 0,
      };
    }
    return {
      content:
        "搜索失败：所有后端都没返回结果。" +
        (failures.length ? failures.map((f) => "\n  - " + f).join("") : "") +
        "\n提示：可设置 HARNESS_TAVILY_KEY / HARNESS_BRAVE_KEY / HARNESS_SERPER_KEY 使用更稳定的搜索 API；" +
        "若全是网络错误，说明这台机器访问不了这些站点（用 WebFetch 抓已知 URL 仍可用）。",
      isError: true,
      metadata: { failures },
    };
  },
};

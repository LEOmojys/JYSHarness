import test from "node:test";
import assert from "node:assert/strict";
import { apiBackends, decodeEntities, filterBySite, formatHits, freeBackends, parseDuckDuckGoHtml, parseRssItems, queryTerms, scoreHit, stripTags, WebSearchTool } from "../src/tools/webSearch.ts";

// 真实抓下来的 Bing RSS 结构（截取两条）
const RSS = [
  '<?xml version="1.0" encoding="utf-8" ?>',
  "<rss version=\"2.0\"><channel>",
  "<item><title>Node.js Streams 官方文档</title><link>https://nodejs.org/api/stream.html</link>",
  "<description>Streams are &lt;em&gt;collections&lt;/em&gt; of data &amp; more.</description></item>",
  "<item><title><![CDATA[ 两种写法 ]]></title><link>https://example.com/a?x=1&amp;y=2</link>",
  "<description>中文摘要，含 &amp;quot;引号&amp;quot;。</description></item>",
  "<item><title>坏数据</title><link>javascript:alert(1)</link><description>应当被丢弃</description></item>",
  "</channel></rss>",
].join("");

// DuckDuckGo HTML 版结构（含跳转链接）
const DDG = [
  '<div class="result"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fnodejs.org%2Fapi%2Fstream.html&rut=x">Node.js Streams</a>',
  '<a class="result__snippet" href="x">A stream is an abstract interface...</a></div>',
  '<div class="result"><a class="result__a" href="https://developer.mozilla.org/en-US/docs/Web/API/Streams_API">Streams API - MDN</a>',
  '<div class="result__snippet">The Streams API allows software to programmatically...</div></div>',
].join("");

test("websearch: entity decoding and tag stripping", () => {
  assert.equal(decodeEntities("a &amp; b &#39;c&#39; &#x4e2d;"), "a & b 'c' 中");
  assert.equal(stripTags("<b>粗</b>  <i>体</i>\n 多空格"), "粗 体 多空格");
  assert.equal(stripTags("<script>var x=1</script>可见"), "可见");
});

test("websearch: RSS parsing keeps real links, drops javascript: ones", () => {
  const hits = parseRssItems(RSS, 5);
  assert.equal(hits.length, 2, "javascript: 链接必须被丢弃");
  assert.equal(hits[0].url, "https://nodejs.org/api/stream.html");
  assert.equal(hits[0].title, "Node.js Streams 官方文档");
  assert.match(hits[0].snippet, /collections of data & more/);
  assert.equal(hits[1].url, "https://example.com/a?x=1&y=2", "&amp; 必须还原成 &");
});

test("websearch: limit is honoured", () => {
  assert.equal(parseRssItems(RSS, 1).length, 1);
});

test("websearch: DuckDuckGo parsing unwraps the redirect", () => {
  const hits = parseDuckDuckGoHtml(DDG, 5);
  assert.equal(hits.length, 2);
  assert.equal(hits[0].url, "https://nodejs.org/api/stream.html", "uddg 跳转必须被还原");
  assert.equal(hits[0].title, "Node.js Streams");
  assert.match(hits[0].snippet, /abstract interface/);
  assert.equal(hits[1].url, "https://developer.mozilla.org/en-US/docs/Web/API/Streams_API");
});

test("websearch: API backends only appear when a key is configured", () => {
  assert.equal(apiBackends({}).length, 0);
  assert.deepEqual(apiBackends({ HARNESS_TAVILY_KEY: "k" }).map((b) => b.name), ["tavily"]);
  assert.deepEqual(apiBackends({ HARNESS_BRAVE_KEY: "k" }).map((b) => b.name), ["brave"]);
  assert.deepEqual(apiBackends({ HARNESS_SERPER_KEY: "k" }).map((b) => b.name), ["serper"]);
});

test("websearch: free backends are cn-bing, www-bing, duckduckgo (in that order)", () => {
  assert.deepEqual(freeBackends().map((b) => b.name), ["bing-cn-rss", "bing-rss", "duckduckgo-html"]);
});

test("websearch: a failing backend falls through to the next one", async () => {
  const backend = freeBackends()[0];
  // 第一个后端直接 HTTP 500 → 抛错，由工具层捕获并尝试下一个
  await assert.rejects(
    backend.run("q", 3, undefined, async () => ({ ok: false, status: 500, text: async () => "" })),
    /HTTP 500/,
  );
  const hits = await backend.run("q", 3, undefined, async () => ({ ok: true, status: 200, text: async () => RSS }));
  assert.equal(hits.length, 2);
});

test("websearch: empty query is rejected before any network call", () => {
  assert.equal(WebSearchTool.validate?.({ query: "   " }), "query must not be empty");
  assert.equal(WebSearchTool.validate?.({ query: "x".repeat(501) }), "query is too long (max 500 chars)");
  assert.equal(WebSearchTool.validate?.({ query: "ok" }), null);
});

test("websearch: output is numbered with titles, urls and snippets", () => {
  const text = formatHits([{ title: "T", url: "https://e.com", snippet: "S" }], "bing-cn-rss", "q");
  assert.match(text, /backend: bing-cn-rss/);
  assert.match(text, /1\. T/);
  assert.match(text, /https:\/\/e\.com/);
});

test("websearch: queryTerms drops operators and short tokens", () => {
  assert.deepEqual(queryTerms('site:nodejs.org "stream pipeline" error'), ["stream", "pipeline", "error"]);
  assert.deepEqual(queryTerms("a b"), []);
});

test("websearch: scoreHit ranks title matches above snippet matches", () => {
  const terms = queryTerms("stream pipeline");
  const inTitle = scoreHit({ title: "Stream Pipeline", url: "https://x", snippet: "" }, terms);
  const inSnippet = scoreHit({ title: "misc", url: "https://x", snippet: "about stream pipeline" }, terms);
  const unrelated = scoreHit({ title: "完全无关", url: "https://x", snippet: "别的主题" }, terms);
  assert.ok(inTitle > inSnippet, "标题命中应更高: " + inTitle + " vs " + inSnippet);
  assert.equal(unrelated, 0);
  assert.equal(scoreHit({ title: "x", url: "https://x", snippet: "" }, []), 1, "没有查询词时不筛");
});

test("websearch: filterBySite implements site: locally (backends ignore it)", () => {
  const hits = [
    { title: "a", url: "https://nodejs.org/api/stream.html", snippet: "" },
    { title: "b", url: "https://blog.csdn.net/x", snippet: "" },
    { title: "c", url: "https://docs.nodejs.org/guide", snippet: "" },
  ];
  assert.deepEqual(filterBySite(hits, "nodejs.org").map((h) => h.title), ["a", "c"]);
  assert.deepEqual(filterBySite(hits, "").map((h) => h.title), ["a", "b", "c"]);
  assert.equal(filterBySite(hits, "not-a-host.com").length, 0);
});

test("websearch: irrelevant backend results are flagged, not silently trusted", async () => {
  // 后端返回一堆与查询无关的结果时，工具必须显式警告（实测 Bing RSS 就会这样）
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    ({
      ok: true,
      status: 200,
      text: async () => '<rss><channel><item><title>抖音</title><link>https://douyin.com/x</link><description>无关内容</description></item></channel></rss>',
    }) as never) as unknown as typeof fetch;
  try {
    const res = await WebSearchTool.call(
      { query: "nodejs stream pipeline", count: 3 },
      { workspaceRoot: ".", cwd: ".", sandbox: { mode: "workspace-write", workspaceRoot: "." }, signal: new AbortController().signal } as never,
    );
    assert.equal(res.isError, true, "零相关结果应标记为错误，避免模型当成事实");
    const text = String(res.content);
    assert.match(text, /没有找到与查询词相关的结果/, "必须明确说明没搜到");
    assert.match(text, /不要当作检索结果引用/, "必须警告不要引用");
    assert.ok(text.indexOf("⚠") < text.indexOf("query:"), "警告要在结果之前，模型才先读到");
  } finally {
    globalThis.fetch = originalFetch;
  }
});


test("websearch: read=1 fetches the top result and inlines its body", async () => {
  const previous = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (url: string) => {
    calls.push(String(url));
    if (String(url).includes("format=rss")) {
      return {
        ok: true, status: 200,
        text: async () =>
          '<rss><channel><item><title>Streams guide</title><link>https://example.com/a</link><description>snip</description></item>' +
          '<item><title>Streams second</title><link>https://example.com/b</link><description>snip2</description></item></channel></rss>',
      };
    }
    return { ok: true, status: 200, headers: { get: () => "text/html" }, text: async () => "<html><body><p>" + "正文内容".repeat(120) + "</p></body></html>" };
  }) as never as typeof fetch;
  try {
    const res = await WebSearchTool.call(
      { query: "streams guide", count: 2, read: 1 },
      { signal: new AbortController().signal } as never,
    );
    const text = String(res.content);
    assert.match(text, /--- 正文 ---/, "必须把正文贴出来");
    assert.match(text, /正文内容正文内容/, "正文要真的来自页面");
    const pageCalls = calls.filter((u) => !u.includes("format=rss"));
    assert.equal(pageCalls.length, 1, "read=1 只该抓 1 个页面，实际: " + pageCalls.length);
  } finally {
    globalThis.fetch = previous;
  }
});

test("websearch: read=0 does not fetch any page", async () => {
  const previous = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (url: string) => {
    calls.push(String(url));
    return {
      ok: true, status: 200,
      text: async () => '<rss><channel><item><title>x</title><link>https://example.com/a</link><description>d</description></item></channel></rss>',
    };
  }) as never as typeof fetch;
  try {
    const res = await WebSearchTool.call({ query: "x", count: 1, read: 0 }, { signal: new AbortController().signal } as never);
    assert.equal(calls.filter((u) => !u.includes("format=rss")).length, 0, "read=0 不该抓页面");
    assert.doesNotMatch(String(res.content), /--- 正文 ---/);
  } finally {
    globalThis.fetch = previous;
  }
});

test("websearch: a failing page fetch is reported, results still returned", async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    if (String(url).includes("format=rss")) {
      return {
        ok: true, status: 200,
        text: async () => '<rss><channel><item><title>node streams</title><link>https://example.com/blocked</link><description>node streams</description></item></channel></rss>',
      };
    }
    return { ok: false, status: 403, headers: { get: () => "text/html" }, text: async () => "denied" };
  }) as never as typeof fetch;
  try {
    const res = await WebSearchTool.call({ query: "node streams", count: 1, read: 1 }, { signal: new AbortController().signal } as never);
    const text = String(res.content);
    assert.match(text, /https:\/\/example.com\/blocked/, "检索结果本身不能丢");
    assert.match(text, /正文抓取失败|正文过短/, "抓取失败要明说");
  } finally {
    globalThis.fetch = previous;
  }
});

test("websearch: per-page cap is enforced", async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    if (String(url).includes("format=rss")) {
      return { ok: true, status: 200, text: async () => '<rss><channel><item><title>long page content</title><link>https://example.com/long</link><description>long page content</description></item></channel></rss>' };
    }
    return { ok: true, status: 200, headers: { get: () => "text/html" }, text: async () => "<p>" + "长".repeat(5000) + "</p>" };
  }) as never as typeof fetch;
  try {
    const res = await WebSearchTool.call({ query: "long page content", count: 1, read: 1, max_chars_per_page: 400 }, { signal: new AbortController().signal } as never);
    const text = String(res.content);
    assert.ok(text.length < 1500, "每页上限 400 字，总输出不该爆: " + text.length);
  } finally {
    globalThis.fetch = previous;
  }
});


test("websearch: no page is fetched when nothing is relevant", async () => {
  const previous = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (url: string) => {
    calls.push(String(url));
    return { ok: true, status: 200, text: async () => '<rss><channel><item><title>无关标题</title><link>https://example.com/junk</link><description>无关</description></item></channel></rss>' };
  }) as never as typeof fetch;
  try {
    const res = await WebSearchTool.call({ query: "qzxvbnmkl kjhgfdsa", count: 1, read: 2 }, { signal: new AbortController().signal } as never);
    assert.equal(res.isError, true);
    // 注意：要排除的是"抓结果页"，不是"试下一个搜索后端"（DDG 的 URL 也不含 format=rss）
    assert.equal(calls.filter((u) => u.includes("example.com")).length, 0, "零相关时不该抓正文");
    assert.doesNotMatch(String(res.content), /--- 正文 ---/);
  } finally {
    globalThis.fetch = previous;
  }
});


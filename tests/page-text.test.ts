import test from "node:test";
import assert from "node:assert/strict";
import { extractMainText, fetchReadableText, htmlToText, sliceForBudget } from "../src/util/pageText.ts";
import { WebFetchTool } from "../src/tools/extra.ts";

// 结构仿真实文档页：一大段导航 + article 正文
const PAGE = [
  "<html><body>",
  "<header><nav><a>Docs</a><a>Handbook</a><a>Playground</a></nav></header>",
  '<div class="sidebar-menu"><a>目录一</a><a>目录二</a></div>',
  "<article><h1>The satisfies Operator</h1><p>" + "正文内容".repeat(80) + "</p></article>",
  "<footer><p>版权所有 导航</p></footer>",
  "</body></html>",
].join("");

test("pageText: htmlToText keeps the whole page (nav included)", () => {
  const text = htmlToText(PAGE);
  assert.match(text, /Handbook/, "整页文本应包含导航");
  assert.match(text, /正文内容/, "也应包含正文");
});

test("pageText: extractMainText prefers the article and drops nav/footer", () => {
  const text = extractMainText(PAGE);
  assert.match(text, /The satisfies Operator/, "要保留正文标题");
  assert.match(text, /正文内容/);
  assert.doesNotMatch(text, /Handbook/, "导航必须被砍掉");
  assert.doesNotMatch(text, /版权所有 导航/, "页脚必须被砍掉");
});

test("pageText: extractMainText falls back to <main> when there is no article", () => {
  const html = '<html><body><nav>menu</nav><main><p>' + "主内容".repeat(40) + "</p></main></body></html>";
  const text = extractMainText(html);
  assert.match(text, /主内容/);
  assert.doesNotMatch(text, /menu/);
});

test("pageText: short body falls back to whole text instead of returning nothing", () => {
  // 这条对应一个真实的回归：最后少了一行 return，导致单段落页面返回 undefined
  const html = "<html><body><p>短</p></body></html>";
  const text = extractMainText(html);
  assert.equal(typeof text, "string");
  assert.equal(text, "短");
});

test("pageText: non-HTML content is returned as-is", async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = (async () => ({ ok: true, status: 200, headers: { get: () => "application/json" }, text: async () => '{"a":1}' })) as never as typeof fetch;
  try {
    const page = await fetchReadableText("https://example.com/x.json", { maxChars: 100 });
    assert.equal(page.ok, true);
    assert.equal(page.text, '{"a":1}');
  } finally {
    globalThis.fetch = previous;
  }
});

test("pageText: redirect chain is validated hop by hop", async () => {
  const previous = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return { ok: false, status: 302, headers: { get: (k: string) => (k === "location" ? "http://169.254.169.254/latest/meta-data/" : null) }, text: async () => "" };
  }) as never as typeof fetch;
  try {
    const page = await fetchReadableText("https://example.com/x", {});
    assert.equal(page.ok, false);
    assert.match(page.reason ?? "", /redirect blocked/, "302 指向内网必须被拦");
  } finally {
    globalThis.fetch = previous;
  }
});

test("pageText: private hosts are blocked before any request", async () => {
  const previous = globalThis.fetch;
  let called = false;
  globalThis.fetch = (async () => { called = true; return { ok: true, status: 200, headers: { get: () => "text/plain" }, text: async () => "x" }; }) as never as typeof fetch;
  try {
    const page = await fetchReadableText("http://127.0.0.1:8080/secret", {});
    assert.equal(page.ok, false);
    assert.equal(called, false, "私网地址不该真的发起请求");
  } finally {
    globalThis.fetch = previous;
  }
});

// 造一篇"有段落、有句子"的长文，方便验证边界切分
const PARA = "这是一段用来测试截断行为的正文，句子之间用句号分隔。第二句继续补充内容，确保每段足够长。";
const LONG = Array.from({ length: 60 }, (_, i) => PARA + "（第" + (i + 1) + "段）").join(String.fromCharCode(10) + String.fromCharCode(10));

test("slice: a slice never ends mid-sentence when a boundary exists", () => {
  const part = sliceForBudget(LONG, 0, 500);
  assert.ok(part.slice.length > 0);
  // 切点应落在句子或段落边界上（段落优先，所以可能以换行结尾）
  const tail = part.slice.slice(-12);
  assert.ok(
    /[。！？]|段）|\n\n$|\n$/.test(tail),
    "切片应以句子或段落结束，实际结尾: " + JSON.stringify(tail),
  );
});

test("slice: offsets chain back to the full text with nothing lost", () => {
  const budget = 400;
  let offset = 0;
  let rebuilt = "";
  let rounds = 0;
  for (;;) {
    const part = sliceForBudget(LONG, offset, budget);
    rebuilt += part.slice;
    rounds++;
    if (part.nextOffset == null || rounds > 100) break;
    offset = part.nextOffset;
  }
  assert.equal(rebuilt, LONG, "分段拼接必须还原全文（不能丢字符）");
  assert.ok(rounds > 1, "长文应分多次取回");
});

test("slice: no boundary nearby falls back to the hard limit instead of returning nothing", () => {
  const noPunct = "a".repeat(5000);
  const part = sliceForBudget(noPunct, 0, 300);
  assert.equal(part.slice.length, 300);
  assert.equal(part.nextOffset, 300);
});

test("slice: offset past the end returns empty and no next offset", () => {
  const part = sliceForBudget("short", 999, 100);
  assert.equal(part.slice, "");
  assert.equal(part.nextOffset, null);
});

test("webfetch: truncated output tells how to continue, and the next call returns the rest", async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    headers: { get: () => "text/html" },
    text: async () => "<html><body><article><p>" + LONG.replace(/\n\n/g, "</p><p>") + "</p></article></body></html>",
  })) as never as typeof fetch;
  try {
    const first = await WebFetchTool.call({ url: "https://example.com/long", max_chars: 600 }, { signal: new AbortController().signal } as never);
    const firstText = String(first.content);
    assert.match(firstText, /已截断/, "必须提示被截断");
    const m = /offset=(\d+)\]/.exec(firstText);
    assert.ok(m, "必须给出下一次的 offset，实际: " + firstText.slice(-120));
    const next = Number(m![1]);

    const second = await WebFetchTool.call({ url: "https://example.com/long", max_chars: 600, offset: next }, { signal: new AbortController().signal } as never);
    assert.ok(String(second.content).length > 300, "续读必须拿到内容");
    assert.notEqual(String(second.content), firstText, "续读不能重复同一段");
  } finally {
    globalThis.fetch = previous;
  }
});

test("webfetch: a page shorter than the budget has no truncation hint", async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = (async () => ({ ok: true, status: 200, headers: { get: () => "text/plain" }, text: async () => "短文本" })) as never as typeof fetch;
  try {
    const res = await WebFetchTool.call({ url: "https://example.com/s", max_chars: 1000 }, { signal: new AbortController().signal } as never);
    assert.doesNotMatch(String(res.content), /已截断/);
  } finally {
    globalThis.fetch = previous;
  }
});


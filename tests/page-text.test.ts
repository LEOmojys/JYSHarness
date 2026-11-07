import test from "node:test";
import assert from "node:assert/strict";
import { extractMainText, fetchReadableText, htmlToText } from "../src/util/pageText.ts";

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

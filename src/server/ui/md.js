/* Markdown 渲染与 HTML 转义。
 *
 * 从 app.js 拆出来的原因：这两个是纯函数（无状态、无 DOM），而 app.js 里
 * 剩下的都是"状态 + 事件"。放在单独文件里也方便盯住唯一的注入风险点：
 * 所有文本必须先 esc() 再 inline()，顺序不能反。
 */
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function inline(s) {
  return s.replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}

function md(text) {
  const parts = String(text).split(/```/);
  let out = "";
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) {
      const body = parts[i].replace(/^[a-zA-Z0-9]*\n/, "");
      out += "<pre><code>" + esc(body.replace(/\n$/, "")) + "</code></pre>";
      continue;
    }
    const lines = parts[i].split("\n");
    let buf = [];
    let list = false;
    const flush = () => {
      if (!buf.length) return;
      if (list) out += "<ul>" + buf.map((l) => "<li>" + inline(esc(l)) + "</li>").join("") + "</ul>";
      else out += "<p>" + buf.map((l) => inline(esc(l))).join("<br>") + "</p>";
      buf = [];
      list = false;
    };
    for (const raw of lines) {
      const line = raw.replace(/\s+$/, "");
      if (!line.trim()) { flush(); continue; }
      const h = /^(#{1,3})\s+(.*)$/.exec(line);
      if (h) { flush(); out += "<h" + h[1].length + ">" + inline(esc(h[2])) + "</h" + h[1].length + ">"; continue; }
      const li = /^\s*[-*]\s+(.*)$/.exec(line);
      if (li) { if (!list) { flush(); list = true; } buf.push(li[1]); continue; }
      if (list) flush();
      buf.push(line);
    }
    flush();
  }
  return out;
}

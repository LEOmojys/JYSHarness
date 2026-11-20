/* 消息列表渲染：从 app.js 抽出以控制单文件规模。
 * 依赖 app.js 里的 el / noticeLine / toolCard / changesFor 与 md.js 的 md，
 * 两者在调用时都已定义（本文件先于 app.js 加载）。 */

const RENDER_LIMIT = 150;

function renderMessages(messages) {
  const results = new Map();
  for (const m of messages) for (const b of m.content || []) if (b.type === "tool_result") results.set(b.tool_use_id, b);
  const frag = document.createDocumentFragment();
  const hidden = Math.max(0, messages.length - RENDER_LIMIT);
  const visible = hidden ? messages.slice(-RENDER_LIMIT) : messages;
  if (hidden) frag.appendChild(noticeLine("更早的 " + hidden + " 条消息已折叠（长会话渲染保护）", "info"));
  for (const m of visible) {
    const blocks = m.content || [];
    const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("");
    if (m.role === "user") {
      if (!text.trim()) continue;
      if (m.isMeta) { frag.appendChild(noticeLine(text.trim(), "info")); continue; }
      const node = el("div", "msg user");
      const head = el("div", "msg-head");
      head.appendChild(el("div", "avatar user", "U"));
      head.appendChild(el("span", "msg-role", "你"));
      node.appendChild(head);
      const body = el("div", "msg-body");
      const imgs = blocks.filter((b) => b.type === "image");
      if (imgs.length) {
        const row = el("div", "msg-images");
        for (const img of imgs) {
          const im = el("img", "msg-img");
          im.src = "data:" + img.mediaType + ";base64," + img.data;
          im.alt = img.name || "attached image";
          row.appendChild(im);
        }
        body.appendChild(row);
      }
      if (text.trim()) body.appendChild(document.createTextNode(text));
      node.appendChild(body);
      frag.appendChild(node);
      continue;
    }
    const thinking = blocks.filter((b) => b.type === "thinking").map((b) => b.text).join("");
    if (text.trim() || thinking.trim()) {
      const node = el("div", "msg assistant");
      const head = el("div", "msg-head");
      head.appendChild(el("div", "avatar assistant", "A"));
      head.appendChild(el("span", "msg-role", "助手"));
      node.appendChild(head);
      // 推理过程：默认折叠；只有推理没有正文时也保留这条消息（否则转录里会"消失一轮"）
      if (thinking.trim()) {
        const box = el("details", "thinking");
        box.appendChild(el("summary", "thinking-head", "思考过程（" + thinking.length + " 字）"));
        box.appendChild(el("div", "thinking-body", thinking));
        node.appendChild(box);
      }
      const body = el("div", "msg-body md");
      body.innerHTML = text.trim() ? md(text) : "（本轮只有推理，没有正文）";
      node.appendChild(body);
      frag.appendChild(node);
    }
    for (const b of blocks) {
      if (b.type !== "tool_use") continue;
      frag.appendChild(toolCard(b.name, b.input, results.get(b.id), undefined, b.id, changesFor(b.id)));
    }
  }
  return frag;
}

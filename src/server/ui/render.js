/* 消息列表渲染：从 app.js 抽出以控制单文件规模。
 *
 * 结构：一个"轮次"= 一条用户消息 + 之后的全部动作（推理、工具调用、中间说明）+ 最终回答。
 * 中间过程放进可折叠的 <details>，只把最终回答留在外面 —— 一条长任务在列表里
 * 就是一张卡片，而不是几十个"助手"气泡。
 *
 * 依赖 app.js 里的 el / noticeLine / toolCard / changesFor 与 md.js 的 md，
 * 它们在本文件调用时都已定义（render.js 先于 app.js 加载，但调用发生在运行期）。
 */

// 首屏渲染多少个轮次：长会话一次渲染几百条消息会卡主线程，改为按轮次分批。
// 更早的轮次不丢弃，用户点"加载更早的 N 轮"就往前扩窗口（见 loadEarlierTurns）。
let turnRenderLimit = 40;
const TURN_PAGE = 40;

/** 切会话/重连时把窗口恢复成首屏大小。 */
function resetTurnWindow() {
  turnRenderLimit = TURN_PAGE;
}

/** 这条消息是不是"用户发起了一轮"（元提示不算，它们只是旁注）。 */
function isUserTurnStart(m) {
  if (m.role !== "user" || m.isMeta) return false;
  return (m.content || []).some((b) => b.type === "text" && String(b.text || "").trim());
}

/**
 * 按轮次分组。开头可能先出现没有用户消息的动作（例如从旧版本恢复的转录），
 * 这种也单独成一组，保证不丢内容。
 */
function groupTurns(messages) {
  const turns = [];
  let current = null;
  for (const m of messages) {
    if (m.isMeta) {
      // 旁注（压缩提示、Hook 反馈）不属于任何过程，单独放在时间线上的位置
      turns.push({ kind: "notice", message: m });
      continue;
    }
    if (isUserTurnStart(m)) {
      current = { kind: "turn", user: m, items: [] };
      turns.push(current);
      continue;
    }
    if (!current) {
      current = { kind: "turn", user: null, items: [] };
      turns.push(current);
    }
    current.items.push(m);
  }
  return turns;
}

/**
 * 一轮分成"过程"和"最终回答"。
 * 只有"最后一条消息是 assistant、带正文、且不再调用工具"才算回答：
 * 否则那句只是中间说明（常见形态是"我先看一下…"后面跟一个 tool_use）。
 */
function splitTurn(items) {
  let finalIndex = -1;
  const last = items[items.length - 1];
  if (last && last.role === "assistant") {
    const blocks = last.content || [];
    const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("");
    const hasTool = blocks.some((b) => b.type === "tool_use");
    if (text.trim() && !hasTool) finalIndex = items.length - 1;
  }
  const process = [];
  let finalText = "";
  items.forEach((m, i) => {
    if (i === finalIndex) {
      finalText = (m.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
      return;
    }
    process.push(m);
  });
  return { process, finalText };
}

function renderUserNode(m) {
  const blocks = m.content || [];
  const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("");
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
  return node;
}

/** 过程区里的一条 assistant 消息：推理块 + 正文（正文是"中间说明"，不是最终回答）。 */
function renderProcessAssistant(m, target) {
  const blocks = m.content || [];
  const thinking = blocks.filter((b) => b.type === "thinking").map((b) => b.text).join("");
  const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("");
  if (thinking.trim()) {
    const box = el("details", "thinking");
    box.appendChild(el("summary", "thinking-head", "思考过程（" + thinking.length + " 字）"));
    box.appendChild(el("div", "thinking-body", thinking));
    target.appendChild(box);
  }
  if (text.trim()) {
    const body = el("div", "msg-body md process-text");
    body.innerHTML = md(text);
    target.appendChild(body);
  }
  return blocks;
}

/**
 * 渲染一轮：用户消息 + 可折叠的过程 + 最终回答。
 * @param {boolean} running 这一轮是否还在跑（还在跑就默认展开过程，方便看实时输出）
 */
function renderTurn(turn, results, running) {
  const wrap = el("div", "turn");
  if (turn.user) wrap.appendChild(renderUserNode(turn.user));

  const { process, finalText } = splitTurn(turn.items);
  const toolCount = process.reduce(
    (n, m) => n + (m.content || []).filter((b) => b.type === "tool_use").length,
    0,
  );
  const hasProcess = process.length > 0 || toolCount > 0;

  if (hasProcess) {
    const details = el("details", "turn-process");
    if (running) details.open = true;
    const label = "过程 · " + (toolCount ? toolCount + " 次工具" : process.length + " 条");
    details.appendChild(el("summary", "turn-process-head", label));
    const body = el("div", "turn-process-body");
    for (const m of process) {
      if (m.role === "user") {
        // 工具结果消息：内容已挂在对应 tool_use 的卡片上，这里不重复
        continue;
      }
      const blocks = renderProcessAssistant(m, body);
      for (const b of blocks) {
        if (b.type !== "tool_use") continue;
        body.appendChild(toolCard(b.name, b.input, results.get(b.id), undefined, b.id, changesFor(b.id)));
      }
    }
    details.appendChild(body);
    wrap.appendChild(details);
  }

  if (finalText.trim()) {
    const node = el("div", "msg assistant final");
    const head = el("div", "msg-head");
    head.appendChild(el("div", "avatar assistant", "A"));
    head.appendChild(el("span", "msg-role", "助手"));
    node.appendChild(head);
    const body = el("div", "msg-body md");
    body.innerHTML = md(finalText);
    node.appendChild(body);
    wrap.appendChild(node);
  }
  return wrap;
}

function renderMessages(messages) {
  const results = new Map();
  for (const m of messages) for (const b of m.content || []) if (b.type === "tool_result") results.set(b.tool_use_id, b);
  const frag = document.createDocumentFragment();
  const allTurns = groupTurns(messages);
  const hiddenTurns = Math.max(0, allTurns.length - turnRenderLimit);
  const turns = hiddenTurns ? allTurns.slice(-turnRenderLimit) : allTurns;
  if (hiddenTurns) {
    // 折叠必须能展开：以前只给一句 inert 提示，历史就再也看不到了。
    const btn = el("button", "chip load-earlier", "加载更早的 " + hiddenTurns + " 轮");
    btn.addEventListener("click", () => loadEarlierTurns());
    const row = el("div", "load-earlier-row");
    row.appendChild(btn);
    frag.appendChild(row);
  }
  // 最后一轮若还没出现最终回答，视为进行中：展开过程，否则用户看不到实时输出
  const last = turns[turns.length - 1];
  const lastRunning = Boolean(last && last.kind === "turn" && !splitTurn(last.items).finalText.trim());

  for (const turn of turns) {
    if (turn.kind === "notice") {
      const text = (turn.message.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
      if (text.trim()) frag.appendChild(noticeLine(text.trim(), "info"));
      continue;
    }
    const running = lastRunning && turn === last;
    frag.appendChild(renderTurn(turn, results, running));
  }
  return frag;
}

/**
 * 把流式节点挂进"最后一轮"的过程区并展开它。
 * 没有轮次容器时（比如流式开始时列表还没渲染）退回 transcript 末尾。
 */
function mountLiveIntoCurrentTurn(node) {
  const t = $("transcript");
  const turn = t.querySelector(".turn:last-child");
  if (!turn) {
    t.appendChild(node);
    return;
  }
  let box = turn.querySelector(".turn-process");
  if (!box) {
    box = el("details", "turn-process");
    box.appendChild(el("summary", "turn-process-head", "过程 · 进行中"));
    box.appendChild(el("div", "turn-process-body"));
    turn.appendChild(box);
  }
  box.open = true;
  box.querySelector(".turn-process-body").appendChild(node);
}

/** 往前扩一轮窗口并重渲染列表（保留"是否贴底"的滚动意图）。 */
function loadEarlierTurns() {
  turnRenderLimit += TURN_PAGE;
  const t = $("transcript");
  if (!t || !state || !state.messages) return;
  const keepBottom = atBottom();
  t.innerHTML = "";
  t.appendChild(renderMessages(state.messages));
  if (keepBottom) scrollToBottom();
}

/* JYSHarness desktop UI — no framework, no build step. */
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

let state = null;
let pendingPerm = null;
let liveText = null;
let activePanel = "files";
let filesPath = "";
let fileEntries = [];
let fileError = "";
let pendingImages = []; // { mediaType, data, name }

const BEHAVIOR_LABEL = { deny: "拒绝", ask: "询问", allow: "允许" };

const JOB_STATUS_LABEL = { running: "运行中", done: "已完成", failed: "失败", killed: "已终止" };

const SANDBOX_LABEL = {
  "read-only": "只读",
  "workspace-write": "工作区可写",
  "danger-full-access": "完全放行",
};

const REASON_LABEL = {
  completed: "正常完成",
  max_turns: "达到轮次上限",
  blocking_limit: "触及硬限制",
  aborted: "已取消",
  prompt_too_long: "上下文超长",
  model_error: "模型错误",
  stop_hook_prevented: "被 Stop Hook 阻止",
};

function reasonLabel(reason) {
  return REASON_LABEL[reason] || reason;
}

/** 权限决策的原因码 -> 中文说明（服务端返回的 message 是给开发者看的）。 */
const PERMISSION_REASON_TEXT = {
  hardcoded_deny: "该操作被硬编码策略禁止，无法通过配置放行。",
  rule_deny: "被规则拒绝。",
  rule_ask: "规则要求确认。",
  tool_check_deny: "工具自身的安全检查拒绝了该操作。",
  tool_check_ask: "该操作超出常规范围，需要确认。",
  rule_allow: "符合放行规则。",
  mode_bypass: "当前为完全放行模式。",
  mode_accept_edits: "当前模式会自动接受文件编辑。",
  mode_plan_deny: "计划模式为只读。",
  mode_dont_ask: "当前为不询问模式，需要确认的操作一律拒绝。",
  read_only_default: "只读工具默认放行。",
  default_ask: "此操作需要你的确认。",
};

function permissionReasonText(decision) {
  return PERMISSION_REASON_TEXT[decision.reason] || decision.message || "";
}

/** 服务端下发的结构化提示（带 code），前端负责翻译。 */
function noticeText(ev) {
  const p = ev.params || {};
  switch (ev.code) {
    case "turn_failed":
      return "本轮执行失败：" + (p.message || "");
    case "undo_done":
      return "已撤销 " + p.id + "：恢复 " + p.count + " 个文件";
    case "undo_none":
      return "没有可撤销的改动";
    case "mcp_failed":
      return "MCP 服务器 " + p.server + " 连接失败：" + (p.message || "");
    default:
      return ev.text || "";
  }
}

/* ---------------- markdown ---------------- */
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

/* ---------------- dom helpers ---------------- */
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}
function button(cls, label, onClick) {
  const b = el("button", cls, label);
  b.addEventListener("click", onClick);
  return b;
}

/* ---------------- sessions ---------------- */
function renderSessions() {
  const list = $("sessionList");
  list.innerHTML = "";
  for (const s of state.sessions || []) {
    const item = el("div", "session-item" + (s.id === state.sessionId ? " current" : ""));
    const title = el("span", "s-title", s.title || "（空会话）");
    title.title = s.title || "";
    item.appendChild(title);
    if (s.running) item.appendChild(el("span", "s-dot"));
    const del = button("icon-btn s-del", "×", (e) => {
      e.stopPropagation();
      confirmDeleteSession(s);
    });
    del.title = "删除这个对话";
    item.appendChild(del);
    item.title = s.id;
    item.addEventListener("click", () => switchSession(s.id));
    list.appendChild(item);
  }
  if (!state.sessions || !state.sessions.length) list.appendChild(el("div", "panel-empty", "暂无会话"));
}

/** 删除是破坏性的，必须二次确认；确认框里带上标题，避免删错。 */
function confirmDeleteSession(session) {
  const isCurrent = session.id === state.sessionId;
  confirmDialog({
    title: "删除对话",
    text:
      "确定删除「" + (session.title || "（空会话）") + "」？" +
      (isCurrent ? "当前正在使用这个会话，" : "") +
      "对话记录会从磁盘移除，无法恢复。",
    okLabel: "删除",
    onOk: async () => {
      const res = await fetch("/api/sessions", {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({ action: "delete", id: session.id }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        notice("删除失败：" + (data.error || res.status));
        return;
      }
      renderState(data);
    },
  });
}

async function switchSession(id) {
  if (id === state.sessionId) return;
  const res = await fetch("/api/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "activate", id }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    notice("无法切换会话：" + (err.error || res.status));
    return;
  }
  renderState(await res.json());
}

async function newSession(fork) {
  const res = await fetch("/api/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: fork ? "fork" : "new" }),
  });
  if (res.ok) renderState(await res.json());
}

/* ---------------- sidebar panels ---------------- */
async function loadFiles(p) {
  try {
    const r = await fetch("/api/files?path=" + encodeURIComponent(p || ""));
    if (!r.ok) throw new Error("HTTP " + r.status);
    const data = await r.json();
    filesPath = data.path || "";
    fileEntries = data.entries || [];
    fileError = "";
  } catch (e) {
    fileError = String(e.message || e);
    fileEntries = [];
  }
  renderPanel();
}

function renderPanel() {
  const body = $("panelBody");
  body.innerHTML = "";
  document.querySelectorAll("#panelTabs button").forEach((b) => {
    b.classList.toggle("active", b.dataset.panel === activePanel);
  });

  if (activePanel === "files") {
    const crumbs = el("div", "file-crumbs");
    crumbs.appendChild(el("span", "", "工作区/"));
    if (filesPath) {
      crumbs.appendChild(button("", "..", () => loadFiles(filesPath.split("/").slice(0, -1).join("/"))));
      crumbs.appendChild(el("span", "", filesPath));
    }
    body.appendChild(crumbs);
    if (fileError) body.appendChild(el("div", "panel-empty", fileError));
    for (const f of fileEntries) {
      const row = el("div", "file-entry");
      row.appendChild(el("span", "fi", f.type === "dir" ? "▸" : "·"));
      row.appendChild(el("span", "", f.name));
      row.addEventListener("click", () => (f.type === "dir" ? loadFiles(f.path) : openFile(f.path)));
      body.appendChild(row);
    }
    if (!fileEntries.length && !fileError) body.appendChild(el("div", "panel-empty", "空目录"));
    return;
  }

  if (activePanel === "todos") {
    const todos = state.todos || [];
    if (!todos.length) body.appendChild(el("div", "panel-empty", "暂无待办。模型在多步任务中会调用 TodoWrite 记录进度。"));
    for (const t of todos) {
      const cls = t.status === "completed" ? "done" : t.status === "in_progress" ? "active" : "";
      const row = el("div", "todo-item " + cls);
      row.appendChild(el("span", "box"));
      row.appendChild(el("span", "", t.content));
      body.appendChild(row);
    }
    return;
  }

  if (activePanel === "jobs") {
    const jobs = state.jobs || [];
    if (!jobs.length) body.appendChild(el("div", "panel-empty", "暂无后台任务。Bash 带 run_in_background 参数即可启动。"));
    for (const j of jobs) {
      const card = el("div", "job-card");
      const top = el("div", "job-top");
      top.appendChild(el("span", "pill " + j.status, JOB_STATUS_LABEL[j.status] || j.status));
      top.appendChild(el("span", "job-cmd", j.command));
      if (j.status === "running") {
        top.appendChild(button("ghost", "终止", async () => {
          await fetch("/api/jobs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "kill", id: j.id }) });
        }));
      }
      card.appendChild(top);
      const out = el("pre", "job-out", (j.outputTail || "").slice(-1200) || "（暂无输出）");
      card.appendChild(out);
      body.appendChild(card);
    }
    return;
  }

  if (activePanel === "skills") {
    const skills = state.skills || [];
    if (!skills.length) body.appendChild(el("div", "panel-empty", "暂无技能。添加 .harness/skills/<名称>/SKILL.md"));
    for (const s of skills) {
      const item = el("div", "skill-item");
      item.appendChild(el("div", "skill-name", s.name));
      if (s.description) item.appendChild(el("div", "skill-desc", s.description));
      item.appendChild(el("div", "skill-desc", s.source === "project" ? "项目技能" : "用户技能"));
      body.appendChild(item);
    }
    return;
  }

  body.appendChild(rulesEditor());
}

async function saveRules(next) {
  const res = await fetch("/api/rules", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(next),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    notice("规则被拒绝：" + (err.error || res.status));
    return;
  }
  state.ruleArrays = await res.json();
  renderPanel();
}

function rulesEditor() {
  const box = el("div", "rules-editor");
  const draft = state.ruleArrays || { allow: [], deny: [], ask: [] };
  const hint = el("div", "panel-empty", "保存到 .jysharness/settings.json，并立即对所有运行中的会话生效。");
  box.appendChild(hint);

  for (const behavior of ["deny", "ask", "allow"]) {
    const group = el("div", "rule-group");
    group.appendChild(el("div", "rule-group-title", BEHAVIOR_LABEL[behavior] || behavior));
    const list = draft[behavior] || [];
    for (const rule of list) {
      const row = el("div", "rule-row");
      const code = el("code", "", rule);
      row.appendChild(code);
      row.appendChild(
        button("icon-btn", "×", () => {
          const next = { ...draft, [behavior]: list.filter((r) => r !== rule) };
          void saveRules(next);
        }),
      );
      group.appendChild(row);
    }
    if (!list.length) group.appendChild(el("div", "panel-empty", "无"));
    const addRow = el("div", "rule-add");
    const input = el("input", "rule-input");
    input.placeholder =
      behavior === "allow" ? "Bash(git status)" : behavior === "ask" ? "Bash(npm install *)" : "Read(.env*)";
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        add();
      }
    });
    const add = () => {
      const value = input.value.trim();
      if (!value) return;
      const next = { ...draft, [behavior]: [...list, value] };
      void saveRules(next);
    };
    addRow.appendChild(input);
    addRow.appendChild(button("ghost", "添加", add));
    group.appendChild(addRow);
    box.appendChild(group);
  }
  return box;
}

/* ---------------- transcript ---------------- */
function summariseInput(name, input) {
  if (!input) return "";
  if (name === "Bash") return String(input.command || "").slice(0, 140);
  if (input.file_path) return String(input.file_path);
  if (input.pattern) return String(input.pattern);
  if (input.url) return String(input.url);
  if (input.name) return String(input.name);
  return JSON.stringify(input).slice(0, 140);
}

function relPath(p) {
  if (!state || !state.workspace) return p;
  const base = state.workspace.replace(/\\/g, "/").replace(/\/$/, "");
  const norm = String(p).replace(/\\/g, "/");
  return norm.startsWith(base + "/") ? norm.slice(base.length + 1) : p;
}

function diffBlock(changes) {
  const box = el("div", "diff");
  for (const c of changes) {
    const head = el("div", "diff-file");
    const adds = (c.diff || []).filter((l) => l.kind === "add").length;
    const dels = (c.diff || []).filter((l) => l.kind === "del").length;
    head.textContent =
      (c.created ? "新建 " : "修改 ") + relPath(c.path) + "　＋" + adds + (dels ? "　－" + dels : "");
    head.style.cursor = "pointer";
    head.addEventListener("click", (e) => {
      e.stopPropagation();
      openFile(c.path);
    });
    box.appendChild(head);
    for (const line of c.diff || []) {
      const row = el("div", "diff-line " + line.kind);
      row.appendChild(el("span", "ln", line.kind === "add" ? "+" : line.kind === "del" ? "-" : ""));
      row.appendChild(el("span", "", line.text));
      box.appendChild(row);
    }
  }
  return box;
}

function changesFor(toolUseId) {
  const all = (state && state.changes) || [];
  const mine = all.filter((c) => c.toolUseId === toolUseId);
  return mine.length ? mine : null;
}

function toolCard(name, input, result, durationMs, id, extraChanges) {
  const wrap = el("div", "tool" + (result && result.isError ? " err" : ""));
  if (id) wrap.dataset.toolId = String(id);
  const head = el("div", "tool-head");
  head.appendChild(el("span", "tool-icon", result && result.isError ? "x" : "+"));
  head.appendChild(el("span", "tool-name", name));
  head.appendChild(el("span", "tool-summary", summariseInput(name, input)));
  if (durationMs !== undefined) head.appendChild(el("span", "tool-time", durationMs + "ms"));
  head.addEventListener("click", () => wrap.classList.toggle("open"));
  wrap.appendChild(head);
  const body = el("pre", "tool-body");
  body.textContent = result ? result.content : "（执行中…）";
  wrap.appendChild(body);
  const changes = (result && result.metadata && result.metadata.changes) || extraChanges || null;
  if (changes && changes.length) {
    wrap.appendChild(diffBlock(changes));
    // 文件改动就是这个调用的结果：默认展示 diff，原始输出按需展开。
    if (changes.length <= 3) wrap.classList.add("show-diff");
  }
  return wrap;
}

function noticeLine(text, level) {
  const n = el("div", "msg");
  const body = el("div", "msg-body");
  const p = el("div", "muted small", text);
  if (level === "warn") p.style.color = "var(--amber)";
  body.appendChild(p);
  n.appendChild(body);
  return n;
}

function renderMessages(messages) {
  const results = new Map();
  for (const m of messages) for (const b of m.content || []) if (b.type === "tool_result") results.set(b.tool_use_id, b);
  const frag = document.createDocumentFragment();
  for (const m of messages) {
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
    if (text.trim()) {
      const node = el("div", "msg assistant");
      const head = el("div", "msg-head");
      head.appendChild(el("div", "avatar assistant", "A"));
      head.appendChild(el("span", "msg-role", "助手"));
      node.appendChild(head);
      const body = el("div", "msg-body md");
      body.innerHTML = md(text);
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

function emptyState() {
  const wrap = el("div", "empty");
  wrap.innerHTML =
    "<h2>准备就绪</h2><p>这是一个完整的 Agent Harness：能读写文件、执行命令、调用 MCP 工具与技能，任何有风险的操作都会先询问你。</p>";
  const hints = el("div", "hints");
  for (const [label, prompt] of [
    ["总结这个仓库", "读一下 README，用五条要点总结这个项目的架构。"],
    ["找出无用文件", "扫一遍工作区，列出看起来没有被使用的文件。"],
    ["加一个功能", "给 CLI 加一个 --version 参数，并接入帮助输出。"],
  ]) {
    const chip = button("chip", label, () => {
      $("input").value = prompt;
      $("input").focus();
    });
    hints.appendChild(chip);
  }
  wrap.appendChild(hints);
  const quick = el("div", "quick-projects");
  wrap.appendChild(quick);
  void fillQuickProjects(quick);
  return wrap;
}

/** 空状态里的"继续上次的项目"：常用路径优先，其次是最近打开的。 */
async function fillQuickProjects(box) {
  try {
    const data = await (await fetch("/api/workspaces")).json();
    const seen = new Set();
    const items = [];
    for (const entry of [...(data.favorites || []), ...(data.recent || [])]) {
      if (seen.has(entry.path) || !entry.exists) continue;
      seen.add(entry.path);
      items.push(entry);
    }
    const others = items.filter((e) => e.path !== (state && state.workspace));
    if (!others.length) return;
    box.innerHTML = "";
    box.appendChild(el("div", "quick-title", "快捷入口"));
    const row = el("div", "hints");
    for (const entry of others.slice(0, 5)) {
      const chip = button("chip quick", (entry.favorite ? "★ " : "") + entry.name, () => void chooseWorkspace(entry.path));
      chip.title = entry.path;
      row.appendChild(chip);
    }
    box.appendChild(row);
  } catch {
    /* 快捷入口是增强项，失败就不显示 */
  }
}

function renderState(next) {
  state = next;
  $("brandSub").textContent = next.provider + " · " + next.sessionId.slice(-6);
  $("sessionTitle").textContent = next.title || "新会话";
  $("modelTag").textContent = next.model;
  $("wsName").textContent = baseName(next.workspace);
  $("workspaceChip").title = next.workspace;
  if (lastWorkspace !== next.workspace) {
    lastWorkspace = next.workspace;
    filesPath = "";
    fileEntries = [];
    fileError = "";
  }
  $("sandboxTag").textContent = SANDBOX_LABEL[next.sandbox] || next.sandbox;
  $("modeSelect").value = next.mode;
  $("agentModeSelect").value = next.agentMode || "default";
  $("sandboxSelect").value = next.sandbox;
  $("statusDot").className = "dot" + (next.running ? " busy" : "");
  $("stopBtn").classList.toggle("hidden", !next.running);
  $("sendBtn").disabled = !!next.running;
  $("costLabel").textContent = "$" + (next.cost ? next.cost.totalUsd.toFixed(4) : "0.0000");
  renderSessions();
  renderPanel();
  // 首次启动且没有模型凭据时，直接把设置面板弹出来。
  if (next.provider === "unconfigured" && !window.__askedForKey) {
    window.__askedForKey = true;
    setTimeout(() => void openSettings(), 400);
  }
  if (activePanel === "files" && !fileEntries.length && !fileError) loadFiles(filesPath);
  const t = $("transcript");
  t.innerHTML = "";
  t.appendChild(next.messages.length ? renderMessages(next.messages) : emptyState());
  updateMeter();
  scrollToBottom();
}

function fmtTokens(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1000) return Math.round(n / 100) / 10 + "k";
  return String(n);
}

function updateMeter() {
  if (!state) return;
  const used = state.contextTokens || 0;
  const win = state.contextWindow || 0;
  const pct = win ? Math.round((used / win) * 1000) / 10 : 0;
  $("meter").textContent =
    state.messages.length + " 条 · 上下文 ~" + fmtTokens(used) + (win ? " / " + fmtTokens(win) + "（" + pct + "%）" : "") +
    " · " + state.stats.turns + " 轮 · " + state.stats.toolCalls + " 次工具 · 检查点 " + (state.checkpoints || 0);
}

function scrollToBottom() {
  const t = $("transcript");
  t.scrollTop = t.scrollHeight;
}
function atBottom() {
  const t = $("transcript");
  return t.scrollHeight - t.scrollTop - t.clientHeight < 90;
}

/* ---------------- live streaming ---------------- */
function liveAssistant() {
  if (liveText) return liveText;
  const node = el("div", "msg assistant");
  const head = el("div", "msg-head");
  head.appendChild(el("div", "avatar assistant", "A"));
  head.appendChild(el("span", "msg-role", "助手"));
  node.appendChild(head);
  const body = el("div", "msg-body md");
  node.appendChild(body);
  const t = $("transcript");
  const empty = t.querySelector(".empty");
  if (empty) empty.remove();
  t.appendChild(node);
  liveText = { node, body, text: "" };
  return liveText;
}

function selForTool(id) {
  return "[data-tool-id=" + JSON.stringify(String(id)) + "]";
}

function handleEvent(ev) {
  const sid = ev.sessionId || (ev.state && ev.state.sessionId);
  if (state && sid && sid !== state.sessionId) return;

  switch (ev.type) {
    case "state":
      renderState(ev.state);
      break;
    case "turn_start":
      $("statusDot").className = "dot busy";
      $("sendBtn").disabled = true;
      $("stopBtn").classList.remove("hidden");
      liveText = null;
      break;
    case "text_delta": {
      const keep = atBottom();
      const live = liveAssistant();
      live.text += ev.text;
      live.body.textContent = live.text;
      if (keep) scrollToBottom();
      break;
    }
    case "assistant_message":
      if (liveText && liveText.text.trim()) liveText.body.innerHTML = md(liveText.text);
      liveText = null;
      break;
    case "tool_start":
      $("transcript").appendChild(toolCard(ev.name, ev.input, null, undefined, ev.id));
      scrollToBottom();
      break;
    case "tool_end": {
      const card = document.querySelector(selForTool(ev.id));
      const fresh = toolCard(ev.name, {}, ev.result, ev.durationMs, ev.id);
      if (card) card.replaceWith(fresh);
      else $("transcript").appendChild(fresh);
      scrollToBottom();
      break;
    }
    case "changes":
      if (state) state.changes = ev.changes;
      break;
    case "todos":
      if (state) state.todos = ev.todos;
      if (activePanel === "todos") renderPanel();
      break;
    case "jobs":
      if (state) state.jobs = ev.jobs;
      if (activePanel === "jobs") renderPanel();
      break;
    case "permission_request":
      showPermission(ev);
      break;
    case "permission_resolved":
      hidePermission();
      break;
    case "compaction":
      $("transcript").appendChild(
        noticeLine("上下文已压缩（" + ev.applied.join("+") + "）：" + ev.tokensBefore + " → " + ev.tokensAfter + " tokens", "info"),
      );
      break;
    case "notice":
      $("transcript").appendChild(noticeLine(noticeText(ev), ev.level));
      break;
    case "done":
      if (ev.reason !== "completed") {
        $("transcript").appendChild(noticeLine("已停止：" + reasonLabel(ev.reason) + (ev.error ? " — " + ev.error : ""), "warn"));
      }
      break;
    case "turn_end":
      liveText = null;
      $("stopBtn").classList.add("hidden");
      $("sendBtn").disabled = false;
      if (ev.state) renderState(ev.state);
      $("input").focus();
      break;
    default:
      break;
  }
}

/* ---------------- 通用确认框 ---------------- */
let confirmHandler = null;

function confirmDialog({ title, text, okLabel, onOk }) {
  $("confirmTitle").textContent = title;
  $("confirmText").textContent = text;
  $("confirmOk").textContent = okLabel || "确定";
  confirmHandler = onOk;
  $("confirmModal").classList.remove("hidden");
  $("confirmCancel").focus();
}

function closeConfirm() {
  confirmHandler = null;
  $("confirmModal").classList.add("hidden");
}

async function runConfirm() {
  const fn = confirmHandler;
  closeConfirm();
  if (fn) await fn();
}

/* ---------------- permissions ---------------- */
function showPermission(ev) {
  pendingPerm = ev.id;
  $("permTitle").textContent = "允许执行 " + ev.toolName + "？";
  $("permReason").textContent = permissionReasonText(ev.decision) + "（" + ev.decision.reason + "）";
  $("permInput").textContent = JSON.stringify(ev.input, null, 2);
  $("permTip").textContent = ev.decision.suggestedRule
    ? "提示：在 .jysharness/settings.json 中加入规则 " + ev.decision.suggestedRule + " 可不再询问。"
    : "";
  $("permModal").classList.remove("hidden");
  $("allowBtn").focus();
}
function hidePermission() {
  pendingPerm = null;
  $("permModal").classList.add("hidden");
}
async function answer(decision) {
  if (!pendingPerm) return;
  const id = pendingPerm;
  hidePermission();
  await fetch("/api/permission", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, decision }),
  });
}

/* ---------------- drawer / files ---------------- */
async function openFile(relPath) {
  $("drawer").classList.remove("hidden");
  $("drawerTitle").textContent = relPath;
  $("drawerBody").textContent = "加载中…";
  try {
    const r = await fetch("/api/file?path=" + encodeURIComponent(relPath));
    if (!r.ok) throw new Error("HTTP " + r.status);
    const data = await r.json();
    $("drawerBody").textContent = data.binary ? "（二进制文件，" + data.size + " 字节）" : data.content + (data.truncated ? "\n…（已截断）" : "");
  } catch (e) {
    $("drawerBody").textContent = "无法读取：" + (e.message || e);
  }
}
function closeDrawer() {
  $("drawer").classList.add("hidden");
}

/* ---------------- composer / commands ---------------- */
function renderAttachments() {
  const box = $("attachments");
  box.innerHTML = "";
  box.classList.toggle("hidden", pendingImages.length === 0);
  pendingImages.forEach((img, index) => {
    const cell = el("div", "thumb");
    const im = el("img");
    im.src = "data:" + img.mediaType + ";base64," + img.data;
    cell.appendChild(im);
    cell.appendChild(
      button("", "×", () => {
        pendingImages.splice(index, 1);
        renderAttachments();
      }),
    );
    box.appendChild(cell);
  });
}

function addImageFile(file) {
  if (!file || !/^image\/(png|jpeg|webp|gif)$/.test(file.type)) {
    notice("只支持 png / jpeg / webp / gif 图片");
    return;
  }
  if (file.size > 6 * 1024 * 1024) {
    notice("图片过大（最大 6MB）");
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    const url = String(reader.result || "");
    const comma = url.indexOf(",");
    if (comma < 0) return;
    pendingImages.push({ mediaType: file.type, data: url.slice(comma + 1), name: file.name });
    renderAttachments();
  };
  reader.readAsDataURL(file);
}

async function send() {
  const input = $("input");
  const text = input.value.trim();
  const images = pendingImages.slice();
  if ((!text && !images.length) || (state && state.running)) return;
  if (text.startsWith("/")) {
    input.value = "";
    await runSlash(text);
    return;
  }
  input.value = "";
  input.style.height = "auto";
  pendingImages = [];
  renderAttachments();
  await fetch("/api/message", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, images, session: state ? state.sessionId : undefined }),
  });
}

async function command(name) {
  const res = await fetch("/api/command", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ command: name, session: state ? state.sessionId : undefined }),
  });
  if (!res.ok) notice("命令执行失败：" + name);
  return res;
}

async function runSlash(text) {
  const cmd = text.slice(1).split(/\s+/)[0];
  if (cmd === "compact") return command("compact");
  if (cmd === "clear") return command("clear");
  if (cmd === "undo") return command("undo");
  if (cmd === "new") return newSession(false);
  if (cmd === "fork") return newSession(true);
  if (cmd === "skills") return command("skills");
  notice("未知命令：/" + cmd);
}

function notice(text) {
  $("transcript").appendChild(noticeLine(text, "info"));
  scrollToBottom();
}

async function setSetting(patch) {
  await fetch("/api/settings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...patch, session: state ? state.sessionId : undefined }),
  });
}

/* ---------------- command palette ---------------- */
const COMMANDS = [
  { cmd: "/new", desc: "新建会话", run: () => newSession(false) },
  { cmd: "/fork", desc: "复制当前会话（保留上下文）", run: () => newSession(true) },
  { cmd: "/compact", desc: "压缩上下文", run: () => command("compact") },
  { cmd: "/undo", desc: "撤销最近一次文件修改", run: () => command("undo") },
  { cmd: "/clear", desc: "清空当前会话的显示", run: () => command("clear") },
  { cmd: "/skills", desc: "重新扫描技能目录", run: () => command("skills") },
  { cmd: "/files", desc: "打开文件面板", run: () => { activePanel = "files"; renderPanel(); } },
  { cmd: "/todos", desc: "打开待办面板", run: () => { activePanel = "todos"; renderPanel(); } },
  { cmd: "/jobs", desc: "打开后台任务面板", run: () => { activePanel = "jobs"; renderPanel(); } },
  { cmd: "模式：计划", desc: "只读的计划模式", run: () => setSetting({ mode: "plan" }) },
  { cmd: "模式：自动接受编辑", desc: "文件编辑不再询问", run: () => setSetting({ mode: "acceptEdits" }) },
  { cmd: "模式：默认", desc: "敏感操作前询问", run: () => setSetting({ mode: "default" }) },
  { cmd: "沙箱：只读", desc: "禁止写入文件系统", run: () => setSetting({ sandbox: "read-only" }) },
  { cmd: "沙箱：工作区可写", desc: "仅允许写工作区内文件", run: () => setSetting({ sandbox: "workspace-write" }) },
];

let paletteSel = 0;
let paletteItems = COMMANDS;
function openPalette() {
  $("palette").classList.remove("hidden");
  $("paletteInput").value = "";
  paletteSel = 0;
  paletteItems = COMMANDS;
  renderPalette();
  $("paletteInput").focus();
}
function closePalette() {
  $("palette").classList.add("hidden");
}
function renderPalette() {
  const q = $("paletteInput").value.toLowerCase();
  paletteItems = COMMANDS.filter((c) => (c.cmd + " " + c.desc).toLowerCase().includes(q));
  const list = $("paletteList");
  list.innerHTML = "";
  paletteItems.forEach((c, i) => {
    const li = el("li", i === paletteSel ? "sel" : "");
    li.appendChild(el("span", "cmd", c.cmd));
    li.appendChild(el("span", "", c.desc));
    li.addEventListener("click", () => { closePalette(); c.run(); });
    list.appendChild(li);
  });
  if (!paletteItems.length) list.appendChild(el("li", "", "没有匹配的命令"));
}

/* ---------------- boot ---------------- */
function connect() {
  const es = new EventSource("/api/events");
  es.onmessage = (m) => {
    try {
      handleEvent(JSON.parse(m.data));
    } catch (e) {
      console.error("bad event", e);
    }
  };
  es.onerror = () => {
    $("statusDot").className = "dot busy";
    $("brandSub").textContent = "正在重连…";
  };
}

document.addEventListener("DOMContentLoaded", () => {
  $("sendBtn").addEventListener("click", send);
  $("settingsBtn").addEventListener("click", openSettings);
  $("workspaceChip").addEventListener("click", () => void openWorkspacePicker());
  $("wsClose").addEventListener("click", closeWorkspacePicker);
  $("wsOpenBtn").addEventListener("click", () => void chooseWorkspace($("wsInput").value));
  $("wsPickBtn").addEventListener("click", () => void chooseWorkspace(wsBrowsePath));
  $("wsWtCreate").addEventListener("click", () => void createWorktreeFromPicker());
  $("wsWtName").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void createWorktreeFromPicker();
    }
  });
  $("wsInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void chooseWorkspace($("wsInput").value);
    }
  });
  $("settingsClose").addEventListener("click", closeSettings);
  $("saveSettingsBtn").addEventListener("click", () => void saveSettings(false));
  $("testConnBtn").addEventListener("click", () => void testConnection());
  $("stopBtn").addEventListener("click", () =>
    fetch("/api/cancel", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ session: state ? state.sessionId : undefined }) }),
  );
  $("newSessionBtn").addEventListener("click", () => newSession(false));
  $("undoBtn").addEventListener("click", () => command("undo"));
  $("compactBtn").addEventListener("click", () => command("compact"));
  $("drawerClose").addEventListener("click", closeDrawer);
  $("allowBtn").addEventListener("click", () => answer("allow"));
  $("alwaysBtn").addEventListener("click", () => answer("always"));
  $("denyBtn").addEventListener("click", () => answer("deny"));
  $("confirmOk").addEventListener("click", () => void runConfirm());
  $("confirmCancel").addEventListener("click", closeConfirm);
  $("confirmModal").addEventListener("click", (e) => {
    if (e.target === $("confirmModal")) closeConfirm();
  });
  $("modeSelect").addEventListener("change", (e) => setSetting({ mode: e.target.value }));
  $("agentModeSelect").addEventListener("change", (e) => setSetting({ agentMode: e.target.value }));
  $("sandboxSelect").addEventListener("change", (e) => setSetting({ sandbox: e.target.value }));
  document.querySelectorAll("#panelTabs button").forEach((b) =>
    b.addEventListener("click", () => {
      activePanel = b.dataset.panel;
      renderPanel();
      if (activePanel === "files" && !fileEntries.length) loadFiles(filesPath);
    }),
  );

  $("attachBtn").addEventListener("click", () => $("fileInput").click());
  $("fileInput").addEventListener("change", (e) => {
    for (const file of e.target.files || []) addImageFile(file);
    e.target.value = "";
  });

  const input = $("input");
  input.addEventListener("paste", (e) => {
    const items = (e.clipboardData && e.clipboardData.items) || [];
    for (const item of items) {
      if (item.type && item.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (file) {
          e.preventDefault();
          addImageFile(file);
        }
      }
    }
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  });
  input.addEventListener("input", () => {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 220) + "px";
  });

  $("paletteInput").addEventListener("input", renderPalette);
  $("paletteInput").addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); paletteSel = Math.min(paletteSel + 1, paletteItems.length - 1); renderPalette(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); paletteSel = Math.max(paletteSel - 1, 0); renderPalette(); }
    else if (e.key === "Enter") { e.preventDefault(); const c = paletteItems[paletteSel]; if (c) { closePalette(); c.run(); } }
    else if (e.key === "Escape") closePalette();
  });
  $("palette").addEventListener("click", (e) => { if (e.target === $("palette")) closePalette(); });

  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); openPalette(); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "n") { e.preventDefault(); newSession(false); }
    else if (e.key === "Escape") {
      if (!$("confirmModal").classList.contains("hidden")) closeConfirm();
      else if (!$("wsModal").classList.contains("hidden")) closeWorkspacePicker();
      else if (!$("settingsModal").classList.contains("hidden")) closeSettings();
      else if (!$("palette").classList.contains("hidden")) closePalette();
      else if (pendingPerm) answer("deny");
      else closeDrawer();
    }
  });

  const panelHash = (location.hash || "").replace("#", "");
  if (["files", "todos", "jobs", "skills", "rules"].includes(panelHash)) {
    activePanel = panelHash;
  }
  const openSettingsHash = panelHash === "settings";
  const openWorkspaceHash = panelHash === "workspace";

  const params = new URLSearchParams(location.search);
  if (params.has("static")) {
    // Dev hook: single snapshot without SSE (used by visual tests).
    fetch("/api/state")
      .then((r) => r.json())
      .then((s) => {
        renderState(s);
        if (openSettingsHash) openSettings();
        if (openWorkspaceHash) void openWorkspacePicker();
        if (params.get("fixture") === "delete") {
          confirmDialog({
            title: "删除对话",
            text: "确定删除「修复登录超时问题」？当前正在使用这个会话，对话记录会从磁盘移除，无法恢复。",
            okLabel: "删除",
            onOk: async () => {},
          });
        }
        if (params.get("fixture") === "permission") {
          showPermission({
            id: "fixture",
            toolName: "Bash",
            input: { command: "git push --force origin main", description: "force push" },
            decision: {
              behavior: "ask",
              reason: "rule_ask",
              message: "project rule requires confirmation.",
              suggestedRule: "Bash(git push *)",
            },
          });
        }
      });
  } else {
    connect();
    if (openSettingsHash) setTimeout(() => void openSettings(), 400);
    if (openWorkspaceHash) setTimeout(() => void openWorkspacePicker(), 400);
  }
});
/* ---------------- 设置 ---------------- */
let appConfig = null;

const MODEL_PRESETS = {
  anthropic: ["claude-sonnet-4-5", "claude-opus-4-1", "claude-haiku-4-5"],
  openai: ["gpt-4.1", "gpt-4o", "o3-mini"],
  deepseek: ["deepseek-chat", "deepseek-reasoner"],
  compatible: [],
  mock: ["mock-1"],
};

const PROVIDER_LABEL = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  deepseek: "DeepSeek",
  compatible: "OpenAI 兼容端点",
  mock: "Mock（离线演示）",
};

function field(labelText, control) {
  const row = el("div", "form-row");
  row.appendChild(el("label", "", labelText));
  row.appendChild(control);
  return row;
}

function input(id, value, type, placeholder) {
  const node = el("input");
  node.id = id;
  node.type = type || "text";
  node.value = value === undefined || value === null ? "" : String(value);
  if (placeholder) node.placeholder = placeholder;
  return node;
}

async function openSettings() {
  $("settingsModal").classList.remove("hidden");
  $("settingsMsg").textContent = "加载中…";
  $("settingsBody").innerHTML = "";
  try {
    const res = await fetch("/api/config");
    appConfig = await res.json();
    renderSettings(appConfig);
    $("settingsMsg").textContent = "";
  } catch (e) {
    $("settingsMsg").textContent = "读取配置失败：" + (e.message || e);
  }
}

function closeSettings() {
  $("settingsModal").classList.add("hidden");
}

function renderSettings(cfg) {
  const body = $("settingsBody");
  body.innerHTML = "";

  // ---- 当前生效 ----
  const active = el("div", "form-hint");
  active.style.margin = "0 0 12px 0";
  active.textContent = "当前生效：" + cfg.active.model + "（" + (PROVIDER_LABEL[cfg.active.provider] || cfg.active.provider) + "）";
  body.appendChild(active);

  // ---- 模型接入 ----
  const modelSection = el("div", "settings-section");
  modelSection.appendChild(el("h4", "", "模型接入"));

  const providerSel = el("select");
  providerSel.id = "cfgProvider";
  for (const [value, label] of Object.entries(PROVIDER_LABEL)) {
    const opt = el("option", "", label);
    opt.value = value;
    providerSel.appendChild(opt);
  }
  providerSel.value = cfg.model.provider;
  modelSection.appendChild(field("服务商", providerSel));

  const modelInput = input("cfgModel", cfg.model.model);
  const list = el("datalist");
  list.id = "cfgModelList";
  modelInput.setAttribute("list", "cfgModelList");
  const listWrap = el("div", "form-inline");
  listWrap.appendChild(modelInput);
  listWrap.appendChild(list);
  modelSection.appendChild(field("模型", listWrap));

  modelSection.appendChild(field("Base URL", input("cfgBaseUrl", cfg.model.baseUrl)));

  const windowInput = input("cfgWindow", cfg.model.contextWindow, "number");
  windowInput.placeholder = "自动按模型推断";
  modelSection.appendChild(field("上下文窗口", windowInput));
  const windowHint = el("div", "form-hint");
  windowHint.textContent =
    "单位 token。当前 " + cfg.model.contextWindow + "，超过 75% 自动压缩到 40%；改动后立即重算压缩阈值。";
  modelSection.appendChild(windowHint);

  const keyInput = input("cfgApiKey", "", "password");
  keyInput.placeholder = cfg.key.present
    ? "已配置 " + cfg.key.hint + "（留空表示不修改）"
    : "粘贴 API Key";
  modelSection.appendChild(field("API Key", keyInput));

  const keyHint = el("div", "form-hint");
  if (cfg.key.present) {
    keyHint.textContent =
      "密钥来源：" +
      (cfg.key.from === "secrets" ? "本机 secrets.json" : "环境变量") +
      "。密钥只保存在 ~/.jysharness/secrets.json，不会写进项目文件。";
  } else {
    keyHint.textContent = "未检测到密钥。填写后保存到本机，不会写进项目文件。";
  }
  modelSection.appendChild(keyHint);

  const scopeSel = el("select");
  scopeSel.id = "cfgScope";
  const scopeUser = el("option", "", "本机（推荐，不进版本库）");
  scopeUser.value = "user";
  const scopeWs = el("option", "", "当前项目（.jysharness/settings.json）");
  scopeWs.value = "workspace";
  scopeSel.appendChild(scopeUser);
  scopeSel.appendChild(scopeWs);
  modelSection.appendChild(field("保存位置", scopeSel));
  body.appendChild(modelSection);

  // ---- 行为 ----
  const behavior = el("div", "settings-section");
  behavior.appendChild(el("h4", "", "权限与行为"));

  const modeSel = el("select");
  modeSel.id = "cfgMode";
  for (const [v, l] of [["default", "默认（敏感操作询问）"], ["acceptEdits", "自动接受编辑"], ["plan", "计划（只读）"], ["dontAsk", "不询问（自动拒绝）"], ["bypassPermissions", "完全放行（危险）"]]) {
    const o = el("option", "", l);
    o.value = v;
    modeSel.appendChild(o);
  }
  modeSel.value = cfg.behavior.permissionMode;
  behavior.appendChild(field("权限模式", modeSel));

  const sbSel = el("select");
  sbSel.id = "cfgSandbox";
  for (const [v, l] of [["read-only", "只读"], ["workspace-write", "工作区可写"], ["danger-full-access", "完全放行"]]) {
    const o = el("option", "", l);
    o.value = v;
    sbSel.appendChild(o);
  }
  sbSel.value = cfg.behavior.sandboxMode;
  behavior.appendChild(field("文件沙箱", sbSel));

  behavior.appendChild(field("最大轮次", input("cfgMaxTurns", cfg.behavior.maxTurns, "number")));
  behavior.appendChild(field("单次输出上限", input("cfgMaxTokens", cfg.behavior.maxTokens, "number")));
  behavior.appendChild(field("temperature", input("cfgTemp", cfg.behavior.temperature, "number")));

  const subCb = el("input");
  subCb.type = "checkbox";
  subCb.id = "cfgSubagent";
  subCb.checked = cfg.behavior.enableSubagent;
  const subWrap = el("div", "form-inline");
  subWrap.appendChild(subCb);
  subWrap.appendChild(el("span", "small muted", "允许模型派生子 Agent"));
  behavior.appendChild(field("子 Agent", subWrap));
  body.appendChild(behavior);

  // ---- MCP ----
  const mcpSection = el("div", "settings-section");
  mcpSection.appendChild(el("h4", "", "MCP 服务器"));
  const mcpList = el("div");
  mcpList.id = "cfgMcpList";
  for (const server of cfg.mcpServers) mcpList.appendChild(mcpRow(server));
  mcpSection.appendChild(mcpList);
  const addBtn = button("ghost", "+ 添加服务器", () => {
    mcpList.appendChild(mcpRow({ name: "", command: "", args: [], env: {} }));
  });
  mcpSection.appendChild(addBtn);
  body.appendChild(mcpSection);

  // ---- 插件 ----
  const pluginSection = el("div", "settings-section");
  pluginSection.appendChild(el("h4", "", "插件"));
  const pluginNote = el("div", "form-hint");
  pluginNote.style.margin = "0 0 8px 0";
  pluginNote.textContent =
    "项目插件放在 .harness/plugins/ 下。启用/停用或重新加载后立即对当前会话生效；修改 index.ts 后需要点「重新加载」。";
  pluginSection.appendChild(pluginNote);

  const pluginList = el("div", "plugin-list");
  pluginList.id = "pluginList";
  pluginList.appendChild(el("div", "panel-empty", "加载中…"));
  pluginSection.appendChild(pluginList);

  const pluginRow = el("div", "form-inline");
  const scaffoldInput = el("input");
  scaffoldInput.id = "pluginNewName";
  scaffoldInput.placeholder = "新插件名，如 acme";
  pluginRow.appendChild(scaffoldInput);
  pluginRow.appendChild(
    button("ghost", "新建", () => {
      void scaffoldPlugin();
    }),
  );
  pluginRow.appendChild(
    button("ghost", "重新加载", () => {
      void reloadPlugins();
    }),
  );
  pluginSection.appendChild(pluginRow);
  body.appendChild(pluginSection);

  void refreshPluginList();

  const refreshModels = () => {
    const provider = providerSel.value;
    list.innerHTML = "";
    for (const m of MODEL_PRESETS[provider] || []) {
      const opt = el("option");
      opt.value = m;
      list.appendChild(opt);
    }
    const defaults = cfg.defaults[provider] || {};
    if (!modelInput.value.trim() && defaults.model) modelInput.value = defaults.model;
    if (defaults.baseUrl) $("cfgBaseUrl").value = defaults.baseUrl;
  };
  providerSel.addEventListener("change", () => {
    modelInput.value = "";
    refreshModels();
  });
  refreshModels();
}

function mcpRow(server) {
  const row = el("div", "mcp-row");
  const name = input("", server.name, "text", "名称");
  name.className = "mcp-name";
  const command = input("", server.command, "text", "命令，如 npx");
  command.className = "mcp-command";
  const args = input("", (server.args || []).join(" "), "text", "参数，空格分隔");
  args.className = "mcp-args";
  row.appendChild(name);
  row.appendChild(command);
  row.appendChild(args);
  row.appendChild(
    button("icon-btn", "×", () => {
      row.remove();
    }),
  );
  return row;
}

function collectSettings() {
  const rows = [...document.querySelectorAll("#cfgMcpList .mcp-row")].map((row) => ({
    name: row.querySelector(".mcp-name").value.trim(),
    command: row.querySelector(".mcp-command").value.trim(),
    args: row.querySelector(".mcp-args").value.trim() ? row.querySelector(".mcp-args").value.trim().split(/\s+/) : [],
    env: {},
  }));
  const payload = {
    scope: $("cfgScope").value,
    provider: $("cfgProvider").value,
    model: $("cfgModel").value.trim(),
    baseUrl: $("cfgBaseUrl").value.trim(),
    permissionMode: $("cfgMode").value,
    sandboxMode: $("cfgSandbox").value,
    maxTurns: Number($("cfgMaxTurns").value),
    maxTokens: Number($("cfgMaxTokens").value),
    temperature: Number($("cfgTemp").value),
    contextWindow: Number($("cfgWindow").value) || 0,
    enableSubagent: $("cfgSubagent").checked,
    mcpServers: rows.filter((r) => r.name && r.command),
  };
  const apiKey = $("cfgApiKey").value.trim();
  if (apiKey) payload.apiKey = apiKey;
  return payload;
}

async function saveSettings(silent) {
  const payload = collectSettings();
  $("settingsMsg").textContent = "保存中…";
  const res = await fetch("/api/config", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    $("settingsMsg").textContent = "保存失败：" + (data.error || res.status);
    $("settingsMsg").style.color = "var(--red)";
    return false;
  }
  $("settingsMsg").style.color = "var(--green)";
  $("settingsMsg").textContent = silent ? "" : "已保存，立即生效";
  if (data.config) {
    appConfig = data.config;
    if (!silent) renderSettings(data.config);
  }
  return true;
}

async function testConnection() {
  const payload = collectSettings();
  $("settingsMsg").style.color = "var(--muted)";
  // 新填的 Key 需要先落盘，测试才能用到它。
  if (payload.apiKey) {
    const ok = await saveSettings(true);
    if (!ok) return;
  }
  $("settingsMsg").textContent = "测试中…";
  const res = await fetch("/api/config/test", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (data.ok) {
    $("settingsMsg").style.color = "var(--green)";
    $("settingsMsg").textContent = "连接正常（" + data.ms + "ms）：" + (data.sample || "");
  } else {
    $("settingsMsg").style.color = "var(--red)";
    $("settingsMsg").textContent = "连接失败：" + (data.error || res.status);
  }
}
/* ---------------- 工作区切换 ---------------- */
let wsBrowsePath = "";
let lastWorkspace = null;

function baseName(p) {
  const parts = String(p || "").split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || p || "workspace";
}

async function openWorkspacePicker() {
  $("wsModal").classList.remove("hidden");
  $("wsMsg").textContent = "";
  $("wsInput").value = "";
  const data = await (await fetch("/api/workspaces")).json();
  $("wsCurrent").textContent = data.current;
  renderWorkspaceSections(data);
  void refreshWorktrees();
  await browseTo(data.current);
}

function closeWorkspacePicker() {
  $("wsModal").classList.add("hidden");
}

const KIND_LABEL = { git: "git", node: "node", python: "python", dir: "" };

function timeAgo(ts) {
  if (!ts) return "";
  const diff = Date.now() - ts;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return Math.floor(diff / 60_000) + " 分钟前";
  if (diff < 86_400_000) return Math.floor(diff / 3_600_000) + " 小时前";
  return Math.floor(diff / 86_400_000) + " 天前";
}

function workspaceRow(entry) {
  const row = el("div", "ws-entry");
  const main = el("div", "ws-entry-main");
  const title = el("div");
  title.appendChild(el("span", "ws-name", entry.name));
  if (KIND_LABEL[entry.kind]) {
    const badge = el("span", "pill", KIND_LABEL[entry.kind]);
    badge.style.marginLeft = "6px";
    title.appendChild(badge);
  }
  main.appendChild(title);
  main.appendChild(el("div", "ws-path", entry.path));
  if (!entry.exists) main.appendChild(el("div", "ws-path", "（目录已不存在）"));
  main.addEventListener("click", () => {
    if (!entry.exists) {
      $("wsMsg").textContent = "目录不存在：" + entry.path;
      return;
    }
    void chooseWorkspace(entry.path);
  });
  row.appendChild(main);
  if (entry.at) row.appendChild(el("span", "ws-when", timeAgo(entry.at)));
  const star = button("icon-btn star" + (entry.favorite ? " on" : ""), entry.favorite ? "★" : "☆", () =>
    void toggleFavorite(entry.path, !entry.favorite),
  );
  star.title = entry.favorite ? "取消固定" : "固定为常用路径";
  row.appendChild(star);
  return row;
}

async function toggleFavorite(p, favorite) {
  const res = await fetch("/api/workspaces/favorite", {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ path: p, favorite }),
  });
  if (!res.ok) return;
  renderWorkspaceSections(await res.json());
}

function renderWorkspaceSections(data) {
  const favorites = $("wsFavorites");
  favorites.innerHTML = "";
  const favList = data.favorites || [];
  if (!favList.length) favorites.appendChild(el("div", "panel-empty", "还没有固定路径，点右侧 ☆ 固定一个"));
  for (const entry of favList) favorites.appendChild(workspaceRow(entry));

  const recent = $("wsRecent");
  recent.innerHTML = "";
  const recentList = data.recent || [];
  if (!recentList.length) recent.appendChild(el("div", "panel-empty", "暂无最近记录"));
  for (const entry of recentList) recent.appendChild(workspaceRow(entry));
}

async function browseTo(p) {
  const res = await fetch("/api/browse?path=" + encodeURIComponent(p || ""));
  const data = await res.json();
  wsBrowsePath = data.path || "";

  const crumbs = $("wsCrumbs");
  crumbs.innerHTML = "";
  if (data.roots && data.roots.length) {
    for (const root of data.roots) {
      crumbs.appendChild(button("", root, () => void browseTo(root)));
    }
  }
  if (data.parent) {
    crumbs.appendChild(button("", "..", () => void browseTo(data.parent)));
  }
  crumbs.appendChild(el("span", "", data.path || "此电脑"));

  const dirs = $("wsDirs");
  dirs.innerHTML = "";
  if (data.error) {
    dirs.appendChild(el("div", "panel-empty", data.error));
  }
  for (const d of data.dirs || []) {
    const row = el("div", "ws-dir");
    row.appendChild(el("span", "fi", "▸"));
    row.appendChild(el("span", "", d.name));
    row.addEventListener("click", () => void browseTo(d.path));
    dirs.appendChild(row);
  }
  if (!data.error && !(data.dirs || []).length) {
    dirs.appendChild(el("div", "panel-empty", "没有子目录"));
  }
}

async function chooseWorkspace(path) {
  const target = String(path || "").trim();
  if (!target) {
    $("wsMsg").textContent = "请输入路径或选择一个目录";
    return;
  }
  $("wsMsg").style.color = "var(--muted)";
  $("wsMsg").textContent = "正在打开 " + target + " …";
  const res = await fetch("/api/workspace", {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ path: target }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    $("wsMsg").style.color = "var(--red)";
    $("wsMsg").textContent = data.error || "切换失败";
    return;
  }
  closeWorkspacePicker();
  renderState(data);
}

/* ---------------- 插件管理 ---------------- */
async function refreshPluginList() {
  const box = $("pluginList");
  if (!box) return;
  box.innerHTML = "";
  let data;
  try {
    data = await (await fetch("/api/plugins")).json();
  } catch (e) {
    box.appendChild(el("div", "panel-empty", "读取插件失败：" + (e.message || e)));
    return;
  }
  if (!data.plugins.length) {
    box.appendChild(el("div", "panel-empty", "还没有插件。填个名字点「新建」，或用 jys plugin new <name>。"));
  }
  for (const plugin of data.plugins) {
    const row = el("div", "plugin-row");
    const info = el("div", "plugin-info");
    const title = el("div", "plugin-title");
    title.appendChild(el("span", "ws-name", plugin.name));
    title.appendChild(el("span", "pill", "v" + plugin.version));
    title.appendChild(el("span", "pill", plugin.source === "user" ? "用户级" : "项目级"));
    if (!plugin.enabled) title.appendChild(el("span", "pill", "已停用"));
    info.appendChild(title);
    info.appendChild(el("div", "ws-path", plugin.dir));
    const stats = [];
    if (plugin.tools) stats.push("工具 " + plugin.tools);
    if (plugin.skills) stats.push("技能 " + plugin.skills);
    if (plugin.hooks) stats.push("hook " + plugin.hooks);
    info.appendChild(el("div", "plugin-meta", stats.length ? stats.join(" · ") : "无贡献"));
    if (plugin.error) info.appendChild(el("div", "plugin-error", plugin.error));
    row.appendChild(info);
    row.appendChild(button("ghost", plugin.enabled ? "停用" : "启用", () => void togglePlugin(plugin)));
    row.appendChild(button("ghost", "打开目录", () => void openPluginDir(plugin.dir)));
    box.appendChild(row);
  }
  for (const err of data.errors || []) {
    box.appendChild(el("div", "plugin-error", "加载失败 " + err.plugin + "：" + err.message));
  }
}

async function callPlugins(body) {
  const res = await fetch("/api/plugins", {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    notice("插件操作失败：" + (data.error || res.status));
    return null;
  }
  return data;
}

async function togglePlugin(plugin) {
  const data = await callPlugins({ action: "setEnabled", dir: plugin.dir, enabled: !plugin.enabled });
  if (!data) return;
  notice((plugin.enabled ? "已停用 " : "已启用 ") + plugin.name);
  await refreshPluginList();
}

async function reloadPlugins() {
  const data = await callPlugins({ action: "reload" });
  if (!data) return;
  notice("插件已重新加载：" + data.loaded + " 个，工具 " + data.tools + " 个");
  await refreshPluginList();
}

async function scaffoldPlugin() {
  const input = $("pluginNewName");
  const name = (input.value || "").trim();
  if (!name) {
    notice("先填一个插件名，例如 acme");
    return;
  }
  const data = await callPlugins({ action: "scaffold", name });
  if (!data) return;
  input.value = "";
  notice("已创建插件 " + name + "，编辑 .harness/plugins/" + name + "/index.ts");
  await refreshPluginList();
}

async function openPluginDir(dir) {
  await callPlugins({ action: "open", dir });
}

/* ---------------- 工作树 ---------------- */
async function refreshWorktrees() {
  const box = $("wsWorktrees");
  if (!box) return;
  let data;
  try {
    data = await (await fetch("/api/worktrees")).json();
  } catch (e) {
    box.innerHTML = "";
    box.appendChild(el("div", "panel-empty", "读取工作树失败：" + (e.message || e)));
    return;
  }
  box.innerHTML = "";
  if (!data.repo) {
    box.appendChild(el("div", "panel-empty", "当前工作区不是 git 仓库，无法使用工作树。"));
    return;
  }
  box.appendChild(el("div", "plugin-meta", "仓库：" + data.repo));
  for (const wt of data.worktrees) {
    const row = el("div", "ws-entry");
    const main = el("div", "ws-entry-main");
    const title = el("div");
    title.appendChild(el("span", "ws-name", wt.branch));
    if (wt.isMain) {
      const badge = el("span", "pill", "主工作树");
      badge.style.marginLeft = "6px";
      title.appendChild(badge);
    }
    if (wt.sessions) {
      const badge = el("span", "pill", "会话 " + wt.sessions);
      badge.style.marginLeft = "6px";
      title.appendChild(badge);
    }
    main.appendChild(title);
    main.appendChild(el("div", "ws-path", wt.path));
    main.addEventListener("click", () => void chooseWorkspace(wt.path));
    row.appendChild(main);
    if (!wt.isMain) {
      row.appendChild(button("icon-btn", "×", () => void removeWorktreeFromPicker(wt)));
    }
    box.appendChild(row);
  }
}

async function createWorktreeFromPicker() {
  const input = $("wsWtName");
  const name = (input.value || "").trim();
  if (!name) {
    notice("先填一个任务名，例如 fix-login");
    return;
  }
  const res = await fetch("/api/worktrees", {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ action: "create", name }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    notice("创建工作树失败：" + (data.error || res.status));
    return;
  }
  input.value = "";
  closeWorkspacePicker();
  if (data.state) renderState(data.state);
  notice("已创建并切换到工作树 " + data.branch);
}

async function removeWorktreeFromPicker(wt) {
  confirmDialog({
    title: "删除工作树",
    text:
      "确定删除工作树「" + wt.branch + "」？目录 " + wt.path + " 会被移除，" +
      "未提交的改动会丢失（已提交到分支的不会）。",
    okLabel: "删除",
    onOk: async () => {
      const res = await fetch("/api/worktrees", {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({ action: "remove", path: wt.path, force: true }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        notice("删除失败：" + (data.error || res.status));
        return;
      }
      if (data.state) renderState(data.state);
      notice("已删除工作树 " + wt.branch);
      void refreshWorktrees();
    },
  });
}

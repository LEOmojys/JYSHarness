/**
 * 插件面板宿主（对应 DSH 的 "client 半"）。
 *
 * 模型：插件在 plugin.json 里声明 panels；宿主在这里为每个面板加一个按钮，
 * 点击时用动态 import() 拉 /plugin-assets/<id>/index.js，调用它导出的 mount(el, api)。
 *
 * 安全取舍：这是**同源同上下文**加载，插件 JS 拥有页面同等权限（能读 localStorage、发请求）。
 * 不做 iframe 隔离，是因为面板要和会话状态互通；代价是"只装信任的插件"，这点写在 PLUGINS.md 里。
 */
let pluginPanels = [];
const mounted = new Map();

/**
 * 从 /api/config 拿到的 panels 应用进来（幂等，可重复调用）。
 *
 * 三个 slot 的挂载方式不同：
 *   sidebar    → 侧栏 tab 区加按钮，点击后在该视图里 mount
 *   settings   → 设置弹窗底部加一段区块（插件自己的设置界面就能进来）
 *   statusbar  → 底部状态栏右侧挂一个小部件（常驻展示类信息）
 */
function applyPluginPanels(panels) {
  pluginPanels = Array.isArray(panels) ? panels.filter((p) => p && p.id && p.asset) : [];
  renderSidebarSlots();
  renderStatusbarSlots();
  renderSettingsSlots();
}

function renderSidebarSlots() {
  const host = $("panelTabs");
  if (!host) return;
  for (const btn of host.querySelectorAll("[data-plugin-panel]")) btn.remove();
  for (const panel of pluginPanels.filter((p) => (p.slot || "sidebar") === "sidebar")) {
    const btn = el("button", "plugin-tab");
    btn.dataset.pluginPanel = panel.plugin + ":" + panel.id;
    btn.textContent = (panel.icon ? panel.icon + " " : "") + panel.title;
    btn.title = "插件面板：" + panel.plugin;
    btn.addEventListener("click", () => openPluginPanel(panel, btn));
    host.appendChild(btn);
  }
}

function renderStatusbarSlots() {
  const host = $("statusbar") || document.querySelector(".composer-meta") || document.querySelector("footer");
  if (!host) return;
  for (const node of host.querySelectorAll("[data-plugin-slot]")) node.remove();
  for (const panel of pluginPanels.filter((p) => p.slot === "statusbar")) {
    const wrap = el("span", "plugin-statusbar");
    wrap.dataset.pluginSlot = panel.plugin + ":" + panel.id;
    host.appendChild(wrap);
    void mountInto(wrap, panel);
  }
}

function renderSettingsSlots() {
  const host = $("settingsBody");
  if (!host) return;
  for (const node of host.querySelectorAll("[data-plugin-slot]")) node.remove();
  const items = pluginPanels.filter((p) => p.slot === "settings");
  if (!items.length) return;
  const section = el("div", "settings-plugin-section");
  section.dataset.pluginSlot = "settings";
  section.appendChild(el("div", "side-label", "插件设置"));
  for (const panel of items) {
    const box = el("div", "plugin-settings-block");
    box.appendChild(el("div", "settings-label", (panel.icon ? panel.icon + " " : "") + panel.title));
    section.appendChild(box);
    void mountInto(box, panel);
  }
  host.appendChild(section);
}

/** 把插件资产 mount 到指定容器（sidebar 点击时也走这里）。 */
async function mountInto(container, panel) {
  const key = panel.plugin + ":" + panel.id;
  try {
    const mod = await import(panel.asset + "?t=" + Date.now());
    const mountFn = mod && (mod.mount || (mod.default && mod.default.mount));
    if (typeof mountFn !== "function") {
      container.textContent = "插件 " + panel.plugin + " 没有导出 mount(el, api)";
      return;
    }
    const unmount = mounted.get(key);
    if (typeof unmount === "function") {
      try { unmount(); } catch { /* 卸载失败不影响重新挂载 */ }
    }
    const api = {
      id: panel.id,
      plugin: panel.plugin,
      slot: panel.slot || "sidebar",
      workspace: (state && state.workspace) || "",
      fetchJson: async (path, init) => {
        const res = await fetch(path, init);
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      },
    };
    const cleanup = mountFn(container, api);
    if (typeof cleanup === "function") mounted.set(key, cleanup);
  } catch (err) {
    container.textContent = "插件面板加载失败：" + (err && err.message ? err.message : String(err));
  }
}


/** 打开一个插件面板：切到 panels 视图，动态 import 资产并 mount。 */
/** 侧栏点击入口：切到面板视图后委托给 mountInto（避免重复实现挂载逻辑）。 */
async function openPluginPanel(panel, btn) {
  for (const b of document.querySelectorAll("#panelTabs button")) b.classList.remove("active");
  btn.classList.add("active");
  const body = $("panelBody");
  if (!body) return;
  body.innerHTML = "";
  const holder = el("div", "plugin-panel");
  body.appendChild(holder);
  await mountInto(holder, panel);
}

/**
 * 拉一次 /api/config，把插件面板清单交给 applyPluginPanels 渲染。
 *
 * 放在首屏（而不是设置面板里）的原因：插件面板是"应用的能力面"，
 * 用户一进来就该看见入口；以前只有打开设置才会拉配置。
 */
async function loadPluginPanels() {
  try {
    const res = await fetch("/api/config");
    if (!res.ok) return;
    const cfg = await res.json();
    applyPluginPanels(cfg.panels);
  } catch {
    /* 插件清单拿不到不该影响主界面 */
  }
}


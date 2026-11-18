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
 * 插槽表：名字 → 怎么渲染。
 *
 * 加一个插槽只需要在这里加一行（选择器 + 形态），不用改散落的 render 函数。
 *   tabs   → 和"文件/待办"并列的 tab 按钮，点击在 panelBody 里 mount
 *   inline → 直接挂在指定容器里的小部件（顶栏/状态栏）
 *   block  → 挂在指定容器里的块（设置区块/输入框上方横幅/抽屉）
 */
const PLUGIN_SLOTS = {
  sidebar: { mode: "tabs", selector: "panelTabs" },
  statusbar: { mode: "inline", selector: null, fallbackSelector: ".composer-actions" },
  header: { mode: "inline", selector: "pluginHeaderSlot" },
  composer: { mode: "block", selector: "pluginComposerSlot" },
  settings: { mode: "block", selector: "settingsBody", appendSection: true },
  drawer: { mode: "block", selector: "pluginDrawerSlot" },
};

/** 未知插槽的统一兜底容器（放在抽屉里，保证"写了名字就一定看得见"）。 */
const FALLBACK_SLOT = "drawer";

function slotConfig(slot) {
  return PLUGIN_SLOTS[slot] || PLUGIN_SLOTS[FALLBACK_SLOT];
}

/**
 * 从 /api/config 拿到的 panels 应用进来（幂等，可重复调用）。
 * 每种插槽的渲染都走同一个循环，顺序由面板的 order 决定。
 */
function applyPluginPanels(panels) {
  pluginPanels = Array.isArray(panels) ? panels.filter((p) => p && p.id && p.asset) : [];
  // 清掉上一轮的挂载点（插件重载/禁用要能立刻反映）
  for (const node of document.querySelectorAll("[data-plugin-slot]")) node.remove();
  for (const btn of document.querySelectorAll("#panelTabs [data-plugin-panel]")) btn.remove();
  mounted.clear();

  const bySlot = new Map();
  for (const panel of pluginPanels) {
    const cfg = slotConfig(panel.slot);
    const key = panel.slot && PLUGIN_SLOTS[panel.slot] ? panel.slot : FALLBACK_SLOT;
    if (!bySlot.has(key)) bySlot.set(key, []);
    bySlot.get(key).push({ panel, cfg });
  }
  for (const [slot, items] of bySlot) {
    items.sort((a, b) => (a.panel.order ?? 100) - (b.panel.order ?? 100) || String(a.panel.title).localeCompare(String(b.panel.title)));
    if (items[0].cfg.mode === "tabs") renderTabSlot(slot, items);
    else renderContainerSlot(slot, items);
  }
}

/** tabs 形态：按钮进 tab 条，点击后在 panelBody 里 mount。 */
function renderTabSlot(slot, items) {
  const host = $(PLUGIN_SLOTS[slot].selector);
  if (!host) return;
  for (const { panel } of items) {
    const btn = el("button", "plugin-tab");
    btn.dataset.pluginPanel = panel.plugin + ":" + panel.id;
    btn.dataset.pluginSlot = slot;
    btn.textContent = (panel.icon ? panel.icon + " " : "") + panel.title;
    btn.title = "插件面板：" + panel.plugin + "（" + slot + "）";
    btn.addEventListener("click", () => openPluginPanel(panel, btn));
    host.appendChild(btn);
  }
}

/** inline / block 形态：直接生成容器并 mount（不需要点击）。 */
function renderContainerSlot(slot, items) {
  const cfg = PLUGIN_SLOTS[slot];
  let host = cfg.selector ? $(cfg.selector) : null;
  if (!host && cfg.fallbackSelector) host = document.querySelector(cfg.fallbackSelector);
  if (!host) return;

  let section = null;
  if (cfg.appendSection) {
    section = el("div", "settings-plugin-section");
    section.dataset.pluginSlot = "section:" + slot;
    section.appendChild(el("div", "side-label", "插件"));
    host.appendChild(section);
    host = section;
  }
  for (const { panel } of items) {
    const box = el("div", cfg.mode === "inline" ? "plugin-slot-inline" : "plugin-slot-block");
    box.dataset.pluginSlot = slot + ":" + panel.plugin + ":" + panel.id;
    box.title = panel.plugin + " · " + (panel.slot || "sidebar");
    if (cfg.mode === "block") {
      const title = el("div", "plugin-slot-title", (panel.icon ? panel.icon + " " : "") + panel.title);
      box.appendChild(title);
      const body = el("div", "plugin-slot-body");
      box.appendChild(body);
      host.appendChild(box);
      void mountInto(body, panel);
    } else {
      host.appendChild(box);
      void mountInto(box, panel);
    }
  }
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


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

/** 从 /api/config 拿到的 panels 应用进来（幂等，可重复调用）。 */
function applyPluginPanels(panels) {
  pluginPanels = Array.isArray(panels) ? panels.filter((p) => p && p.id && p.asset) : [];
  const host = $("panelTabs");
  if (!host) return;
  // 先清掉上一轮的插件按钮（重载插件后要能反映变化）
  for (const btn of host.querySelectorAll("[data-plugin-panel]")) btn.remove();
  for (const panel of pluginPanels) {
    const btn = el("button", "plugin-tab");
    btn.dataset.pluginPanel = panel.plugin + ":" + panel.id;
    btn.textContent = (panel.icon ? panel.icon + " " : "") + panel.title;
    btn.title = "插件面板：" + panel.plugin;
    btn.addEventListener("click", () => openPluginPanel(panel, btn));
    host.appendChild(btn);
  }
}

/** 打开一个插件面板：切到 panels 视图，动态 import 资产并 mount。 */
async function openPluginPanel(panel, btn) {
  for (const b of document.querySelectorAll("#panelTabs button")) b.classList.remove("active");
  btn.classList.add("active");
  const body = $("panelBody");
  if (!body) return;
  body.innerHTML = "";
  const holder = el("div", "plugin-panel");
  body.appendChild(holder);

  const key = panel.plugin + ":" + panel.id;
  try {
    // 每次点击重新 import（带时间戳绕过模块缓存），这样改完插件 JS 刷新页面即生效
    const mod = await import(panel.asset + "?t=" + Date.now());
    const mountFn = mod && (mod.mount || (mod.default && mod.default.mount));
    if (typeof mountFn !== "function") {
      holder.textContent = "插件 " + panel.plugin + " 没有导出 mount(el, api)";
      return;
    }
    const unmount = mounted.get(key);
    if (typeof unmount === "function") {
      try { unmount(); } catch { /* 卸载失败不影响重新挂载 */ }
    }
    // 传给插件的 api：只暴露面板需要的少量能力，避免插件直接摸内部状态
    const api = {
      id: panel.id,
      plugin: panel.plugin,
      workspace: (state && state.workspace) || "",
      fetchJson: async (path, init) => {
        const res = await fetch(path, init);
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      },
    };
    const cleanup = mountFn(holder, api);
    if (typeof cleanup === "function") mounted.set(key, cleanup);
  } catch (err) {
    holder.textContent = "插件面板加载失败：" + (err && err.message ? err.message : String(err));
  }
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


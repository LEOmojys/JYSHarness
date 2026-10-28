/**
 * 设置面板（从 app.js 拆出）。
 *
 * 为什么拆：它是独立的一块 UI（表单构造 + 收集 + 保存），
 * 和会话流/事件渲染没有任何耦合。放在同一个文件里只会让两个人都难读。
 * 两个文件都是经典脚本，顶层函数共享全局作用域，加载顺序由 index.html 保证。
 */
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
  for (const [v, l] of [["default", "默认（敏感操作询问）"], ["acceptEdits", "自动接受编辑"], ["plan", "计划（只读）"], ["auto", "自动（只读命令免询问）"], ["dontAsk", "不询问（自动拒绝）"], ["bypassPermissions", "完全放行（危险）"]]) {
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
  const fbInput = input("cfgFallback", cfg.behavior.fallbackModel || "", "text");
  fbInput.placeholder = "主模型不可用时切换到（留空=不启用）";
  behavior.appendChild(field("备用模型", fbInput));

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
    fallbackModel: ($("cfgFallback") && $("cfgFallback").value.trim()) || "",
    contextWindow: Number($("cfgWindow").value) || 0,
    enableSubagent: $("cfgSubagent").checked,
    mcpServers: rows.filter((r) => r.name && r.command),
  };
  const apiKey = $("cfgApiKey").value.trim();
  if (apiKey) payload.apiKey = apiKey;
  return payload;
}

async function saveSettings(silent) {
  // 收集阶段就可能抛（表单被上一次失败的渲染清空过）：要给出可读的提示并自愈，
  // 而不是让 TypeError 冒到控制台、界面停在"保存中…"或者假装已保存。
  let payload;
  try {
    payload = collectSettings();
  } catch (e) {
    $("settingsMsg").style.color = "var(--red)";
    $("settingsMsg").textContent = "设置面板状态异常（" + (e.message || e) + "），正在重新加载…";
    await openSettings();
    return false;
  }
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
  if (data.config) {
    appConfig = data.config;
    if (!silent) {
      // 先渲染、再报成功：顺序反了就会出现"显示已保存，但表单已经炸没了"。
      try {
        renderSettings(data.config);
      } catch (e) {
        await openSettings();
        $("settingsMsg").style.color = "var(--red)";
        $("settingsMsg").textContent = "已写入磁盘，但面板刷新失败：" + (e.message || e);
        return true;
      }
    }
  }
  $("settingsMsg").style.color = "var(--green)";
  $("settingsMsg").textContent = silent ? "" : "已保存，立即生效";
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


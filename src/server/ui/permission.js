/**
 * 审批弹窗与队列（从 app.js 拆出）。
 *
 * 为什么拆：这块有独立状态（队列、正在显示的那条、已答复集合），
 * 和会话流渲染无关；放在 app.js 里既让主文件超长，也让"审批被覆盖"这类
 * 状态问题更难看清。
 *
 * 与 settings.js 一致：经典脚本，共享全局作用域，加载顺序由 index.html 保证。
 */
let pendingPerm = null;
/**
 * 审批队列。
 *
 * 以前是"来一个就把 pendingPerm 覆盖掉"：两个会话同时跑时，前一个请求会从
 * 界面上消失，服务端一直等到超时后按拒绝处理 —— 用户根本没看到那次询问。
 * 现在排队逐个问，并在标题里标出"是哪个会话 / 是否子 Agent"。
 */
let permQueue = [];
/** 已经被本地答复过、但服务端还会回 permission_resolved 的 id（避免误清下一条）。 */
let resolvedPermIds = new Set();

/** Esc 处理用：有没有正在等待答复的请求。 */
function hasPendingPermission() {
  return Boolean(pendingPerm);
}

function showPermission(ev) {
  permQueue.push(ev);
  if (!pendingPerm) presentNextPermission();
  // 弹窗已经在显示时，后面的请求只会改变"还有几个在排队"，这里要刷新一下提示
  else $("permTip").textContent = permissionTipText();
}

/** 审批提示行：建议规则 + 排队数，两处都用它，避免文案分叉。 */
function permissionTipText() {
  const ev = permQueue[0];
  const tip =
    ev && ev.decision && ev.decision.suggestedRule
      ? "提示：在 .jysharness/settings.json 中加入规则 " + ev.decision.suggestedRule + " 可不再询问。"
      : "";
  const waiting = permQueue.length - 1;
  return tip + (waiting > 0 ? "（还有 " + waiting + " 个请求排队）" : "");
}

/** 呈现队首请求；队列空则收起弹窗。 */
function presentNextPermission() {
  const ev = permQueue[0];
  if (!ev) {
    pendingPerm = null;
    $("permModal").classList.add("hidden");
    return;
  }
  pendingPerm = ev.id;
  // 子 Agent 发起 / 非当前会话的请求都要标出来：用户有权知道自己在替谁批准
  const from = ev.origin === "subagent" ? "（子 Agent 发起）" : "";
  const otherSession =
    ev.sessionId && state && ev.sessionId !== state.sessionId ? " · 会话 " + String(ev.sessionId).slice(-6) : "";
  $("permTitle").textContent = "允许执行 " + ev.toolName + "？" + from + otherSession;
  $("permReason").textContent = permissionReasonText(ev.decision) + "（" + ev.decision.reason + "）";
  $("permInput").textContent = JSON.stringify(ev.input, null, 2);
  $("permTip").textContent = permissionTipText();
  $("permModal").classList.remove("hidden");
  $("allowBtn").focus();
}

function hidePermission() {
  // 服务端确认已解决时调用：只清掉对应那条，不要把还在排队的请求一起吞掉。
  permQueue = permQueue.filter((q) => !resolvedPermIds.has(q.id) && q.id !== pendingPerm);
  pendingPerm = null;
  if (permQueue.length) presentNextPermission();
  else $("permModal").classList.add("hidden");
}

async function answer(decision) {
  if (!pendingPerm) return;
  const id = pendingPerm;
  resolvedPermIds.add(id);
  permQueue = permQueue.filter((q) => q.id !== id);
  pendingPerm = null;
  $("permModal").classList.add("hidden");
  presentNextPermission();
  await fetch("/api/permission", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, decision }),
  });
}

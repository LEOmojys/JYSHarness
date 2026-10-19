# 桌面端

目标：让 harness 有一个真正的桌面窗口，而不是只有终端。做到这件事不需要重写内核——内核已经只会"产出一串事件"，窗口只是这些事件的另一个消费者。

## 架构

```
┌─────────────────────────────┐
│  WebView (Edge/Chrome app)  │  src/server/ui/  index.html + app.js + style.css
│  渲染事件流 / 弹权限窗       │
└──────────────┬──────────────┘
               │  SSE: GET /api/events        (服务端 → UI，单向事件流)
               │  POST /api/message           (UI → 服务端，发起一轮)
               │  POST /api/permission        (UI → 服务端，审批回填)
┌──────────────┴──────────────┐
│  HTTP 服务  src/server/app.ts│  127.0.0.1 only，校验 Origin
└──────────────┬──────────────┘
               │  Session.send() → AsyncGenerator<HarnessEvent>
┌──────────────┴──────────────┐
│  内核（未改动）              │  queryLoop / tools / permissions / hooks
└─────────────────────────────┘
```

**关键设计：SSE 而不是 WebSocket。** 事件流是单向的（服务端 → UI），审批和发消息本来就是独立的 POST 请求。用 SSE 省掉了握手、心跳、重连协议，浏览器原生 `EventSource` 自带断线重连。

## 事件协议

服务端下发的每条 `data:` 都是一个 JSON 事件：

| 事件 | 时机 | UI 行为 |
| --- | --- | --- |
| `state` | 连接建立时、每轮结束 | 全量重建界面（转录是唯一真相） |
| `turn_start` | 用户消息进入循环 | 转圈、禁用输入 |
| `text_delta` | 模型流式输出 | 追加到当前气泡 |
| `assistant_message` | 一条消息结束 | 把纯文本转成 markdown |
| `tool_start` | 工具开始执行 | 插入"运行中"卡片 |
| `tool_end` | 工具返回 | 替换卡片，带耗时与错误态 |
| `permission_request` | 权限管道返回 ask | 弹出模态框并阻塞循环 |
| `permission_resolved` | 用户点击后 | 关闭模态框 |
| `compaction` | 上下文压缩 | 插入一条灰色说明 |
| `done` | 循环终止 | 非 completed 时显示原因 |
| `turn_end` | 一轮彻底结束 | 用最新 `state` 重绘 |

## 权限往返（这是最容易写错的地方）

```
queryLoop                server                      browser
   │  decidePermission()     │                            │
   ├── behavior = "ask" ────►│                            │
   │  （await，循环暂停）     ├── SSE permission_request ─►│
   │                         │                            ├─ 用户点 Allow
   │                         │◄── POST /api/permission ───┤
   │◄──── resolve("allow") ──┤                            │
   ├── 执行工具 ─────────────►│── SSE tool_end ───────────►│
```

三个必须处理的边界：

1. **超时**：10 分钟没有回答就按 deny 走，否则循环永远挂着。
2. **一轮结束**：`runTurn` 的 `finally` 会把所有未决审批强制 resolve 成 deny，避免泄漏。
3. **断线**：UI 关掉不影响服务端存活（窗口模式除外），重连后 `state` 事件会让界面回到真实状态。

## 安全

- 只绑 `127.0.0.1`，不监听局域网。
- 校验 `Origin`：只接受 `http://127.0.0.1:*` 和 `http://localhost:*`，挡住 DNS rebinding 一类的跨站调用。
- 静态文件做了路径归一化，禁止 `..` 逃逸出 `ui/`。
- 请求体上限 2MB，超过直接断开。
- 服务端不持有任何模型凭据的副本——API key 只在进程环境变量里。

## 打包与分发

| 方式 | 产物 | 依赖 |
| --- | --- | --- |
| `npm run package` | `dist/JYSHarness/` + zip（自带 node.exe） | 无 |
| `scripts/install-desktop.ps1` | 桌面/开始菜单图标 | 需 node 在 PATH |
| Tauri（`desktop/tauri`） | 签名安装包 | Rust + WebView2 |

便携包里的 `jysharness.vbs` 是给快捷方式用的：`WshShell.Run` 无法直接执行 `.cmd`，
必须经过 `cmd.exe /c`，否则启动会静默失败——这个坑踩过。

## 三种打包方式

| 方式 | 依赖 | 体积 | 何时用 |
| --- | --- | --- | --- |
| **app 模式窗口**（当前实现） | 系统里的 Edge/Chrome | 0 | 立刻可用，开发/自用 |
| **Tauri** | Rust + WebView2 | ~5MB | 要签名安装包、要托盘/菜单/自动更新 |
| **Electron** | Node + Chromium | ~150MB | 渲染进程里需要 Node 能力（一般不需要） |

本项目的形态更适合 Tauri：前端已经是纯静态资源，服务端是外部 Node 进程，Tauri 只要开一个窗口指向 `http://127.0.0.1:4317` 即可。

Tauri 落地步骤（约半小时）：

1. `npm create tauri-app@latest` 选 vanilla + TypeScript，得到 `src-tauri/`。
2. `tauri.conf.json` 里把 `build.frontendDist` 指向一个只有 `<script>location.href=...` 的占位页，或直接设 `app.windows[0].url = "http://127.0.0.1:4317/"`。
3. 在 Rust 的 `setup` 钩子里用 `std::process::Command` 拉起 `node src/cli/main.ts serve`，`on_window_event(CloseRequested)` 时 kill 子进程 —— 这样它就是一个自包含的 exe。
4. `window.decorations = false` 可以做到完全自绘标题栏。

## 已知限制

- **单进程多会话**：一个服务进程管所有会话；没有跨设备/远程。
- **一次一个弹窗**：两个会话同时请求审批时，UI 只显示最新一个（服务端会排队）。
- **没有设置界面**：模式/沙箱能在顶栏改，权限规则还得改 `settings.json`。
- **没有多模态**：图片附件未接。
- `?static=1` / `?fixture=permission` 是渲染与弹窗的截图夹具，只服务于视觉测试。

## 界面功能对照

| 功能 | 入口 |
| --- | --- |
| 新建 / 切换 / fork 会话 | 左栏 `+ New session`、会话条目、`Ctrl+N`、`/fork` |
| 切换工作区 | 顶栏 📁 → 常用路径（★）/ 最近项目 / 直接输入 / 目录浏览 |
| 多任务并行 | 顶栏 📁 → 工作树：新建 / 切换 / 删除 git worktree |
| 项目快捷入口 | 空会话中央的 ★ 芯片，一键切换 |
| 浏览工作区 | 左栏 Files 面板，点目录进入、点文件右侧抽屉查看 |
| 查看改动 | 工具卡片内联 diff（写文件类默认展开） |
| 回滚改动 | 顶栏 `undo` 或命令面板 |
| 任务清单 | 左栏 Todos 面板（模型调用 TodoWrite 时实时更新） |
| 后台任务 | 左栏 Jobs 面板，可 kill |
| 技能 | 左栏 Skills 面板 |
| 权限规则 | 左栏 Rules 面板，增删即存盘并热更新 |
| 图片输入 | 输入框粘贴图片或点 `image` 选择文件，可多张 |
| 深链 | `#files` `#todos` `#jobs` `#skills` `#rules` 直接打开对应面板 |
| 所有命令 | `Ctrl+K` |

## 目录

| 文件 | 职责 |
| --- | --- |
| `src/server/app.ts` | 路由、SSE 广播、多会话、审批桥、文件 API |
| `src/server/ui/index.html` | 结构（侧栏 / 转录 / 抽屉 / 弹窗 / 命令面板） |
| `src/server/ui/style.css` | 深色主题与全部组件样式 |
| `src/server/ui/app.js` | 事件渲染、diff、面板、命令面板、快捷键 |
| `src/desktop/launch.ts` | 浏览器探测、`--app=` 窗口、默认浏览器兜底 |
| `src/cli/serve.ts` | `jys serve` / `jys desktop`，含 MCP 连接与会话工厂 |
| `tests/server.test.ts` | SSE、审批往返、多会话、文件 API 越界、Origin |
# JYSHarness

一个从零实现的 AI Agent Harness —— 参考 [《Harness Engineering: 基于 Claude Code 的完全指南》](https://wanlanglin.github.io/-awesome-cc-harness/zh/)，用 TypeScript 实现 Claude Code / DeepSeek Harness 的核心设计，并做成可用的桌面产品。

**零运行时依赖**：只用 Node 内置模块，Node 24 直接运行 .ts，不需要 npm install。

```
模型（LLM）是那匹马，harness 是围栏、缰绳和跑道。
```

![desktop UI](docs/desktop.png)

---

## 30 秒上手（不需要 API Key）

```bash
cd harness

# 桌面窗口（Edge/Chrome app 模式，无边框、独立 profile）
node src/cli/main.ts desktop --provider mock --script examples/mock-scenario.json \
    --workspace examples/demo-workspace -y

# 或者只起服务，浏览器打开 http://127.0.0.1:4317
node src/cli/main.ts serve --workspace examples/demo-workspace

# 终端交互（同样的内核）
node src/cli/main.ts
```

Windows 上可以直接双击 `jys.cmd`：不带参数时打开桌面端，工作区默认 `%USERPROFILE%\jysharness-workspace`；终端模式用 `jys repl`。

接真实模型：

```bash
export ANTHROPIC_API_KEY=sk-ant-...      # node src/cli/main.ts
export DEEPSEEK_API_KEY=sk-...           # node src/cli/main.ts --provider deepseek --model deepseek-chat
node src/cli/main.ts --provider openai --model qwen2.5-coder --workspace /path/to/repo
```

## 安装为桌面应用

```powershell
cd harness
.\scripts\install-desktop.ps1            # 在桌面创建 JYSHarness 快捷方式
.\scripts\install-desktop.ps1 -Workspace D:\work   # 指定默认工作区
```

快捷方式执行 `jys desktop --workspace <ws>`，双击即开窗口；首次运行会自动创建 workspace 目录。

## 能力清单

| 能力 | 说明 |
| --- | --- |
| **Agent Loop** | Async Generator + continue 站点：413 反应式压缩、max_tokens 续写、429/5xx 退避、Stop Hook 阻断 |
| **工具系统** | 13 个内置工具 + MCP 动态工具；Schema 校验 → 权限 → Hook → 执行 → 事后审计 |
| **并发编排** | 只读工具并行、写入工具串行；审批与 Hook 在分区之前串行完成 |
| **权限模型** | 6 段管道（硬编码拒绝 → deny → ask → 工具自检 → allow → 模式），每条决策带 reason |
| **沙箱** | 真实路径包含检查（`..`/符号链接/Windows 8.3 短路径）、只读模式双处拦截 |
| **多会话** | 新建 / 切换 / **fork** / 删除，每个会话独立的循环、审批队列、后台任务 |
| **MCP** | stdio JSON-RPC 客户端：initialize → tools/list → tools/call，工具以 `mcp__server__tool` 注册 |
| **Skills** | `.harness/skills/*/SKILL.md` 按需加载：系统提示只放名字+描述，正文调用时才进上下文 |
| **后台任务** | `Bash run_in_background` + `JobOutput/JobKill/JobList`，长任务不阻塞循环 |
| **待办** | `TodoWrite` 工具 + 侧栏实时面板 |
| **检查点/撤销** | 每次写文件前快照，`undo` 回滚；UI 内联显示真实 diff |
| **上下文压缩** | 三级：microcompact → snip → LLM 摘要；压缩后仍超长才终止（防烧钱死循环） |
| **子 Agent** | 独立上下文、独立预算、只回传摘要；权限完全继承（不给提权） |
| **Hooks** | PreToolUse / PostToolUse / Stop / UserPromptSubmit，可阻断、可改参数、可加注 |
| **成本核算** | 按模型定价估算 USD，顶栏实时显示 |
| **WebFetch** | 抓取网页转文本，阻断 loopback/私网地址（SSRF） |
| **图片输入** | 粘贴/选择图片，base64 走 Anthropic image block 或 OpenAI image_url |
| **沙箱后端** | 子进程环境清洗（剥离 API key/token）+ bwrap/sandbox-exec 自动探测 |
| **规则编辑器** | 侧栏直接增删 allow/deny/ask 规则，写回 settings.json 并立即对所有会话生效 |
| **桌面安装器** | 一条命令在桌面创建快捷方式，双击即开 |
| **插件模式** | `.harness/plugins/` 下的项目插件：注册专属工具、进程内 hook、提示段落与内存技能 |
| **项目快捷入口** | 常用路径（★ 固定）+ 最近项目（含类型徽标与相对时间），空会话上一键直达 |

## 工具（13 个 + MCP）

| 工具 | 作用 | 只读 |
| --- | --- | --- |
| `Read` `Write` `Edit` | 文件读写；Edit 要求唯一匹配，写前自动快照 | 混合 |
| `Glob` `Grep` | 找文件、搜内容 | ✅ |
| `Bash` | 平台 shell（pwsh→powershell 降级），可后台运行 | ❌ |
| `Agent` | 派生子 Agent | ❌ |
| `TodoWrite` | 维护任务清单 | ❌ |
| `JobOutput` `JobKill` `JobList` | 后台任务读取/终止/列表 | ✅/❌ |
| `WebFetch` | 抓网页 | ✅ |
| `Skill` | 加载技能正文 | ✅ |
| `mcp__<server>__<tool>` | 任意 MCP 工具，启动时自动发现 | 由 `readOnlyHint` 决定 |

## 界面

| 区域 | 内容 |
| --- | --- |
| 左栏 | 会话列表（新建 / 切换 / fork / 删除，删除有二次确认）、Files / Todos / Jobs / Skills / Rules 五个面板 |
| 顶栏 | 标题、模型、沙箱、权限模式、成本、undo、compact |
| 主区 | 流式对话、工具卡片（点击展开，文件改动直接内联 diff） |
| 抽屉 | 点击文件名/文件树，右侧查看源码 |
| 命令面板 | `Ctrl+K`：所有命令，含模式与沙箱切换 |
| 权限弹窗 | Allow once / Always allow / Deny，带规则建议 |

![permission](docs/permission.png)

规则可以直接在左栏 Rules 面板增删，保存即写回 `.jysharness/settings.json` 并热更新所有会话：

![rules](docs/rules.png)

界面文案全部为中文。可翻译的字符串集中在 `src/server/ui/app.js` 顶部的标签表（权限行为、沙箱、任务状态、停止原因、命令面板）与服务端 `notice` 事件的 `code` 映射里，加英文版只需补一张表。

> 说明：CLI（`jys` 终端模式）与工具返回值仍为英文——工具返回值是给模型读的协议内容，不属于界面文案。

## 在界面里切换工作区

顶栏的 📁 按钮打开工作区选择器：

- **当前**：正在操作的项目目录
- **直接输入**：粘贴任意路径，回车或点「打开」
- **常用路径**：手动 ★ 固定的入口，最多 12 个，不受"最近"淘汰影响
- **最近项目**：按打开时间倒序自动记录 8 个，显示项目类型（git / node / python）和「刚刚 / 3 小时前」
- **浏览目录**：从盘符逐层点进去，「选择当前目录」确认

空会话的界面上还有一排**快捷入口**（当前工作区除外，常用路径优先），一次点击直接切过去。
两条列表都存在 `~/.jysharness/settings.json`（`favoriteWorkspaces` / `recentWorkspaces`），不进项目；目录被删掉后不会再出现在最近列表里。

切换会**新建一个绑定该目录的会话**（之前的工作区会话保留，可随时切回）；同一个目录再次打开会复用已有会话，不会重复创建。工作区决定了 Agent 能读写的边界 —— 沙箱的 `workspace-write` 就是相对它生效的。

![workspace](docs/workspace.png)

## 删除对话

左栏会话行右侧有 **×**，点击弹出二次确认（显示会话标题，当前会话会额外提示），确认后：

- 从会话列表移除，**同时删除磁盘上的 `.harness/sessions/<id>.jsonl`** 和它的 transcript 备份
- 正在运行的会话会被中断，后台任务一并终止
- 历史会话（只存在于磁盘、当前进程没加载的）也可以删
- 只剩一个会话时不允许删除（避免没有可用工作区）

![delete](docs/delete.png)

## 在界面里配置模型

顶栏「设置」打开配置面板，不需要改文件、不需要重启：

| 区块 | 内容 |
| --- | --- |
| 模型接入 | 服务商（Anthropic / OpenAI / DeepSeek / 兼容端点 / Mock）、模型、Base URL、API Key、保存位置 |
| 权限与行为 | 权限模式、文件沙箱、最大轮次、单次输出上限、temperature、是否允许子 Agent |
| MCP 服务器 | 增删服务器，保存后立即重连，无需重启 |

保存后**当场热切换**：所有运行中的会话立刻使用新模型，系统提示里的模型名同步更新。
「测试连接」会真的发一次最小请求，返回耗时或具体错误。

**上下文窗口**：设置面板里可以直接填「上下文窗口」（token）。填 0 或留空表示按模型名自动推断（claude→200k、gpt-4.1→1M、deepseek/qwen→128k、llama→32k、其它→128k）。

窗口决定压缩阈值：**超过 75% 自动压缩，目标压到 40%**（200k 窗口 → 150k 触发 / 80k 目标；8k 小模型 → 6k 触发 / 3.2k 目标）。界面底部实时显示 `上下文 ~1.0k / 128k（0.8%）`。

**密钥怎么存**：API Key 只写入 `~/.jysharness/secrets.json`（权限 600），**不会**写进项目里的 settings.json，接口也永远不回传明文（只回 `sk-m…3456` 这样的提示）。要便携/隔离，可以设 `HARNESS_HOME` 换配置目录。

![settings](docs/settings.png)

## 项目插件（Plugin 模式）

给某个项目加专属能力，不用改 harness 源码：

```bash
jys plugin new acme            # 在 .harness/plugins/acme/ 生成脚手架
# 编辑 index.ts：注册工具 / hook / 技能 / 提示段落
jys plugin test                # 加载校验，出错返回非 0
```

插件是一个目录：`plugin.json` + `index.ts`，入口导出 `activate(api)`：

| API | 作用 |
| --- | --- |
| `registerTool` | 新增工具，与内置工具走同一套权限/并发/diff 管道 |
| `addPromptSection` | 追加项目约定到系统提示 |
| `on(event, handler)` | 进程内 hook（PreToolUse 等），无需起 shell |
| `addSkill` | 内存技能，按需加载 |

加载是**逐插件隔离**的：坏掉的插件只影响自己，其余照常工作。完整 API、示例和调试方式见 [PLUGINS.md](./PLUGINS.md)。

## 多任务并行（git worktree）

同一个仓库要同时干几件事，最干净的做法是**每个任务一个 worktree**：

![worktrees](docs/worktrees.png)

顶栏 📁 → 「工作树」区块：

| 元素 | 说明 |
| --- | --- |
| 列表 | 仓库下所有 worktree：分支名、路径、是否主工作树、该工作树的会话数 |
| 新建 | 填任务名（如 `fix-login`）→ 创建 `jys/fix-login` 分支 + `.harness/worktrees/fix-login` 目录，并**立即切过去** |
| 删除 | 非主工作树可删，二次确认后连目录一起移除 |
| 点击 | 切换到该工作树（没有会话就新建一个） |

**为什么这样就互不干扰**：会话是存在 `<workspace>/.harness/sessions` 下的，而每个 worktree 就是独立的 workspace —— 因此转录、规则快照、检查点、后台任务天然按任务隔离。两个任务同时改代码，各自的分支、各自的 Agent 上下文、各自的 diff 记录。

约束与约定：

- 只有 git 仓库能建工作树；非仓库会提示不可用
- 工作树放在 `<repo>/.harness/worktrees/<name>`，并自动写进 `.git/info/exclude`（不会污染 `git status`）
- 分支名固定 `jys/<name>`，方便回头 `git log jys/fix-login` 看这个任务的提交
- 删除是 `--force` 的：**未提交的改动会丢**（分支上已提交的不会），确认框里有提示
- 删除当前正在使用的工作树时，会先切回主工作树，再清理它的会话

## 架构

```
┌────────────────────────────────────────────────────────────┐
│ Web UI (SSE)   src/server/ui/*        ── 或 ──  CLI REPL     │
├────────────────────────────────────────────────────────────┤
│ HTTP + SSE 服务  src/server/app.ts    多会话 / 文件 API / 审批桥│
├────────────────────────────────────────────────────────────┤
│ Session        src/core/session.ts    jobs todos checkpoints │
│ Agent Loop     src/core/query.ts      continue sites         │
├────────────────────────────────────────────────────────────┤
│ Tools          src/tools/*            fs shell extra agent   │
│ Permissions    src/permissions/*      decision pipeline      │
│ Sandbox        src/sandbox/*          path + command guards  │
│ Hooks          src/hooks/*            Pre/Post/Stop          │
│ Context        src/context/*          prompt + compaction    │
│ MCP            src/mcp/*              stdio client + adapter │
├────────────────────────────────────────────────────────────┤
│ Providers      src/providers/*        anthropic / openai / mock │
└────────────────────────────────────────────────────────────┘
```

设计取舍见 [ARCHITECTURE.md](./ARCHITECTURE.md)，桌面端细节见 [DESKTOP.md](./DESKTOP.md)。

### 目录

| 路径 | 职责 |
| --- | --- |
| `src/core/query.ts` | 主循环：流式、压缩、恢复、工具编排 |
| `src/core/session.ts` | 会话编排：提示词、子 Agent、扩展工具、撤销 |
| `src/core/jobs.ts` | 后台任务管理 |
| `src/core/checkpoints.ts` | 快照、undo、行级 diff |
| `src/core/skills.ts` | 技能发现与按需加载 |
| `src/core/cost.ts` | 价格表与成本估算 |
| `src/tools/*` | 13 个工具 + 注册表 + 分区并发 |
| `src/permissions/*` | 规则解析与决策管道 |
| `src/sandbox/*` | 路径包含、命令执行、超时截断 |
| `src/mcp/*` | MCP 客户端、工具适配、批量连接 |
| `src/server/app.ts` | HTTP/SSE、多会话、文件 API、审批往返 |
| `src/server/ui/*` | 零依赖前端 |
| `src/desktop/launch.ts` | app 模式窗口 |
| `desktop/tauri/*` | 可选 Tauri 打包脚手架 |

## 测试

```bash
npm test
```

**61 个测试**，分五组：

- 纯函数：权限管道、规则匹配、分区、路径包含、压缩、diff
- 端到端（Mock Provider）：工具真实执行、危险命令拦截、用户拒绝、Hook 阻断、子 Agent、撤销
- 服务层：SSE 全流程、审批往返（allow/deny）、多会话 new/fork/delete、Origin 校验、文件 API 越界
- 集成：**真实 MCP 服务器**（stdio 子进程）握手、列工具、调用、错误降级、坏服务器不影响会话
- 运维面：工作区切换/收藏、会话删除（**连磁盘文件一起删**）、配置热切换、上下文窗口换算

## 打包与分发

### 一键启动（三种方式）

```powershell
# 1) 在仓库里装桌面图标（需要 PATH 里有 node）
.\scripts\install-desktop.ps1 -Workspace D:\my-project

# 2) 直接跑
.\jys.cmd desktop

# 3) 打进便携包，拷到别的机器
npm run package
```

### 便携包

`npm run package` 产出：

| 产物 | 说明 |
| --- | --- |
| `dist/JYSHarness/` | 免安装目录，约 109 MB（其中 87 MB 是 node.exe） |
| `dist/JYSHarness-<版本>-win-x64.zip` | 分发用压缩包，约 34 MB |

包内结构：

```
JYSHarness/
  jysharness.cmd        ← 双击即用（优先用 runtime\node.exe）
  jysharness.vbs        ← 无控制台窗口启动（快捷方式指向它）
  install-shortcut.ps1    ← 生成桌面图标
  runtime/node.exe        ← 自带运行时，目标机器不需要装 Node
  src/                    ← 全部源码
  examples/ ... README.md ...
```

拷到任意 Windows x64 机器上：解压 → 双击 `jysharness.cmd`，或先跑
`powershell -ExecutionPolicy Bypass -File install-shortcut.ps1` 生成桌面图标（双击后无黑窗）。

> 已验证：把 PATH 清到只剩 `C:\Windows\System32`（相当于没装 Node）后，包内命令仍能正常启动服务。

### 其他打包路线

| 方式 | 体积 | 代价 | 建议 |
| --- | --- | --- | --- |
| **便携包**（当前） | ~109 MB / zip 34 MB | 未签名，SmartScreen 可能提示 | 自用/内部分发首选 |
| Node SEA 单文件 exe | ~90 MB | 需要 bundler 打成单文件，且 UI 静态资源要从 blob 里读，得改资源加载 | 想要"一个 exe"时再上 |
| Tauri（`desktop/tauri`） | ~5 MB + 需带 Node | 需要 Rust 工具链 | 要签名安装包/托盘/自动更新时 |
| Electron | ~150 MB | 多一层运行时 | 一般不需要 |

Tauri 方案不会重写 UI：Rust 只负责拉起 Node 服务、开 webview、关窗时杀进程。

## 与 Claude Code 的差距

| 维度 | 本项目 | Claude Code |
| --- | --- | --- |
| 工具 | 13 + MCP 动态 | 43+ |
| 权限 | 6 段管道 | 6 层 + AI 分类器 |
| 恢复站点 | 5 | 7+ |
| 压缩 | 3 级 | 4 级（含读时投影） |
| 多 Agent | 单层子 Agent | Agent 类型 + Coordinator/Swarm |
| 编辑体验 | 内联 diff + undo | 内联 diff + 逐块审阅 |
| 会话 | 多会话 + fork | 多会话 + resume |

## 已知限制

- **多模态只有图片**：PDF/音频/视频未接，图片也不做缩放压缩。
- **单进程**：一个服务进程管理所有会话，没有跨设备/远程。
- **Tauri 未预编译**：需要 Rust 工具链才能出 .exe；当前用 Chromium app 模式 + 快捷方式。
- **Windows 没有进程级沙箱**：环境变量清洗 + 路径/命令约束是硬限制，真正的隔离需要 Job Object 或受限令牌（Linux 上 bwrap 后端已经是真隔离）。
- **没有插件市场**：Skills/MCP 仍是文件配置（规则已有 GUI）。

## 参考

- 原文：[Harness Engineering: 基于 Claude Code 的完全指南](https://wanlanglin.github.io/-awesome-cc-harness/zh/)
- 源码：[WanLanglin/-awesome-cc-harness](https://github.com/WanLanglin/-awesome-cc-harness)
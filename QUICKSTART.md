# 使用指南

从零到跑起来大约 2 分钟。不需要 `npm install`（零运行时依赖）。

## 0. 前置条件

- **Node.js ≥ 22.18**（本项目在 24.14 上验证，需要原生跑 .ts）
- Windows / macOS / Linux
- 一个模型 API key —— 但如果只是想先看看效果，可以跳过（见下一步的 mock 演示）

检查版本：

```bash
node -v
```

## 1. 第一次运行（不需要 API Key）

```bash
cd harness
node src/cli/main.ts desktop --provider mock --script examples/mock-scenario.json --workspace examples/demo-workspace -y
```

会弹出一个独立窗口。这条命令的含义：

| 参数 | 作用 |
| --- | --- |
| `desktop` | 开桌面窗口（Chromium app 模式），而不是终端 |
| `--provider mock` | 用脚本化的假模型，真实执行工具、真实判定权限 |
| `--script ...` | 假模型要播放的剧本 |
| `--workspace ...` | 工作区，Agent 只能在这里读写 |
| `-y` | 自动批准权限（演示用，真实使用别加） |

## 2. 接真实模型

```bash
# Anthropic
export ANTHROPIC_API_KEY=sk-ant-...
node src/cli/main.ts desktop --workspace E:\your-project

# DeepSeek（OpenAI 兼容）
export DEEPSEEK_API_KEY=sk-...
node src/cli/main.ts desktop --provider deepseek --model deepseek-chat --workspace E:\your-project

# 任意 OpenAI 兼容端点（vLLM / Ollama / Moonshot…）
node src/cli/main.ts desktop --provider openai --model qwen2.5-coder --workspace E:\your-project
```

PowerShell 里用 `$env:ANTHROPIC_API_KEY="..."` 代替 `export`。

## 3. 建一个桌面快捷方式 / 打包分发

```powershell
# 在仓库里：生成桌面图标（需要 node）
.\scripts\install-desktop.ps1 -Workspace D:\my-project

# 打包成免安装目录 + zip（自带 node.exe，目标机器不装 Node 也能跑）
npm run package
# 产物：dist/JYSHarness/ 和 dist/JYSHarness-<版本>-win-x64.zip
# 拷走后双击 jysharness.cmd 即可，或运行包内的 install-shortcut.ps1 生成图标
```


```powershell
cd harness
.\scripts\install-desktop.ps1                      # 桌面图标，工作区默认 ~/harness-workspace
.\scripts\install-desktop.ps1 -Workspace D:\work   # 指定工作区
```

之后双击图标即可，不用再开终端。

## 4. 三种使用方式

| 命令 | 形态 | 适合 |
| --- | --- | --- |
| `jys`（或双击 `jys.cmd`） | 独立窗口 | 日常使用 |
| `jys desktop` | 独立窗口（显式） | 脚本/快捷方式 |
| `jys serve --open` | 浏览器打开 `http://127.0.0.1:4317` | 想多开标签、远程桌面 |
| `jys repl` | 终端交互 | 服务器、SSH、没有图形界面 |
| `jys "把测试修好"` | 一次性执行后退出 | 脚本、CI |

（`jys` 是 `jys.cmd` 的简写；不带任何参数时直接打开桌面端。想要一个没有黑窗的图标，用 `scripts/install-desktop.ps1`。）

## 5. 界面怎么用

**删对话**：左栏会话行右侧 × → 二次确认。会话文件会从磁盘删除，不可恢复。

**多任务并行**：顶栏 📁 → 工作树 → 填任务名新建，立刻得到一个独立分支 + 独立会话（会话按工作树隔离）。切换工作树即切换任务，互不干扰。

**换工作区**：顶栏 📁 → 常用路径 / 最近项目 / 输入路径 / 逐层浏览。点右侧 ☆ 可把项目固定成常用路径；空会话界面上还有一排快捷入口，一键切过去。切换会新开一个绑定该目录的会话；同一目录再开一次会复用，不会重复。

**发消息**：输入框回车发送，Shift+Enter 换行。可以**直接粘贴图片**（截图后 Ctrl+V）。

**权限弹窗**：Agent 要做敏感操作时会拦下来，三个选择：

- **允许一次** —— 只放行这一次
- **总是允许** —— 本次会话内同类操作不再问
- **拒绝** —— 模型会收到拒绝原因，换方案
- 按 Esc = 拒绝

**工具卡片**：点标题栏展开原始输出。改文件的工具会**默认展示 diff**（绿色新增、红色删除），点 diff 里的文件名可以在右侧查看完整源码。

**撤销**：顶栏「撤销」按钮，回滚最近一次文件改动（新建的文件会被删除）。

**顶栏两个下拉**：

| 下拉 | 选项 | 含义 |
| --- | --- | --- |
| 权限模式 | 默认 | 敏感操作都问 |
| | 自动接受编辑 | 改文件不问，跑命令还问 |
| | 计划 | 只读，只能看不能改 |
| | 不询问 | 需要问的操作直接拒绝（无人值守） |
| | 完全放行 | 全部允许（危险） |
| 沙箱 | 只读 / 工作区可写 / 完全放行 | 限制能写哪些文件 |

**左栏五个面板**：

- **文件**：工作区目录树，点文件在右侧看内容
- **待办**：模型用 TodoWrite 记的任务清单
- **任务**：后台命令（`Bash run_in_background`）的状态和输出，可终止
- **技能**：已安装的 skills
- **规则**：权限规则**可直接增删**，保存后立即生效

**快捷键**：

| 键 | 作用 |
| --- | --- |
| `Ctrl+K` | 命令面板（所有命令、模式切换） |
| `Ctrl+N` | 新建会话 |
| `Esc` | 拒绝权限 / 关闭面板 |

**会话**：左栏顶部「新建会话」；`/fork` 复制当前会话（保留上下文）。

## 5.5 在界面里改模型（推荐）

顶栏点「设置」，填服务商、模型、API Key，点「保存」——**立即生效，不用重启**。

- 密钥只存到 `~/.jysharness/secrets.json`，不会进项目代码库
- 「测试连接」会发一次真实的最小请求，直接告诉你通不通
- MCP 服务器也能在这里增删，保存后自动重连
- 想换配置目录（便携模式/隔离测试）：设环境变量 `HARNESS_HOME`
- 「上下文窗口」填 0 = 按模型自动推断；填了就按它算压缩阈值（75% 触发、压到 40%）

高级：也可以在 `settings.json` 里精细控制压缩行为，手动值优先于自动推导：

```json
{ "contextWindow": 200000, "compaction": { "softLimit": 120000, "targetTokens": 60000, "keepRecentMessages": 12 } }
```

## 6. 配置

两个位置，项目级优先：

```
.jysharness/settings.json      # 当前工作区
~/.jysharness/settings.json    # 全局默认
```

完整示例见 `examples/settings.example.json`：

```json
{
  "provider": "anthropic",
  "model": "claude-sonnet-4-5",
  "permissionMode": "default",
  "sandboxMode": "workspace-write",
  "permissions": {
    "allow": ["Read", "Glob", "Grep", "Bash(git status)"],
    "ask":   ["Bash(npm install *)"],
    "deny":  ["Read(.env*)"]
  },
  "hooks": {
    "PreToolUse": [{ "matcher": "Write|Edit", "command": "node examples/hooks/guard-secrets.mjs" }]
  },
  "mcpServers": {
    "demo": { "command": "node", "args": ["../tests/fixtures/mcp-echo.mjs"] }
  }
}
```

## 7. 接 MCP 服务器

在 `settings.json` 里加 `mcpServers`，重启服务即可。MCP 工具会以 `mcp__服务器名__工具名` 出现，自动继承权限、并发、diff 记录。

```json
{
  "mcpServers": {
    "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "D:/data"] }
  }
}
```

## 8. 加技能（Skills）

建一个目录，放 `SKILL.md`：

```
.harness/skills/release-notes/SKILL.md
```

```markdown
---
name: release-notes
description: 把改动整理成用户可读的更新日志。
---

1. 按 新增 / 变更 / 修复 / 移除 分组
2. 写给用户看，不要写给提交者看
```

系统提示里只放名字和描述，模型真正需要时才会用 `Skill` 工具加载正文——不会白占上下文。

## 9. 常用参数

| 参数 | 说明 |
| --- | --- |
| `--provider` | anthropic / openai / deepseek / mock |
| `--model` | 模型 ID |
| `--workspace` | 工作区根目录（默认当前目录） |
| `--mode` | 权限模式，同上表 |
| `--sandbox` | read-only / workspace-write / danger-full-access |
| `--resume <id>` | 恢复历史会话（id 见左栏会话列表） |
| `--max-turns` | 单轮最多循环几次（默认 60） |
| `--port` | 服务端口（默认 4317） |
| `--open` | 自动打开浏览器 |
| `-y` | 自动批准所有权限（演示/CI） |
| `--no-subagent` | 禁用子 Agent |
| `--debug` | 输出调试日志 |

## 10. 常见问题

**端口被占用** → `--port 4318`

**提示找不到浏览器** → 装 Edge/Chrome，或设置 `HARNESS_BROWSER="C:\path\to\chrome.exe"`

**没有 API key 想先玩一下** → 加 `--provider mock --script examples/mock-scenario.json -y`

**权限问得太频繁** → 左栏「规则」面板加 allow 规则，或切「自动接受编辑」模式

**PowerShell 调 API 中文变问号** → PowerShell 5.1 默认非 UTF-8。用 `Invoke-RestMethod -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($json))`，或直接用 Node/curl

**想确认沙箱是不是真的在挡** → 启动横幅会打印 `sandbox=... backend=...`；Windows 上 backend 是 `none`（诚实报告，见 README 已知限制）

## 11. 跑测试

```bash
cd harness
npm test        # 40 个用例：权限、压缩、diff、撤销、MCP、多会话、图片、沙箱
```
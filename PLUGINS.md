# 插件（Plugins）

插件是**项目级**的 JYSHarness 扩展：一个目录，一段 `activate(api)`，就能给你的项目加上专属工具、约定、hook 和技能。

![插件管理](docs/plugins.png)

## 和已有的扩展方式怎么分工

| 方式 | 形态 | 适合 |
| --- | --- | --- |
| **插件** | 目录 + `index.ts` | 需要**新增工具**、进程内 hook、组合多种扩展的项目工作流 |
| Skills | `SKILL.md` | 纯提示词的长流程说明，按需加载 |
| Hooks | settings.json 里的 shell 命令 | 跨项目通用、语言无关的拦截/审计 |
| MCP | 独立服务器进程 | 已经存在的外部服务（数据库、Jira、浏览器…） |

插件可以**同时**贡献工具、提示段落、hook 和技能，且不需要启动额外进程。

## 目录结构

```
<workspace>/.harness/plugins/<name>/
  plugin.json        # 清单
  index.ts           # 入口，导出 activate(api)
  skills/            # 可选：随插件分发的技能
    example/SKILL.md
```

用户级插件放在 `~/.jysharness/plugins/<name>/`（设了 `HARNESS_HOME` 就跟着走），对所有项目生效。

### plugin.json

```json
{
  "name": "acme",
  "version": "0.1.0",
  "description": "ACME 项目工作流",
  "entry": "index.ts",
  "skills": "skills",
  "enabled": true
}
```

- `entry` 省略时按 `index.ts` / `index.mjs` / `index.js` 顺序查找，且**必须在插件目录内**（`../` 会被拒绝）。
- `enabled: false` 保留插件但不加载（设置面板里也能一键停用）。
- 插件名只允许字母、数字、`.` `_` `-`。

## API

`activate(api)` 里的 `api`：

| API | 作用 |
| --- | --- |
| `api.registerTool(tool)` | 注册工具，接口与内置工具完全一致（`name/description/inputSchema/isReadOnly/isConcurrencySafe/call`） |
| `api.addPromptSection(text)` | 追加稳定的系统提示段落（项目约定） |
| `api.on(event, handler)` | 进程内 hook：`PreToolUse` `PostToolUse` `PostToolUseFailure` `PreCompact` `Stop` `UserPromptSubmit` `SessionStart`；payload 见下 |
| `api.addSkill({name, description, content})` | 内存技能，不进文件 |
| `api.log(message)` | 写日志（`--debug` 可见） |
| `api.name` / `api.version` / `api.workspaceRoot` | 元信息 |

**hook payload 的字段名（容易踩坑）：** 进程内 handler 和 shell 钩子的 stdin JSON 用的是**同一套 camelCase 字段**：

```jsonc
{ "event": "PreToolUse", "sessionId": "...", "cwd": "...",
  "toolName": "Write", "toolInput": { "file_path": "..." },
  "toolResult": "…",   // PostToolUse / PostToolUseFailure
  "prompt": "…" }      // UserPromptSubmit
```

是 `toolName` / `toolInput`，**不是** `tool_name` / `tool_input`。写错字段名的钩子不会报错，只会永远不匹配 —— 所以脚手架模板里直接给了可用写法。

hook handler 返回 `{ decision: "deny", reason }` 可以拦住工具调用，返回 `{ updatedInput }` 可以改参数，返回 `{ additionalContext }` 会给模型补一句话。

## 完整示例

```ts
export function activate(api) {
  // 1) 项目约定
  api.addPromptSection("<project_rules>使用 pnpm；提交前跑 pnpm lint 与 pnpm test。</project_rules>");

  // 2) 专属工具
  api.registerTool({
    name: "acme_deploy",
    description: "把当前分支部署到 staging，返回部署 URL。",
    inputSchema: { type: "object", properties: { branch: { type: "string" } } },
    isReadOnly: false,
    isConcurrencySafe: () => false,
    async call(input, ctx) {
      const { execFile } = await import("node:child_process");
      return await new Promise((resolve) => {
        execFile("npm", ["run", "deploy:staging"], { cwd: ctx.workspaceRoot }, (err, stdout) => {
          resolve({ content: err ? "部署失败：" + err.message : stdout, isError: Boolean(err) });
        });
      });
    },
  });

  // 3) 拦截危险操作（进程内，不用起 shell）
  api.on("PreToolUse", (payload) => {
    const target = String(payload.toolInput?.file_path ?? "");
    if (/migrations[\\/]/.test(target)) return { decision: "deny", reason: "不要直接改 migrations/" };
    return;
  });

  // 4) 技能
  api.addSkill({
    name: "acme-release",
    description: "ACME 发版流程",
    content: "# 发版\n1. bump 版本\n2. pnpm test\n3. 打 tag 并推送",
  });
}
```

## 桌面端管理

顶栏「设置」→「插件」：

- 列出项目级 + 用户级插件，含版本、贡献数量（工具/技能/hook）、路径
- **停用 / 启用**：直接改 `plugin.json` 的 `enabled`，立即生效
- **重新加载**：重读所有插件并热替换到每个会话（改完 `index.ts` 不用重启）
- **新建**：填名字点一下，等价于 `jys plugin new <name>`
- **打开目录**：在文件管理器里定位到插件
- 加载失败的插件会显示具体错误，不影响其它插件

## 插件开发模式

顶栏的「工作模式」下拉切到 **插件开发**（或 `jys --agent-mode makePlugin ...`）：

- 系统提示会注入插件 API 说明和开发流程（脚手架 → 写 `index.ts` → `jys plugin test` → 修到通过 → 重新加载）
- 模型会按这个流程工作，而不是随手写个文件了事
- 权限不变：仍然受权限模式、沙箱和规则约束

适合"让 Agent 帮我做一个项目专属插件"这种任务。

## 开发流程

```bash
jys plugin new acme                 # 在当前工作区生成脚手架
# 编辑 .harness/plugins/acme/index.ts
jys plugin test                     # 加载并校验：工具、技能、错误
jys plugin list                     # 列出全部插件及贡献数量
jys --agent-mode makePlugin         # 打开桌面端，进入插件开发模式
```

## 加载与隔离

- **每个插件独立加载**：JSON 写错、入口不存在、`activate` 抛异常都只会让**这一个**插件失败，其余照常工作。
- **重复工具名**会被拒绝并警告，不会覆盖内置工具。
- 插件在**进程启动时加载**；设置面板的「重新加载」会重新 import（用文件 mtime 破缓存），不需要重启。
- 新开会话（含切换工作区）会应用当前已加载的插件。

## 调试

- `jys plugin test` 失败返回非 0，适合放进 CI。
- `jys --debug serve` 能看到 `[plugin-name]` 前缀的日志。
- 插件工具和内置工具走同一套权限管道：在规则面板里写 `acme_deploy` 或 `acme_*` 就能约束它。

## 分发

插件是工作区的一部分（`.harness/plugins/`），跟着仓库走；也可以放到 `~/.jysharness/plugins/` 作为你自己的常用工具箱。

## 插件能配置到什么程度（实测）

下面这些都是**已经跑通并验证过**的，不是设计设想。

### 三种扩展形态

| 形态 | 放哪里 | 适合什么 | 隔离 |
| --- | --- | --- | --- |
| **项目插件** | `<workspace>/.harness/plugins/<name>/` | 只属于这个项目的工具/约定/hook | 同进程 |
| **用户插件** | `~/.jysharness/plugins/<name>/`（`HARNESS_HOME` 可改） | 跨项目通用（个人习惯、公司规范） | 同进程 |
| **MCP 服务器** | settings 里的 `mcpServers` | 进程外扩展、换语言、独立升级 | 独立进程 |

前两种是同一个 API（`activate(api)`），区别只是生效范围；第三种走 MCP 协议，工具名自动加 `mcp__<server>__` 前缀。

### 插件能拿到什么（`PluginApi`）

```ts
api.registerTool({...})        // 新工具，和内置工具走同一条 权限→审计 管道
api.on("PreToolUse", fn)       // 进程内 hook：可直接 deny 一次调用
api.addSkill({...})            // 内存技能（不落文件）
api.addPromptSection(text)     // 固定提示段落（每轮都在，适合放团队约定）
api.log(msg)                   // 打到 serve/desktop 控制台
```

外加清单里的 `skills: "skills/"` 可以随插件分发**文件技能**（每个 `*.md` 一个 `SKILL.md` 格式）。

### 实测：一个插件四件套全生效

写了一个 `team-conventions` 插件（工具 + hook + 内存技能 + 文件技能 + 提示段落），用真模型跑：

| 验证项 | 结果 |
| --- | --- |
| 加载 | `tools=1 skills=2 hooks=1`，`errors` 为空 |
| 工具被模型调用 | 模型主动调 `team_iso_now`，返回 `2026-11-17T18:06:09Z` |
| hook 拦截 | 让模型写 `secrets.env` → 插件返回 deny → **文件不存在** |
| 技能 | 内存技能 `changelog` + 文件技能 `release-note` 都进了技能索引 |
| 提示段落 | 进入系统提示，每轮都在 |

外部 MCP 也验证过：一个 30 行的 Node MCP server 暴露 `deploy_window`，被注册成 `mcp__team__deploy_window`，调用返回正确结果。

### 这次补上的一个安全缺口

**插件工具原来不走 `guardPath`**。插件自己没写 `toolCheck` 时，它能写工作区外——而内置 `Write` 不能。等于"沙箱承诺取决于第三方作者是否细心"。

修法：`ToolRegistry.assemble()` 对**所有扩展工具**（插件 + MCP）兜底注入路径校验：若 schema 里有 `file_path` / `path` / `target` 等路径参数且工具未自定义 `toolCheck`，就自动接上 `guardPath`（只读工具按 read 判、其余按 write 判）。

四条测试锁住：注入生效、插件自己的 `toolCheck` 不被覆盖、没有路径参数的工具不乱加、`bypassPermissions` 下插件越界写入仍被 deny。

### 仍然没有的（写插件前要知道）

| 缺口 | 影响 |
| --- | --- |
| **没有插件市场/安装命令** | 只能手动放进目录；`jys plugin list` 能看状态、能启用/禁用 |
| **同进程、无沙箱** | 插件代码直接跑在 harness 进程里，能 `import` 任意模块、能读环境变量。**只装你信任的插件** |
| **没有版本兼容声明** | manifest 的 `version` 只是展示，不校验平台兼容性 |
| **没有权限清单** | 插件不需要声明"我要读网络/写文件"，装上就拥有进程的全部能力 |
| **MCP 走子进程但仍然全权** | 工具调用本身受权限管道约束，但 server 进程自身不受沙箱限制 |


## 与 DSH 的兼容性（实测）

结论：**技能天然兼容（已跑通），MCP 通用，DSH 的前端客户端插件不兼容。**

### 技能：直接可用（不是"能转换"，是"能读"）

DSH 的技能格式是**扁平 `*.md` + frontmatter**：

```yaml
---
name: active-scan
description: 主动端口与服务扫描（nmap/masscan），严格遵守授权范围
whenToUse: 需要确认资产存活与开放端口时
role: recon
enabled: true
---
## 前置检查
...
```

JYSHarness 的技能发现本来就认扁平 `.md`，所以两个格式在文件层面就是同一件事。差别只在 frontmatter 的两个字段：

| 字段 | 之前 | 现在 |
| --- | --- | --- |
| `whenToUse` | 被忽略（可 DSH 的 23 个技能**全部**写了它） | 解析并**并入 description**：`主动端口与服务扫描（何时使用：需要确认资产存活…）` |
| `enabled: false` | 被忽略（停用的技能照样加载） | **跳过**并提示"已停用" |
| `role` | 忽略 | 忽略（仅分类信息，对行为无影响） |

### 导入命令

```bash
jys skill import-dsh "~/.dsh/redteam/skills" --to project   # 进当前项目
jys skill import-dsh <dir> --to user                        # 进用户级（所有项目）
jys skill list                                              # 看当前可见的技能
```

实测：把 DSH 真实目录 `~/.dsh/redteam/skills` 的 **23 个技能**导入临时工作区 → `复制 23 个` → `skill list` 全部可见、`whenToUse` 已并入描述；再导一次是 `复制 0 个，跳过 23 个`（幂等，不覆盖用户改过的版本）。

### MCP：同一份配置两边都能用

JYSHarness 的 `mcpServers` 就是标准 MCP 配置（`command` + `args` + `env`），与 DSH/Claude 一侧的写法一致。实测用 30 行的 Node MCP server 验证过：工具注册为 `mcp__<server>__<tool>`，调用返回正确结果。所以基于 MCP 的扩展两边通用。

### 不兼容的部分（要说清）

| DSH 侧 | 能否复用 | 原因 |
| --- | --- | --- |
| **客户端插件（client-plugin）** | ❌ | DSH 的前端插件是打进 `apps/web` 的 React/TS 包，走 HMR 注入 `window.__DSH_BOOT__`；JYSHarness 的 UI 是无构建的经典脚本，两套渲染模型不同 |
| **DSH 的 `activate(api)` 插件** | ⚠️ 需改写 | 两个平台的 `PluginApi` 不是同一个接口。工具/hook/技能的**贡献类型**一样，但对象形状不同（JYSHarness 是 `registerTool/addSkill/on/addPromptSection`）。好在单个插件通常只有几十行，改写成本低 |
| **DSH 的 session/checkpoint 数据** | ❌ | JSONL 结构不同 |
| **prompt-inject.md 之类的注入文件** | ⚠️ 需手写 | JYSHarness 对应的是 `.harness/memory.md` 与 `AGENTS.md` |

### 一句话总结

- **技能**：同一格式，`jys skill import-dsh` 一条命令搬过来，还能吃 `whenToUse` 和 `enabled`；
- **MCP**：同一协议，配置可直接复用；
- **插件代码**：贡献类型相同但接口不同，需要改写（通常几十行）；
- **前端插件**：不兼容，属于两套 UI。


## v2：从"钩进管线"到"可安装的能力面"

参考 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)（"Everything is a Plugin"）。DSH 的插件是 Cordis 插件：每个能力都是一个把服务注册到 ctx 的包，分 host 半与 client 半，另有 Plugin Manager 负责安装/启停/检查。

JYSHarness 的 v1 只能"钩进已有管线"（工具/hook/技能/提示词）。v2 让插件能贡献**新的能力面**，因此一个插件可以是一个"可安装的服务 + 界面模块"。

### 对照表

| 能力 | DSH（Cordis） | JYSHarness v2 |
| --- | --- | --- |
| 注册工具 | `ctx.tools` | `api.registerTool()` |
| 注册服务/路由 | `ctx.<service>`，host 半持有 | `api.registerRoute()` → `/plugin/<id>/<path>` |
| UI 模块 | client 半包，编译进 client program | `ui/index.js`，宿主 `import()` 后 `mount(el, api)` |
| 命令 | `ctx.commands` | `api.registerCommand()` |
| 声明式清单 | package.json + Cordis 元信息 | `plugin.json`（id/engines/contributes/panels/ui） |
| 安装/启停 | Plugin Manager | `jys plugin list/enable/disable` + `/api/plugins` |
| 隔离 | host/client 双半 + 沙箱 runner | 同进程；路径守卫 + 目录包含校验 |

### 插件能贡献的五类东西

```json
{
  "name": "demo-panel", "id": "demo-panel", "version": "1.0.0",
  "entry": "index.ts", "ui": "ui",
  "engines": { "harness": ">=0.2" },
  "contributes": { "permissions": ["http-route", "ui-panel"] },
  "panels": [{ "id": "demo", "title": "演示面板", "icon": "◈", "slot": "sidebar" }]
}
```

```ts
export function activate(api) {
  api.registerTool({...});                                       // 工具（走权限/审计管道）
  api.on("PreToolUse", fn);                                      // 钩子（可 deny）
  api.addSkill({ name, description, content });                   // 内存技能
  api.addPromptSection("...");                                   // 固定提示段落
  api.registerRoute({ method: "GET", path: "stats", handler });    // HTTP 路由
  api.registerPanel({ id: "demo", title: "演示面板" });            // Web UI 面板
  api.registerCommand({ name: "/demo-ping", run });               // 斜杠命令
}
```

### 三条挂载路径

| 路径 | 来源 | 说明 |
| --- | --- | --- |
| `/plugin/<id>/<path>` | `api.registerRoute()` | 插件自己的 API；body 已解析 JSON、query 已解析 |
| `/plugin-assets/<id>/<file>` | 清单 `ui` 目录 | 浏览器侧资产，no-store 不缓存（改完刷新即生效） |
| `/api/config` 的 `panels` | 清单 `panels` | UI 首屏据此加侧栏按钮（同步读清单，不执行 activate） |

### 为什么面板要在清单里声明

`api.registerPanel()` 写在 `activate()` 里，而它是异步、可能有副作用；但 `/api/config` 是同步构造的（UI 首屏就要按钮）。所以：

- 清单 `panels` → 首屏可见（同步读 JSON）；
- `api.registerPanel()` → 运行期登记，出现在 `/api/plugins` 的贡献清单（调试/审计）。

### 安全边界（v2 新增两条）

| 风险 | 处理 |
| --- | --- |
| 插件资产被用来读任意文件 | `resolveAssetPath()` 做目录包含校验；`..` 穿越一律 404，且不区分"越界"与"不存在" |
| 插件工具绕过沙箱 | `ToolRegistry.assemble()` 对扩展工具兜底注入 `guardPath`（漏写 toolCheck 也拦得住） |
| 插件 JS 拥有页面权限 | 不做隔离，属于已知取舍：面板要与会话状态互通。只装信任的插件 |

### 实测（真实浏览器，非模拟）

| 验证项 | 结果 |
| --- | --- |
| `/api/config` 带上 panels | `[{id:"demo",title:"演示面板",icon:"◈",asset:"/plugin-assets/demo-panel/index.js"}]` |
| `GET /plugin/demo-panel/stats` | `{"plugin":"demo-panel","workspace":"…","at":"…"}` |
| `GET /plugin-assets/demo-panel/index.js` | 200 text/javascript（未开缓存） |
| `GET /plugin-assets/demo-panel/../../etc/passwd` | **404**（目录穿越被拒） |
| 不存在的插件路由 | **404** |
| 浏览器侧栏按钮 | 出现「◈ 演示面板」 |
| 点击后面板内容 | `插件: demo-panel / 工作区: … / 时间: …`（数据来自插件自己的路由） |
| 控制台异常 | 0 |

### 与 DSH 仍有的差距

| 差距 | 说明 |
| --- | --- |
| 无沙箱 runner | DSH 用 cordis-host-runner 把插件放进沙箱执行；这里插件在同进程，拥有进程全部能力 |
| 无动态安装 | DSH 有 Plugin Manager 安装持久化插件；这里是"放目录 + 启停"，没有从 URL/包仓库安装 |
| UI 能力有限 | 目前只有侧栏面板一个 slot；DSH 的 client 半可注册任意 slot/命令面板/设置页 |
| 无版本解析 | `engines` 只是声明，不校验；也没有插件间依赖解析 |


## 插件平台：安装、版本、权限、多 slot

v2 让插件能贡献能力面；这一轮把它补成**能分发、能校验、能审计**的平台。

### 1. 安装与卸载

```bash
jys plugin install ./my-plugin            # 本地目录
jys plugin install plugin-dir --force      # 覆盖已安装的（默认拒绝）
jys plugin install <git-url>               # git 源（浅克隆，需要网络）
jys plugin install ./my-plugin --user      # 装到用户级（所有项目生效）
jys plugin install ./my-plugin --disabled  # 装了但先不启用
jys plugin uninstall my-plugin [--user]
jys plugin list [--json]                   # 含来源、能力声明、面板数、是否停用
```

安装时做四件校验，任何一条不过就**不落盘**：

| 校验 | 不通过的表现 |
| --- | --- |
| 清单合法（`name` 匹配 `[a-zA-Z0-9._-]`） | `清单无效：…` |
| 入口在插件目录内（`../` 逃逸） | `入口无效：entry escapes the plugin folder` |
| `engines.harness` 与当前版本兼容 | `不兼容（harness 0.2.0）：需要 harness >=99.0.0` |
| 同名插件是否已存在 | `已安装：xxx（加 --force 覆盖）` |

安装成功会写 `plugin.lock.json`（来源、安装时间、安装时的 harness 版本），`list` 据此显示来源。

### 2. 版本与依赖校验

- `engines.harness`：支持 `>=x.y.z`、`>x`、`<=`、`<`、`=`、`^x.y.z`（同 major）、`~x.y.z`（同 minor）、`*`，以及 `^1 || ^2` 多选；
- `dependencies`：插件可声明依赖其它插件与版本范围，**缺依赖或版本不符直接拒绝加载**（不是"加载了但行为怪"）；
- 加载期不兼容 → 进 `errors`，`jys plugin list` 会红字打出原因。

不引入第三方 semver：需求只是"拦住明显不兼容"，为此加运行时依赖不划算（本项目运行时零依赖）。

### 3. 能力声明是强制的

`contributes.permissions` 不再只是展示字段：

| 能力 | 需要声明 | 未声明的后果 |
| --- | --- | --- |
| `api.registerRoute()` | `http-route` | **拒绝注册**，告警写明原因 |
| `api.registerPanel()` | `ui-panel` | **拒绝注册**，告警写明原因 |

这不是安全沙箱（插件仍在同进程），但它把"这个插件对外开了接口"变成**安装前可见、加载时强制**的事实。

### 4. 三个 UI slot

| slot | 位置 | 典型用途 |
| --- | --- | --- |
| `sidebar`（默认） | 侧栏 tab（与"文件/待办"并列），点击后 mount | 主面板 |
| `settings` | 设置弹窗底部的独立区块 | 插件自己的配置界面 |
| `statusbar` | 底部状态栏右侧常驻小部件 | 状态/计数类信息 |

```json
"panels": [
  { "id": "board",          "title": "团队看板", "slot": "sidebar" },
  { "id": "board-settings", "title": "看板设置", "slot": "settings" },
  { "id": "board-status",   "title": "看板",     "slot": "statusbar" }
]
```

未识别的 `slot` 值回落到 `sidebar`（不让一个拼错毁掉整个插件）。

### 5. 插件命令真的能用了

`api.registerCommand()` 原来只收集不派发。现在 `/board` 这类命令在**两处**都能用：

- REPL：`handleSlash` 的 default 分支先问插件；
- Web：`POST /api/command` 同样先查插件命令，找到就把结果作为 notice 广播回界面。

两处共用同一个 `runPluginCommand()`，返回 `null` 表示"没有插件认领"，调用方继续报 unknown command。

### 实测（真实浏览器 + 真实 CLI）

| 验证项 | 结果 |
| --- | --- |
| `jys plugin install ./my-plugin` | `已安装 team-board → …/.harness/plugins/team-board` |
| 重复安装 | `安装失败：已安装：team-board（加 --force 覆盖）` |
| `jys plugin list` | 显示 `来源 … · 能力 http-route,ui-panel · 面板 3` |
| 命令 `/board` | `看板: 2 个任务待办`（REPL 与 API 同源） |
| 侧栏 slot | 出现「▦ 团队看板」，点击显示 `任务: 写文档、修 bug` |
| 设置 slot | 弹窗底部出现「插件设置」区块 |
| 状态栏 slot | 显示「▦ 2」 |
| 控制台异常 | 0 |

单测：`tests/plugin-platform.test.ts` 12 项（版本范围、依赖、安装/覆盖/卸载、入口逃逸、`--disabled`、repo 布局、权限强制、slot 回落、不兼容拒绝）。


## 进程隔离执行（isolation: process）

这是对"插件在同进程、崩溃会带走会话"这一缺口的补齐。清单里写一行就切换执行位置：

```json
{
  "name": "my-plugin",
  "isolation": "process"
}
```

| | `in-process`（默认） | `process` |
|---|---|---|
| 加载方式 | 父进程 `import()` 插件入口 | 独立子进程（`src/plugins/host/child.ts`） |
| 工具/路由/命令/hook | 直接调用函数 | 通过 stdio JSON-RPC 调用，父进程只持有**代理** |
| 插件崩溃 | **带走整个会话** | 只有它的调用失败，会话继续；下次调用自动重启宿主 |
| 插件卡死 | 会话卡死 | 按类超时（工具 120s / 路由 30s / 命令 30s / hook 10s） |
| 内存 | 共享 | 独立 |
| 沙箱 | 走父进程沙箱策略 | **不走**：子进程是独立 OS 进程，父进程的沙箱管不到它 |

**必须说清的边界**：进程隔离解决的是"崩溃/卡死/内存污染"，**不是安全沙箱**。子进程拥有普通用户的全部权限。要真正的权限隔离，得配合系统级沙箱（低完整性令牌 / 容器），这是另一件事。

### 协议（换行分隔 JSON over stdio）

```
子 → 父   {type:"ready", plugins:[描述...], errors, warnings}
子 → 父   {type:"log", level, message}          ← 插件 console.* 被重定向到这里
父 → 子   {id, method:"tool.call"|"route"|"command"|"hook", ...}
子 → 父   {id, ok:true, result} | {id, ok:false, error}
```

三条硬性约束（都有测试守着）：

1. **stdout 只走协议** —— 子进程启动第一件事是把 `console.*` 全部重定向到 stderr，否则插件一句 `console.log` 就会污染通道、父进程解析失败；
2. **异常必须回响应** —— 子进程任何抛错都转成 `ok:false`，否则父进程永久等待；
3. **只传可序列化的东西** —— 函数留在子进程，父进程拿到的是描述 + 代理。

### 生命周期与缓存

- 宿主按**插件目录**缓存（`hostFor()`）：服务端每个请求都会 `loadPlugins`，不缓存会漏进程；
- 服务端 `close()` 与进程 `exit` 都会 `shutdownHosts()`，实测关闭服务端后宿主进程**立即退出**，无孤儿；
- 崩溃后 `request()` 会尝试重启一次（自愈），失败才返回错误。

### 超时可配置

```bash
HARNESS_PLUGIN_TOOL_TIMEOUT_MS=300000   # 工具（默认 120s）
HARNESS_PLUGIN_ROUTE_TIMEOUT_MS=30000   # 路由
HARNESS_PLUGIN_COMMAND_TIMEOUT_MS=30000 # 命令
HARNESS_PLUGIN_HOOK_TIMEOUT_MS=10000    # hook
```

注意：这些**每次调用时读取**。之前写成模块加载时求值，测试里设了 300ms 仍按默认跑完 —— 这是个真实的坑，已修。

### 实测（真实进程 + 真实服务端 + 真实浏览器）

| 验证项 | 结果 |
| --- | --- |
| 工具在子进程执行 | 父 `pid=18412`，工具返回 `child-pid:6384` |
| 路由在子进程执行 | `GET /plugin/iso/whoami` → `{"pid":11676}`，与 harness 主进程不同 |
| 命令在子进程执行 | `/who` → `cmd-pid:6384` |
| hook 可 deny | `PreToolUse` 返回 `{decision:"deny", reason:"isolated-hook-says-no"}` |
| 插件 `console.log` | 不污染协议，工具仍正常返回 `noisy-ok` |
| 插件崩溃 | 工具返回 `[插件 isolated 执行失败] 插件宿主已退出（code=9…）`，父进程存活，下次调用返回新 pid（自愈） |
| 插件卡死 | 300ms 超时生效，返回"插件调用超时" |
| 宿主缓存 | 重复 `loadPlugins` → 宿主数仍为 1 |
| 关闭服务端 | 宿主进程消失，端口释放，无孤儿 |
| 与本进程插件混合 | 两种插件并存，in-process 的仍返回父进程 pid |

单测：`tests/plugin-isolation.test.ts` **8 项**（子进程执行、路由/命令、日志不污染、崩溃自愈、超时、hook、缓存与关机、混合模式）。


## 与 DSH 插件的兼容性（实测结论）

一句话：**格式层能适配（已实现），实现层不兼容。**

DSH 的插件是 @deepseek-ai/cordis 的插件对象 —— 一个带 `apply(ctx, config)` 的对象外加 `inject` 依赖声明
（判定逻辑见 `cordis/src/registry.ts`：`typeof object.apply === 'function'`）。所以"兼容"要看三层：

| 层 | 内容 | 结论 | 证据 |
| --- | --- | --- | --- |
| ① 入口契约 | `activate(api)` vs Cordis `apply(ctx)` + `inject` | **可适配，已实现** | `src/plugins/cordis.ts`，5 项测试 |
| ② 依赖与服务面 | 插件 `import` `@deepseek-ai/dsh-*`，用 `ctx.llm/sessions/sandbox/guard/jobs/fs` | **不兼容** | 这台机器的 DSH 只装了 8 个包（cordis/cosmokit/schemastery/deque/timeout/brand/api-gateway/typert-protocol）；`dsh-core`、`dsh-tools`、`dsh-session`、`dsh-llm`、`dsh-sandbox`、`dsh-guard` **全部缺失** |
| ③ 浏览器半 | client 插件是 React 组件，编译进 DSH 的 `apps/web`（HMR + `window.__DSH_BOOT__`） | **不兼容** | 本平台 UI 是经典脚本 + slot mount，两套渲染模型 |

### ① 层做了什么（可用的部分）

`src/plugins/cordis.ts` 给 Cordis 插件一个 ctx 门面，把这一小部分映射到本平台：

| Cordis API | 映射到 |
| --- | --- |
| `ctx.tools.register({ name, parameters, execute })` | `api.registerTool()`（接受 `execute/call/handler` 三种命名、`parameters/inputSchema` 两种 schema 字段） |
| `ctx.commands.register({ name, run })` | `api.registerCommand()`（名字自动补 `/` 前缀） |
| `ctx.skills.register({ name, content })` | `api.addSkill()` |
| `ctx.on('PreToolUse' …)` | `api.on(HookEvent)`；其它事件名只在本插件内部派发 |
| `ctx.logger()` / `ctx.effect()` / `ctx.emit()` | 日志 / 清理收集 / 局部事件 |
| `ctx.provide(name, v)` / `ctx.get(name)` | 插件私有服务注册表 |

**inject 会被强制校验**：声明了 `llm`/`sessions` 这类本平台不提供的服务，插件直接**拒绝加载**并说明缺什么，不会留下半截贡献。

### ② 层为什么不兼容（不可用的部分）

不是"没实现"，而是**依赖不存在**：DSH 的插件代码 `import { ... } from '@deepseek-ai/dsh-tools'`，
这些包在 DSH 安装目录里没有（应用是打包的 asar，只带了 8 个支撑包）。就算把包凑齐，
那些插件要的 `ctx` 服务面（会话、模型、沙箱、审批、任务、文件系统）也得逐一对齐 —— 那等于重做 DSH 内核。

### 什么真的能搬过来

| 形式 | 兼容性 | 怎么用 |
| --- | --- | --- |
| **MCP 服务器** | ✅ 通用（标准协议） | 配置写进 `mcpServers`，工具注册为 `mcp__<server>__<tool>` |
| **技能（`*.md` + frontmatter）** | ✅ 直接可用 | `jys skill import-dsh <dir>`，实测 23 个全通，支持 `whenToUse`/`enabled` |
| **纯逻辑 Cordis 插件**（只用 tools/commands/skills） | ⚠️ 可用（经适配层） | 放进 `.harness/plugins/<name>/`，入口导出 `{ apply(ctx) }` 即可 |
| **依赖 dsh-* 包或 ctx 深度服务的插件** | ❌ | 会以"inject 了本平台不提供的服务"或 import 失败拒绝，原因明确 |
| **client 插件（React）** | ❌ | 需按本平台 slot 重写浏览器半 |

### 实测

| 项 | 结果 |
| --- | --- |
| 真实 DSH 包能否 import | `dsh-deque` ✅、`cordis` ✅（零依赖），说明 cordis 本身可加载 |
| DSH 插件依赖的包 | `dsh-core`/`dsh-tools`/`dsh-session`/`dsh-llm`/`dsh-sandbox`/`dsh-guard` **全部缺失** |
| Cordis 风格插件（只注册工具） | ✅ 加载成功，工具调用返回正常 |
| Cordis 风格插件（`inject: {llm, sessions}`） | ✅ 按预期拒绝，错误含"不提供 / llm" |
| Cordis `ctx.on('PreToolUse')` | ✅ 接进 hook 管线，可返回 deny |
| 误判防护 | 修掉一个真 bug：任何函数都有 `Function.prototype.apply`，导致 `activate` 被误认成 Cordis 插件 → 改为要求**自有 apply** |

单测：`tests/cordis-compat.test.ts` **5 项**。

### 结论怎么用

想在 DSH 与本平台之间复用，按这个顺序：
1. **技能**直接搬（`jys skill import-dsh`）；
2. **MCP 服务器**直接配；
3. **纯逻辑插件**用 `apply(ctx)` 形态写，两边都能跑（本平台走适配层）；
4. **需要 DSH 内核服务的插件**别想着搬 —— 重写更划算。


## 插件实现审查报告（本轮）

按"能不能真的用"为标准逐项实测，发现并修复 3 个真 bug、2 个一致性问题、1 个性能问题。

### 修掉的 bug

| # | 问题 | 现象（实测） | 修法 |
| --- | --- | --- | --- |
| 1 | **宿主缓存不失效** | 覆盖安装/改代码后，工具仍返回旧值（v1 而非 v2） | 新增 `shutdownHost(dir)`；安装、卸载、启停、reload 全部调用 |
| 2 | **一次性命令挂死** | 带进程隔离插件时 `jys plugin list` 永不退出（`timeout 8` → 退出码 124）；只有本进程插件时正常 0 | 子进程 `unref()` + stdio 运行时探测 unref + 模块级 `process.once("exit")` 清理 |
| 3 | **函数被误判成 Cordis 插件** | 任何函数都自带 `Function.prototype.apply`，导致 `activate` 走进 Cordis 分支 | 判定改为要求**自有 apply**（class static apply 仍支持） |

### 一致性问题

| # | 问题 | 影响 | 修法 |
| --- | --- | --- | --- |
| 4 | 清单 `panels` 绕过 `ui-panel` 权限 | 只要写进 manifest 就能显示 UI，规则自相矛盾 | `pluginPanelDirs` 也校验权限 |
| 5 | 命令重名静默覆盖 | 两个插件都注册 `/deploy`，先加载的生效，用户以为"命令没反应" | 加载期检测并告警，指出两个插件名 |

### 性能

| # | 问题 | 修法 |
| --- | --- | --- |
| 6 | `jys plugin list` 在循环里对每个插件重新 `discover`（O(n²)） | 提到循环外，一次读取 |

### 逐项验证（真实进程/真实服务端/真实 Agent 循环）

| 验证项 | 结果 |
| --- | --- |
| 两种模式工具并存 | `isoVersion → iso-v1`（子进程）、`inprocVersion → inproc-v1`（本进程） |
| 崩溃隔离 | `isoCrash → [插件 iso 执行失败] 插件宿主已退出（code=9）`，其它工具不受影响 |
| 路由按插件命名空间隔离 | 两个插件都注册 `GET /info`，分别命中各自实现 |
| 命令 | `/iso`、`/inproc` 均可用；重名会告警 |
| 面板 | `config.panels` 同时列出 `inproc:inproc-p`、`iso:iso-p` |
| 资产 | `/plugin-assets/iso/index.js`、`/plugin-assets/inproc/index.js` 均 200 |
| **Agent 循环** | 模型可见 `IsoVersion` → `tool_end` 命中 → 结果 `iso-v1-from-child` 回传 → `completed`（两种模式各一条测试） |
| 路径守卫 | 插件工具漏写 `toolCheck` 时，`assemble` 兜底拦截越界写入（两种模式） |
| 并发 | 20 个并发调用无串台（响应按 id 配对） |
| 升级 | 安装 v1 → 使用 → 覆盖安装 v2 → 重新加载拿到 v2 |
| 卸载 | 有活宿主时卸载不报错、目录删除、宿主退出、工具消失 |
| 一次性命令退出 | 带进程隔离插件时退出码 0（修复前 124） |

### 回归测试（新增 12 项）

`tests/plugin-lifecycle.test.ts`（升级/卸载/并发/不挂死）、`tests/plugin-guard.test.ts`（两种模式的路径守卫）、`tests/plugin-agent.test.ts`（两种模式的 Agent 循环）、`tests/plugin-stale.test.ts`（缓存失效复现与修复）。


## 插件调用的取消语义

进程隔离解决了"崩溃隔离"，但还留着一个问题：父进程超时后只是**不再等待**，子进程里那次调用还在算 —— 幽灵计算。这一轮补上。

### 机制

```
父 → 子   {type:"abort", id, reason}      取消某次进行中的调用
子：inflight.get(id)?.abort(reason)       → 插件的 ctx.signal 变成 aborted
```

触发点有三个：

| 触发 | 行为 |
| --- | --- |
| 调用超时 | 先发 abort，再拒绝（子进程不会继续算下去） |
| 会话中止（用户点停止 / 上游 abort） | 通过 `ctx.signal` 透传到子进程，立刻拒绝 |
| 宿主关闭（`kill()` / 进程退出） | 对所有挂起调用逐个发 abort，再杀进程 |

插件侧能拿到的地方：

| 位置 | 字段 |
| --- | --- |
| 工具 | `call(input, ctx)` 的 `ctx.signal` |
| 路由 | handler 的 `ctx.signal` |
| 命令 | `run(arg, { workspaceRoot, signal })` |

### 边界（必须说清）

这是**协作式取消**：JS 没有跨进程强杀函数的手段。插件只有在检查 `signal.aborted`（或 `signal.addEventListener('abort')`）时才会提前退出；
完全不看 signal 的插件，父进程只能做到"不再等待"，子进程仍会算完。

子进程另有一道**安全上限**（10 分钟）：即使父进程崩溃失联，调用也会被宿主自己 abort，不会永久挂着。

### 实测（从文件观察子进程，而不是只看父进程超时）

| 场景 | 结果 |
| --- | --- |
| 工具超时 300ms，插件循环 5s | 父进程收到"超时"；子进程写下 `aborted-after:~300`，**没有跑到 5s** |
| 会话 abort 400ms，插件循环 8s | 全链路 410ms 结束；子进程写下 `aborted-after:399` |
| 不取消的正常调用 | 正常返回 `finished-normal`，宿主仍健康 |
| 取消未知 id | 无操作，不崩溃 |

测试：`tests/plugin-cancel.test.ts` **3 项**。


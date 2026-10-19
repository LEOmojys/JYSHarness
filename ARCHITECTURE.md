# 架构与设计取舍

这份文档解释"为什么这样实现"，而不是"实现了什么"。功能清单见 README。

---

## 1. 主循环：while(true) + continue 站点

`src/core/query.ts` 是本项目的核心，形态与 Claude Code 的 `queryLoop()` 一致：**Async Generator + 无限循环 + 显式 continue**。

```
while (true) {
  ① 主动压缩（microcompact → snip → summary）
  ② 组装请求，流式调用模型
  ③ 错误恢复（429/5xx → 退避重试；413 → 反应式压缩；max_tokens → 升级/续写）
  ④ 有 tool_use → 权限门禁 + 分区执行 → 追加 tool_result → continue（正常下一轮）
  ⑤ 无 tool_use → Stop Hook → 完成，或把 hook 反馈注入后 continue
}
```

**为什么不用递归？** 递归会随着恢复次数增长栈深度，而恢复路径本质上都是"重来一次"。`continue` 把重试表达成循环的自然行为，状态也只有一个 `LoopState` 对象，不需要在闭包间传递。

**为什么用 Generator 而不是返回最终结果？** 客户端需要在模型还在生成时就开始渲染；用户需要能中断；压缩、重试、工具进度都应该是可观察事件 —— 而不是一个黑盒 `await`。

### 本实现 vs Claude Code 的恢复站点

| 恢复路径 | 本项目 | Claude Code |
| --- | --- | --- |
| 正常下一轮（工具执行完） | ✅ | ✅ |
| Proactive compaction | ✅ | ✅ |
| Prompt too long (413) → 反应式压缩 | ✅（只重试一次，用 `hasAttemptedReactiveCompact` 防止死循环） | ✅ |
| Max output tokens → 提升上限 / 注入续写提示 | ✅（提升一次 + 最多 3 次续写） | ✅ |
| 瞬时错误（429/5xx）→ 指数退避 | ✅ | ✅ |
| Fallback model | ❌ | ✅ |
| Stop Hook 阻断 | ✅ | ✅ |
| 图片/媒体错误 | ❌（不支持多模态） | ✅ |

关键细节：**413 反应式压缩只做一次**。如果压缩后仍然超长，必须终止而不是再压一次 —— 否则就是 `compact → 仍然太长 → 报错 → compact` 的无限循环，在真实 API 上会烧掉真金白银。这就是 Claude Code 源码里 `hasAttemptedReactiveCompact` 不重置的原因。

---

## 2. 工具系统：接口设计比 `call()` 更重要

`Tool` 接口里，执行函数只占一行；真正决定 harness 质量的是这些字段：

- `isReadOnly` / `isDestructive`：权限引擎据此决定默认行为（只读默认放行，破坏性默认询问）。
- `isConcurrencySafe(input)`：驱动执行分区。
- `toolCheck(input, ctx)`：工具自己的安全检查（路径包含、沙箱模式），在通用规则之后、模式之前执行 —— 这个位置很关键：**用户显式 allow 规则不能绕过路径逃逸检查**。
- `inputSchema` + `validate()`：结构校验和语义校验分开。Schema 失败是"模型写错了参数"，`validate()` 失败是"参数合法但没意义"（例如 `old_string === new_string`），两者的错误文案不同。

### 分区并发

`partitionCalls()` 把一批工具调用切成"连续同类"的批次：

```
[Read a, Read b, Write c, Read d]  →  [[Read a, Read b], [Write c], [Read d]]
```

只读批次用 `Promise.all` 并发，写入批次串行。**权限门禁和 Hook 必须在这之前串行完成**：它们可能要弹窗问用户，并发弹窗是灾难。

---

## 3. 权限：顺序即安全

`decidePermission()` 的判定顺序是刻意设计的，不能随意调整：

```
硬编码拒绝 → deny 规则 → ask 规则 → 工具自检 → allow 规则 → 权限模式 → 默认询问
```

- **硬编码拒绝在最前**：`rm -rf /`、fork 炸弹、`git push --force` 这类操作不能被任何配置放行。这是"第 6 层防御"，弱点是不灵活，价值是不可绕过。
- **deny 先于 allow**：两条规则同时命中时拒绝优先。否则一条宽泛的 allow 会静默吃掉即将添加的 deny 规则。
- **工具自检先于 allow 规则**：允许用户写 `Write(*)`，但不允许因此写出工作区 —— 路径逃逸检查在规则之后无法阻止这一点。
- **模式最后**：`bypassPermissions` 是最后的兜底放行，不应该跳过工具自检。

每个决策都带 `reason`（`rule_deny` / `tool_check_ask` / `mode_accept_edits` …）。**能解释自己的权限系统，才能让用户建立正确信任** —— 否则用户会习惯性按 y，纵深防御退化为按 y 的手速测试。

拒绝了也要回给模型：`<tool_use_error>Permission denied for Write: ... Do not retry the same call.</tool_use_error>`。静默失败会让模型执着地重试同一个被拒操作。

---

## 4. 沙箱：一个真实的 Windows 坑

路径包含检查最容易写错。本项目的实现要点：

1. **两边都做 realpath**：`..` 和符号链接必须被解析后再比较。
2. **比较 `path.relative`**，而不是字符串前缀（`C:\work` 与 `C:\work-other` 前缀相同但不是子目录）。
3. **Windows 上要处理 8.3 短路径**。这是实测踩到的坑：`mkdtemp()` 返回 `C:\Users\XXX~1\AppData\...`，而 `realpathSync.native()` 返回长形式，两边直接比较会判定"在工作区外"，于是每次写入都要求授权 —— 测试里表现为"read-only 沙箱没拦住写入"。修法是在 `guardPath()` 里把**工作区根也做一次 realResolve**。

另外，沙箱模式 `read-only` 同时由两处执行：权限引擎（工具级）和 `guardPath()`（路径级）。**冗余在这里是特性**：任何一处有 bug，另一处仍然挡得住。

命令执行层还做三件事：超时（默认 120s，超时 kill）、输出截断（防止一次日志刷爆上下文）、平台 shell 探测（`pwsh` 不在就退回 `powershell.exe`，再不行才报错 —— 而不是抛 ENOENT 给模型）。

---

## 5. 上下文：先丢最便宜的

压缩是三级流水线，顺序不是随意的：

| 级别 | 动作 | 信息损失 | 成本 |
| --- | --- | --- | --- |
| microcompact | 把较老的工具输出换成 `[earlier tool output elided: N chars]` | 低（细节通常已经用不上了） | ~0 |
| snip | 丢弃最老的轮次，保留首条用户消息 | 中 | ~0 |
| summarize | LLM 生成交接摘要，替换整个转录 | 高 | 一次额外调用 |

实现上有个必须遵守的约束：**snip 不能从一条只含 `tool_result` 的消息开始**，否则会留下没有对应 `tool_use` 的孤儿结果，多数 API 会直接 400。代码里用 `while (...) start++` 跳过这类消息。

摘要提示词要求保留：用户目标与约束 → 已做的决策及原因 → 触碰过的文件与当前状态 → 待办 → 下一步需要的标识符。这比"总结一下"有效得多，因为它保留的是**可继续执行性**，而不是文风。

---

## 6. 会话：文件即真相

会话是追加式 JSONL：第一行 `meta`，之后每行是 `message` 或 `note`。

- 崩溃只会损坏最后一行，加载时跳过解析失败的行即可恢复。
- `--resume` 就是重读文件；`fork` 就是复制文件。
- 压缩前用 `saveTranscript()` 把完整转录另存为 JSON 备份 —— 摘要是有损的，原始记录不能丢。

注意一个实现细节：`queryLoop` 内部会**替换**消息数组（压缩），所以外部不能靠"追加自己收到的事件"来重建状态。本项目通过 `onState(messages)` 回调把循环内部的真实状态镜像回 Session。

---

## 7. Provider：只做协议转换

`ModelProvider` 只有一个方法 `stream(req): AsyncGenerator<StreamEvent>`，产出 `text_delta` 和最终的 `done`（含 `stopReason` 与 `usage`）。

- 错误必须被归类成 `ProviderError.kind`（`prompt_too_long` / `rate_limit` / `overloaded` / `auth` / `model_error`）。**循环靠 `kind` 做恢复决策，靠 HTTP 状态码做不了** —— 各家的错误体格式完全不同。
- Mock Provider 不是玩具：它让整个 harness 可以在无 key、无网络、确定性的情况下做端到端测试。一个不能测试的 harness 是不可信的。
- 适配器里不能有重试逻辑：重试属于循环（它需要决定是否先压缩、是否计数、是否降级）。

---

## 8. 子 Agent：隔离是唯一目的

`Agent` 工具的价值不是"并行"，而是**上下文隔离**：探索性任务产生的大量噪声（读 20 个文件、试 5 种方案）留在子会话里，父级只收到一段摘要。

实现上子 Agent 自己跑一个 `queryLoop`：全新的 `messages`、工具列表去掉 `Agent`（防止无限递归）、深度上限 2、`maxTurns` 25。权限与沙箱**完全继承**父会话 —— 子 Agent 不应该获得更高的权限，这是个常见的安全漏洞。

---

## 9. 测试策略

17 个用例分三层：

1. **纯函数**：权限决策、规则匹配、分区、路径包含、压缩。快且能覆盖边界。
2. **端到端（Mock Provider）**：真实执行工具、真实落盘、真实拦截危险命令、真实的用户拒绝、真实的 Hook 阻断、真实恢复会话。
3. **回归锚点**：`max_turns` 不会死循环；被拒的调用一定会产生 `tool_end` 事件（否则 UI 看起来像卡死）。

---

## 10. MCP：协议边界放在哪里

MCP 客户端（`src/mcp/`）只做三件事：`initialize` → `tools/list` → `tools/call`。资源、提示词、采样都没做，因为它们不影响"Agent 能调用什么"这个核心问题。

三个工程决定：

1. **适配器而不是特例**。MCP 工具被包装成普通的 `Tool`，所以权限管道、Hook、并发分区、diff 记录全部自动生效 —— 循环里没有一行 MCP 相关代码。
2. **失败降级**。一个服务器起不来只是少几个工具，不会让会话崩溃：坏 command 只让 `errors` 多一条。
3. **优雅关闭**。MCP 服务器在 stdin 关闭时退出，调用方不应该 SIGKILL —— Windows 上在 stdio 回调里杀子进程会把父进程带崩，这个坑记在 `close()` 的注释里。

## 11. 后台任务：不要阻塞循环，也不要丢输出

`JobManager` 用子进程 + 环形缓冲实现。三个要点：

- **立即返回**：`Bash run_in_background` 只回 job id，模型可以接着干别的。
- **有界内存**：输出超过 200KB 就截断尾部，否则一次 `npm install` 就能把进程撑爆。
- **可回收**：会话删除或进程退出时 `killAll()`，不留孤儿进程。

## 12. 检查点：让"可逆"变成默认

每个会写文件的工具在执行前调用 `ctx.checkpoints.record(path)`，注册表在调用结束后统一 `commitCall()` 计算 diff：

```
beginCall() → tool.call() → record(path)×N → commitCall() → FileChange[]
```

这样做的原因：**工具不需要知道 diff 怎么算，UI 不需要知道文件怎么改**。撤销就是反向写回快照；文件是新建的则删除。

一个真实的 bug 值得记录：最初工具里调用的是 `ctx.checkpoint(...)`，而上下文暴露的是 `ctx.checkpoints.record(...)` —— 可选链让这个错误**静默通过**，表现为"undo 永远说没有可撤销的改动"。测试（断言 `metadata.changes` 非空）才把它抓出来。可选链在跨模块契约里是双刃剑。

## 13. 多会话：状态必须按会话隔离

服务端的 `Map<sessionId, Hosted>` 里，每个会话独立持有：循环状态、AbortController、待审批队列、文件变更日志。SSE 是**一条广播**，每个事件带 `sessionId`，前端按当前会话过滤。

代价是前端必须小心过滤（漏了就会串台），收益是服务端不需要为每个会话维护一条长连接，重连和新增会话都变成免费操作。

审批 id 全局唯一，`/api/permission` 遍历所有会话找归属 —— 因为可能有两个会话同时在等审批，而 UI 一次只显示一个弹窗。

## 14. Skills：只在需要时付费

`Skill` 的整个价值主张是**上下文经济学**：系统提示里只放 `name + description`（几十个 token），正文在模型主动调用工具时才加载。

如果直接把 SKILL.md 全部塞进系统提示，10 个技能就能吃掉几千 token，而且大部分时候是无关的。这是"上下文即稀缺资源"最直接的一次应用。

## 15. 进程级沙箱：把「信任」变成「验证」

沙箱分三层，缺一层都算不上隔离：

| 层 | 挡的是 | 实现 |
| --- | --- | --- |
| 路径/规则 | Agent 自己写错地方 | `guardPath` + 权限管道 |
| 进程环境 | 子进程把密钥带出去 | `scrubEnv` |
| 操作系统 | 子进程绕过一切约定 | bwrap / sandbox-exec |

中间那层最容易被忽略：模型看不见 `ANTHROPIC_API_KEY`，但一条 `printenv` 就能把它打进转录。所以 `scrubEnv()` 在非 `danger-full-access` 模式下剥掉所有匹配 `API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL` 的变量。这不是理论风险——测试里真的跑了一条 `node -e "console.log(process.env...)"`，断言密钥不出现在工具输出里。

最下面那层是探测式的，不是必须的：

```
linux   → bwrap --ro-bind / / --bind <ws> <ws> --tmpfs /tmp --die-with-parent
macos   → sandbox-exec -p "(deny file-write*) (allow file-write* (subpath <ws>))"
windows → none（诚实报告，不假装有）
```

`detectBackend()` 返回 `kind + note`，`/api/state` 和启动横幅都会显示当前后端。**一个不会说谎的沙箱，比一个看起来很安全的花架子有用**。Windows 上真正的隔离需要 Job Object 或受限令牌，这需要原生模块，明确留在待办里。

## 16. 图片输入的两个适配点

内部只有一种表示：`{ type: "image", mediaType, data }`。分歧全部关在适配器里：

- Anthropic：`{ type: "image", source: { type: "base64", media_type, data } }`
- OpenAI：content 必须是数组，图片走 `{ type: "image_url", image_url: { url: "data:<mime>;base64,..." } }`

两个容易漏的细节：

1. **token 记账**。一张图按 1200 token 估算，否则压缩阈值会被图片静默顶爆，等到 413 才发现。
2. **入口校验**。服务端限制图片数量、单张 base64 大小和 MIME 白名单 —— 前端校验是体验，后端校验才是边界。

## 17. 下一步

按收益/成本排序：

1. **Windows 进程级隔离**：Job Object（内存/进程数/时间上限）或受限令牌，这是「敢让它跑」的最后一块。
2. **图片压缩**：客户端缩放到长边 1568px 再上传，省 token 也省带宽。
3. **多模态错误恢复**：图片过大时的反应式压缩（对应循环里的第 6 个站点）。
4. **Fallback model**：补齐循环的恢复站点。
5. **远程/多用户**：现在是单进程本地服务。

不做的事：把模型调用逻辑塞进工具、把权限判断塞进 UI、在没有测试的情况下改循环。

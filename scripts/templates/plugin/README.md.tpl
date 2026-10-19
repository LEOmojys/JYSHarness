# __NAME__

JYSHarness 项目插件。入口 `index.ts` 导出 `activate(api)`：

| API | 作用 |
| --- | --- |
| `api.registerTool(tool)` | 给模型新增一个工具 |
| `api.addPromptSection(text)` | 往系统提示追加稳定文本 |
| `api.on(event, handler)` | 进程内 hook：PreToolUse / PostToolUse / Stop / UserPromptSubmit / SessionStart |
| `api.addSkill({name, description, content})` | 内存技能 |
| `api.log(msg)` | 输出日志 |

加载：插件目录放在 `<workspace>/.harness/plugins/` 下，启动时自动加载。
校验：`jys plugin test`。

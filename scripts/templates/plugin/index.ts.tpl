/**
 * __NAME__ — JYSHarness 项目插件。
 * 文档：PLUGINS.md
 */

/**
 * @param {object} api
 * @param {(tool: object) => void} api.registerTool
 * @param {(text: string) => void} api.addPromptSection
 * @param {(event: string, handler: Function) => void} api.on
 * @param {(skill: { name: string, description: string, content: string }) => void} api.addSkill
 * @param {(msg: string) => void} api.log
 */
export function activate(api) {
  // 1) 项目约定：进入系统提示，模型每一轮都能看到
  api.addPromptSection(
    [
      "<project_rules>",
      "本项目使用 pnpm；提交前运行 pnpm lint 与 pnpm test。",
      "</project_rules>",
    ].join("\n"),
  );

  // 2) 工具：给模型一个项目专属动作
  api.registerTool({
    name: "__NAME___status",
    description: "汇总当前工作区的文件数与 TODO 标记数。",
    inputSchema: { type: "object", properties: {} },
    isReadOnly: true,
    isConcurrencySafe: () => true,
    async call(_input, ctx) {
      const fs = await import("node:fs/promises");
      const p = await import("node:path");
      let files = 0;
      let todos = 0;
      const walk = async (dir, depth) => {
        if (depth > 4) return;
        for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
          if (entry.name === "node_modules" || entry.name === ".git") continue;
          const abs = p.join(dir, entry.name);
          if (entry.isDirectory()) {
            await walk(abs, depth + 1);
            continue;
          }
          files++;
          try {
            const text = await fs.readFile(abs, "utf8");
            todos += text.split("TODO").length - 1;
          } catch {}
        }
      };
      await walk(ctx.workspaceRoot, 0);
      return { content: "files=" + files + " todos=" + todos };
    },
  });

  // 3) Hook：进程内拦截，不启动 shell
  api.on("PreToolUse", (payload) => {
    const target = String(payload.toolInput?.file_path ?? "");
    if (target.endsWith(".env")) return { decision: "deny", reason: "不要直接改 .env" };
    return;
  });

  // 4) 技能：长流程说明，按需加载
  api.addSkill({
    name: "__NAME__-release",
    description: "本项目发版流程",
    content: "# 发版\n1. 更新版本号\n2. 跑测试\n3. 打 tag",
  });
}

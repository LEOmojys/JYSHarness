/**
 * 插件斜杠命令的执行入口。
 *
 * 为什么单独一个模块：REPL（cli/main.ts）与 HTTP 服务（server/app.ts）都要用它。
 * 之前的写法是 app.ts 里 `await import("../cli/main.ts")` —— 那让**服务端反向依赖 CLI**，
 * 既是循环依赖风险，又会把一个重型模块（bootstrap/serve）拉进请求路径。
 */
import { loadPlugins } from "./loader.ts";
import type { PluginRuntime } from "./types.ts";
import { Logger } from "../util/log.ts";

export interface PluginCommandHit {
  plugin: string;
  output: string;
}

/**
 * 执行插件注册的斜杠命令。
 *
 * 返回 null = 没有插件认领这个命令，调用方继续按"未知命令"处理。
 * 名字既接受 "/board" 也接受 "board"（registerCommand 时两种写法都有人用）。
 */
export async function findPluginCommand(
  workspaceRoot: string,
  name: string,
  arg: string,
  runtimes?: readonly PluginRuntime[],
): Promise<PluginCommandHit | null> {
  const wanted = name.startsWith("/") ? name : "/" + name;
  const active = runtimes ?? (await loadPlugins(workspaceRoot, new Logger("error"))).runtimes;
  for (const runtime of active) {
    for (const cmd of runtime.commands) {
      const alias = cmd.name.startsWith("/") ? cmd.name : "/" + cmd.name;
      if (alias !== wanted) continue;
      const out = await cmd.run(arg, { workspaceRoot });
      return { plugin: runtime.pluginId, output: typeof out === "string" ? out : String(out) };
    }
  }
  return null;
}

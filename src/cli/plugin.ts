/** `jys plugin new|list|test` — scaffold and inspect project plugins. */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { discoverPlugins, loadPlugins } from "../plugins/loader.ts";
import { installPlugin, listInstalled, uninstallPlugin } from "../plugins/manager.ts";
import { Logger, paint } from "../util/log.ts";
import { parseArgs } from "./bootstrap.ts";

const TEMPLATE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "templates", "plugin");

const USAGE = [
  "jys plugin <command>",
  "",
  "  new <name> [--workspace <dir>] [--force]        创建插件脚手架",
  "  install <dir|git-url> [--user] [--force] [--disabled]  安装插件",
  "  uninstall <name> [--user]                       卸载插件",
  "  list [--workspace <dir>] [--json]               列出插件（含来源与权限）",
  "  test [--workspace <dir>]                        加载并校验插件，出错返回非 0",
  "",
  "插件目录：<workspace>/.harness/plugins/<name>/ 或 ~/.jysharness/plugins/<name>/",
].join("\n");

function firstPositional(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--workspace" || a === "--port" || a === "--mode") {
      i++;
      continue;
    }
    if (a.startsWith("-")) continue;
    return a;
  }
  return undefined;
}

/** 插件子命令自己的 flag：parseArgs 不认识它们，必须先摘掉，否则会报 unknown flag。 */
const PLUGIN_FLAGS = ["--json", "--force", "--disabled", "--user"];
const GLOBAL_VALUE_FLAGS = new Set(["--workspace", "--provider", "--model", "--mode", "--sandbox", "--port", "--resume", "--max-turns", "--agent-mode"]);

/**
 * 拆出子命令与插件专有 flag。
 *
 * 两件事必须一起做，否则出错方式很隐蔽：
 *   1. `jys --workspace X plugin install …` 里 argv[0] 是 "--workspace"，不是子命令；
 *   2. `--json` 这类 flag 传给 parseArgs 会报 unknown flag（实测）。
 */
export function splitPluginArgs(argv: string[]): { sub: string; rest: string[]; flags: Set<string> } {
  const flags = new Set<string>();
  const rest: string[] = [];
  let sub = "";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    const isFlag = a.startsWith("-");
    if (isFlag && PLUGIN_FLAGS.indexOf(a) >= 0) {
      flags.add(a);
      continue;
    }
    if (isFlag && GLOBAL_VALUE_FLAGS.has(a)) {
      rest.push(a);
      const nextVal = argv[i + 1];
      if (nextVal !== undefined) {
        rest.push(nextVal);
        i++;
      }
      continue;
    }
    if (!isFlag && !sub) {
      sub = a;
      continue;
    }
    rest.push(a);
  }
  return { sub: sub || "list", rest, flags };
}
export async function runPlugin(argvRaw: string[]): Promise<void> {
  const parsed = splitPluginArgs(argvRaw);
  const sub = parsed.sub;
  const rest = parsed.rest;

  if (sub === "help" || sub === "-h" || sub === "--help") {
    console.log(USAGE);
    return;
  }
  if (sub === "new" || sub === "create") return scaffold(rest);
  if (sub === "install" || sub === "add") return install(rest, parsed.flags);
  if (sub === "uninstall" || sub === "remove" || sub === "rm") return uninstall(rest, parsed.flags);
  if (sub === "list" || sub === "ls") return list(rest, parsed.flags);
  if (sub === "test" || sub === "check") return test(rest);

  console.error(paint.red("未知子命令：" + sub));
  console.log(USAGE);
  process.exitCode = 1;
}

function render(template: string, name: string): string {
  return readFileSync(path.join(TEMPLATE_DIR, template), "utf8").split("__NAME__").join(name);
}

function scaffold(argv: string[]): void {
  const args = parseArgs(argv);
  const name = firstPositional(argv);
  if (!name) {
    console.error(paint.red("用法：jys plugin new <name>"));
    process.exitCode = 1;
    return;
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(name)) {
    console.error(paint.red("插件名只能包含字母、数字、点、下划线、连字符"));
    process.exitCode = 1;
    return;
  }
  if (!existsSync(TEMPLATE_DIR)) {
    console.error(paint.red("缺少脚手架模板：" + TEMPLATE_DIR));
    process.exitCode = 1;
    return;
  }

  const force = argv.includes("--force");
  const dir = path.join(args.workspace, ".harness", "plugins", name);
  if (existsSync(dir) && !force) {
    console.error(paint.red("已存在：" + dir + "（加 --force 覆盖）"));
    process.exitCode = 1;
    return;
  }

  mkdirSync(path.join(dir, "skills", "example"), { recursive: true });
  writeFileSync(path.join(dir, "plugin.json"), render("plugin.json.tpl", name), "utf8");
  writeFileSync(path.join(dir, "index.ts"), render("index.ts.tpl", name), "utf8");
  writeFileSync(path.join(dir, "README.md"), render("README.md.tpl", name), "utf8");
  writeFileSync(path.join(dir, "skills", "example", "SKILL.md"), render("skills/example/SKILL.md.tpl", name), "utf8");

  console.log("");
  console.log(paint.green("已创建插件：") + dir);
  console.log(paint.dim("  plugin.json  清单"));
  console.log(paint.dim("  index.ts     入口（activate(api)）"));
  console.log(paint.dim("  skills/      技能目录"));
  console.log("");
  console.log(paint.dim("下一步：编辑 index.ts，然后运行 jys plugin test 校验。"));
}

async function list(argv: string[], flags: Set<string>): Promise<void> {
  const args = parseArgs(argv);
  const logger = new Logger("warn");
  const discovered = discoverPlugins(args.workspace);
  const result = await loadPlugins(args.workspace, logger);

  // --json：给脚本/CI 用，输出与 /api/plugins 同构的字段
  if (flags.has("--json")) {
    const installed = listInstalled(args.workspace);
    console.log(
      JSON.stringify(
        {
          workspace: args.workspace,
          plugins: installed.map((p) => ({
            ...p,
            errors: result.errors.filter((e) => e.plugin === p.name).map((e) => e.message),
          })),
          errors: result.errors,
          warnings: result.warnings,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log("");
  console.log(paint.bold("工作区：") + args.workspace);
  if (!discovered.length) {
    console.log(paint.dim("  未发现插件。用 jys plugin new <name> 创建第一个，或 jys plugin install <目录|git-url>。"));
    console.log("");
    return;
  }
  for (const err of result.errors) console.log("  " + paint.red("x") + " " + err.plugin + ": " + err.message);
  for (const warn of result.warnings) console.log("  " + paint.yellow("!") + " " + warn.plugin + ": " + warn.message);
  for (const plugin of result.plugins) {
    console.log(
      "  " +
        paint.green("*") +
        " " +
        paint.bold(plugin.name) +
        paint.dim("  v" + plugin.version + "  [" + plugin.source + "]") +
        paint.dim("  tools=" + plugin.tools + " skills=" + plugin.skills + " hooks=" + plugin.hooks),
    );
    console.log(paint.dim("    " + plugin.dir));
    // 来源与能力声明：安装前就能看见"这个插件对外开了什么"
    const meta = listInstalled(args.workspace).find((p) => p.name === plugin.name);
    if (meta) {
      const bits: string[] = [];
      if (meta.installedFrom) bits.push("来源 " + meta.installedFrom);
      if (meta.permissions.length) bits.push("能力 " + meta.permissions.join(","));
      if (meta.panels) bits.push("面板 " + meta.panels);
      if (!meta.enabled) bits.push("已停用");
      if (bits.length) console.log(paint.dim("    " + bits.join(" · ")));
    }
  }
  for (const err of result.errors) console.log("  " + paint.red("x") + " " + err.plugin + "：" + err.message);
  console.log("");
}

async function test(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const logger = new Logger("warn");
  const result = await loadPlugins(args.workspace, logger);

  console.log("");
  if (!result.plugins.length && !result.errors.length) {
    console.log(paint.yellow("没有找到任何插件。"));
    process.exitCode = 1;
    return;
  }
  const names = new Set(result.plugins.map((p) => p.name));
  for (const plugin of result.plugins) {
    console.log(paint.green("OK " + plugin.name) + paint.dim(" v" + plugin.version + "  " + plugin.dir));
    for (const tool of result.tools) {
      if (tool.name.startsWith(plugin.name + "_")) {
        console.log(paint.dim("    tool  " + tool.name + " — " + tool.description.split("\n")[0]));
      }
    }
    for (const skill of result.skills) {
      if (skill.name.startsWith(plugin.name)) console.log(paint.dim("    skill " + skill.name));
    }
  }
  for (const err of result.errors) {
    if (names.has(err.plugin)) continue;
    console.log(paint.red("FAIL " + err.plugin + "：" + err.message));
  }
  console.log("");
  if (result.errors.length) process.exitCode = 1;
}

function install(argv: string[], flags: Set<string>): void {
  const args = parseArgs(argv);
  const src = firstPositional(argv);
  if (!src) {
    console.error(paint.red("用法：jys plugin install <目录|git-url> [--user] [--force] [--disabled]"));
    process.exitCode = 2;
    return;
  }
  const target = flags.has("--user") ? "user" : "project";
  const res = installPlugin(args.workspace, src, {
    target,
    force: flags.has("--force") || args.yes,
    disabled: flags.has("--disabled"),
  });
  if (!res.ok) {
    console.error(paint.red("安装失败：" + (res.error ?? "")));
    process.exitCode = 1;
    return;
  }
  console.log(paint.green("已安装 " + res.name) + "  →  " + res.dir);
  console.log("来源：" + res.source + "（" + (target === "user" ? "用户级，所有项目生效" : "项目级") + "）");
}

function uninstall(argv: string[], flags: Set<string>): void {
  const args = parseArgs(argv);
  const name = firstPositional(argv);
  if (!name) {
    console.error(paint.red("用法：jys plugin uninstall <name> [--user]"));
    process.exitCode = 2;
    return;
  }
  const target = flags.has("--user") ? "user" : "project";
  const res = uninstallPlugin(args.workspace, name, target);
  if (!res.ok) {
    console.error(paint.red("卸载失败：" + (res.error ?? "")));
    process.exitCode = 1;
    return;
  }
  console.log(paint.green("已卸载 " + name));
}


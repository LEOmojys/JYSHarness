/** `jys plugin new|list|test` — scaffold and inspect project plugins. */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { discoverPlugins, loadPlugins } from "../plugins/loader.ts";
import { Logger, paint } from "../util/log.ts";
import { parseArgs } from "./bootstrap.ts";

const TEMPLATE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "templates", "plugin");

const USAGE = [
  "jys plugin <command>",
  "",
  "  new <name> [--workspace <dir>] [--force]   创建插件脚手架",
  "  list [--workspace <dir>]                   列出已发现的插件",
  "  test [--workspace <dir>]                   加载并校验插件，出错返回非 0",
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

export async function runPlugin(argv: string[]): Promise<void> {
  const first = argv[0];
  const hasSub = Boolean(first && !first.startsWith("-"));
  const sub = hasSub ? first : "list";
  const rest = hasSub ? argv.slice(1) : argv;

  if (sub === "help" || sub === "-h" || sub === "--help") {
    console.log(USAGE);
    return;
  }
  if (sub === "new" || sub === "create") return scaffold(rest);
  if (sub === "list" || sub === "ls") return list(rest);
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

async function list(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const logger = new Logger("warn");
  const discovered = discoverPlugins(args.workspace);
  const result = await loadPlugins(args.workspace, logger);

  console.log("");
  console.log(paint.bold("工作区：") + args.workspace);
  if (!discovered.length) {
    console.log(paint.dim("  未发现插件。用 jys plugin new <name> 创建第一个。"));
    console.log("");
    return;
  }
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

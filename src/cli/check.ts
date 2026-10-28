/**
 * jys check —— 把架构约束变成可执行的命令，而不是 README 里的一段建议。
 *
 *   jys check                 只跑硬约束（import 解析 / 分层 / 零依赖 / 文档链接 / 密钥）
 *   jys check --entropy       追加熵检查（大文件 / TODO / 版本漂移）
 *   jys check --json          给 Agent 或 CI 读的结构化输出
 *   jys check --install-hook  写 .git/hooks/pre-commit，提交前自动跑
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installHook, runChecks, type Finding } from "../quality/checks.ts";
import { paint } from "../util/log.ts";

function formatFinding(f: Finding): string {
  const loc = f.file ? f.file + (f.line ? ":" + f.line : "") : "(repo)";
  const mark = f.level === "error" ? paint.red("x") : paint.yellow("!");
  return "  " + mark + " " + paint.dim(loc) + "  " + f.rule + ": " + f.message;
}

export async function runCheck(argv: string[]): Promise<void> {
  const json = argv.includes("--json");
  const entropy = argv.includes("--entropy") || argv.includes("--all");
  // --types：跑 tsc（需要 devDependency；没装就跳过并说明）
  const types = argv.includes("--types") || argv.includes("--all");
  const rootAt = argv.indexOf("--root");
  const root = rootAt >= 0 ? path.resolve(argv[rootAt + 1] ?? ".") : process.cwd();

  if (argv.includes("--install-hook")) {
    const self = fileURLToPath(import.meta.url);
    const cliPath = path.join(path.dirname(self), "main.ts");
    const installed = installHook(root, process.execPath, cliPath);
    if (!installed.ok) {
      console.error(paint.red("安装失败：" + installed.error));
      process.exitCode = 1;
      return;
    }
    console.log(paint.green("已安装 pre-commit 钩子：") + installed.path);
    if (installed.backup) console.log(paint.dim("  原钩子已备份到 " + installed.backup));
    console.log(paint.dim("  提交前会自动执行 jys check --entropy；跳过用 git commit --no-verify"));
    return;
  }

  const report = runChecks({ root, entropy, types });

  if (json) {
    console.log(JSON.stringify({ root, ...report }, null, 2));
    if (report.errors > 0) process.exitCode = 1;
    return;
  }

  const errors = report.findings.filter((f) => f.level === "error");
  const warnings = report.findings.filter((f) => f.level === "warn");

  if (errors.length) {
    console.log(paint.red("约束违规 " + errors.length + " 条"));
    for (const f of errors) console.log(formatFinding(f));
    console.log("");
  }
  if (warnings.length) {
    console.log(paint.yellow("提示 " + warnings.length + " 条"));
    for (const f of warnings) console.log(formatFinding(f));
    console.log("");
  }
  if (!errors.length && !warnings.length) {
    console.log(paint.green("全部通过") + paint.dim("（" + report.filesScanned + " 个文件，无违规）"));
    return;
  }

  const summary =
    (errors.length ? paint.red(errors.length + " error") : paint.green("0 error")) +
    " / " +
    (warnings.length ? paint.yellow(warnings.length + " warn") : "0 warn") +
    paint.dim("  扫描 " + report.filesScanned + " 个文件");
  console.log(summary);
  if (errors.length) process.exitCode = 1;
}

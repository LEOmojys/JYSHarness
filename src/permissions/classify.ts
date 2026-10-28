/**
 * Auto 模式的风险分类器（ch.5.7）。
 *
 * 设计取向：**只放行能证明安全的，剩下的一律问人。**
 * 分类器最容易犯的错是"猜"，而猜错的代价是不可逆的副作用，所以这里：
 *   1. 命令先按 shell 分隔符拆成段，逐段判定，任一段升级则整体升级；
 *   2. 只对白名单里的只读命令放行；写操作、管道进 shell、危险动词一律升级；
 *   3. 无法解析（空命令、怪引号）时默认 ask，绝不默认 allow。
 *
 * 这不是"让 Agent 免审批"，而是"把显然安全的审批去掉"——
 * 把审批额度留给 rm -rf 和 curl | sh。
 */
import path from "node:path";

export type Risk = "safe" | "moderate" | "dangerous";

export interface CommandVerdict {
  risk: Risk;
  /** 命中的规则说明，直接进审批理由。 */
  why: string;
}

/** 只读、幂等、不产生副作用的命令（按可执行名匹配）。 */
const SAFE_COMMANDS = new Set([
  "ls", "dir", "pwd", "cd", "echo", "cat", "type", "head", "tail", "wc", "stat", "file",
  "grep", "rg", "find", "which", "where", "whoami", "date", "env", "printenv", "sort", "uniq",
  "diff", "cmp", "tree", "du", "df", "basename", "dirname", "realpath", "readlink",
  "node", "python", "python3", "deno", "bun",
  "git", "npm", "pnpm", "yarn", "pip", "cargo", "go", "dotnet", "tsc", "eslint", "prettier",
]);

/** 明确危险的动词组合（子串匹配，宁可误报）。 */
const DANGEROUS_PATTERNS: { needle: string; why: string }[] = [
  { needle: "rm -rf /", why: "递归删除根目录" },
  { needle: "rm -rf ~", why: "递归删除家目录" },
  { needle: "format ", why: "格式化磁盘" },
  { needle: "mkfs", why: "创建文件系统" },
  { needle: "dd if=", why: "裸设备写入" },
  { needle: "> /dev/sd", why: "写裸设备" },
  { needle: "shutdown", why: "关机" },
  { needle: "reboot", why: "重启" },
  { needle: "chmod 777 /", why: "放开根目录权限" },
  { needle: "git reset --hard", why: "丢弃未提交改动" },
  { needle: "git clean -fd", why: "删除未跟踪文件" },
  { needle: "git push --force", why: "强推覆盖远端历史" },
  { needle: "git push -f", why: "强推覆盖远端历史" },
  { needle: ":(){", why: "fork 炸弹" },
  { needle: "curl | sh", why: "远程脚本直接执行" },
  { needle: "curl|sh", why: "远程脚本直接执行" },
  { needle: "wget | sh", why: "远程脚本直接执行" },
  { needle: "invoke-expression", why: "动态执行字符串" },
  { needle: "iex(", why: "动态执行字符串" },
  { needle: "remove-item -recurse", why: "递归删除" },
  { needle: "del /s", why: "递归删除" },
  { needle: "rd /s", why: "递归删除" },
  { needle: "reg delete", why: "删除注册表项" },
  { needle: "netsh advfirewall", why: "修改防火墙规则" },
];

/** 需要人工确认的写操作。 */
const MODERATE_PATTERNS: { needle: string; why: string }[] = [
  { needle: "npm install", why: "安装依赖" },
  { needle: "npm i ", why: "安装依赖" },
  { needle: "pip install", why: "安装依赖" },
  { needle: "git commit", why: "生成提交" },
  { needle: "git merge", why: "合并分支" },
  { needle: "git rebase", why: "改写历史" },
  { needle: "git checkout", why: "切换/覆盖工作区" },
  { needle: "git restore", why: "覆盖工作区文件" },
  { needle: "npm publish", why: "发布包" },
  { needle: "docker run", why: "启动容器" },
  { needle: ">", why: "重定向写文件" },
  { needle: ">>", why: "追加写入文件" },
  { needle: "mv ", why: "移动/改名" },
  { needle: "cp ", why: "复制覆盖" },
  { needle: "sed -i", why: "原地修改文件" },
];

const SAFE_GIT_SUBCOMMANDS = new Set([
  "status", "log", "diff", "show", "branch", "rev-parse", "remote", "describe", "blame", "shortlog", "ls-files",
]);

const SAFE_NPM_SUBCOMMANDS = new Set(["test", "run", "--version", "ls", "list", "view", "outdated"]);

function firstToken(segment: string): string {
  const trimmed = segment.trim();
  if (!trimmed) return "";
  const token = trimmed.split(/[\s]+/)[0];
  return path.basename(token.replace(/^["']|["']$/g, "")).toLowerCase();
}

function secondToken(segment: string): string {
  const parts = segment.trim().split(/[\s]+/).filter(Boolean);
  return (parts[1] ?? "").replace(/^["']|["']$/g, "").toLowerCase();
}

/** 顶层运算符拆分：; && || | 换行。 */
function splitOperators(command: string): string[] {
  return command
    .split(/&&|\|\||;|\||\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 抽出 $(...) 的 body（按括号配对，支持嵌套）。 */
function commandSubstitutions(command: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < command.length - 1; i++) {
    if (command[i] !== "$" || command[i + 1] !== "(") continue;
    let depth = 1;
    let j = i + 2;
    for (; j < command.length && depth > 0; j++) {
      if (command[j] === "(") depth++;
      else if (command[j] === ")") depth--;
    }
    if (depth === 0) out.push(command.slice(i + 2, j - 1));
  }
  return out;
}

/** 抽出反引号内容。 */
function backtickSubstitutions(command: string): string[] {
  const out: string[] = [];
  let from = 0;
  while (true) {
    const start = command.indexOf(String.fromCharCode(96), from);
    if (start < 0) break;
    const end = command.indexOf(String.fromCharCode(96), start + 1);
    if (end < 0) break;
    out.push(command.slice(start + 1, end));
    from = end + 1;
  }
  return out;
}

/** 抽出 `bash -c "..."` / `eval "..."` 里的内联脚本。 */
function inlineScripts(command: string): string[] {
  const out: string[] = [];
  const re = /(?:^|[\s;&|])(?:bash|sh|zsh|dash|ksh|pwsh|powershell|cmd|eval)(?:\s+-[^\s]+)*\s+(['"])([\s\S]*?)\1/gi;
  for (const m of command.matchAll(re)) out.push(m[2]);
  return out;
}

/**
 * 把一条 shell 命令拆成"所有可能被求值的子命令"。
 *
 * 只按 && || ; | 拆是不够的：`git status $(rm -rf build)` 顶层只有一段，
 * 允许规则 `Bash(git *)` 会把括号里的命令一起放行 —— 这是真实的提权路径。
 * 所以这里把命令替换、反引号、`bash -c`/`eval` 的内联脚本**递归**抽出来，
 * 让上层"每段都必须匹配"的判定能看到它们。
 *
 * 解析刻意保守：拿不准就多拆一段。多拆只会让判定更严格（多问一次），
 * 少拆才会漏放行 —— 方向上必须偏保守。
 */
export function splitShellSegments(command: string, depth = 0): string[] {
  const units = splitOperators(command);
  if (depth >= 3) return units;
  const nested = [
    ...commandSubstitutions(command),
    ...backtickSubstitutions(command),
    ...inlineScripts(command),
  ];
  for (const body of nested) units.push(...splitShellSegments(body, depth + 1));
  return [...new Set(units)];
}

export function classifyCommand(command: string): CommandVerdict {
  const raw = command.toLowerCase();
  for (const p of DANGEROUS_PATTERNS) {
    if (raw.includes(p.needle)) return { risk: "dangerous", why: "命中危险模式：" + p.why };
  }

  const segments = splitShellSegments(command);
  if (!segments.length) return { risk: "moderate", why: "空命令，无法判断" };

  let worst: CommandVerdict = { risk: "safe", why: "全部为只读命令" };

  for (const segment of segments) {
    const cmd = firstToken(segment);
    const sub = secondToken(segment);

    for (const p of MODERATE_PATTERNS) {
      if (segment.toLowerCase().includes(p.needle)) {
        return { risk: "moderate", why: "需要确认：" + p.why };
      }
    }

    if (!SAFE_COMMANDS.has(cmd)) {
      return { risk: "moderate", why: "未知命令 " + (cmd || "(空)") + "，不自动放行" };
    }

    // git / npm 这类多态命令要看子命令
    if (cmd === "git") {
      const safeSub = SAFE_GIT_SUBCOMMANDS.has(sub) || sub === "";
      if (!safeSub) return { risk: "moderate", why: "git " + sub + " 可能修改仓库" };
      if (sub === "branch" && /\s-[dD]\s/.test(segment)) {
        return { risk: "moderate", why: "git branch 删除分支" };
      }
    }
    if (cmd === "npm" || cmd === "pnpm" || cmd === "yarn") {
      const installLike = sub === "install" || sub === "add" || sub === "i";
      if (installLike) return { risk: "moderate", why: "安装依赖" };
      if (!SAFE_NPM_SUBCOMMANDS.has(sub) && sub !== "") {
        return { risk: "moderate", why: cmd + " " + sub + " 会执行项目脚本" };
      }
    }
    if (cmd === "find" && segment.includes("-delete")) {
      return { risk: "moderate", why: "find -delete 会删文件" };
    }
    if (cmd === "node" || cmd === "python" || cmd === "python3" || cmd === "deno" || cmd === "bun") {
      // 解释器带脚本/参数就可能做任何事；只放行 --version 这类
      if (!/\s(-v|--version|-h|--help)\b/.test(segment) && sub !== "-v" && sub !== "--version") {
        return { risk: "moderate", why: "解释器执行代码，不自动放行" };
      }
    }
    if (segment.includes(">") || segment.includes("<")) {
      return { risk: "moderate", why: "命令包含重定向" };
    }
  }
  return worst;
}

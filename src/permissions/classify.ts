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

export interface ClassifyOptions {
  /**
   * 工作区根。给了之后，"读文件类"命令的绝对路径参数要做包含检查：
   * `cat /etc/passwd` 与 `cat src/app.ts` 都"只读"，但前者读的是工作区外的
   * 系统文件，不能算"能证明安全"。不给则跳过这一步（保持旧的纯语法判定）。
   */
  workspaceRoot?: string;
}

/** 只读、幂等、不产生副作用的命令（按可执行名匹配）。 */
const SAFE_COMMANDS = new Set([
  "ls", "dir", "pwd", "cd", "echo", "cat", "type", "head", "tail", "wc", "stat", "file",
  "grep", "rg", "find", "which", "where", "whoami", "date", "env", "printenv", "sort", "uniq",
  "diff", "cmp", "tree", "du", "df", "basename", "dirname", "realpath", "readlink",
  "node", "python", "python3", "deno", "bun",
  "git", "npm", "pnpm", "yarn", "pip", "cargo", "go", "dotnet", "tsc", "eslint", "prettier",
]);

/**
 * 会"代为执行后面那条命令"的前缀。
 *
 * 为什么必须单独处理：`env rm -rf build` 的第一个 token 是 `env`，`env` 在只读白名单里，
 * 于是整条命令被判成 safe —— 但真正被执行的命令是 `rm -rf build`。
 * 同类还有 sudo/xargs/nice/timeout 等。剥掉前缀后按真实命令判定，才是"能证明安全"。
 */
const COMMAND_WRAPPERS = new Set([
  "env", "sudo", "doas", "nice", "nohup", "time", "command", "builtin", "exec",
  "xargs", "stdbuf", "setsid", "timeout", "ionice", "chrt", "busybox", "runuser",
]);

/** 这些命令的路径参数需要做 workspace 包含检查。 */
const READ_PATH_COMMANDS = new Set([
  "cat", "type", "head", "tail", "wc", "stat", "file", "grep", "rg", "find",
  "tree", "du", "df", "diff", "cmp", "sort", "uniq",
]);

/** 明确危险的动词组合（子串匹配，宁可误报）。 */
const DANGEROUS_PATTERNS: { needle: string; why: string }[] = [
  { needle: "rm -rf /", why: "递归删除根目录" },
  { needle: "rm -rf ~", why: "递归删除家目录" },
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

/** `git remote add|remove|set-url` 会改仓库配置，只有这几种子命令是只读的。 */
const SAFE_GIT_REMOTE_ACTIONS = new Set(["", "-v", "--verbose", "show", "get-url"]);

const SAFE_NPM_SUBCOMMANDS = new Set(["--version", "ls", "list", "view", "outdated", "why", "info"]);

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

/**
 * 顶层运算符拆分：; && || | & 换行。
 *
 * `&` 必须单独处理：`ls & rm -rf build` 的第一个 token 是 `ls`，只按 `;`/`&&` 拆分时
 * 整条命令会被判成"全部为只读命令"，auto 模式于是**自动放行一次删除**。
 * 拆之前先把文件描述符重定向（`2>&1`、`>&2`、`&>file`）里的 `&` 摘掉，
 * 否则那些写法会被拆错（拆错只会更保守，但没必要制造噪音）。
 */
function splitOperators(command: string): string[] {
  return command
    // 只吃"N>&M"这种 fd 复制（后面必须紧跟数字）；`>& file`/`&> file` 是文件重定向，
    // 留给下面的 `>` 检查去判，不能在这里吃掉，否则写文件会被当成无害的 fd 操作。
    .replace(/\d*>&\d+/g, " ")
    .replace(/&>\s*\S+/g, " ")
    .split(/&&|\|\||;|\||\r?\n|&/)
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

/**
 * 剥掉"代为执行"的前缀，返回真正会被执行的命令。
 *
 * 只剥能确定是前缀的情况：`env` 的 `VAR=VAL`、`timeout` 的时长、各命令自己的 `-x` flag。
 * 其余（比如 `nice -n 10 rm x` 里的 `10`）故意不猜 —— 剥不动就保持原样，
 * 后面按"未知命令"升级为 moderate，方向仍然保守。
 */
function stripWrappers(segment: string): string {
  let rest = segment.trim();
  for (let guard = 0; guard < 5; guard++) {
    const parts = rest.split(/\s+/).filter(Boolean);
    const head = path.basename((parts[0] ?? "").replace(/^["']|["']$/g, "")).toLowerCase();
    if (!COMMAND_WRAPPERS.has(head)) return rest;
    let i = 1;
    while (i < parts.length) {
      const part = parts[i] as string;
      if (part.startsWith("-")) { i++; continue; }
      if (head === "env" && /^[A-Za-z_][A-Za-z0-9_]*=/.test(part)) { i++; continue; }
      if (head === "timeout" && /^\d+(\.\d+)?[smhd]?$/.test(part)) { i++; continue; }
      break;
    }
    if (i >= parts.length) return "";
    rest = parts.slice(i).join(" ");
  }
  // 嵌套超过 5 层：不猜，返回空串让上层按原段处理（会更保守）。
  return "";
}

/** `find` 的写/执行动作：`-delete`、`-exec` 之外还有一批，漏一个就等于没拦。 */
function findAction(segment: string): string | null {
  const m = /(?:^|\s)-(delete|exec|execdir|ok|okdir|fprint0?|fprintf|fls)(?:\s|$)/.exec(segment);
  return m ? "-" + m[1] : null;
}

/** 绝对路径参数是否指向工作区外（相对路径不猜，交由调用方的工作目录语义决定）。 */
function outsidePathArg(segment: string, root: string): string | null {
  const rootAbs = path.resolve(root);
  for (const token of segment.split(/\s+/).slice(1)) {
    const raw = token.replace(/^["']|["']$/g, "");
    if (!raw) continue;
    const looksAbsolute = raw.startsWith("/") || raw.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(raw);
    if (!looksAbsolute) continue;
    const rel = path.relative(rootAbs, path.resolve(rootAbs, raw));
    if (rel.startsWith("..") || path.isAbsolute(rel)) return raw;
  }
  return null;
}

export function classifyCommand(command: string, opts: ClassifyOptions = {}): CommandVerdict {
  const raw = command.toLowerCase();
  for (const p of DANGEROUS_PATTERNS) {
    if (raw.includes(p.needle)) return { risk: "dangerous", why: "命中危险模式：" + p.why };
  }
  // Windows 的 `format C:`：不能用 "format " 子串判，否则 `git log --format "%h"` 会被误杀
  if (/\bformat\s+[a-z]:(\s|$)/i.test(command)) return { risk: "dangerous", why: "命中危险模式：格式化磁盘" };

  const segments = splitShellSegments(command);
  if (!segments.length) return { risk: "moderate", why: "空命令，无法判断" };

  for (const rawSegment of segments) {
    // 剥不干净时回退到原段：`xargs` 这类"没有后继命令"的写法会因此被判 moderate。
    const segment = stripWrappers(rawSegment) || rawSegment;
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

    // 读文件类命令：绝对路径必须落在工作区内，否则 `cat /etc/shadow` 也算"只读"
    if (opts.workspaceRoot && READ_PATH_COMMANDS.has(cmd)) {
      const outside = outsidePathArg(segment, opts.workspaceRoot);
      if (outside) return { risk: "moderate", why: "读取工作区外的路径 " + outside };
    }

    // git / npm 这类多态命令要看子命令
    if (cmd === "git") {
      const safeSub = SAFE_GIT_SUBCOMMANDS.has(sub) || sub === "";
      if (!safeSub) return { risk: "moderate", why: "git " + sub + " 可能修改仓库" };
      if (sub === "branch" && /(^|\s)(-[dD]|--delete)(\s|$)/.test(segment)) {
        return { risk: "moderate", why: "git branch 删除分支" };
      }
      if (sub === "remote") {
        const action = segment.trim().split(/\s+/)[2] ?? "";
        if (!SAFE_GIT_REMOTE_ACTIONS.has(action)) {
          return { risk: "moderate", why: "git remote " + action + " 会修改仓库配置" };
        }
      }
    }
    if (cmd === "npm" || cmd === "pnpm" || cmd === "yarn") {
      const installLike = sub === "install" || sub === "add" || sub === "i";
      if (installLike) return { risk: "moderate", why: "安装依赖" };
      // run/test/start/exec 都是"执行 package.json 里的任意脚本"，等于任意代码执行，
      // 不能因为"名字听起来像只读"就放行 —— 脚本里可以是 curl | sh。
      if (["run", "test", "start", "exec", "dlx", "create"].includes(sub)) {
        return { risk: "moderate", why: cmd + " " + sub + " 会执行项目脚本" };
      }
      if (!SAFE_NPM_SUBCOMMANDS.has(sub) && sub !== "") {
        return { risk: "moderate", why: cmd + " " + sub + " 会执行项目脚本" };
      }
    }
    if (cmd === "find") {
      const action = findAction(segment);
      if (action) return { risk: "moderate", why: "find " + action + " 会删改文件或执行命令" };
    }
    if ((cmd === "sort" || cmd === "tree") && /(^|\s)(-o|--output)(\s|=|$)/.test(segment)) {
      return { risk: "moderate", why: cmd + " 会写入输出文件" };
    }
    if (cmd === "uniq") {
      const positional = segment.split(/\s+/).slice(1).filter((t) => t && !t.startsWith("-"));
      if (positional.length >= 2) return { risk: "moderate", why: "uniq 的第二个位置参数是输出文件" };
    }
    if (cmd === "node" || cmd === "python" || cmd === "python3" || cmd === "deno" || cmd === "bun") {
      // 解释器带脚本/参数就可能做任何事；只放行 --version 这类。
      // 边界用 (?=\s|$)：`--version-evil` 不是版本开关。
      if (!/(^|\s)(-v|--version|-h|--help)(?=\s|$)/.test(segment)) {
        return { risk: "moderate", why: "解释器执行代码，不自动放行" };
      }
    }
    if (segment.includes(">") || segment.includes("<")) {
      return { risk: "moderate", why: "命令包含重定向" };
    }
  }
  return { risk: "safe", why: "全部为只读命令" };
}

/**
 * 确定性约束检查器（架构约束 + 熵管理）。
 *
 * 三条设计规则：
 *   1. 只做机械判定：不调模型、不发网络请求，毫秒级，能被 pre-commit 直接调用。
 *   2. 失败要指到 file:line，而不是"你的架构有问题"这种没法行动的话。
 *   3. error = 已经坏了（构建/协议会炸），warn = 正在变坏（需要人判断）。
 *
 * 实现上刻意不用正则字面量：这是一个"零依赖、能被 Agent 读"的检查器，
 * 用 indexOf + startsWith 拼出来，反而让每条规则都能被单独读懂和测试。
 */
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

export type Level = "error" | "warn";

export interface Finding {
  rule: string;
  level: Level;
  message: string;
  file?: string;
  line?: number;
}

export interface CheckOptions {
  root: string;
  /** 额外跑熵检查（大文件 / TODO / 版本漂移）。 */
  entropy?: boolean;
  /** 额外跑 TypeScript 类型检查（需要 devDependency；未安装则跳过并说明）。 */
  types?: boolean;
}

const NL = String.fromCharCode(10);
const CR = String.fromCharCode(13);
const TAB = String.fromCharCode(9);
const BACKTICK = String.fromCharCode(96);

const SKIP_DIRS = new Set(["node_modules", "dist", ".git", ".harness", ".idea"]);

function splitLines(text: string): string[] {
  return text.split(NL).map((l) => (l.endsWith(CR) ? l.slice(0, -1) : l));
}

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const abs = path.join(dir, name);
    let st;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(abs, out);
    else out.push(abs);
  }
  return out;
}

function rel(root: string, abs: string): string {
  return path.relative(root, abs).split(path.sep).join("/");
}

function lineAt(text: string, index: number): number {
  return text.slice(0, index).split(NL).length;
}

/** 手工扫 import 说明符：覆盖 from "x"、import "x"、import("x")。 */
function importsOf(text: string): { spec: string; index: number }[] {
  const out: { spec: string; index: number }[] = [];
  const n = text.length;
  for (let i = 0; i < n; i++) {
    let keyword = 0;
    if (text.startsWith("from", i)) keyword = 4;
    else if (text.startsWith("import", i)) keyword = 6;
    if (!keyword) continue;
    let j = i + keyword;
    while (j < n && (text[j] === " " || text[j] === TAB || text[j] === NL || text[j] === "(")) j++;
    const quote = text[j];
    if (quote !== '"' && quote !== "'") continue;
    const end = text.indexOf(quote, j + 1);
    if (end < 0) continue;
    const spec = text.slice(j + 1, end);
    if (!spec || spec.indexOf(NL) >= 0) continue;
    out.push({ spec, index: i });
  }
  return out;
}

function resolveSpec(fromFile: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const candidate of [base, base + ".ts", base + ".js", path.join(base, "index.ts")]) {
    if (!existsSync(candidate)) continue;
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      /* ignore */
    }
  }
  return null;
}

/**
 * 分层许可表：上层可以依赖下层，反之不行。
 * 价值不在好看：providers 一旦 import 了 tools，就再也没法在没有工具注册表的
 * 场景下复用；core 一旦 import 了 server，单元测试就得先起一个 HTTP 服务。
 */
const LAYER_RULES: { from: RegExp; forbid: RegExp; why: string }[] = [
  { from: new RegExp("^src/(core|context)/"), forbid: new RegExp("^src/(server|cli|desktop)/"), why: "核心逻辑不得依赖入口层" },
  { from: new RegExp("^src/(providers|sandbox|tools|session)/"), forbid: new RegExp("^src/(server|cli|desktop)/"), why: "下层模块不得反向依赖入口层" },
  { from: new RegExp("^src/providers/"), forbid: new RegExp("^src/(tools|server|cli)/"), why: "协议适配层必须与工具层解耦" },
  { from: new RegExp("^src/(sandbox|permissions)/"), forbid: new RegExp("^src/(tools|server|cli)/"), why: "安全原语不得依赖被它约束的对象" },
];

function checkImports(root: string, sources: string[]): Finding[] {
  const findings: Finding[] = [];
  for (const abs of sources) {
    const relPath = rel(root, abs);
    let text: string;
    try {
      text = readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    for (const imp of importsOf(text)) {
      if (!imp.spec.startsWith(".")) continue;
      const target = resolveSpec(abs, imp.spec);
      if (!target) {
        findings.push({
          rule: "imports.resolve",
          level: "error",
          message: "import 指向不存在的文件: " + imp.spec,
          file: relPath,
          line: lineAt(text, imp.index),
        });
        continue;
      }
      const targetRel = rel(root, target);
      for (const rule of LAYER_RULES) {
        if (rule.from.test(relPath) && rule.forbid.test(targetRel)) {
          findings.push({
            rule: "layering",
            level: "error",
            message: rule.why + "（" + relPath + " -> " + targetRel + "）",
            file: relPath,
            line: lineAt(text, imp.index),
          });
        }
      }
    }
  }
  return findings;
}

function checkZeroDeps(root: string): Finding[] {
  const pkgPath = path.join(root, "package.json");
  if (!existsSync(pkgPath)) return [];
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const out: Finding[] = [];
    const deps = Object.keys(pkg.dependencies ?? {});
    if (deps.length) {
      out.push({ rule: "deps.zero", level: "error", message: "运行时依赖必须为空，发现: " + deps.join(", "), file: "package.json" });
    }
    // 已知且刻意引入的开发依赖：类型检查用的工具链。
    // 白名单不是"放过依赖"，而是让"新冒出来的开发依赖"仍然会响 —— 永久常亮的
    // 警告等于没有警告。
    const ALLOWED_DEV = new Set(["typescript", "@types/node"]);
    const dev = Object.keys(pkg.devDependencies ?? {}).filter((name) => !ALLOWED_DEV.has(name));
    if (dev.length) {
      // 开发依赖和运行时分清楚：**发布包**里不含 node_modules，所以"零依赖安装"
      // 这个卖点仍然成立；真正要守的是 dependencies 必须为空（上面那条 error）。
      // 这条 warn 只是提醒：仓库里多了 `npm install` 这一步。
      out.push({
        rule: "deps.zero",
        level: "warn",
        message: "有开发依赖: " + dev.join(", ") + "（仅开发期，不影响打包产物与运行）",
        file: "package.json",
      });
    }
    return out;
  } catch (err) {
    return [
      {
        rule: "deps.zero",
        level: "error",
        message: "package.json 解析失败: " + (err instanceof Error ? err.message : String(err)),
        file: "package.json",
      },
    ];
  }
}

const DOCS = ["README.md", "ARCHITECTURE.md", "QUICKSTART.md", "DESKTOP.md", "PLUGINS.md"];
const FENCE = BACKTICK + BACKTICK + BACKTICK;

/** 抽出一行里的 markdown 链接目标（![x](y) 与 [x](y) 都算）。 */
function linkTargets(line: string): string[] {
  const out: string[] = [];
  let from = 0;
  while (from < line.length) {
    const open = line.indexOf("](", from);
    if (open < 0) break;
    const start = open + 2;
    const end = line.indexOf(")", start);
    if (end < 0) break;
    out.push(line.slice(start, end).trim());
    from = end + 1;
  }
  return out;
}

/** 文档里的相对链接必须真的存在 —— "文档与代码漂移"最便宜的一道闸。 */
function checkDocLinks(root: string): Finding[] {
  const findings: Finding[] = [];
  for (const doc of DOCS) {
    const abs = path.join(root, doc);
    if (!existsSync(abs)) continue;
    const lines = splitLines(readFileSync(abs, "utf8"));
    let inFence = false;
    lines.forEach((line, i) => {
      const trimmed = line.trim();
      if (trimmed.startsWith(FENCE) || trimmed.startsWith("~~~")) {
        inFence = !inFence;
        return;
      }
      if (inFence) return;
      for (const target of linkTargets(line)) {
        if (!target) continue;
        if (target.startsWith("http:") || target.startsWith("https:") || target.startsWith("mailto:") || target.startsWith("#")) continue;
        const clean = target.split("#")[0];
        if (!clean) continue;
        let decoded = clean;
        try {
          decoded = decodeURIComponent(clean);
        } catch {
          /* 保留原样 */
        }
        if (!existsSync(path.resolve(root, decoded))) {
          findings.push({ rule: "docs.links", level: "error", message: "文档引用了不存在的文件: " + decoded, file: doc, line: i + 1 });
        }
      }
    });
  }
  return findings;
}

const SECRET_PATTERNS: { re: RegExp; what: string }[] = [
  { re: new RegExp("sk-ant-[A-Za-z0-9_-]{20,}"), what: "Anthropic key" },
  { re: new RegExp("sk-[A-Za-z0-9]{32,}"), what: "API key" },
  { re: new RegExp("AKIA[0-9A-Z]{16}"), what: "AWS access key" },
  { re: new RegExp("-----BEGIN [A-Z ]*PRIVATE KEY-----"), what: "私钥" },
];

function checkSecrets(root: string, files: string[]): Finding[] {
  const findings: Finding[] = [];
  for (const abs of files) {
    const relPath = rel(root, abs);
    if (relPath.startsWith("tests/")) continue;
    if (relPath.endsWith("package-lock.json")) continue;
    if (!/^[A-Za-z0-9_./-]+$/.test(relPath)) continue;
    const dot = relPath.lastIndexOf(".");
    const ext = dot < 0 ? "" : relPath.slice(dot + 1);
    if (!["ts", "js", "mjs", "json", "md", "ps1", "sh", "cmd", "txt", "cs"].includes(ext)) continue;
    let text: string;
    try {
      text = readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    for (const pat of SECRET_PATTERNS) {
      const m = pat.re.exec(text);
      if (m) {
        findings.push({
          rule: "secrets",
          level: "error",
          message: "疑似硬编码 " + pat.what + ": " + m[0].slice(0, 10) + "...",
          file: relPath,
          line: lineAt(text, m.index),
        });
      }
    }
  }
  return findings;
}

/**
 * 只数"注释开头就是标记"的 TODO/FIXME。
 *
 * 为什么不用整词匹配：文档里正常描述这条规则也会被算成待办（本文件自己就
 * 命中过两次）。标记的惯例是紧跟在注释起始符后面，而不是出现在句子中间，
 * 所以大文件、待办标记、版本漂移这类散文不会被误报。
 */
function todoCount(text: string): number {
  const tokens = ["TODO", "FIXME", "XXX"];
  let count = 0;
  for (const line of splitLines(text)) {
    const candidates = [line.indexOf("//"), line.indexOf("#")];
    if (line.trimStart().startsWith("*")) candidates.push(0);
    let cut = -1;
    for (const c of candidates) if (c >= 0 && (cut < 0 || c < cut)) cut = c;
    if (cut < 0) continue;
    let tail = line.slice(cut);
    let i = 0;
    while (i < tail.length) {
      const ch = tail[i];
      if (ch === "/" || ch === "*" || ch === "!" || ch === "#" || ch === " " || ch === TAB) i++;
      else break;
    }
    tail = tail.slice(i);
    for (const token of tokens) if (tail.startsWith(token)) count++;
  }
  return count;
}

function countToken(text: string, token: string): number {
  let count = 0;
  let from = 0;
  while (true) {
    const at = text.indexOf(token, from);
    if (at < 0) break;
    count++;
    from = at + token.length;
  }
  return count;
}

/**
 * 体量预算按"这个文件是干什么的"分类，而不是一刀切。
 *
 * 逻辑模块超过 900 行基本就是"塞了太多职责"，该拆；
 * 而单页 UI 控制器（事件绑定 + 渲染 + 状态镜像）天然会到 1500 行上下，
 * 用同一个阈值只会制造噪音 —— 噪音多了规则就会被无视。
 */
function sizeBudgetFor(relPath: string): number {
  if (relPath.startsWith("src/core/") || relPath.startsWith("src/tools/") || relPath.startsWith("src/providers/") || relPath.startsWith("src/context/")) {
    return 900;
  }
  if (relPath.startsWith("src/server/ui/")) return 1600;
  return 1200;
}

/** 熵：文件在变胖、TODO 在堆积、产物版本在漂移 —— 都还没坏，但在变坏。 */
function checkEntropy(root: string, files: string[], sources: string[]): Finding[] {
  const findings: Finding[] = [];
  for (const abs of files) {
    const relPath = rel(root, abs);
    const dot = relPath.lastIndexOf(".");
    const ext = dot < 0 ? "" : relPath.slice(dot + 1);
    if (ext !== "ts" && ext !== "js") continue;
    if (relPath.startsWith("tests/")) continue;
    const lines = splitLines(readFileSync(abs, "utf8")).length;
    const budget = sizeBudgetFor(relPath);
    if (lines > budget) {
      findings.push({
        rule: "entropy.size",
        level: "warn",
        message: "文件已 " + lines + " 行（本类上限 " + budget + "），考虑拆分",
        file: relPath,
      });
    }
  }
  // 干净的时候不输出任何信息：警告位只留给"确实有问题"的东西。
  for (const abs of sources) {
    const count = todoCount(readFileSync(abs, "utf8"));
    if (count) {
      findings.push({ rule: "entropy.todo", level: "warn", message: "遗留 " + count + " 处 TODO/FIXME", file: rel(root, abs) });
    }
  }
  return findings;
}

function checkVersionDrift(root: string): Finding[] {
  const pkg = path.join(root, "package.json");
  const stamp = path.join(root, "dist", "JYSHarness", "VERSION.txt");
  if (!existsSync(pkg) || !existsSync(stamp)) return [];
  try {
    const version = (JSON.parse(readFileSync(pkg, "utf8")) as { version?: string }).version ?? "";
    const first = splitLines(readFileSync(stamp, "utf8"))[0] ?? "";
    if (version && first.indexOf(version) < 0) {
      return [
        {
          rule: "entropy.version",
          level: "warn",
          message: "打包产物版本是 " + first + "，package.json 是 " + version + "（重新打包即可）",
          file: "dist/JYSHarness/VERSION.txt",
        },
      ];
    }
  } catch {
    /* 产物损坏由打包脚本负责报警 */
  }
  return [];
}

/** 从 "**61 个测试**" 这类声明里取出数字（不用正则，避免转义坑）。 */
function claimedTestCount(text: string): number | null {
  const at = text.indexOf("个测试");
  if (at < 0) return null;
  let i = at - 1;
  while (i >= 0 && (text[i] === " " || text[i] === "*" || text[i] === "*")) i--;
  const end = i;
  while (i >= 0 && text[i] >= "0" && text[i] <= "9") i--;
  const digits = text.slice(i + 1, end + 1);
  if (!digits) return null;
  const n = Number(digits);
  return Number.isFinite(n) ? n : null;
}

function countTests(root: string): number {
  const dir = path.join(root, "tests");
  if (!existsSync(dir)) return 0;
  let total = 0;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".test.ts")) continue;
    for (const line of splitLines(readFileSync(path.join(dir, name), "utf8"))) {
      if (line.startsWith("test(")) total++;
    }
  }
  return total;
}

/**
 * README 里声明的用例数必须等于真实用例数。
 * 这是最容易腐烂的一类文档：代码天天加，数字没人改，读者看到的是幻象。
 */
function checkTestCountDrift(root: string): Finding[] {
  const readme = path.join(root, "README.md");
  if (!existsSync(readme)) return [];
  const claimed = claimedTestCount(readFileSync(readme, "utf8"));
  if (claimed === null) return [];
  const actual = countTests(root);
  // 发行包里不带 tests/：那里的 README 数字描述的是源码仓库，不是这份拷贝。
  if (actual === 0) return [];
  if (claimed === actual) return [];
  return [
    {
      rule: "entropy.testCount",
      level: "warn",
      message: "README 声明 " + claimed + " 个测试，实际 " + actual + " 个",
      file: "README.md",
    },
  ];
}

export interface CheckReport {
  findings: Finding[];
  errors: number;
  warnings: number;
  filesScanned: number;
}


/**
 * 死导出：只在定义处出现一次的 export。
 *
 * 为什么值得一条规则：删掉的这 11 个函数每一个都"看起来像公共 API"，
 * 于是没人敢删、也没人用；半年后它们就变成"读代码必须先排除的噪声"。
 * 这里只在**全仓库**（src + tests + scripts）都找不到第二处引用时才报 warn，
 * 因为 warn 的定位是"需要人判断"，而删不删确实需要判断。
 */
function checkDeadExports(root: string, sources: string[], all: string[]): Finding[] {
  const findings: Finding[] = [];
  const corpus = all
    .filter((f) => /\.(ts|js|mjs|cjs)$/.test(f) && !rel(root, f).startsWith("dist/"))
    .map((f) => readFileSync(f, "utf8"))
    .join(NL);

  for (const file of sources) {
    const body = readFileSync(file, "utf8");
    const lines = body.split(NL);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // 只认 "export function/class/const/interface/type Name"
      const idx = line.indexOf("export ");
      if (idx !== 0) continue;
      const rest = line.slice(7);
      const keyword = ["function ", "async function ", "class ", "const ", "interface ", "type "].find((k) =>
        rest.startsWith(k),
      );
      if (!keyword) continue;
      const nameMatch = rest.slice(keyword.length).match(/^[A-Za-z_$][A-Za-z0-9_$]*/);
      if (!nameMatch) continue;
      const name = nameMatch[0];
      if (name.length < 4) continue;
      // 出现次数：定义本身算一次
      let count = 0;
      let from = 0;
      for (;;) {
        const at = corpus.indexOf(name, from);
        if (at < 0) break;
        const before = at === 0 ? "" : corpus[at - 1];
        const after = corpus[at + name.length] ?? "";
        if (!/[A-Za-z0-9_$]/.test(before) && !/[A-Za-z0-9_$]/.test(after)) count++;
        from = at + name.length;
      }
      if (count <= 1) {
        findings.push({
          rule: "dead-export",
          level: "warn",
          message: name + " 导出后没有任何引用（考虑删除或补测试）",
          file: rel(root, file),
          line: i + 1,
        });
      }
    }
  }
  return findings;
}

/**
 * TypeScript 类型检查（可选步骤）。
 *
 * 为什么放在 check 里：源码由 Node **直接剥离类型**运行，标注本身没人验证。
 * 第一次跑 tsc 时炸出 25 个错误，其中 5 个是真 bug（/compact 引用未定义变量、
 * readonly 字段被整体赋值、re-export 没把名字带进作用域……）。把类型检查接到
 * 同一个入口，结构和类型一次跑完，才不会有人忘了跑。
 *
 * 没装 typescript 时**跳过并说明**：便携安装（双击即用）不该被开发依赖卡住。
 */
function checkTypes(root: string): Finding[] {
  const local = process.platform === "win32" ? "node_modules/.bin/tsc.cmd" : "node_modules/.bin/tsc";
  const tscPath = path.join(root, local);
  if (!existsSync(path.join(root, "tsconfig.json"))) {
    return [{ rule: "types", level: "warn", message: "没有 tsconfig.json，跳过类型检查" }];
  }
  let out = "";
  try {
    out = execFileSync(tscPath, ["-p", "tsconfig.json", "--noEmit", "--pretty", "false"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 180_000,
    });
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: string };
    if (e.code === "ENOENT") {
      return [
        {
          rule: "types",
          level: "warn",
          message: "未安装 typescript（npm install），跳过类型检查 —— 源码的类型标注无人验证",
        },
      ];
    }
    out = String(e.stdout ?? "") + String(e.stderr ?? "");
  }
  if (!out.trim()) return [];

  const findings: Finding[] = [];
  for (const line of splitLines(out)) {
    const idx = line.indexOf("error TS");
    if (idx < 0) continue;
    const head = line.slice(0, idx).trim();
    const message = line.slice(idx + "error ".length).trim();
    const m = head.match(/^(.*?)\((\d+),(\d+)\):\s*$/);
    findings.push({
      rule: "types",
      level: "error",
      message,
      file: m ? m[1].split("\\").join("/") : undefined,
      line: m ? Number(m[2]) : undefined,
    });
    if (findings.length > 40) {
      findings.push({ rule: "types", level: "error", message: "类型错误超过 40 条，已截断" });
      break;
    }
  }
  return findings;
}
export function runChecks(opts: CheckOptions): CheckReport {
  const root = path.resolve(opts.root);
  const all = walk(root);
  const sources = all.filter((f) => rel(root, f).startsWith("src/") && (f.endsWith(".ts") || f.endsWith(".js")));

  const findings: Finding[] = [
    ...checkImports(root, sources),
    ...checkZeroDeps(root),
    ...checkDocLinks(root),
    ...checkSecrets(root, all),
    ...(opts.entropy ? [...checkEntropy(root, all, sources), ...checkVersionDrift(root), ...checkTestCountDrift(root)] : []),
    ...(opts.entropy ? checkDeadExports(root, sources, all) : []),
    ...(opts.types ? checkTypes(root) : []),
  ];

  findings.sort((a, b) => {
    if (a.level !== b.level) return a.level === "error" ? -1 : 1;
    const byFile = (a.file ?? "").localeCompare(b.file ?? "");
    return byFile !== 0 ? byFile : (a.line ?? 0) - (b.line ?? 0);
  });

  return {
    findings,
    errors: findings.filter((f) => f.level === "error").length,
    warnings: findings.filter((f) => f.level === "warn").length,
    filesScanned: all.length,
  };
}

/** 安装 pre-commit 钩子：让约束在提交前生效，而不是在 CI 里事后报警。 */
export function installHook(
  root: string,
  nodePath: string,
  cliPath: string,
): { ok: true; path: string; backup?: string } | { ok: false; error: string } {
  const gitDir = path.join(root, ".git");
  if (!existsSync(gitDir)) return { ok: false, error: "不是 git 仓库：" + gitDir };
  const hooksDir = path.join(gitDir, "hooks");
  const file = path.join(hooksDir, "pre-commit");
  const marker = "#!/bin/sh" + NL + "# installed by: jys check";
  let backup: string | undefined;

  if (existsSync(file)) {
    const current = readFileSync(file, "utf8");
    if (!current.startsWith(marker)) {
      backup = file + ".jys-backup";
      if (!existsSync(backup)) copyFileSync(file, backup);
    }
  }

  const body = marker + " --install-hook" + NL + 'exec "' + nodePath + '" "' + cliPath + '" check --entropy' + NL;
  try {
    mkdirSync(hooksDir, { recursive: true });
    writeFileSync(file, body, "utf8");
    chmodSync(file, 0o755);
    return { ok: true, path: file, backup };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

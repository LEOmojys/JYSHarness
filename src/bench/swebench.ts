/**
 * SWE-bench Verified 适配器（无 Docker 版）。
 *
 * 官方 harness 靠 Docker 镜像保证"每个实例的 Python 版本与依赖"完全一致；这台机器没有 Docker，
 * 所以这里用**本地 venv + shallow clone** 复现同一流程：
 *
 *   1. shallow fetch 到 base_commit（只取那一个提交，避免拉全历史）；
 *   2. 建 venv、pip install -e .（依赖走 pypi 直连，实测可达）；
 *   3. 让被测 harness 在仓库里干活，取 `git diff` 作为它的 patch；
 *   4. 还原测试文件 → 应用官方 test_patch → 跑 FAIL_TO_PASS + PASS_TO_PASS；
 *   5. 全部 F2P 通过且 P2P 不回归 = resolved。
 *
 * **能力边界（写在代码里，避免误读结果）**：
 *   - 只支持 pytest 型实例（F2P 是 `path::test` 形式）；django 的 `runtests.py` 不在内；
 *   - 仅运行有环境规格且本机具备对应 Python 解释器的实例；
 *   - 打分与官方一致（同样的 test_patch、同样的 F2P/P2P 集合），但**环境不完全一致**，
 *     所以数字不能直接与官方榜单并列，只能同条件横向对比。
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { specFor } from "./sweSpecs.ts";
export { prepareRepo, resetToBase, extractPatch } from "./sweRepo.ts";

export interface SweInstance {
  instance_id: string;
  repo: string;
  base_commit: string;
  version: string;
  problem_statement: string;
  test_patch: string;
  FAIL_TO_PASS: string[];
  PASS_TO_PASS: string[];
  environment_setup_commit?: string;
}

export function loadDataset(file: string): SweInstance[] {
  const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>[];
  return raw.map((r) => ({
    instance_id: String(r.instance_id),
    repo: String(r.repo),
    base_commit: String(r.base_commit),
    version: String(r.version),
    problem_statement: String(r.problem_statement ?? ""),
    test_patch: String(r.test_patch ?? ""),
    FAIL_TO_PASS: JSON.parse(String(r.FAIL_TO_PASS ?? "[]")) as string[],
    PASS_TO_PASS: JSON.parse(String(r.PASS_TO_PASS ?? "[]")) as string[],
    environment_setup_commit: r.environment_setup_commit ? String(r.environment_setup_commit) : undefined,
  }));
}

/** 只保留 pytest 型（标签形如 a/b.py::test_x），并按测试规模升序 —— 小任务先跑通链路。 */
export function selectInstances(
  all: SweInstance[],
  opts: { repos?: string[]; versions?: string[]; limit?: number } = {},
): SweInstance[] {
  const pytestLike = all.filter((i) => specFor(i.repo, i.version) && i.FAIL_TO_PASS.length > 0 &&
    [...i.FAIL_TO_PASS, ...i.PASS_TO_PASS].every((t) => t.includes("::")));
  const byRepo = opts.repos?.length ? pytestLike.filter((i) => opts.repos!.includes(i.repo)) : pytestLike;
  const byVersion = opts.versions?.length
    ? byRepo.filter((i) => opts.versions!.some((v) => i.version.startsWith(v)))
    : byRepo;
  const sorted = [...byVersion].sort(
    (x, y) => x.FAIL_TO_PASS.length + x.PASS_TO_PASS.length - (y.FAIL_TO_PASS.length + y.PASS_TO_PASS.length),
  );
  return sorted.slice(0, opts.limit);
}

const run = (cmd: string, args: string[], cwd: string, timeout = 600_000) =>
  spawnSync(cmd, args, { cwd, encoding: "utf8", timeout, maxBuffer: 64 * 1024 * 1024 });

const venvPython = (dir: string) =>
  process.platform === "win32" ? path.join(dir, ".venv", "Scripts", "python.exe") : path.join(dir, ".venv", "bin", "python");

/** 2) 建 venv 并安装仓库（+ pytest）。这一步是 SWE-bench 里最慢的部分。 */
export function installRepo(dir: string, extra: string[] = [], interpreter = "python"): { ok: boolean; detail: string } {
  const py = venvPython(dir);
  if (!existsSync(py)) {
    // 用指定解释器建 venv：SWE-bench 的实例与 Python 版本强绑定（flask 2.3 的测试在 3.12 上
    // 会因为 ast.Str 弃用告警 + filterwarnings=error 直接 ERROR），必须能切版本。
    const mk = run(interpreter, ["-m", "venv", ".venv"], dir, 300_000);
    if (mk.status !== 0) return { ok: false, detail: "venv 失败: " + String(mk.stderr).slice(-200) };
  }
  const base = ["-m", "pip", "install", "-q", "--disable-pip-version-check", "-e", ".", ...extra];
  const install = run(py, base, dir, 900_000);
  if (install.status !== 0) return { ok: false, detail: "pip install -e . 失败: " + String(install.stderr).slice(-300) };

  // 测试依赖必须按**仓库自己的锁文件**装：直接装最新 pytest 会让老仓库的 conftest 崩掉
  // （实测 flask 2.3 的 conftest 用了 monkeypatch.notset，pytest 9 已移除该属性 → 所有用例 ERROR）
  const candidates = [
    "requirements/tests.txt",
    "requirements/test.txt",
    "requirements_test.txt", // pylint 用这个名字
    "requirements/dev.txt",
    "requirements/tests.in",
  ];
  for (const rel of candidates) {
    if (!existsSync(path.join(dir, rel))) continue;
    const r = run(py, ["-m", "pip", "install", "-q", "--disable-pip-version-check", "-r", rel], dir, 900_000);
    if (r.status === 0) return { ok: true, detail: "installed (+" + rel + ")" };
  }
  const fallback = run(py, ["-m", "pip", "install", "-q", "--disable-pip-version-check", "pytest"], dir, 600_000);
  return { ok: fallback.status === 0, detail: fallback.status === 0 ? "installed (bare pytest)" : String(fallback.stderr).slice(-200) };
}

/** 5) 应用一个 patch 文件（模型 patch 或官方 test_patch）。 */
export function applyPatchFile(dir: string, patch: string, name: string): { ok: boolean; detail: string } {
  if (!patch.trim()) return { ok: true, detail: "empty patch" };
  const r = spawnSync("git", ["apply", "--whitespace=nowarn", "-"], {
    cwd: dir, encoding: "utf8", input: patch, timeout: 180_000,
  });
  return { ok: r.status === 0, detail: r.status === 0 ? "applied " + name : name + ": " + (r.error?.message ?? r.stderr).slice(-300) };
}

/** 5) 跑测试：解析每个 node id 的结果。 */
export function runTests(dir: string, ids: string[]) {
  const py = venvPython(dir);
  // 与官方 test_cmd 一致：pytest --no-header -rA --tb=no -p no:cacheprovider
  // -rA 会输出 "PASSED path::test" / "FAILED path::test" 的简短摘要，解析靠它
  const r = run(py, ["-m", "pytest", "--no-header", "--color=no", "-rA", "--tb=no", "-p", "no:cacheprovider", ...ids], dir, 900_000);
  const raw = [r.stdout, r.stderr, r.error?.message].filter(Boolean).join("\n");
  return parseTestRun(raw, r.error ? null : r.status);
}

export function parseTestRun(raw: string, status: number | null) {
  const passed = new Set<string>();
  const failed = new Set<string>();
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    // pytest -rA 的短摘要格式是 "<STATUS> path::test"（状态在前）。
    // 之前只写了 "FAILED path::test"，没有 "PASSED path::test"，结果 gold patch 也被判成 0/1
    // —— 这个 bug 是靠"先让 gold patch 必须通过"这条自检抓出来的。
    const short = /^(PASSED|FAILED|ERROR)\s+(.+::.+)$/.exec(t);
    if (short) {
      if (short[1] === "PASSED") passed.add(short[2]);
      else failed.add(short[2].split(" - ")[0]);
    }
    // 兼容 "path::test PASSED" 这种（-v 输出）顺序
    const long = /^(.+::.+?)\s+(PASSED|FAILED|ERROR)(?:\s+\[\s*\d+%\])?$/.exec(t);
    if (long) (long[2] === "PASSED" ? passed : failed).add(long[1]);
  }
  return { passed, failed, raw, status };
}

export interface SweResult {
  instance_id: string;
  /** 实际使用的解释器 */
  python?: string;
  repo: string;
  version: string;
  resolved: boolean;
  f2pPassed: number;
  f2pTotal: number;
  p2pFailed: number;
  patchLines: number;
  ms: number;
  stage: "prepare" | "install" | "agent" | "test" | "done";
  detail: string;
}

/** 判分：F2P 全过 + P2P 不回归 = resolved（与官方口径一致）。 */
export function grade(dir: string, inst: SweInstance, f2p = inst.FAIL_TO_PASS, p2p = inst.PASS_TO_PASS) {
  if (f2p.length === 0) return scoreTests(f2p, p2p, parseTestRun("", null));
  const res = runTests(dir, [...f2p, ...p2p]);
  return scoreTests(f2p, p2p, res);
}

export function scoreTests(f2p: string[], p2p: string[], res: ReturnType<typeof parseTestRun>) {
  const passed = (id: string) => res.passed.has(id) && !res.failed.has(id);
  const f2pPassed = f2p.filter(passed).length;
  const p2pFailed = p2p.length - p2p.filter(passed).length;
  const resolved = res.status === 0 && f2p.length > 0 && f2pPassed === f2p.length && p2pFailed === 0;
  const detail = "F2P " + f2pPassed + "/" + f2p.length + " P2P 未通过 " + p2pFailed +
    (res.status === 0 ? "" : " | pytest " + (res.status === null ? "运行异常" : "exit " + res.status));
  return { resolved, detail, f2pPassed, p2pFailed };
}

export { run, venvPython };

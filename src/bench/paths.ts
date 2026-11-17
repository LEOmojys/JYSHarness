/**
 * 基准资产的路径约定：**一律落在仓库所在的盘，不碰 C 盘**。
 *
 * 原因很实际：这台机器 C 盘只剩 30 多 G，而基准资产不小 ——
 * 数据集 8MB、每个 Python 解释器 160MB+、每条 SWE-bench 实例的 clone+venv 数百 MB。
 * 之前把它们放在 C:/Users/Public 下，直接吃掉了 C 盘 350MB。
 *
 * 目录结构（均可用 HARNESS_BENCH_ROOT 覆盖）：
 *   bench/datasets/   数据集 JSON
 *   bench/tools/      Python 解释器（py39 / py311 …）
 *   bench/swe-work/   SWE-bench 实例工作区（clone + venv）
 *   bench/tmp/        临时工作区（原来是 os.tmpdir()，也在 C 盘）
 */
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/** 仓库根目录（src/bench 往上两级）。 */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** 基准资产根目录：默认 <repo>/bench，可用 HARNESS_BENCH_ROOT 指到外置盘。 */
export function benchRoot(): string {
  const override = (process.env.HARNESS_BENCH_ROOT ?? "").trim();
  return override ? path.resolve(override) : path.join(REPO_ROOT, "bench");
}

export function benchPath(...parts: string[]): string {
  const p = path.join(benchRoot(), ...parts);
  mkdirSync(p, { recursive: true });
  return p;
}

export const datasetDir = () => benchPath("datasets");
export const workDir = () => benchPath("swe-work");
export const tmpDir = () => benchPath("tmp");

/**
 * 找到某个 Python 版本的解释器。
 *
 * 顺序：<bench>/tools/py<ver> → HARNESS_PY<ver> → PATH 里的 python<ver>。
 * **不再回退到 C 盘硬编码路径**（上一版把环境建在 C:/Users/Public，是这次要修的问题）。
 */
export function interpreterFor(version: string): string | null {
  const tag = version.replace(/\./g, "");
  const win = path.join(benchRoot(), "tools", "py" + tag, "python.exe");
  if (existsSync(win)) return win;
  const nix = path.join(benchRoot(), "tools", "py" + tag, "bin", "python");
  if (existsSync(nix)) return nix;
  const fromEnv = (process.env["HARNESS_PY" + tag] ?? "").trim();
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const probe = spawnSync("python" + version, ["--version"], { encoding: "utf8", timeout: 10_000 });
  if (probe.status === 0) return "python" + version;
  return null;
}

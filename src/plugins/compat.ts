/**
 * 插件兼容性与依赖校验。
 *
 * 为什么需要：装了不兼容的插件，表现是"加载了但行为怪"，而不是明确报错。
 * 这里在加载前把三件事查清楚：
 *   1. `engines.harness` 是否匹配本平台版本（不匹配直接拒绝并说明）；
 *   2. 插件声明的 `dependencies`（其它插件 + 版本范围）是否满足；
 *   3. 声明了 `contributes.permissions` 才能用对应能力（路由/面板）。
 */
import { readFileSync } from "node:fs";
import path from "node:path";

/** 本平台版本（读 package.json，避免两处手写不一致）。 */
export function harnessVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as { version?: string };
    if (pkg.version) return pkg.version;
  } catch {
    /* 读不到就走下面的兜底 */
  }
  return "0.0.0";
}

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
}

export function parseVersion(v: string): ParsedVersion | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v.trim().replace(/^v/, ""));
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

const cmp = (a: ParsedVersion, b: ParsedVersion): number =>
  a.major - b.major || a.minor - b.minor || a.patch - b.patch;

/**
 * 极简 semver 范围判断：支持 `>=x.y.z`、`>x.y.z`、`<=x.y.z`、`<x.y.z`、`=x.y.z`、`^x.y.z`、`~x.y.z`、`x.y.z`，
 * 以及用 `||` 分隔的多选（`^1.0.0 || ^2.0.0`）。
 *
 * 不引第三方 semver：需求只有"拦住明显不兼容"，完整语义优先级不高，多一个运行时依赖不划算。
 */
export function satisfies(version: string, range: string): { ok: boolean; reason?: string } {
  const v = parseVersion(version);
  if (!v) return { ok: false, reason: "无法解析版本号：" + version };
  const trimmed = range.trim();
  if (!trimmed || trimmed === "*") return { ok: true };

  for (const alt of trimmed.split("||")) {
    const part = alt.trim();
    const m = /^(>=|<=|>|<|=|\^|~)?\s*v?(\d+\.\d+\.\d+)$/.exec(part);
    if (!m) return { ok: false, reason: "无法解析版本范围：" + part };
    const op = m[1] ?? "=";
    const target = parseVersion(m[2]!);
    if (!target) return { ok: false, reason: "无法解析版本：" + m[2] };
    const c = cmp(v, target);
    const hit =
      op === ">=" ? c >= 0 :
      op === ">" ? c > 0 :
      op === "<=" ? c <= 0 :
      op === "<" ? c < 0 :
      op === "=" ? c === 0 :
      // caret：同 major 且不低于目标；tilde：同 minor 且不低于目标
      op === "^" ? v.major === target.major && c >= 0 :
      v.major === target.major && v.minor === target.minor && c >= 0;
    if (hit) return { ok: true };
  }
  return { ok: false, reason: version + " 不满足 " + range };
}

export interface CompatIssue { severity: "error" | "warn"; message: string }

/** 校验单个插件的 engines 与依赖；返回问题列表（error 表示不可加载）。 */
export function checkCompat(
  manifest: { name: string; engines?: Record<string, string>; dependencies?: Record<string, string> },
  available: Map<string, string>,
): CompatIssue[] {
  const issues: CompatIssue[] = [];
  const want = manifest.engines?.harness;
  if (want) {
    const got = harnessVersion();
    const res = satisfies(got, want);
    if (!res.ok) {
      issues.push({ severity: "error", message: "需要 harness " + want + "，当前 " + got + "（" + (res.reason ?? "") + "）" });
    }
  }
  for (const [dep, range] of Object.entries(manifest.dependencies ?? {})) {
    const have = available.get(dep);
    if (!have) {
      issues.push({ severity: "error", message: "缺少依赖插件：" + dep + "（需要 " + range + "）" });
      continue;
    }
    const res = satisfies(have, range);
    if (!res.ok) issues.push({ severity: "error", message: "依赖 " + dep + " 版本不符：需要 " + range + "，实际 " + have });
  }
  return issues;
}

/** 能力名 → 是否需要显式声明。未声明就使用 → 拒绝注册。 */
export const CAPABILITY_BY_KIND: Record<string, string> = {
  route: "http-route",
  panel: "ui-panel",
};

export function hasPermission(declared: string[] | undefined, capability: string): boolean {
  return Array.isArray(declared) && declared.includes(capability);
}

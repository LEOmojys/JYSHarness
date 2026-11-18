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

/** A portable directory name for an installed plugin. */
export function isPluginName(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9._-]+$/.test(value)
    && !value.endsWith(".") && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(value);
}

/** 本平台版本（读 package.json，避免两处手写不一致）。 */
export function harnessVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version?: string };
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
 * 极简 semver 范围判断：支持 `>=x.y.z`、`>x.y.z`、`<=x.y.z`、`<x.y.z`、`=x.y.z`、`^x.y.z`、`~x.y.z`、`x.y.z`、
 * 省略段的写法（`>=0.2`、`1.2`、`1`），空格/逗号分隔的多条件（`>=1.0.0 <3.0.0`），
 * 以及用 `||` 分隔的多选（`^1.0.0 || ^2.0.0`）。
 *
 * 为什么要支持省略段：文档示例写的就是 `engines.harness: ">=0.2"`。以前只认三段式，
 * 于是**照文档写的清单会被当成致命错误直接拒载** —— 文档与实现互相打脸。
 *
 * 不引第三方 semver：需求只有"拦住明显不兼容"，完整语义优先级不高，多一个运行时依赖不划算。
 */
export function satisfies(version: string, range: string): { ok: boolean; reason?: string } {
  const v = parseVersion(version);
  if (!v) return { ok: false, reason: "无法解析版本号：" + version };
  const trimmed = range.trim();
  if (!trimmed || trimmed === "*") return { ok: true };

  for (const alt of trimmed.split("||")) {
    // 同一个备选里的多个条件是与关系：`>=1.0.0 <3.0.0`
    const parts = alt.trim().split(/[\s,]+/).filter(Boolean);
    if (!parts.length) return { ok: false, reason: "无法解析版本范围：" + alt };
    let allMatch = true;
    for (const part of parts) {
      const hit = oneConstraint(v, part);
      if (hit === null) return { ok: false, reason: "无法解析版本范围：" + part };
      if (!hit) {
        allMatch = false;
        break;
      }
    }
    if (allMatch) return { ok: true };
  }
  return { ok: false, reason: version + " 不满足 " + range };
}

/** 单个约束；返回 null 表示这条约束本身写错了。 */
function oneConstraint(v: ParsedVersion, part: string): boolean | null {
  const m = /^(>=|<=|>|<|=|\^|~)?\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(part);
  if (!m) return null;
  const op = m[1] ?? "";
  const major = Number(m[2]);
  const minor = m[3] === undefined ? 0 : Number(m[3]);
  const patch = m[4] === undefined ? 0 : Number(m[4]);
  const width = m[4] !== undefined ? 3 : m[3] !== undefined ? 2 : 1; // 写了几个段
  const c = cmp(v, { major, minor, patch });
  const sameMajor = v.major === major;
  const sameMinor = sameMajor && v.minor === minor;

  if (op === ">=") return c >= 0;
  if (op === ">") return c > 0;
  if (op === "<=") return c <= 0;
  if (op === "<") return c < 0;
  if (op === "=" || op === "") {
    // 省略段的"精确"是 X-range：`1.2` 表示整个 1.2.x，`1` 表示整个 1.x
    if (width === 1) return sameMajor;
    if (width === 2) return sameMinor;
    return c === 0;
  }
  if (op === "^") {
    if (c < 0) return false;
    if (width === 1) return sameMajor;
    if (width === 2) return sameMinor;
    // major 为 0 时 caret 更严格（0.x 视为不兼容边界）
    if (major > 0) return sameMajor;
    if (minor > 0) return v.major === 0 && v.minor === minor;
    return v.major === 0 && v.minor === 0 && v.patch === patch;
  }
  // "~"：允许 patch 变化，不允许 cross minor
  if (width === 1) return sameMajor;
  return sameMinor && c >= 0;
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

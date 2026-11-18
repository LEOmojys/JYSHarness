/**
 * 插件管理器：安装 / 卸载 / 更新 / 启停 / 查看。
 *
 * 与 loader 的分工：loader 负责"加载已存在的插件"，这里负责"把插件放到位并记录来源"。
 * 安装来源支持：本地目录、`.tgz` 之外的普通目录树、git URL（走 git clone，需要网络）。
 *
 * 安装时做三件事，缺一不可：
 *   1. 校验清单（name 合法、entry 不越界、可选 ui 目录存在）；
 *   2. **拒绝覆盖**已存在的同名插件（除非 --force），避免误删用户改过的版本；
 *   3. 写 `plugin.lock.json` 记录来源与安装时间，便于 `list` 显示与日后更新。
 */
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { configHome } from "../core/configStore.ts";
import { discoverPlugins, readManifest, resolveEntry } from "./loader.ts";
import { shutdownHost } from "./host/client.ts";
import { checkCompat, harnessVersion, isPluginName } from "./compat.ts";
import { isInside, realResolve } from "../sandbox/paths.ts";

const NL = String.fromCharCode(10);

export interface InstallOptions {
  /** project（默认）或 user */
  target?: "project" | "user";
  /** 已存在时覆盖 */
  force?: boolean;
  /** 安装后不启用（写 enabled:false） */
  disabled?: boolean;
}

export interface InstallResult {
  ok: boolean;
  name?: string;
  dir?: string;
  source?: string;
  error?: string;
}

export function pluginDestination(workspaceRoot: string, name: string, target: "project" | "user" = "project"): string {
  if (!isPluginName(name)) throw new Error("插件名无效：" + name);
  const base = realResolve(target === "user" ? configHome() : workspaceRoot);
  let dir = base;
  for (const segment of target === "user" ? ["plugins", name] : [".harness", "plugins", name]) {
    dir = path.join(dir, segment);
    if (lstatSync(dir, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error("安装路径包含目录链接：" + dir);
  }
  return dir;
}

/** 判断来源是 git URL 还是本地目录。 */
const GITHUB_SHORTHAND = /^[a-z\d][a-z\d-]*\/[\w.-]+$/i;

export function isGitSource(src: string): boolean {
  return /^(git@|https?:\/\/.+\.git$|ssh:\/\/)/.test(src) || (GITHUB_SHORTHAND.test(src) && !existsSync(src));
}

/** 从 git 克隆到临时目录（浅克隆），失败返回错误说明。 */
function cloneToTemp(url: string): { ok: true; dir: string } | { ok: false; error: string } {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "jys-plugin-"));
  const remote = GITHUB_SHORTHAND.test(url) ? "https://github.com/" + url : url;
  const args = ["clone", "--depth", "1", "--quiet", "--", remote, tmp];
  const res = spawnSync("git", args, { encoding: "utf8", timeout: 180_000 });
  if (res.status !== 0) {
    rmSync(tmp, { recursive: true, force: true });
    const err = String(res.stderr ?? "").trim().slice(0, 300);
    return { ok: false, error: "git clone 失败：" + (err || "未知错误") + "（这台机器访问 github 可能需要代理）" };
  }
  return { ok: true, dir: tmp };
}

/** 找到含 plugin.json 的目录：来源可能本身就是插件目录，也可能是含多个插件的仓库。 */
function findPluginDir(root: string): string | null {
  if (existsSync(path.join(root, "plugin.json"))) return root;
  const candidates = ["plugins", "packages", "."];
  for (const c of candidates) {
    const dir = path.join(root, c);
    if (!existsSync(dir)) continue;
    const entries = (() => {
      try {
        return readdirSync(dir);
      } catch {
        return [];
      }
    })();
    for (const e of entries) {
      const sub = path.join(dir, e);
      if (existsSync(path.join(sub, "plugin.json"))) return sub;
    }
  }
  return null;
}

/**
 * 递归复制插件目录。
 *
 * 不用 fs.cpSync：这台 Windows 上它对目标目录报 EIO/Access denied（实测），
 * 而手写递归可控性更好 —— 可以跳过 .git/node_modules（不该随插件分发）。
 */
const SKIP_COPY = new Set([".git", "node_modules", "plugin.lock.json"]);

export function copyTree(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    if (SKIP_COPY.has(entry.name)) continue;
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyTree(from, to);
    else if (entry.isFile()) copyFileSync(from, to);
  }
}
export function installPlugin(workspaceRoot: string, source: string, opts: InstallOptions = {}): InstallResult {
  const target = opts.target ?? "project";
  let srcDir = source;
  let cleanup: string | null = null;
  let resolvedSource = path.resolve(source);

  if (isGitSource(source)) {
    const cloned = cloneToTemp(source);
    if (!cloned.ok) return { ok: false, error: cloned.error };
    cleanup = cloned.dir;
    srcDir = cloned.dir;
    resolvedSource = source;
  } else if (!existsSync(source)) {
    return { ok: false, error: "来源不存在：" + source };
  }

  try {
    const pluginDir = findPluginDir(srcDir);
    if (!pluginDir) return { ok: false, error: "来源里找不到 plugin.json（可以是插件目录，或含 plugins/*/plugin.json 的仓库）" };

    let manifest;
    try {
      manifest = readManifest(path.join(pluginDir, "plugin.json"));
    } catch (err) {
      return { ok: false, error: "清单无效：" + (err instanceof Error ? err.message : String(err)) };
    }

    // entry 必须落在插件目录内
    try {
      resolveEntry(pluginDir, manifest);
    } catch (err) {
      return { ok: false, error: "入口无效：" + (err instanceof Error ? err.message : String(err)) };
    }

    // 兼容性：装之前就告诉用户合不合适
    const available = new Map(listInstalled(workspaceRoot)
      .filter((plugin) => plugin.enabled && (target === "project" || plugin.source === "user"))
      .map((plugin) => [plugin.name, plugin.version]));
    const compat = checkCompat(manifest, available);
    const fatal = compat.find((i) => i.severity === "error");
    if (fatal) return { ok: false, error: "不兼容（harness " + harnessVersion() + "）：" + fatal.message };

    const dest = pluginDestination(workspaceRoot, manifest.name, target);
    const root = path.dirname(dest);
    if (existsSync(dest) && !opts.force) return { ok: false, error: "已安装：" + manifest.name + "（加 --force 覆盖）" };
    if (isInside(realResolve(pluginDir), realResolve(root))) return { ok: false, error: "安装目录不能位于插件源目录内" };
    mkdirSync(root, { recursive: true });

    // 安装锁：记录来源，便于 list 显示与后续更新
    const lock = {
      name: manifest.name,
      version: manifest.version ?? "0.0.0",
      source: resolvedSource,
      target,
      installedAt: new Date().toISOString(),
      harnessAtInstall: harnessVersion(),
    };
    const transaction = mkdtempSync(path.join(root, ".install-"));
    const staged = path.join(transaction, "new");
    const backup = path.join(transaction, "previous");
    let keepBackup = false;
    try {
      copyTree(pluginDir, staged);
      const mp = path.join(staged, "plugin.json");
      const stagedManifest = readManifest(mp);
      resolveEntry(staged, stagedManifest);
      writeFileSync(path.join(staged, "plugin.lock.json"), JSON.stringify(lock, null, 2) + NL, "utf8");
      if (opts.disabled) {
        writeFileSync(mp, JSON.stringify({ ...stagedManifest, enabled: false }, null, 2) + NL, "utf8");
      }
      if (existsSync(dest)) {
        if (!opts.force) return { ok: false, error: "已安装：" + manifest.name };
        shutdownHost(dest);
        renameSync(dest, backup);
      }
      try {
        renameSync(staged, dest);
      } catch (err) {
        if (existsSync(backup)) {
          keepBackup = true;
          renameSync(backup, dest);
          keepBackup = false;
        }
        throw err;
      }
    } finally {
      if (!keepBackup) rmSync(transaction, { recursive: true, force: true });
    }
    return { ok: true, name: manifest.name, dir: dest, source: resolvedSource };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    if (cleanup) rmSync(cleanup, { recursive: true, force: true });
  }
}

export function uninstallPlugin(workspaceRoot: string, name: string, target: "project" | "user" = "project"): InstallResult {
  let dir: string;
  try {
    dir = pluginDestination(workspaceRoot, name, target);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  if (!existsSync(dir)) return { ok: false, error: "未安装：" + name };
  // 先杀宿主再删目录：否则子进程还引用着已删代码（Windows 下还可能占用句柄）
  shutdownHost(dir);
  rmSync(dir, { recursive: true, force: true });
  return { ok: true, name, dir };
}

export interface InstalledPlugin {
  name: string;
  version: string;
  dir: string;
  source: "project" | "user";
  enabled: boolean;
  installedFrom?: string;
  installedAt?: string;
  permissions: string[];
  panels: number;
}

export function listInstalled(workspaceRoot: string): InstalledPlugin[] {
  const out: InstalledPlugin[] = [];
  for (const d of discoverPlugins(workspaceRoot)) {
    let manifest;
    try {
      manifest = readManifest(d.manifestPath);
    } catch {
      continue;
    }
    let source: string | undefined;
    let installedAt: string | undefined;
    try {
      const lock = JSON.parse(readFileSync(path.join(d.dir, "plugin.lock.json"), "utf8"));
      if (typeof lock?.source === "string") source = lock.source;
      if (typeof lock?.installedAt === "string") installedAt = lock.installedAt;
    } catch {
      /* 手放的插件没有 lock 文件，正常 */
    }
    const declared = (manifest as { panels?: unknown[] }).panels;
    out.push({
      name: manifest.name,
      version: manifest.version ?? "0.0.0",
      dir: d.dir,
      source: d.source,
      enabled: manifest.enabled !== false,
      installedFrom: source,
      installedAt,
      permissions: manifest.contributes?.permissions ?? [],
      panels: Array.isArray(declared) ? declared.length : 0,
    });
  }
  return out;
}

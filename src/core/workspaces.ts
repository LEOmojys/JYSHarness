/** Recent workspaces, persisted in the user settings file (not the project). */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { userSettingsPath } from "./configStore.ts";

const MAX_RECENT = 8;
const MAX_FAVORITES = 12;

export type WorkspaceKind = "git" | "node" | "python" | "dir";

export interface WorkspaceEntry {
  path: string;
  /** 目录名，用于快捷入口的显示。 */
  name: string;
  /** 粗粒度项目类型，仅用于展示徽标。 */
  kind: WorkspaceKind;
  /** 上次打开时间（毫秒），仅收藏没有这个值时为 0。 */
  at: number;
  exists: boolean;
  favorite: boolean;
}

function readUserSettings(): Record<string, unknown> {
  const file = userSettingsPath();
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function writeUserSettings(data: Record<string, unknown>): void {
  const file = userSettingsPath();
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 2) + "\n", "utf8");
}

/** 兼容旧格式（string[]）并保留时间戳。 */
function readRecentRaw(): { path: string; at: number }[] {
  const raw = readUserSettings().recentWorkspaces;
  if (!Array.isArray(raw)) return [];
  const out: { path: string; at: number }[] = [];
  for (const item of raw) {
    if (typeof item === "string") out.push({ path: item, at: 0 });
    else if (item && typeof item === "object" && typeof (item as any).path === "string") {
      out.push({ path: String((item as any).path), at: Number((item as any).at) || 0 });
    }
  }
  return out.filter((e) => e.path);
}

function readFavoritePaths(): string[] {
  const raw = readUserSettings().favoriteWorkspaces;
  if (!Array.isArray(raw)) return [];
  return raw.map(String).filter(Boolean);
}

export function detectWorkspaceKind(dir: string): WorkspaceKind {
  try {
    if (existsSync(path.join(dir, ".git"))) return "git";
    if (existsSync(path.join(dir, "package.json"))) return "node";
    if (existsSync(path.join(dir, "pyproject.toml")) || existsSync(path.join(dir, "requirements.txt"))) {
      return "python";
    }
  } catch {
    /* 读不到的目录按普通目录处理 */
  }
  return "dir";
}

function toEntry(p: string, at: number, favorites: Set<string>): WorkspaceEntry {
  const exists = existsSync(p);
  return {
    path: p,
    name: path.basename(p) || p,
    kind: exists ? detectWorkspaceKind(p) : "dir",
    at,
    exists,
    favorite: favorites.has(p),
  };
}

/** 最近项目：按打开时间倒序，已删除的目录不展示。 */
export function listRecentEntries(): WorkspaceEntry[] {
  const favorites = new Set(readFavoritePaths());
  return readRecentRaw()
    .map((e) => toEntry(e.path, e.at, favorites))
    .filter((e) => e.exists)
    .slice(0, MAX_RECENT);
}

/** 常用路径：收藏（固定的快捷入口），保持收藏顺序。 */
export function listFavoriteEntries(): WorkspaceEntry[] {
  const favorites = new Set(readFavoritePaths());
  return readFavoritePaths()
    .map((p) => toEntry(p, 0, favorites))
    .slice(0, MAX_FAVORITES);
}

/** 旧接口：其它地方仍按字符串列表消费。 */
export function listRecentWorkspaces(): string[] {
  return listRecentEntries().map((e) => e.path);
}

export function rememberWorkspace(absPath: string): string[] {
  const normalized = path.resolve(absPath);
  const now = Date.now();
  const next = [
    { path: normalized, at: now },
    ...readRecentRaw().filter((e) => e.path !== normalized),
  ].slice(0, MAX_RECENT);
  const settings = readUserSettings();
  settings.recentWorkspaces = next;
  writeUserSettings(settings);
  return next.map((e) => e.path);
}

/** 固定 / 取消固定一个常用路径。返回是否已收藏。 */
export function setFavorite(absPath: string, favorite: boolean): boolean {
  const normalized = path.resolve(absPath);
  const current = readFavoritePaths().filter((p) => p !== normalized);
  const next = favorite ? [normalized, ...current].slice(0, MAX_FAVORITES) : current;
  const settings = readUserSettings();
  settings.favoriteWorkspaces = next;
  writeUserSettings(settings);
  return favorite;
}

export function isFavorite(absPath: string): boolean {
  return readFavoritePaths().includes(path.resolve(absPath));
}

export interface WorkspaceCheck {
  ok: boolean;
  path: string;
  error?: string;
}

export function validateWorkspace(raw: string): WorkspaceCheck {
  if (!raw || !raw.trim()) return { ok: false, path: "", error: "路径为空" };
  const trimmed = raw.trim().replace(/^"|"$/g, "");
  const abs = path.resolve(trimmed.replace(/^~(?=$|[\\/])/, os.homedir()));
  if (!existsSync(abs)) return { ok: false, path: abs, error: "目录不存在：" + abs };
  try {
    if (!statSync(abs).isDirectory()) return { ok: false, path: abs, error: "不是目录：" + abs };
  } catch (err) {
    return { ok: false, path: abs, error: err instanceof Error ? err.message : String(err) };
  }
  return { ok: true, path: abs };
}

export interface BrowseEntry {
  name: string;
  path: string;
}

export interface BrowseResult {
  path: string;
  parent: string | null;
  dirs: BrowseEntry[];
  /** Windows drive roots when browsing from "this computer". */
  roots?: string[];
  error?: string;
}

export function browseDirectories(raw: string): BrowseResult {
  if (!raw || !raw.trim()) {
    if (process.platform === "win32") {
      const roots: string[] = [];
      for (const letter of "CDEFGHIJKLMNOPQRSTUVWXYZ") {
        const drive = letter + ":\\";
        if (existsSync(drive)) roots.push(drive);
      }
      return { path: "", parent: null, dirs: [], roots };
    }
    return browseDirectories(os.homedir());
  }

  const check = validateWorkspace(raw);
  const target = check.path;
  if (!check.ok) return { path: target, parent: path.dirname(target), dirs: [], error: check.error };

  let names: string[] = [];
  try {
    names = readdirSyncSafe(target);
  } catch (err) {
    return { 
      path: target,
      parent: path.dirname(target),
      dirs: [],
      error: "无法读取目录：" + (err instanceof Error ? err.message : String(err)),
    };
  }

  const dirs: BrowseEntry[] = [];
  for (const name of names) {
    const abs = path.join(target, name);
    try {
      if (statSync(abs).isDirectory()) dirs.push({ name, path: abs });
    } catch {
      /* 无权限的目录直接跳过 */
    }
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name));
  const parent = path.dirname(target);
  return { path: target, parent: parent === target ? null : parent, dirs };
}

function readdirSyncSafe(dir: string): string[] {
  // 单独包一层：这里不做过滤，用户可能就是要选隐藏目录或 node_modules。
  return readdirSync(dir) as string[];
}

/**
 * 插件面板的**同步**发现。
 *
 * 为什么不复用 loadPlugins：那要执行插件的 activate()，可能有副作用/异步，
 * 而 /api/config 是同步构造的（UI 首屏就要面板清单）。所以面板走**清单声明**：
 * plugin.json 里写 panels: [{id,title,icon,slot}]，这里只读 JSON。
 * 运行期 api.registerPanel() 仍然保留，供 /api/plugins 展示与调试。
 */
import path from "node:path";
import { discoverPlugins, readManifest } from "./loader.ts";
import { hasPermission } from "./compat.ts";
import type { PluginPanel } from "./types.ts";

export interface PanelDecl extends PluginPanel {
  plugin: string;
  /** 浏览器侧入口（宿主提供，插件不用关心） */
  asset: string;
}

/** UI 认识的内置插槽。不在这里的名字会进兜底区域（而不是被丢掉）。 */
export const KNOWN_SLOTS = ["sidebar", "settings", "statusbar", "header", "composer", "drawer"] as const;

export function isKnownSlot(slot: string): boolean {
  return (KNOWN_SLOTS as readonly string[]).includes(slot);
}

/** 同一插槽内按 order 排序（order 相同则按 title，保证顺序稳定）。 */
export function sortPanels(panels: PanelDecl[]): PanelDecl[] {
  return [...panels].sort((a, b) => (a.order ?? 100) - (b.order ?? 100) || a.title.localeCompare(b.title));
}

export function assetUrl(pluginId: string, file = "index.js"): string {
  return "/plugin-assets/" + encodeURIComponent(pluginId) + "/" + file;
}

export function pluginPanelDirs(workspaceRoot: string): { dir: string; panels: PanelDecl[] }[] {
  const out: { dir: string; panels: PanelDecl[] }[] = [];
  for (const discovered of discoverPlugins(workspaceRoot)) {
    let manifest;
    try {
      manifest = readManifest(discovered.manifestPath);
    } catch {
      continue;
    }
    if (manifest.enabled === false) continue;
    const declared = (manifest as { panels?: PluginPanel[] }).panels ?? [];
    if (!declared.length) continue;
    // 清单声明的面板同样要 ui-panel 权限：否则"只在 manifest 里写 panels"
    // 就能绕过 registerPanel 的能力校验，规则就自相矛盾了。
    if (!hasPermission(manifest.contributes?.permissions, "ui-panel")) continue;
    const id = (manifest as { id?: string }).id ?? path.basename(discovered.dir);
    const panels: PanelDecl[] = [];
    for (const p of declared) {
      if (!p?.id || !p?.title) continue;
      // 槽位名**不再限定**在这三个里：插件可以写 header/composer/drawer，
      // 甚至写自己的名字 —— 未知名字由 UI 集中渲染到"插件"区域，不会被静默丢弃。
      const slot = typeof p.slot === "string" && p.slot.trim() ? p.slot.trim() : "sidebar";
      const order = Number.isFinite(p.order) ? Number(p.order) : 100;
      panels.push({
        id: p.id,
        title: p.title,
        icon: p.icon,
        slot,
        order,
        plugin: id,
        asset: assetUrl(id),
      });
    }
    if (panels.length) out.push({ dir: discovered.dir, panels });
  }
  return out;
}

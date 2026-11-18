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
import type { PluginPanel } from "./types.ts";

export interface PanelDecl extends PluginPanel {
  plugin: string;
  /** 浏览器侧入口（宿主提供，插件不用关心） */
  asset: string;
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
    const id = (manifest as { id?: string }).id ?? path.basename(discovered.dir);
    const panels: PanelDecl[] = [];
    for (const p of declared) {
      if (!p?.id || !p?.title) continue;
      const slot = p.slot === "settings" || p.slot === "statusbar" ? p.slot : "sidebar";
      panels.push({
        id: p.id,
        title: p.title,
        icon: p.icon,
        slot,
        plugin: id,
        asset: assetUrl(id),
      });
    }
    if (panels.length) out.push({ dir: discovered.dir, panels });
  }
  return out;
}

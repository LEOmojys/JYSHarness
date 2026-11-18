import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { KNOWN_SLOTS, isKnownSlot, pluginPanelDirs, sortPanels } from "../src/plugins/panels.ts";

function wsWith(panels: unknown[]): string {
  const ws = mkdtempSync(path.join(os.tmpdir(), "jys-slot-"));
  const dir = path.join(ws, ".harness", "plugins", "slots");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "plugin.json"),
    JSON.stringify({ name: "slots", contributes: { permissions: ["ui-panel"] }, panels }),
    "utf8",
  );
  return ws;
}

test("slots: all documented slot names are accepted (not downgraded to sidebar)", () => {
  const ws = wsWith(KNOWN_SLOTS.map((slot, i) => ({ id: "p" + i, title: "T" + i, slot, order: i })));
  const panels = pluginPanelDirs(ws)[0].panels;
  assert.equal(panels.length, KNOWN_SLOTS.length);
  for (let i = 0; i < KNOWN_SLOTS.length; i++) {
    assert.equal(panels.find((p) => p.id === "p" + i)?.slot, KNOWN_SLOTS[i], "槽位名不该被改写");
  }
});

test("slots: an unknown slot name is preserved so the UI can show it in the fallback area", () => {
  const ws = wsWith([{ id: "x", title: "自定义", slot: "my-custom-slot" }]);
  const panel = pluginPanelDirs(ws)[0].panels[0];
  assert.equal(panel.slot, "my-custom-slot", "未知槽位必须原样保留，不能静默丢弃");
  assert.equal(isKnownSlot(panel.slot), false);
  assert.equal(isKnownSlot("sidebar"), true);
});

test("slots: omitted slot defaults to sidebar; order defaults to 100", () => {
  const ws = wsWith([{ id: "d", title: "默认" }]);
  const panel = pluginPanelDirs(ws)[0].panels[0];
  assert.equal(panel.slot, "sidebar");
  assert.equal(panel.order, 100);
});

test("slots: order controls placement inside the same slot", () => {
  const ws = wsWith([
    { id: "c", title: "C", slot: "header", order: 30 },
    { id: "a", title: "A", slot: "header", order: 10 },
    { id: "b", title: "B", slot: "header", order: 20 },
  ]);
  const sorted = sortPanels(pluginPanelDirs(ws)[0].panels);
  assert.deepEqual(sorted.map((p) => p.id), ["a", "b", "c"]);
});

test("slots: equal order yields a stable order across reloads", () => {
  const ws = wsWith([
    { id: "z", title: "乙", slot: "drawer" },
    { id: "y", title: "甲", slot: "drawer" },
  ]);
  const first = sortPanels(pluginPanelDirs(ws)[0].panels).map((p) => p.id);
  const second = sortPanels(pluginPanelDirs(ws)[0].panels).map((p) => p.id);
  assert.deepEqual(first, second, "同一 order 下顺序必须稳定");
});

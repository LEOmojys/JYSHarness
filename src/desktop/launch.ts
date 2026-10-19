/**
 * Desktop shell with zero dependencies.
 *
 * A Chromium browser in app mode gives a real, chromeless desktop window. It is
 * not a packaged binary, but it removes every reason to postpone the UI: no
 * Electron download, no Rust toolchain, no build step. When you want a signed
 * .exe later, Tauri wraps the same server URL with one config file.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const CANDIDATES = [
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
];

export function findBrowser(): string | null {
  if (process.env.HARNESS_BROWSER && existsSync(process.env.HARNESS_BROWSER)) return process.env.HARNESS_BROWSER;
  for (const c of CANDIDATES) if (existsSync(c)) return c;
  return null;
}

export interface WindowOptions {
  url: string;
  /** Persisted under the workspace so the app keeps its own profile. */
  profileDir: string;
  width?: number;
  height?: number;
}

export function launchAppWindow(opts: WindowOptions): ChildProcess | null {
  const browser = findBrowser();
  if (!browser) return null;
  const args = [
    "--app=" + opts.url,
    "--user-data-dir=" + path.resolve(opts.profileDir),
    "--window-size=" + (opts.width ?? 1280) + "," + (opts.height ?? 880),
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-features=Translate,MediaRouter",
    "--disable-background-mode",
  ];
  const child = spawn(browser, args, { detached: false, stdio: "ignore", windowsHide: false });
  child.on("error", () => {});
  return child;
}

export function openInBrowser(url: string): void {
  const cmd =
    process.platform === "win32" ? ["cmd", ["/c", "start", "", url]]
    : process.platform === "darwin" ? ["open", [url]]
    : ["xdg-open", [url]];
  spawn(cmd[0] as string, cmd[1] as string[], { stdio: "ignore", detached: true }).unref();
}

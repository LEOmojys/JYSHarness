# JYSHarness - Tauri packaging (optional)

`jys desktop` already gives you a real window with zero dependencies (Chromium app mode).
Use Tauri only when you need a signed installer, tray icon or auto-update.

## Prerequisites

- Rust toolchain (`rustup`) and the Tauri CLI: `cargo install tauri-cli --version "^2"`
- Node.js 22+ on PATH (the shell spawns `node`, it does not embed Node)

## Build

```bash
cd desktop/tauri
cargo tauri build
```

The shell starts `node src/cli/main.ts serve --port 4317` from `MINI_HARNESS_ROOT`
(or the current directory), opens a webview at `http://127.0.0.1:4317/`, and kills the
server when the window closes.

## What the Rust side does (and does not do)

- It does **not** reimplement the UI: `ui-dist/index.html` just redirects to the local server.
- It does **not** bundle Node. Ship Node next to the binary, or embed a single-file build later.
- It kills the child on `ExitRequested`; a hard crash can leave a server on port 4317.

## Better long-term option

Compile the server to a single binary (`node --experimental-sea-config`, `pkg`, or Bun build)
and spawn that instead of `node`, so the app becomes one self-contained executable.
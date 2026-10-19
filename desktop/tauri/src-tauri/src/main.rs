// Tauri shell: start the harness server, show it in a webview, kill it on exit.
use std::process::{Child, Command};
use std::sync::Mutex;
use tauri::Manager;

struct ServerProcess(Mutex<Option<Child>>);

fn spawn_server() -> Option<Child> {
    let root = std::env::var("MINI_HARNESS_ROOT").unwrap_or_else(|_| ".".to_string());
    Command::new("node")
        .args(["src/cli/main.ts", "serve", "--port", "4317", "--no-subagent"])
        .current_dir(root)
        .spawn()
        .ok()
}

fn main() {
    tauri::Builder::default()
        .manage(ServerProcess(Mutex::new(None)))
        .setup(|app| {
            let child = spawn_server();
            *app.state::<ServerProcess>().0.lock().unwrap() = child;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { .. } = event {
                if let Some(mut child) = app.state::<ServerProcess>().0.lock().unwrap().take() {
                    let _ = child.kill();
                }
            }
        });
}

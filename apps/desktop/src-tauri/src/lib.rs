#[cfg(target_os = "macos")]
use tauri::Manager;
#[cfg(target_os = "macos")]
use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial};

use serde::Serialize;
use std::{
    env,
    net::{SocketAddr, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Mutex,
    time::{Duration, Instant},
};

const SERVER_HOST: &str = "127.0.0.1";
const SERVER_PORT: u16 = 3001;
const SERVER_BASE_URL: &str = "http://127.0.0.1:3001";

#[derive(Default)]
struct AgentServerState {
    child: Mutex<Option<Child>>,
}

impl Drop for AgentServerState {
    fn drop(&mut self) {
        if let Ok(mut child) = self.child.lock() {
            if let Some(mut child) = child.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentServerStatus {
    running: bool,
    managed: bool,
    base_url: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PickedFile {
    name: String,
    path: String,
}

#[tauri::command]
fn pick_workspace_directory() -> Result<Option<String>, String> {
    let folder = rfd::FileDialog::new()
        .set_title("Choose workspace folder")
        .pick_folder();

    Ok(folder.map(|path| path.to_string_lossy().into_owned()))
}

#[tauri::command]
fn pick_upload_file() -> Result<Option<PickedFile>, String> {
    let file = rfd::FileDialog::new()
        .set_title("Choose file to upload")
        .pick_file();

    Ok(file.map(|path| PickedFile {
        name: path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("selected-file")
            .to_string(),
        path: path.to_string_lossy().into_owned(),
    }))
}

#[tauri::command]
fn agent_server_status() -> AgentServerStatus {
    AgentServerStatus {
        running: is_server_reachable(),
        managed: false,
        base_url: SERVER_BASE_URL,
    }
}

#[tauri::command]
fn ensure_agent_server(
    state: tauri::State<'_, AgentServerState>,
) -> Result<AgentServerStatus, String> {
    if is_server_reachable() {
        return Ok(AgentServerStatus {
            running: true,
            managed: false,
            base_url: SERVER_BASE_URL,
        });
    }

    {
        let mut child_slot = state
            .child
            .lock()
            .map_err(|_| "agent server state lock poisoned".to_string())?;

        if child_slot.is_none() {
            let workspace_root = workspace_root().ok_or_else(|| {
                "Could not find repository root. Set COLORFUL_CODE_REPO_ROOT.".to_string()
            })?;

            let mut command = Command::new(
                env::var("COLORFUL_CODE_SERVER_COMMAND").unwrap_or_else(|_| "bun".to_string()),
            );
            command
                .arg("apps/server/src/main.ts")
                .current_dir(&workspace_root)
                .env("HOST", SERVER_HOST)
                .env("PORT", SERVER_PORT.to_string())
                .env("DATABASE_PATH", server_database_path(&workspace_root))
                .env(
                    "CORS_ORIGIN",
                    "http://localhost:3000,http://127.0.0.1:3000,http://tauri.localhost",
                )
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null());

            let child = command
                .spawn()
                .map_err(|error| format!("Failed to start agent server: {error}"))?;
            *child_slot = Some(child);
        }
    }

    wait_for_server(Duration::from_secs(12))?;

    Ok(AgentServerStatus {
        running: true,
        managed: true,
        base_url: SERVER_BASE_URL,
    })
}

fn workspace_root() -> Option<PathBuf> {
    if let Ok(root) = env::var("COLORFUL_CODE_REPO_ROOT") {
        return Some(PathBuf::from(root));
    }

    if let Some(root) = find_workspace_root_from(env::current_dir().ok()?) {
        return Some(root);
    }

    find_workspace_root_from(PathBuf::from(env!("CARGO_MANIFEST_DIR")))
}

fn find_workspace_root_from(mut dir: PathBuf) -> Option<PathBuf> {
    loop {
        if is_workspace_root(&dir) {
            return Some(dir);
        }
        if !dir.pop() {
            return None;
        }
    }
}

fn is_workspace_root(path: &Path) -> bool {
    path.join("pnpm-workspace.yaml").is_file() && path.join("apps/server/src/main.ts").is_file()
}

fn server_database_path(workspace_root: &Path) -> PathBuf {
    workspace_root.join("apps/server/data/colorful-code.db")
}

fn wait_for_server(timeout: Duration) -> Result<(), String> {
    let started_at = Instant::now();
    while started_at.elapsed() < timeout {
        if is_server_reachable() {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(150));
    }
    Err("Agent server did not become reachable on 127.0.0.1:3001.".to_string())
}

fn is_server_reachable() -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], SERVER_PORT));
    TcpStream::connect_timeout(&addr, Duration::from_millis(200)).is_ok()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AgentServerState::default())
        .invoke_handler(tauri::generate_handler![
            pick_workspace_directory,
            pick_upload_file,
            agent_server_status,
            ensure_agent_server
        ])
        .setup(|app| {
            #[cfg(target_os = "macos")]
            {
                let window = app
                    .get_webview_window("main")
                    .ok_or_else(|| "main window was not initialized".to_string())?;
                apply_vibrancy(&window, NSVisualEffectMaterial::Sidebar, None, None)
                    .map_err(|error| error.to_string())?;
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Colorful Code desktop app");
}

#[cfg(test)]
mod tests {
    use super::is_workspace_root;
    use super::{find_workspace_root_from, server_database_path, workspace_root};
    use std::path::{Path, PathBuf};

    #[test]
    fn repository_root_is_detected_by_workspace_and_server_entry() {
        assert!(is_workspace_root(Path::new("../../..")));
    }

    #[test]
    fn src_tauri_directory_is_not_the_workspace_root() {
        assert!(!is_workspace_root(Path::new(".")));
    }

    #[test]
    fn workspace_root_can_be_found_from_src_tauri() {
        let root = find_workspace_root_from(PathBuf::from(env!("CARGO_MANIFEST_DIR")));
        assert!(root.is_some());
    }

    #[test]
    fn workspace_root_uses_a_fallback_when_current_dir_is_not_the_repo() {
        assert!(workspace_root().is_some());
    }

    #[test]
    fn managed_server_uses_the_server_data_database_path() {
        let root = Path::new("/repo");
        assert_eq!(
            server_database_path(root),
            PathBuf::from("/repo/apps/server/data/colorful-code.db")
        );
    }
}

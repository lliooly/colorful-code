#[cfg(target_os = "macos")]
use tauri::{Emitter, Manager};
#[cfg(target_os = "macos")]
use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial};

use serde::Serialize;
use std::{
    ffi::{CStr, CString},
    os::raw::c_char,
    env,
    net::{SocketAddr, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Mutex, OnceLock},
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

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MacosSpeechEvent {
    kind: String,
    text: String,
}

#[cfg(target_os = "macos")]
static SPEECH_APP_HANDLE: OnceLock<Mutex<Option<tauri::AppHandle>>> = OnceLock::new();

#[cfg(target_os = "macos")]
extern "C" {
    fn colorful_macos_speech_start(
        language: *const c_char,
        callback: extern "C" fn(*const c_char, *const c_char),
    ) -> *mut c_char;
    fn colorful_macos_speech_stop();
    fn colorful_macos_speech_free(pointer: *mut c_char);
}

#[cfg(target_os = "macos")]
extern "C" fn macos_speech_callback(kind: *const c_char, text: *const c_char) {
    let kind = unsafe { c_string_to_string(kind) };
    let text = unsafe { c_string_to_string(text) };
    if let Some(handle) = speech_app_handle() {
        let _ = handle.emit("macos_speech://event", MacosSpeechEvent { kind, text });
    }
}

#[cfg(target_os = "macos")]
unsafe fn c_string_to_string(value: *const c_char) -> String {
    if value.is_null() {
        return String::new();
    }
    CStr::from_ptr(value).to_string_lossy().into_owned()
}

#[cfg(target_os = "macos")]
fn speech_app_handle() -> Option<tauri::AppHandle> {
    let slot = SPEECH_APP_HANDLE.get_or_init(|| Mutex::new(None));
    slot.lock().ok().and_then(|handle| handle.clone())
}

#[cfg(target_os = "macos")]
fn set_speech_app_handle(handle: tauri::AppHandle) -> Result<(), String> {
    let slot = SPEECH_APP_HANDLE.get_or_init(|| Mutex::new(None));
    let mut guard = slot
        .lock()
        .map_err(|_| "macOS speech handle lock poisoned".to_string())?;
    *guard = Some(handle);
    Ok(())
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

#[cfg(target_os = "macos")]
#[tauri::command]
fn macos_speech_start(app: tauri::AppHandle, language: String) -> Result<(), String> {
    set_speech_app_handle(app)?;
    let language = CString::new(language).map_err(|_| "Invalid speech language.".to_string())?;
    let error = unsafe { colorful_macos_speech_start(language.as_ptr(), macos_speech_callback) };
    if error.is_null() {
        return Ok(());
    }
    let message = unsafe { CStr::from_ptr(error).to_string_lossy().into_owned() };
    unsafe { colorful_macos_speech_free(error) };
    Err(message)
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
fn macos_speech_start(_language: String) -> Result<(), String> {
    Err("macOS speech is only available on macOS.".to_string())
}

#[cfg(target_os = "macos")]
#[tauri::command]
fn macos_speech_stop() -> Result<(), String> {
    unsafe { colorful_macos_speech_stop() };
    Ok(())
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
fn macos_speech_stop() -> Result<(), String> {
    Ok(())
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
            ensure_agent_server,
            macos_speech_start,
            macos_speech_stop
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
    use std::process::Command;

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

    #[test]
    fn macos_privacy_descriptions_cover_voice_input() {
        let plist = include_str!("../Info.plist");

        assert!(plist.contains("<key>NSMicrophoneUsageDescription</key>"));
        assert!(plist.contains("<string>Colorful Code 需要访问麦克风以接收语音输入。</string>"));
        assert!(plist.contains("<key>NSSpeechRecognitionUsageDescription</key>"));
        assert!(plist.contains("<string>Colorful Code 使用语音识别将您的语音转换为文字。</string>"));
    }

    #[test]
    fn macos_speech_bridge_source_is_packaged() {
        let bridge = Path::new(env!("CARGO_MANIFEST_DIR")).join("src/macos_speech.m");
        assert!(bridge.is_file());
    }

    #[test]
    fn macos_speech_bridge_preflights_privacy_usage_descriptions() {
        let bridge = include_str!("macos_speech.m");

        assert!(bridge.contains("privacyUsageDescriptionError"));
        assert!(bridge.contains("NSSpeechRecognitionUsageDescription"));
        assert!(bridge.contains("NSMicrophoneUsageDescription"));
        assert!(bridge.find("privacyUsageDescriptionError").unwrap() < bridge.find("requestSpeechAuthorization").unwrap());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_speech_bridge_uses_non_deprecated_audio_tap_api() {
        let object_path = std::env::temp_dir().join(format!(
            "colorful_macos_speech_warning_probe_{}.o",
            std::process::id()
        ));
        let output = Command::new("xcrun")
            .arg("clang")
            .arg("-Werror=deprecated-declarations")
            .arg("-fobjc-arc")
            .arg("-ObjC")
            .arg("-c")
            .arg("src/macos_speech.m")
            .arg("-o")
            .arg(&object_path)
            .current_dir(env!("CARGO_MANIFEST_DIR"))
            .output()
            .expect("failed to execute xcrun clang for macOS speech bridge warning check");

        assert!(
            output.status.success(),
            "macOS speech bridge compiled with deprecated API warnings:\n{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
}

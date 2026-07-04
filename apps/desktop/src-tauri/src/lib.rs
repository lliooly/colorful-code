#[cfg(target_os = "macos")]
use tauri::Emitter;
use tauri::Manager;
#[cfg(target_os = "macos")]
use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial};

use serde::Serialize;
use std::{
    env,
    ffi::{CStr, CString},
    fs::{self, OpenOptions},
    io::{Read, Write},
    net::{SocketAddr, TcpStream},
    os::raw::c_char,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

const SERVER_HOST: &str = "127.0.0.1";
const SERVER_PORT: u16 = 3367;
const SERVER_BASE_URL: &str = "http://127.0.0.1:3367";
const SERVER_SIDECAR_NAME: &str = "colorful-code-server";

#[derive(Default)]
struct AgentServerState {
    child: Mutex<Option<Child>>,
}

impl Drop for AgentServerState {
    fn drop(&mut self) {
        stop_managed_server(self);
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
        running: is_server_reachable() && server_allows_tauri_origin(),
        managed: false,
        base_url: SERVER_BASE_URL,
    }
}

#[tauri::command]
fn ensure_agent_server(
    app: tauri::AppHandle,
    state: tauri::State<'_, AgentServerState>,
) -> Result<AgentServerStatus, String> {
    if is_server_reachable() {
        if !server_allows_tauri_origin() {
            return Err(
                "Agent server port 3367 is already in use, but that server does not allow the Tauri desktop origin. Restart the dev server or stop the process using port 3367, then reopen Colorful Code."
                    .to_string(),
            );
        }
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
            let mut command = build_server_command(&app)?;

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

fn source_server_directory(workspace_root: &Path) -> PathBuf {
    workspace_root.join("apps/server")
}

fn source_database_path(workspace_root: &Path) -> PathBuf {
    workspace_root.join("apps/server/data/colorful-code.db")
}

fn app_data_database_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not resolve app data directory: {error}"))?;
    fs::create_dir_all(&data_dir)
        .map_err(|error| format!("Could not create app data directory: {error}"))?;
    Ok(data_dir.join("colorful-code.db"))
}

fn build_server_command(app: &tauri::AppHandle) -> Result<Command, String> {
    if let Some(sidecar) = bundled_server_sidecar() {
        let data_dir = app
            .path()
            .app_data_dir()
            .map_err(|error| format!("Could not resolve app data directory: {error}"))?;
        fs::create_dir_all(&data_dir)
            .map_err(|error| format!("Could not create app data directory: {error}"))?;
        let log_file = open_server_log(&data_dir)?;
        let error_log_file = log_file
            .try_clone()
            .map_err(|error| format!("Could not prepare agent server log: {error}"))?;

        let mut command = Command::new(sidecar);
        configure_server_process(&mut command);
        command
            .current_dir(data_dir)
            .env("NODE_ENV", "production")
            .env("DATABASE_PATH", app_data_database_path(app)?)
            .stdin(Stdio::null())
            .stdout(Stdio::from(log_file))
            .stderr(Stdio::from(error_log_file));
        return Ok(command);
    }

    let workspace_root = workspace_root().ok_or_else(|| {
        "Could not find repository root. Set COLORFUL_CODE_REPO_ROOT.".to_string()
    })?;

    let mut command = Command::new(
        env::var("COLORFUL_CODE_SERVER_COMMAND").unwrap_or_else(|_| "bun".to_string()),
    );
    configure_server_process(&mut command);
    command
        .arg("src/main.ts")
        .current_dir(source_server_directory(&workspace_root))
        .env("DATABASE_PATH", source_database_path(&workspace_root))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    Ok(command)
}

fn configure_server_process(command: &mut Command) {
    command
        .env("HOST", SERVER_HOST)
        .env("PORT", SERVER_PORT.to_string())
        .env(
            "CORS_ORIGIN",
            "http://localhost:3000,http://127.0.0.1:3000,http://tauri.localhost,https://tauri.localhost,tauri://localhost,null",
        );
}

fn bundled_server_sidecar() -> Option<PathBuf> {
    if cfg!(debug_assertions) {
        return None;
    }

    let sidecar = env::current_exe().ok()?.parent()?.join(SERVER_SIDECAR_NAME);
    sidecar.is_file().then_some(sidecar)
}

fn server_log_path(data_dir: &Path) -> PathBuf {
    data_dir.join("agent-server.log")
}

fn open_server_log(data_dir: &Path) -> Result<fs::File, String> {
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(server_log_path(data_dir))
        .map_err(|error| format!("Could not open agent server log: {error}"))
}

fn wait_for_server(timeout: Duration) -> Result<(), String> {
    let started_at = Instant::now();
    while started_at.elapsed() < timeout {
        if is_server_reachable() {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(150));
    }
    Err("Agent server did not become reachable on 127.0.0.1:3367.".to_string())
}

fn is_server_reachable() -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], SERVER_PORT));
    TcpStream::connect_timeout(&addr, Duration::from_millis(200)).is_ok()
}

fn server_allows_tauri_origin() -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], SERVER_PORT));
    let mut stream = match TcpStream::connect_timeout(&addr, Duration::from_millis(300)) {
        Ok(stream) => stream,
        Err(_) => return false,
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(700)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(300)));

    if stream
        .write_all(
            b"GET /health HTTP/1.1\r\nHost: 127.0.0.1:3367\r\nOrigin: http://tauri.localhost\r\nConnection: close\r\n\r\n",
        )
        .is_err()
    {
        return false;
    }

    let mut response = String::new();
    if stream.read_to_string(&mut response).is_err() {
        return false;
    }

    http_response_allows_tauri_origin(&response)
}

fn http_response_allows_tauri_origin(response: &str) -> bool {
    response
        .lines()
        .take_while(|line| !line.trim().is_empty())
        .any(|line| {
            line.eq_ignore_ascii_case("access-control-allow-origin: http://tauri.localhost")
                || line.eq_ignore_ascii_case("access-control-allow-origin: *")
        })
}

fn stop_managed_server(state: &AgentServerState) {
    if let Ok(mut child_slot) = state.child.lock() {
        if let Some(mut child) = child_slot.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
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
        .build(tauri::generate_context!())
        .expect("error while running Colorful Code desktop app");

    app.run(|app_handle, event| match event {
        tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit => {
            stop_managed_server(app_handle.state::<AgentServerState>().inner());
        }
        _ => {}
    });
}

#[cfg(test)]
mod tests {
    use super::is_workspace_root;
    use super::{
        find_workspace_root_from, http_response_allows_tauri_origin, server_log_path,
        source_database_path, source_server_directory, stop_managed_server, workspace_root,
        AgentServerState, SERVER_BASE_URL, SERVER_PORT, SERVER_SIDECAR_NAME,
    };
    use std::path::{Path, PathBuf};
    use std::process::Command;
    use std::time::Duration;

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
    fn managed_source_server_uses_the_server_package_directory() {
        let root = Path::new("/repo");
        assert_eq!(
            source_server_directory(root),
            PathBuf::from("/repo/apps/server")
        );
    }

    #[test]
    fn managed_source_server_uses_the_server_data_database_path() {
        let root = Path::new("/repo");
        assert_eq!(
            source_database_path(root),
            PathBuf::from("/repo/apps/server/data/colorful-code.db")
        );
    }

    #[test]
    fn sidecar_name_matches_the_tauri_external_binary_name() {
        assert_eq!(SERVER_SIDECAR_NAME, "colorful-code-server");
    }

    #[test]
    fn desktop_agent_server_uses_the_packaged_default_port() {
        assert_eq!(SERVER_PORT, 3367);
        assert_eq!(SERVER_BASE_URL, "http://127.0.0.1:3367");
    }

    #[test]
    fn managed_sidecar_writes_to_a_stable_log_file() {
        assert_eq!(
            server_log_path(Path::new("/Users/example/Library/Application Support/com.colorfulcode.desktop")),
            PathBuf::from(
                "/Users/example/Library/Application Support/com.colorfulcode.desktop/agent-server.log"
            )
        );
    }

    #[test]
    fn stop_managed_server_terminates_the_tracked_child() {
        let state = AgentServerState::default();
        let child = Command::new("sh")
            .arg("-c")
            .arg("sleep 30")
            .spawn()
            .expect("spawn test child");
        let child_id = child.id();

        *state.child.lock().expect("state lock") = Some(child);

        stop_managed_server(&state);
        std::thread::sleep(Duration::from_millis(50));

        let still_running = Command::new("kill")
            .arg("-0")
            .arg(child_id.to_string())
            .stderr(std::process::Stdio::null())
            .status()
            .expect("probe test child")
            .success();
        assert!(!still_running);
        assert!(state.child.lock().expect("state lock").is_none());
    }

    #[test]
    fn server_origin_probe_accepts_tauri_cors_header() {
        assert!(http_response_allows_tauri_origin(
            "HTTP/1.1 200 OK\r\nAccess-Control-Allow-Origin: http://tauri.localhost\r\n\r\n{}"
        ));
        assert!(http_response_allows_tauri_origin(
            "HTTP/1.1 200 OK\r\naccess-control-allow-origin: *\r\n\r\n{}"
        ));
    }

    #[test]
    fn server_origin_probe_rejects_missing_or_wrong_cors_header() {
        assert!(!http_response_allows_tauri_origin(
            "HTTP/1.1 200 OK\r\nVary: Origin\r\n\r\n{}"
        ));
        assert!(!http_response_allows_tauri_origin(
            "HTTP/1.1 200 OK\r\nAccess-Control-Allow-Origin: http://localhost:3000\r\n\r\n{}"
        ));
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
    fn macos_transport_security_allows_local_agent_http() {
        let plist = include_str!("../Info.plist");

        assert!(plist.contains("<key>NSAppTransportSecurity</key>"));
        assert!(plist.contains("<key>NSAllowsLocalNetworking</key>"));
        assert!(plist.contains("<true/>"));
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
        assert!(
            bridge.find("privacyUsageDescriptionError").unwrap()
                < bridge.find("requestSpeechAuthorization").unwrap()
        );
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

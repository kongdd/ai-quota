use serde_json::{json, Map, Value};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager};

const VIRTUAL_PI_AUTH: &str = "/pi/auth.json";
const VIRTUAL_LEDGER: &str = "/config/ai-quota/api-usage.json";

fn home_dir() -> Result<PathBuf, String> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .ok_or("home directory not found".into())
}

fn config_dir(home: &Path) -> PathBuf {
    std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".config"))
}

fn pi_auth_path(home: &Path) -> PathBuf {
    std::env::var_os("PI_CONFIG_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".pi/agent"))
        .join("auth.json")
}

fn read_text(path: &Path) -> Option<String> {
    fs::read_to_string(path).ok()
}

fn append_log_file(path: &Path, message: &str) -> Result<(), String> {
    if message.len() > 16 * 1024 {
        return Err("log line exceeds 16 KiB".into());
    }
    let message = message.replace('\r', " ").replace('\n', " ");
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|error| error.to_string())?;
    writeln!(file, "{message}").map_err(|error| error.to_string())
}

#[tauri::command]
fn append_log(message: String) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|error| error.to_string())?;
    append_log_file(&exe.with_file_name("log.txt"), &message)
}

#[tauri::command]
fn read_runtime() -> Result<String, String> {
    let home = home_dir()?;
    let config = config_dir(&home);
    let pi_path = pi_auth_path(&home);
    let codex = std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".codex"));
    let claude = std::env::var_os("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".claude"));
    let opencode = std::env::var_os("OPENCODE_GO_ENV")
        .map(PathBuf::from)
        .unwrap_or_else(|| config.join("ai-quota/opencode.env"));
    let sources = [
        (VIRTUAL_PI_AUTH, pi_path.clone()),
        ("/home/user/.codex/auth.json", codex.join("auth.json")),
        (
            "/home/user/.claude/.credentials.json",
            claude.join(".credentials.json"),
        ),
        ("/home/user/.grok/auth.json", home.join(".grok/auth.json")),
        (
            "/config/ai-quota/auth.json",
            config.join("ai-quota/auth.json"),
        ),
        (
            "/config/ai-quota/config.json",
            config.join("ai-quota/config.json"),
        ),
        (VIRTUAL_LEDGER, config.join("ai-quota/api-usage.json")),
        ("/home/user/.config/ai-quota/opencode.env", opencode),
    ];
    let files: Map<String, Value> = sources
        .iter()
        .filter_map(|(virtual_path, path)| {
            read_text(path).map(|text| ((*virtual_path).into(), Value::String(text)))
        })
        .collect();
    let keys = [
        "MINIMAX_CN_API_KEY",
        "MINIMAX_API_KEY",
        "DEEPSEEK_API_KEY",
        "DEEPSEEK_CURRENCY",
        "DEEPSEEK_DAILY_BUDGET",
        "DEEPSEEK_BUDGET",
        "DEEPSEEK_WEEKLY_BUDGET",
        "DEEPSEEK_MONTHLY_BUDGET",
        "KIMI_API_KEY",
        "KIMI_CODING_API_KEY",
        "MOONSHOT_API_KEY",
        "ZHIPU_CN_API_KEY",
        "ZHIPU_API_KEY",
        "OPENCODE_GO_WORKSPACE_ID",
        "OPENCODE_GO_AUTH_COOKIE",
        "OPENCODE_SERVER",
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "NO_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
        "no_proxy",
    ];
    let mut env = Map::new();
    env.insert("PI_CONFIG_DIR".into(), Value::String("/pi".into()));
    env.insert("XDG_CONFIG_HOME".into(), Value::String("/config".into()));
    for key in keys {
        if let Ok(value) = std::env::var(key) {
            env.insert(key.into(), Value::String(value));
        }
    }
    serde_json::to_string(&json!({
        "home": "/home/user",
        "platform": if cfg!(windows) { "win32" } else { "linux" },
        "env": env,
        "files": files,
    }))
    .map_err(|error| error.to_string())
}

fn write_atomic(path: &Path, contents: &str) -> Result<(), String> {
    if contents.len() > 512 * 1024 {
        return Err("state file exceeds 512 KiB".into());
    }
    fs::create_dir_all(path.parent().ok_or("invalid state path")?)
        .map_err(|error| error.to_string())?;
    let temporary = path.with_extension("tmp");
    fs::write(&temporary, contents).map_err(|error| error.to_string())?;
    #[cfg(windows)]
    if path.exists() {
        fs::remove_file(path).map_err(|error| error.to_string())?;
    }
    fs::rename(temporary, path).map_err(|error| error.to_string())
}

#[tauri::command]
fn write_runtime(writes: String) -> Result<(), String> {
    let values: Map<String, Value> = serde_json::from_str::<Value>(&writes)
        .map_err(|error| error.to_string())?
        .as_object()
        .cloned()
        .ok_or("runtime writes must be an object")?;
    let home = home_dir()?;
    let config = config_dir(&home);
    for (virtual_path, value) in values {
        let contents = value.as_str().ok_or("runtime write must be text")?;
        let path = match virtual_path.as_str() {
            VIRTUAL_PI_AUTH => pi_auth_path(&home),
            VIRTUAL_LEDGER => config.join("ai-quota/api-usage.json"),
            path if path.starts_with("/pi/auth.json.bak-")
                && path["/pi/auth.json.bak-".len()..]
                    .chars()
                    .all(|c| c.is_ascii_digit()) =>
            {
                PathBuf::from(format!(
                    "{}.{}",
                    pi_auth_path(&home).display(),
                    &path["/pi/auth.json.".len()..]
                ))
            }
            _ => return Err(format!("runtime write denied: {virtual_path}")),
        };
        write_atomic(&path, contents)?;
    }
    Ok(())
}

fn glyph(character: char) -> [u8; 5] {
    match character {
        '0' => [7, 5, 5, 5, 7],
        '1' => [2, 6, 2, 2, 7],
        '2' => [7, 1, 7, 4, 7],
        '3' => [7, 1, 7, 1, 7],
        '4' => [5, 5, 7, 1, 1],
        '5' => [7, 4, 7, 1, 7],
        '6' => [7, 4, 7, 5, 7],
        '7' => [7, 1, 2, 2, 2],
        '8' => [7, 5, 7, 5, 7],
        '9' => [7, 5, 7, 1, 7],
        '%' => [5, 1, 2, 4, 5],
        '￥' | '¥' => [5, 5, 2, 7, 2],
        '.' => [0, 0, 0, 0, 2],
        '-' => [0, 0, 7, 0, 0],
        _ => [0, 0, 0, 0, 0],
    }
}

fn tray_image(text: &str, tone: &str) -> Image<'static> {
    const SIZE: usize = 32;
    let color = match tone {
        "safe" => [47, 191, 102],
        "warn" => [229, 164, 35],
        "danger" => [224, 85, 74],
        "balance" => [86, 95, 194],
        _ => [24, 62, 40],
    };
    let mut rgba = vec![0; SIZE * SIZE * 4];
    for y in 0..SIZE {
        for x in 0..SIZE {
            if (x < 2 || x >= SIZE - 2) && (y < 2 || y >= SIZE - 2) {
                continue;
            }
            let pixel = (y * SIZE + x) * 4;
            rgba[pixel..pixel + 3].copy_from_slice(&color);
            rgba[pixel + 3] = 255;
        }
    }

    let characters: Vec<char> = text.chars().take(8).collect();
    let count = characters.len().max(1);
    let scale_x = ((SIZE - 2 - count.saturating_sub(1)) / (count * 3)).max(1);
    let scale_y = 5;
    let width = count * 3 * scale_x + count.saturating_sub(1);
    let left = SIZE.saturating_sub(width) / 2;
    let top = (SIZE - 5 * scale_y) / 2;
    for (index, character) in characters.into_iter().enumerate() {
        for (row, bits) in glyph(character).into_iter().enumerate() {
            for column in 0..3 {
                if bits & (1 << (2 - column)) == 0 {
                    continue;
                }
                for dy in 0..scale_y {
                    for dx in 0..scale_x {
                        let x = left + index * (3 * scale_x + 1) + column * scale_x + dx;
                        let y = top + row * scale_y + dy;
                        let pixel = (y * SIZE + x) * 4;
                        rgba[pixel..pixel + 4].copy_from_slice(&[255, 255, 255, 255]);
                    }
                }
            }
        }
    }
    Image::new_owned(rgba, SIZE as u32, SIZE as u32)
}

#[tauri::command]
fn set_tray_display(
    app: tauri::AppHandle,
    text: String,
    tone: String,
    tooltip: String,
) -> Result<(), String> {
    let tray = app.tray_by_id("quota").ok_or("tray icon not found")?;
    tray.set_icon(Some(tray_image(&text, &tone)))
        .map_err(|error| error.to_string())?;
    tray.set_tooltip(Some(tooltip))
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn hide_window(app: tauri::AppHandle) -> Result<(), String> {
    app.get_webview_window("main")
        .ok_or("main window not found")?
        .hide()
        .map_err(|error| error.to_string())
}

fn show_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn setup_tray(app: &mut tauri::App) -> tauri::Result<()> {
    let refresh_all = MenuItem::with_id(app, "refresh-all", "刷新全部", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "设置", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&refresh_all, &settings, &quit])?;

    TrayIconBuilder::with_id("quota")
        .icon(tray_image("--", "idle"))
        .tooltip("AI Quota")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().0.as_str() {
            "refresh-all" => {
                let _ = app.emit("tray-refresh-all", ());
            }
            "settings" => show_window(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_window(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .setup(|app| {
            setup_tray(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            hide_window,
            set_tray_display,
            read_runtime,
            write_runtime,
            append_log
        ])
        .run(tauri::generate_context!())
        .expect("error while running AI Quota");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_single_line_log() {
        let path = std::env::temp_dir().join(format!("ai-quota-{}.log", std::process::id()));
        let _ = fs::remove_file(&path);
        append_log_file(&path, "first\nsecond").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "first second\n");
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn renders_quota_and_balance_icons() {
        for text in ["07", "100", "￥8.5"] {
            let image = tray_image(text, "safe");
            let white: Vec<_> = image
                .rgba()
                .chunks_exact(4)
                .enumerate()
                .filter(|(_, pixel)| *pixel == [255, 255, 255, 255])
                .map(|(index, _)| (index % 32, index / 32))
                .collect();
            let width = white.iter().map(|(x, _)| x).max().unwrap()
                - white.iter().map(|(x, _)| x).min().unwrap()
                + 1;
            let height = white.iter().map(|(_, y)| y).max().unwrap()
                - white.iter().map(|(_, y)| y).min().unwrap()
                + 1;
            assert!(width >= 25 && height == 25, "{text}: {width}x{height}");
        }
    }
}

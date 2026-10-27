use super::{append_log, config_dir, home_dir, read_runtime, set_tray_display, write_atomic, write_runtime};
use chrono::{Local, Timelike};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{Emitter, Manager};

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Config {
    target: String,
    refresh_seconds: u64,
    refresh_limit: u32,
    quiet_start: u32,
    quiet_end: u32,
    paused: bool,
}

impl Default for Config {
    fn default() -> Self {
        Self { target: String::new(), refresh_seconds: 120, refresh_limit: 30,
            quiet_start: 23, quiet_end: 8, paused: false }
    }
}

impl Config {
    fn validate(&self) -> Result<(), String> {
        if self.refresh_seconds == 0 || self.refresh_seconds > 86400 || self.refresh_limit == 0
            || self.quiet_start > 23 || self.quiet_end > 23 {
            return Err("间隔须为 1–86400 秒，次数须大于 0，静默时间须为 0–23".into());
        }
        Ok(())
    }

    fn quiet(&self, hour: u32) -> bool {
        if self.quiet_start == self.quiet_end { return false; }
        if self.quiet_start < self.quiet_end {
            hour >= self.quiet_start && hour < self.quiet_end
        } else {
            hour >= self.quiet_start || hour < self.quiet_end
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct View {
    config: Config,
    snapshot: Option<Value>,
    auto_left: u32,
    error: String,
    silent: bool,
    revision: u64,
}

struct Data {
    view: View,
    targets: Vec<Value>,
    initialized: bool,
    initial_pending: bool,
    next_due: u64,
}

struct Monitor {
    data: Mutex<Data>,
    query: Mutex<()>,
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64
}

fn settings_path() -> Result<std::path::PathBuf, String> {
    Ok(config_dir(&home_dir()?).join("ai-quota/desktop.json"))
}

fn persist(data: &Data) -> Result<(), String> {
    write_atomic(&settings_path()?, &json!({
        "config": data.view.config, "autoLeft": data.view.auto_left,
    }).to_string())
}

fn publish(app: &tauri::AppHandle, data: &mut Data) {
    data.view.revision = data.view.revision.wrapping_add(1);
    let selected = data.targets.iter().find(|target| target["id"].as_str() == Some(&data.view.config.target))
        .or_else(|| data.targets.first());
    let text = selected.and_then(|t| t["text"].as_str()).unwrap_or("--").replace('%', "");
    let tone = selected.and_then(|t| t["tone"].as_str()).unwrap_or("idle");
    let tooltip = selected.and_then(|t| t["tooltip"].as_str()).unwrap_or("AI Quota：等待额度数据");
    let _ = set_tray_display(app.clone(), text, tone.into(), tooltip.into());
    let _ = app.emit("monitor-updated", &data.view);
}

fn worker_path() -> Result<std::path::PathBuf, String> {
    let ext = if cfg!(windows) { ".exe" } else { "" };
    let triple = format!("ai-quota-worker-{}{ext}", env!("WORKER_TARGET"));
    let mut candidates = Vec::new();
    if let Some(dir) = std::env::current_exe().ok().and_then(|path| path.parent().map(std::path::Path::to_path_buf)) {
        candidates.push(dir.join(&triple));
        candidates.push(dir.join(format!("ai-quota-worker{ext}")));
    }
    candidates.push(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("binaries").join(triple));
    candidates.iter().find(|path| path.exists()).cloned().ok_or_else(|| {
        format!("找不到查询进程：{}", candidates.iter().map(|path| path.display().to_string()).collect::<Vec<_>>().join("，"))
    })
}

// The bundled worker reuses the TypeScript providers, without a WebView or installed Node.js.
fn run_worker(input: Value) -> Result<Value, String> {
    let path = worker_path()?;
    let mut command = Command::new(&path);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let mut child = command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped())
        .spawn().map_err(|e| format!("启动查询进程失败：{}：{e}", path.display()))?;
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let read = |mut pipe: Box<dyn Read + Send>| std::thread::spawn(move || {
        let mut bytes = Vec::new();
        pipe.read_to_end(&mut bytes).map(|_| bytes)
    });
    let output = read(Box::new(stdout));
    let logs = read(Box::new(stderr));
    let result: Result<_, String> = (|| {
        child.stdin.take().unwrap().write_all(input.to_string().as_bytes()).map_err(|e| e.to_string())?;
        let started = Instant::now();
        loop {
            if let Some(status) = child.try_wait().map_err(|e| e.to_string())? { return Ok(status); }
            if started.elapsed() >= Duration::from_secs(35) { return Err("查询超时（35 秒）".into()); }
            std::thread::sleep(Duration::from_millis(100));
        }
    })();
    if result.is_err() { let _ = child.kill(); }
    let _ = child.wait();
    let output = output.join().map_err(|_| "读取查询结果失败")?.map_err(|e| e.to_string())?;
    let logs = logs.join().map_err(|_| "读取查询日志失败")?.map_err(|e| e.to_string())?;
    let logs = String::from_utf8_lossy(&logs);
    for line in logs.lines() { let _ = append_log(line.into()); }
    if !result?.success() {
        return Err(logs.lines().last().unwrap_or("查询进程失败").to_string());
    }
    serde_json::from_slice(&output).map_err(|e| format!("解析查询结果失败：{e}"))
}

fn refresh(app: &tauri::AppHandle, provider: Option<String>) -> View {
    let monitor = app.state::<Monitor>();
    let previous = monitor.data.lock().unwrap().view.snapshot.clone();
    let result = (|| {
        let runtime: Value = serde_json::from_str(&read_runtime()?).map_err(|e| e.to_string())?;
        let result = run_worker(json!({
            "runtime": runtime, "providers": provider.map(|p| vec![p]),
            "previous": previous.as_ref().map(|s| &s["providers"]).unwrap_or(&json!([])),
        }))?;
        write_runtime(result["writes"].to_string())?;
        Ok::<_, String>(result)
    })();
    let mut data = monitor.data.lock().unwrap();
    match result {
        Ok(result) => {
            data.view.snapshot = Some(result["snapshot"].clone());
            data.targets = result["targets"].as_array().cloned().unwrap_or_default();
            data.view.error.clear();
        }
        Err(error) => data.view.error = format!("{error}（详见 log.txt）"),
    }
    data.view.silent = data.view.config.quiet(Local::now().hour());
    publish(app, &mut data);
    data.view.clone()
}

#[tauri::command]
pub fn start_monitor(app: tauri::AppHandle, config: Config) -> Result<View, String> {
    let monitor = app.state::<Monitor>();
    let mut data = monitor.data.lock().unwrap();
    if !data.initialized {
        config.validate()?;
        data.view.auto_left = config.refresh_limit;
        data.view.config = config;
        persist(&data)?;
        data.initialized = true;
        data.initial_pending = true;
    }
    Ok(data.view.clone())
}

#[tauri::command]
pub fn get_monitor(app: tauri::AppHandle) -> View {
    let monitor = app.state::<Monitor>();
    let mut data = monitor.data.lock().unwrap();
    data.view.silent = data.view.config.quiet(Local::now().hour());
    data.view.clone()
}

#[tauri::command]
pub fn configure_monitor(app: tauri::AppHandle, config: Config) -> Result<View, String> {
    config.validate()?;
    let monitor = app.state::<Monitor>();
    let mut data = monitor.data.lock().unwrap();
    if (data.view.config.paused && !config.paused) || data.view.config.refresh_limit != config.refresh_limit {
        data.view.auto_left = config.refresh_limit;
    }
    if data.view.config.refresh_seconds != config.refresh_seconds || data.view.config.paused != config.paused {
        data.next_due = now_ms() + config.refresh_seconds * 1000;
    }
    data.view.silent = config.quiet(Local::now().hour());
    data.view.config = config;
    let start = !data.initialized;
    persist(&data)?;
    if start {
        data.initialized = true;
        data.initial_pending = true;
    }
    publish(&app, &mut data);
    Ok(data.view.clone())
}

#[tauri::command]
pub async fn refresh_monitor(app: tauri::AppHandle, provider: Option<String>) -> Result<View, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let monitor = app.state::<Monitor>();
        let _query = monitor.query.lock().unwrap();
        refresh(&app, provider)
    }).await.map_err(|e| e.to_string())
}

pub fn setup(app: &mut tauri::App) {
    let saved = settings_path().ok().and_then(|path| std::fs::read(path).ok())
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok());
    let config = saved.as_ref().and_then(|saved| serde_json::from_value::<Config>(saved["config"].clone()).ok())
        .filter(|config| config.validate().is_ok());
    let initialized = config.is_some();
    let config = config.unwrap_or_default();
    let auto_left = saved.as_ref().and_then(|s| s["autoLeft"].as_u64())
        .map(|n| n.min(config.refresh_limit as u64) as u32).unwrap_or(config.refresh_limit);
    app.manage(Monitor {
        data: Mutex::new(Data {
            view: View { config, auto_left, snapshot: None, error: String::new(), silent: false, revision: 0 },
            targets: Vec::new(), initialized, initial_pending: initialized, next_due: 0,
        }),
        query: Mutex::new(()),
    });
    let app = app.handle().clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(500));
        let monitor = app.state::<Monitor>();
        let Ok(_query) = monitor.query.try_lock() else { continue; };
        let initial = {
            let mut data = monitor.data.lock().unwrap();
            if !data.initialized { continue; }
            let silent = data.view.config.quiet(Local::now().hour());
            if data.view.silent != silent {
                data.view.silent = silent;
                publish(&app, &mut data);
            }
            let initial = data.initial_pending;
            let due = !data.view.config.paused && now_ms() >= data.next_due && !silent;
            if !initial && !due { continue; }
            data.initial_pending = false;
            data.next_due = now_ms() + data.view.config.refresh_seconds * 1000;
            initial
        };
        refresh(&app, None);
        if !initial {
            let mut data = monitor.data.lock().unwrap();
            if !data.view.error.is_empty() { continue; }
            data.view.auto_left = data.view.auto_left.saturating_sub(1);
            if data.view.auto_left == 0 { data.view.config.paused = true; }
            if let Err(error) = persist(&data) { let _ = append_log(error); }
            publish(&app, &mut data);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quiet_hours_include_cross_midnight_and_disabled() {
        let mut config = Config::default();
        assert!(config.quiet(23) && config.quiet(0) && config.quiet(7));
        assert!(!config.quiet(8) && !config.quiet(22));
        config.quiet_start = 9;
        config.quiet_end = 17;
        assert!(config.quiet(9) && !config.quiet(17));
        config.quiet_end = 9;
        assert!(!config.quiet(9));
    }

    #[test]
    fn rejects_invalid_settings() {
        assert!(Config::default().validate().is_ok());
        let mut config = Config::default();
        config.refresh_seconds = 0;
        assert!(config.validate().is_err());
    }
}

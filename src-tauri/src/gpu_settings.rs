use std::{fs, path::Path};
use tauri::Manager;

fn read_enabled(path: &Path) -> Result<Option<bool>, String> {
    match fs::read_to_string(path) {
        Ok(value) => serde_json::from_str(&value).map(Some).map_err(|error| error.to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

fn settings_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    app.path().app_config_dir().map(|path| path.join("hardware-acceleration.json"))
        .map_err(|error| error.to_string())
}

#[derive(serde::Serialize)]
pub struct AccelerationSetting {
    supported: bool,
    enabled: Option<bool>,
    policy_error: bool,
}

#[tauri::command]
pub fn hardware_acceleration(app: tauri::AppHandle) -> Result<AccelerationSetting, String> {
    if !cfg!(target_os = "linux") {
        return Ok(AccelerationSetting { supported: false, enabled: None, policy_error: false });
    }
    let enabled = read_enabled(&settings_path(&app)?)?;
    let policy_error = app.state::<std::sync::Mutex<bool>>().lock().map(|error| *error).unwrap_or(true);
    Ok(AccelerationSetting { supported: true, enabled, policy_error })
}

fn write_enabled(path: &Path, enabled: bool) -> Result<(), String> {
    fs::create_dir_all(path.parent().ok_or("Invalid settings path")?).map_err(|error| error.to_string())?;
    fs::write(path, enabled.to_string()).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn set_hardware_acceleration(app: tauri::AppHandle, enabled: Option<bool>) -> Result<(), String> {
    if !cfg!(target_os = "linux") {
        return Err("Hardware acceleration control is not supported on this platform".into());
    }
    let path = settings_path(&app)?;
    match enabled {
        Some(enabled) => write_enabled(&path, enabled),
        None => match fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error.to_string()),
        },
    }
}

pub fn create_window(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    #[cfg(target_os = "linux")]
    let enabled = settings_path(app.handle()).and_then(|path| read_enabled(&path)).unwrap_or_else(|error| {
        eprintln!("Could not read hardware acceleration setting: {error}");
        None
    });
    app.manage(std::sync::Mutex::new(false));
    let config = &app.config().app.windows[0];
    let builder = tauri::WebviewWindowBuilder::from_config(app, config)?;
    let window = builder.build()?;
    #[cfg(target_os = "linux")]
    {
        let app_handle = app.handle().clone();
        if let Err(error) = window.with_webview(move |view| {
            let Some(enabled) = enabled else { return; };
            use webkit2gtk::{SettingsExt, WebViewExt};
            let result = view.inner().settings().ok_or("WebKit settings unavailable").and_then(|settings| {
                let policy = if enabled { webkit2gtk::HardwareAccelerationPolicy::OnDemand }
                    else { webkit2gtk::HardwareAccelerationPolicy::Never };
                settings.set_hardware_acceleration_policy(policy);
                if settings.hardware_acceleration_policy() == policy { Ok(()) }
                else { Err("WebKit rejected hardware acceleration policy") }
            });
            if let Err(error) = result {
                eprintln!("{error}");
                if let Ok(mut failed) = app_handle.state::<std::sync::Mutex<bool>>().lock() {
                    *failed = true;
                }
            }
        }) {
            eprintln!("Could not apply hardware acceleration policy: {error}");
            if let Ok(mut failed) = app.state::<std::sync::Mutex<bool>>().lock() {
                *failed = true;
            }
        }
    }
    #[cfg(not(target_os = "linux"))]
    let _ = window;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn defaults_and_rejects_invalid_settings() {
        let path = std::env::temp_dir().join(format!("ss14-gpu-setting-{}", std::process::id()));
        let _ = fs::remove_file(&path);
        assert_eq!(read_enabled(&path).unwrap(), None);
        write_enabled(&path, false).unwrap();
        assert_eq!(read_enabled(&path).unwrap(), Some(false));
        write_enabled(&path, true).unwrap();
        assert_eq!(read_enabled(&path).unwrap(), Some(true));
        fs::write(&path, "").unwrap();
        assert!(read_enabled(&path).is_err());
        fs::write(&path, "invalid").unwrap();
        assert!(read_enabled(&path).is_err());
        fs::remove_file(path).unwrap();
    }
}

use std::{fs, path::Path};
use tauri::Manager;

fn read_enabled(path: &Path) -> Result<bool, String> {
    match fs::read_to_string(path) {
        Ok(value) => serde_json::from_str(&value).map_err(|error| error.to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(true),
        Err(error) => Err(error.to_string()),
    }
}

fn settings_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    app.path().app_config_dir().map(|path| path.join("hardware-acceleration.json"))
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn hardware_acceleration(app: tauri::AppHandle) -> Result<Option<bool>, String> {
    if !cfg!(any(target_os = "linux", target_os = "windows")) { return Ok(None); }
    read_enabled(&settings_path(&app)?).map(Some)
}

fn write_enabled(path: &Path, enabled: bool) -> Result<(), String> {
    fs::create_dir_all(path.parent().ok_or("Invalid settings path")?).map_err(|error| error.to_string())?;
    fs::write(path, enabled.to_string()).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn set_hardware_acceleration(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    if !cfg!(any(target_os = "linux", target_os = "windows")) {
        return Err("Hardware acceleration control is not supported on this platform".into());
    }
    write_enabled(&settings_path(&app)?, enabled)
}

pub fn create_window(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let enabled = settings_path(app.handle()).and_then(|path| read_enabled(&path)).unwrap_or(true);
    let config = &app.config().app.windows[0];
    let builder = tauri::WebviewWindowBuilder::from_config(app, config)?;
    #[cfg(target_os = "windows")]
    let builder = if enabled { builder } else { builder.additional_browser_args("--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --disable-gpu") };
    let window = builder.build()?;
    #[cfg(target_os = "linux")]
    if !enabled {
        use webkit2gtk::{SettingsExt, WebViewExt};
        window.with_webview(|view| {
            if let Some(settings) = view.inner().settings() {
                settings.set_hardware_acceleration_policy(webkit2gtk::HardwareAccelerationPolicy::Never);
            }
        })?;
    }
    #[cfg(not(target_os = "linux"))]
    let _ = (enabled, window);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn defaults_and_rejects_invalid_settings() {
        let path = std::env::temp_dir().join(format!("ss14-gpu-setting-{}", std::process::id()));
        let _ = fs::remove_file(&path);
        assert_eq!(read_enabled(&path).unwrap(), true);
        write_enabled(&path, false).unwrap();
        assert_eq!(read_enabled(&path).unwrap(), false);
        write_enabled(&path, true).unwrap();
        assert_eq!(read_enabled(&path).unwrap(), true);
        fs::write(&path, "invalid").unwrap();
        assert!(read_enabled(&path).is_err());
        fs::remove_file(path).unwrap();
    }
}

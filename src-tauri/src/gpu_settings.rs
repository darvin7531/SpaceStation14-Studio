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
    if !cfg!(target_os = "linux") { return Ok(None); }
    read_enabled(&settings_path(&app)?).map(Some)
}

fn write_enabled(path: &Path, enabled: bool) -> Result<(), String> {
    fs::create_dir_all(path.parent().ok_or("Invalid settings path")?).map_err(|error| error.to_string())?;
    fs::write(path, enabled.to_string()).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn set_hardware_acceleration(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    if !cfg!(target_os = "linux") {
        return Err("Hardware acceleration control is not supported on this platform".into());
    }
    write_enabled(&settings_path(&app)?, enabled)
}

pub fn create_window(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    #[cfg(target_os = "linux")]
    let enabled = settings_path(app.handle()).and_then(|path| read_enabled(&path))
        .map_err(std::io::Error::other)?;
    let config = &app.config().app.windows[0];
    let builder = tauri::WebviewWindowBuilder::from_config(app, config)?;
    #[cfg(target_os = "linux")]
    let builder = builder.visible(false);
    let window = builder.build()?;
    #[cfg(target_os = "linux")]
    {
        let visible = config.visible;
        let window_for_callback = window.clone();
        window.with_webview(move |view| {
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
                std::process::exit(1);
            }
            if visible {
                if let Err(error) = window_for_callback.show() {
                    eprintln!("Could not show window: {error}");
                    std::process::exit(1);
                }
            }
        })?;
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

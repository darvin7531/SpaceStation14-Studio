//! Electron update check/install parity for signed Tauri artifacts only.
//! The optional compile-time public key is a release prerequisite. In ordinary
//! CI builds, the updater is disabled and never requests existing Electron assets.
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Url};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::error::{internal_lock, StudioError};

const MANIFEST_URL: &str =
    "https://github.com/darvin7531/SpaceStation14-Studio/releases/download/beta-updates/tauri-latest.json";

#[derive(Default)]
pub struct PendingUpdate(pub Mutex<Option<Update>>);

#[derive(Serialize)]
pub struct UpdateStatus {
    pub status: &'static str,
    pub current_version: String,
    pub available_version: Option<String>,
    pub message: String,
}

#[derive(Clone, Serialize)]
pub struct UpdateProgress {
    pub event: &'static str,
    pub downloaded_bytes: u64,
    pub total_bytes: Option<u64>,
}

fn issue(code: &'static str, message: &str, hint: &str) -> StudioError {
    StudioError::new(code, message, hint)
}

fn public_key() -> Option<&'static str> {
    option_env!("SS14_STUDIO_UPDATER_PUBKEY").filter(|value| !value.trim().is_empty())
}

pub fn register(app: &mut tauri::App) -> Result<(), tauri::Error> {
    if let Some(key) = public_key() {
        app.handle()
            .plugin(tauri_plugin_updater::Builder::new().pubkey(key).build())?;
    }
    Ok(())
}

pub async fn check(app: AppHandle, pending: &PendingUpdate) -> Result<UpdateStatus, StudioError> {
    *pending.0.lock().map_err(|_| internal_lock())? = None;
    let version = app.package_info().version.to_string();
    if public_key().is_none() {
        return Ok(UpdateStatus {
            status: "disabled",
            current_version: version,
            available_version: None,
            message: "Обновления Tauri отключены: сборка не содержит публичного ключа подписи."
                .into(),
        });
    }

    let endpoint = Url::parse(MANIFEST_URL).map_err(|reason| {
        issue(
            "UPDATE_CONFIG_FAILED",
            "Некорректный URL Tauri-манифеста.",
            "Исправьте адрес файла обновлений в релизной конфигурации.",
        )
        .with_details(reason.to_string())
    })?;
    let update = app
        .updater_builder()
        .endpoints(vec![endpoint])
        .map_err(|reason| {
            issue(
                "UPDATE_CONFIG_FAILED",
                "Не удалось настроить адрес подписанного Tauri-манифеста.",
                "Проверьте URL и конфигурацию релизной сборки.",
            )
            .with_details(reason.to_string())
        })?
        .build()
        .map_err(|reason| {
            issue(
                "UPDATE_CONFIG_FAILED",
                "Не удалось создать проверку Tauri-обновлений.",
                "Проверьте публичный ключ подписи и параметры updater.",
            )
            .with_details(reason.to_string())
        })?
        .check()
        .await
        .map_err(|reason| {
            issue(
                "UPDATE_CHECK_FAILED",
                "Не удалось проверить подписанное Tauri-обновление.",
                "Убедитесь, что опубликован tauri-latest.json и доступен GitHub.",
            )
            .with_details(reason.to_string())
        })?;
    let available_version = update.as_ref().map(|found| found.version.clone());
    *pending.0.lock().map_err(|_| internal_lock())? = update;
    Ok(UpdateStatus {
        status: if available_version.is_some() {
            "available"
        } else {
            "unavailable"
        },
        current_version: version,
        message: match &available_version {
            Some(number) => format!("Найдено подписанное Tauri-обновление {number}."),
            None => "Подписанных обновлений Tauri нет.".into(),
        },
        available_version,
    })
}

pub async fn install(app: AppHandle, pending: &PendingUpdate) -> Result<(), StudioError> {
    if public_key().is_none() {
        return Err(issue(
            "UPDATE_NOT_CONFIGURED",
            "Обновления Tauri не настроены в этой сборке.",
            "Создайте подписанный релиз Rust-приложения с публичным ключом.",
        ));
    }
    let update = pending
        .0
        .lock()
        .map_err(|_| internal_lock())?
        .take()
        .ok_or_else(|| {
            issue(
                "UPDATE_NOT_CHECKED",
                "Нет проверенного Tauri-обновления для установки.",
                "Сначала проверьте обновления в настройках редактора.",
            )
        })?;

    let download_app = app.clone();
    let finish_app = app.clone();
    let mut downloaded = 0_u64;
    update
        .download_and_install(
            move |chunk_length, total_length| {
                downloaded = downloaded.saturating_add(chunk_length as u64);
                let _ = download_app.emit(
                    "studio:update-progress",
                    UpdateProgress {
                        event: "downloading",
                        downloaded_bytes: downloaded,
                        total_bytes: total_length,
                    },
                );
            },
            move || {
                let _ = finish_app.emit(
                    "studio:update-progress",
                    UpdateProgress {
                        event: "finished",
                        downloaded_bytes: 0,
                        total_bytes: None,
                    },
                );
            },
        )
        .await
        .map_err(|reason| {
            issue(
                "UPDATE_INSTALL_FAILED",
                "Не удалось установить подписанный Tauri-релиз.",
                "Проверьте подключение и состояние установленного приложения.",
            )
            .with_details(reason.to_string())
        })?;
    #[cfg(not(target_os = "windows"))]
    {
        app.restart()
    }
    #[cfg(target_os = "windows")]
    {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn beta_discovery_uses_fixed_repository_and_channel_asset() {
        assert_eq!(
            MANIFEST_URL,
            "https://github.com/darvin7531/SpaceStation14-Studio/releases/download/beta-updates/tauri-latest.json"
        );
    }
}

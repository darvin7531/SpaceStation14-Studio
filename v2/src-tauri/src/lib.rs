mod error;
mod project;

use error::StudioError;
use project::ProjectOverview;

/// Runs on the blocking pool to keep filesystem walks off the webview thread.
#[tauri::command]
async fn inspect_project(path: String) -> Result<ProjectOverview, StudioError> {
    tauri::async_runtime::spawn_blocking(move || project::inspect_project(&path))
        .await
        .map_err(|join_error| {
            StudioError::new(
                "INSPECTION_INTERRUPTED",
                "Проверка проекта неожиданно прервалась.",
                "Повторите открытие проекта. Если ошибка повторится, приложите журнал запуска.",
            )
            .with_details(join_error.to_string())
        })?
}

pub fn run() -> Result<(), tauri::Error> {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![inspect_project])
        .run(tauri::generate_context!())
}

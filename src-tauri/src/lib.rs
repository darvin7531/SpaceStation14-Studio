mod error;
mod project;

use std::sync::{Arc, Mutex};

use error::{internal_lock, interrupted, StudioError};
use project::{ProjectIndex, ProjectOverview, ResourceDocument, ResourcePage};
use tauri::State;

#[derive(Default)]
pub struct WorkspaceState(Mutex<Option<Arc<ProjectIndex>>>);

fn current_project(state: &WorkspaceState) -> Result<Arc<ProjectIndex>, StudioError> {
    state
        .0
        .lock()
        .map_err(|_| internal_lock())?
        .clone()
        .ok_or_else(|| {
            StudioError::new(
                "PROJECT_NOT_OPEN",
                "Проект ещё не открыт.",
                "Сначала откройте корневую папку исходников SS14.",
            )
        })
}

/// Scan on the blocking thread pool, then atomically publish the new index.
#[tauri::command]
async fn open_project(
    path: String,
    state: State<'_, WorkspaceState>,
) -> Result<ProjectOverview, StudioError> {
    let index = tauri::async_runtime::spawn_blocking(move || ProjectIndex::open(&path))
        .await
        .map_err(interrupted)??;
    let summary = index.overview().clone();
    *state.0.lock().map_err(|_| internal_lock())? = Some(Arc::new(index));
    Ok(summary)
}

#[tauri::command]
async fn search_resources(
    query: String,
    kind: Option<String>,
    offset: Option<usize>,
    limit: Option<usize>,
    state: State<'_, WorkspaceState>,
) -> Result<ResourcePage, StudioError> {
    let index = current_project(&state)?;
    tauri::async_runtime::spawn_blocking(move || {
        index.search(&query, kind.as_deref(), offset.unwrap_or(0), limit.unwrap_or(100))
    })
    .await
    .map_err(interrupted)
}

#[tauri::command]
async fn read_resource(
    path: String,
    state: State<'_, WorkspaceState>,
) -> Result<ResourceDocument, StudioError> {
    let index = current_project(&state)?;
    tauri::async_runtime::spawn_blocking(move || index.read_resource(&path))
        .await
        .map_err(interrupted)?
}

pub fn run() -> Result<(), tauri::Error> {
    tauri::Builder::default()
        .manage(WorkspaceState::default())
        .invoke_handler(tauri::generate_handler![
            open_project,
            search_resources,
            read_resource
        ])
        .run(tauri::generate_context!())
}

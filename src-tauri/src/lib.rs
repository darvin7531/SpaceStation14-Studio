mod draft_journal;
mod error;
mod project;
mod prototype_graph;
mod prototypes;
mod resource_edit;

use std::sync::{Arc, Mutex};

use draft_journal::{DraftJournal, DraftList, DraftSnapshot, DraftSummary, DraftWriteResult};
use error::{internal_lock, interrupted, StudioError};
use project::{ProjectIndex, ProjectOverview, ResourceDocument, ResourcePage};
use prototype_graph::PrototypeRelations;
use prototypes::{DiagnosticPage, PrototypePage};
use resource_edit::SaveResult;
use tauri::{Manager, State};

#[derive(Default)]
pub struct WorkspaceState(Mutex<Option<Arc<ProjectIndex>>>);

/// Serialize recovery snapshots independently of source-file saves.
#[derive(Default)]
pub struct DraftStorageLock(Arc<Mutex<()>>);

fn draft_storage_root(app: &tauri::AppHandle) -> Result<std::path::PathBuf, StudioError> {
    app.path().app_data_dir().map_err(|error| {
        StudioError::new(
            "DRAFT_STORAGE_UNAVAILABLE",
            "Не удалось определить каталог восстановления черновиков.",
            "Проверьте права пользовательского профиля и папку данных приложения.",
        ).with_details(error.to_string())
    })
}

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
        index.search(
            &query,
            kind.as_deref(),
            offset.unwrap_or(0),
            limit.unwrap_or(100),
        )
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

/// Indexing is lazy and runs off the webview thread. Every declaration has
/// stable source provenance; partials are not silently merged.
#[tauri::command]
async fn search_prototypes(
    query: String,
    kind: Option<String>,
    offset: Option<usize>,
    limit: Option<usize>,
    state: State<'_, WorkspaceState>,
) -> Result<PrototypePage, StudioError> {
    let index = current_project(&state)?;
    tauri::async_runtime::spawn_blocking(move || {
        Ok(index.prototypes()?.search(
            &query,
            kind.as_deref(),
            offset.unwrap_or(0),
            limit.unwrap_or(100),
        ))
    })
    .await
    .map_err(interrupted)?
}

#[tauri::command]
async fn list_prototype_diagnostics(
    offset: Option<usize>,
    limit: Option<usize>,
    state: State<'_, WorkspaceState>,
) -> Result<DiagnosticPage, StudioError> {
    let index = current_project(&state)?;
    tauri::async_runtime::spawn_blocking(move || {
        Ok(index
            .prototypes()?
            .diagnostics(offset.unwrap_or(0), limit.unwrap_or(100)))
    })
    .await
    .map_err(interrupted)?
}

/// Source relationships are informational and do not perform YAML inheritance.
#[tauri::command]
async fn prototype_relations(
    kind: String,
    id: String,
    state: State<'_, WorkspaceState>,
) -> Result<PrototypeRelations, StudioError> {
    let index = current_project(&state)?;
    tauri::async_runtime::spawn_blocking(move || {
        index.prototypes()?.relations(&kind, &id).ok_or_else(|| {
            StudioError::new(
                "PROTOTYPE_NOT_INDEXED",
                "Прототип не найден в каталоге открытого проекта.",
                "Повторите поиск по точному типу и ID либо заново откройте проект.",
            )
        })
    })
    .await
    .map_err(interrupted)?
}

/// A text-only operation: no YAML reserialization or unreviewed graph edits.
#[tauri::command]
async fn save_yaml_resource(
    path: String,
    expected_revision: String,
    content: String,
    state: State<'_, WorkspaceState>,
) -> Result<SaveResult, StudioError> {
    let index = current_project(&state)?;
    tauri::async_runtime::spawn_blocking(move || {
        index.save_yaml(&path, &expected_revision, content)
    })
    .await
    .map_err(interrupted)?
}

/// List snapshots without modifying SS14 resource files.
#[tauri::command]
async fn list_drafts(
    app: tauri::AppHandle,
    state: State<'_, WorkspaceState>,
    drafts: State<'_, DraftStorageLock>,
) -> Result<DraftList, StudioError> {
    let project = current_project(&state)?;
    let root = draft_storage_root(&app)?;
    let lock = drafts.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock.lock().map_err(|_| internal_lock())?;
        let journal = DraftJournal::new(&root, &project.overview().project_root);
        let (entries, warnings) = journal.list()?;
        let items = entries.into_iter().map(|entry| DraftSummary {
            source_indexed: project.is_yaml_indexed(&entry.path),
            path: entry.path,
            saved_at_ms: entry.saved_at_ms,
        }).collect();
        Ok(DraftList { items, warnings })
    }).await.map_err(interrupted)?
}

#[tauri::command]
async fn read_draft(
    path: String,
    app: tauri::AppHandle,
    state: State<'_, WorkspaceState>,
    drafts: State<'_, DraftStorageLock>,
) -> Result<Option<DraftSnapshot>, StudioError> {
    let project = current_project(&state)?;
    let root = draft_storage_root(&app)?;
    let lock = drafts.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock.lock().map_err(|_| internal_lock())?;
        DraftJournal::new(&root, &project.overview().project_root).read(&path)
    }).await.map_err(interrupted)?
}

#[tauri::command]
async fn persist_draft(
    path: String,
    base_revision: String,
    content: String,
    app: tauri::AppHandle,
    state: State<'_, WorkspaceState>,
    drafts: State<'_, DraftStorageLock>,
) -> Result<DraftWriteResult, StudioError> {
    let project = current_project(&state)?;
    if !project.is_yaml_indexed(&path) {
        return Err(StudioError::new(
            "DRAFT_SOURCE_NOT_INDEXED",
            "Автосохранение доступно только для YAML из открытого проекта.",
            "Выберите настоящий YAML-файл в списке ресурсов Studio.",
        ));
    }
    let root = draft_storage_root(&app)?;
    let lock = drafts.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock.lock().map_err(|_| internal_lock())?;
        DraftJournal::new(&root, &project.overview().project_root)
            .write(&path, &base_revision, &content)
    }).await.map_err(interrupted)?
}

#[tauri::command]
async fn delete_draft(
    path: String,
    app: tauri::AppHandle,
    state: State<'_, WorkspaceState>,
    drafts: State<'_, DraftStorageLock>,
) -> Result<(), StudioError> {
    let project = current_project(&state)?;
    let root = draft_storage_root(&app)?;
    let lock = drafts.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock.lock().map_err(|_| internal_lock())?;
        DraftJournal::new(&root, &project.overview().project_root).delete(&path)
    }).await.map_err(interrupted)?
}

pub fn run() -> Result<(), tauri::Error> {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(WorkspaceState::default())
        .manage(DraftStorageLock::default())
        .invoke_handler(tauri::generate_handler![
            open_project,
            search_resources,
            search_prototypes,
            prototype_relations,
            list_prototype_diagnostics,
            read_resource,
            save_yaml_resource,
            list_drafts,
            read_draft,
            persist_draft,
            delete_draft
        ])
        .run(tauri::generate_context!())
}

mod csharp_index;
mod draft_journal;
mod error;
mod fluent_create;
mod fluent_diagnostics;
mod fluent_locale;
mod project;
mod project_watcher;
mod prototype_append;
mod prototype_components;
mod prototype_create;
mod prototype_fields;
mod prototype_graph;
mod prototype_localization;
mod prototype_merge;
mod prototype_parents;
mod prototype_sources;
mod prototypes;
mod resource_browser;
mod resource_drift;
mod resource_edit;
mod rsi_create;
mod rsi_credits;
mod rsi_delete;
mod rsi_import;
mod rsi_preview;
mod rsi_rename;
mod rsi_replace;
mod rsi_restore;
mod rsi_timing;
mod ui_sources;

use std::sync::{Arc, Mutex};

use csharp_index::{CSharpPage, ComponentSchemaBatch};
use draft_journal::{DraftJournal, DraftList, DraftSnapshot, DraftSummary, DraftWriteResult};
use error::{internal_lock, interrupted, StudioError};
use fluent_create::{FluentDraft, FluentPreview};
use fluent_locale::FluentInspection;
use project::{
    ContentSearchResults, ProjectIndex, ProjectOverview, ProjectRefresh, ResourceDocument,
    ResourcePage,
};
use project_watcher::ProjectWatcher;
use prototype_append::AppendPreview;
use prototype_components::{ComponentInspection, ComponentOperation};
use prototype_create::{PrototypeDraft, PrototypePreview};
use prototype_fields::{FieldInspection, FieldLocator, FieldPatch, PrototypeFields};
use prototype_graph::PrototypeRelations;
use prototype_localization::{EntityLocalizationAnalysis, EntityLocalizationSource};
use prototype_merge::{
    LinkedPrototypeReport, PrototypeInheritancePreview, PrototypePartialPreview,
};
use prototype_parents::ParentInspection;
use prototype_sources::PrototypeSourceReport;
use prototypes::{DiagnosticPage, PrototypePage, SourceOutline};
use resource_browser::ResourceBrowserPage;
use resource_drift::{OpenRevision, ResourceDriftReport};
use resource_edit::{SaveResult, YamlSyntaxReport};
use rsi_create::{RsiCreationPreview, RsiDraft};
use rsi_credits::RsiCreditsUpdate;
use rsi_delete::{DeletedRsiState, RsiDeleteRequest};
use rsi_import::{ImportedRsiState, RsiStateImport};
use rsi_preview::{RsiSheetImage, RsiSheetList};
use rsi_rename::{RenamedRsiState, RsiRenameRequest};
use rsi_restore::{RestoredRsiState, RsiArchiveList, RsiRestoreRequest};
use rsi_timing::RsiTimingUpdate;
use serde::Serialize;
use tauri::{Emitter, Manager, State};
use ui_sources::UiSourcePage;

#[derive(Clone, Serialize)]
struct ProjectScanProgress {
    requested_path: String,
    phase: &'static str,
    indexed_resources: usize,
}

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
        )
        .with_details(error.to_string())
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
    app: tauri::AppHandle,
    watcher: State<'_, ProjectWatcher>,
) -> Result<ProjectOverview, StudioError> {
    let scan_app = app.clone();
    let requested_path = path.clone();
    let index = tauri::async_runtime::spawn_blocking(move || {
        ProjectIndex::open_with_progress(&path, |phase, indexed_resources| {
            let _ = scan_app.emit(
                "studio:scan-progress",
                ProjectScanProgress {
                    requested_path: requested_path.clone(),
                    phase,
                    indexed_resources,
                },
            );
        })
    })
    .await
    .map_err(interrupted)??;
    let mut summary = index.overview().clone();
    *state.0.lock().map_err(|_| internal_lock())? = Some(Arc::new(index));
    if let Err(error) = watcher.replace(&app, std::path::Path::new(&summary.project_root)) {
        summary.warnings.push(format!(
            "Автообновление отключено: {} {}",
            error.message, error.hint
        ));
    }
    Ok(summary)
}

/// Only swap the workspace after a complete and valid scan. An overlapping
/// project switch must not be undone by a late refresh result.
#[tauri::command]
async fn refresh_project(
    changed_paths: Option<Vec<String>>,
    state: State<'_, WorkspaceState>,
) -> Result<ProjectRefresh, StudioError> {
    let original = current_project(&state)?;
    let source = original.clone();
    let (rebuilt, summary) = tauri::async_runtime::spawn_blocking(move || match changed_paths {
        Some(paths) => source.refresh_paths(&paths),
        None => source.refresh(),
    })
    .await
    .map_err(interrupted)??;
    let mut active = state.0.lock().map_err(|_| internal_lock())?;
    if !active
        .as_ref()
        .is_some_and(|index| Arc::ptr_eq(index, &original))
    {
        return Err(StudioError::new(
            "PROJECT_REFRESH_STALE",
            "Проект изменился во время обновления каталога.",
            "Повторите обновление для активного проекта.",
        ));
    }
    *active = Some(Arc::new(rebuilt));
    Ok(summary)
}

/// Navigate indexed resource folders without scanning the filesystem or building
/// a huge tree in the webview. Directories are listed before files.
#[tauri::command]
async fn browse_resource_folder(
    directory: String,
    offset: Option<usize>,
    limit: Option<usize>,
    state: State<'_, WorkspaceState>,
) -> Result<ResourceBrowserPage, StudioError> {
    let index = current_project(&state)?;
    tauri::async_runtime::spawn_blocking(move || {
        index.browse_resource_folder(&directory, offset.unwrap_or(0), limit.unwrap_or(100))
    })
    .await
    .map_err(interrupted)?
}

#[tauri::command]
async fn search_ui_sources(
    query: String,
    offset: Option<usize>,
    limit: Option<usize>,
    state: State<'_, WorkspaceState>,
) -> Result<UiSourcePage, StudioError> {
    let project = current_project(&state)?;
    tauri::async_runtime::spawn_blocking(move || {
        project.ui_sources_page(&query, offset.unwrap_or(0), limit.unwrap_or(80))
    })
    .await
    .map_err(interrupted)?
}

#[tauri::command]
async fn read_ui_source(
    path: String,
    state: State<'_, WorkspaceState>,
) -> Result<ResourceDocument, StudioError> {
    let project = current_project(&state)?;
    tauri::async_runtime::spawn_blocking(move || project.read_ui_source(&path))
        .await
        .map_err(interrupted)?
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

/// Check open resource revisions without accepting external changes.
#[tauri::command]
async fn probe_open_revisions(
    opened: Vec<OpenRevision>,
    state: State<'_, WorkspaceState>,
) -> Result<ResourceDriftReport, StudioError> {
    let project = current_project(&state)?;
    tauri::async_runtime::spawn_blocking(move || resource_drift::probe(&project, &opened))
        .await
        .map_err(interrupted)?
}

/// Search inside indexed YAML/FTL/RSI sources off the UI thread.
#[tauri::command]
async fn search_resource_content(
    query: String,
    kind: Option<String>,
    state: State<'_, WorkspaceState>,
) -> Result<ContentSearchResults, StudioError> {
    let index = current_project(&state)?;
    tauri::async_runtime::spawn_blocking(move || index.search_content(&query, kind.as_deref()))
        .await
        .map_err(interrupted)?
}

/// Discover C# annotations without the legacy regex / fixed-line-window
/// heuristics. Work is bounded, lazy and cached per open project.
#[tauri::command]
async fn search_csharp_definitions(
    query: String,
    kind: Option<String>,
    offset: Option<usize>,
    limit: Option<usize>,
    state: State<'_, WorkspaceState>,
) -> Result<CSharpPage, StudioError> {
    let project = current_project(&state)?;
    tauri::async_runtime::spawn_blocking(move || {
        project.csharp_page(
            &query,
            kind.as_deref(),
            offset.unwrap_or(0),
            limit.unwrap_or(50),
        )
    })
    .await
    .map_err(interrupted)?
}

/// Preview only files that were indexed as C# definitions. No editor writes.
#[tauri::command]
async fn read_csharp_source(
    path: String,
    state: State<'_, WorkspaceState>,
) -> Result<ResourceDocument, StudioError> {
    let index = current_project(&state)?;
    tauri::async_runtime::spawn_blocking(move || index.read_csharp_source(&path))
        .await
        .map_err(interrupted)?
}

/// Return only direct C# schema matches for explicitly declared YAML
/// components. Keep schema inference separate from source-preserving edits.
#[tauri::command]
async fn inspect_component_schemas(
    names: Vec<String>,
    state: State<'_, WorkspaceState>,
) -> Result<ComponentSchemaBatch, StudioError> {
    let project = current_project(&state)?;
    tauri::async_runtime::spawn_blocking(move || project.csharp_component_schemas(&names))
        .await
        .map_err(interrupted)?
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

#[tauri::command]
async fn list_rsi_sheets(
    path: String,
    state: State<'_, WorkspaceState>,
) -> Result<RsiSheetList, StudioError> {
    let index = current_project(&state)?;
    tauri::async_runtime::spawn_blocking(move || index.list_rsi_sheets(&path))
        .await
        .map_err(interrupted)?
}

#[tauri::command]
async fn read_rsi_sheet(
    path: String,
    name: String,
    state: State<'_, WorkspaceState>,
) -> Result<RsiSheetImage, StudioError> {
    let index = current_project(&state)?;
    tauri::async_runtime::spawn_blocking(move || index.read_rsi_sheet(&path, &name))
        .await
        .map_err(interrupted)?
}

/// Replace an existing PNG and rebuild its frame grid, preserving a restorable archive.
#[tauri::command]
async fn replace_rsi_state(
    request: RsiStateImport,
    state: State<'_, WorkspaceState>,
) -> Result<ImportedRsiState, StudioError> {
    let index = current_project(&state)?;
    tauri::async_runtime::spawn_blocking(move || index.replace_rsi_state(&request))
        .await
        .map_err(interrupted)?
}

/// Append a new state and PNG with a revision guard. The editor reconciles
/// the returned full metadata as the new read-only RSI snapshot.
#[tauri::command]
async fn import_rsi_state(
    request: RsiStateImport,
    state: State<'_, WorkspaceState>,
) -> Result<ImportedRsiState, StudioError> {
    let index = current_project(&state)?;
    tauri::async_runtime::spawn_blocking(move || index.import_rsi_state(&request))
        .await
        .map_err(interrupted)?
}

#[tauri::command]
async fn rename_rsi_state(
    request: RsiRenameRequest,
    state: State<'_, WorkspaceState>,
) -> Result<RenamedRsiState, StudioError> {
    let index = current_project(&state)?;
    tauri::async_runtime::spawn_blocking(move || index.rename_rsi_state(&request))
        .await
        .map_err(interrupted)?
}

#[tauri::command]
async fn update_rsi_credits(
    request: RsiCreditsUpdate,
    state: State<'_, WorkspaceState>,
) -> Result<ImportedRsiState, StudioError> {
    let index = current_project(&state)?;
    tauri::async_runtime::spawn_blocking(move || index.update_rsi_credits(&request))
        .await
        .map_err(interrupted)?
}

#[tauri::command]
async fn update_rsi_timing(
    request: RsiTimingUpdate,
    state: State<'_, WorkspaceState>,
) -> Result<ImportedRsiState, StudioError> {
    let index = current_project(&state)?;
    tauri::async_runtime::spawn_blocking(move || index.update_rsi_timing(&request))
        .await
        .map_err(interrupted)?
}

#[tauri::command]
async fn delete_rsi_state(
    request: RsiDeleteRequest,
    state: State<'_, WorkspaceState>,
) -> Result<DeletedRsiState, StudioError> {
    let index = current_project(&state)?;
    tauri::async_runtime::spawn_blocking(move || index.delete_rsi_state(&request))
        .await
        .map_err(interrupted)?
}

#[tauri::command]
async fn list_rsi_archives(
    path: String,
    state: State<'_, WorkspaceState>,
) -> Result<RsiArchiveList, StudioError> {
    let index = current_project(&state)?;
    tauri::async_runtime::spawn_blocking(move || index.list_rsi_archives(&path))
        .await
        .map_err(interrupted)?
}

#[tauri::command]
async fn restore_rsi_state(
    request: RsiRestoreRequest,
    state: State<'_, WorkspaceState>,
) -> Result<RestoredRsiState, StudioError> {
    let index = current_project(&state)?;
    tauri::async_runtime::spawn_blocking(move || index.restore_rsi_state(&request))
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
/// Existing Electron Inspector 'Linked prototypes' section.
#[tauri::command]
async fn prototype_linked_references(
    kind: String,
    id: String,
    state: State<'_, WorkspaceState>,
) -> Result<LinkedPrototypeReport, StudioError> {
    let project = current_project(&state)?;
    tauri::async_runtime::spawn_blocking(move || project.prototype_linked_references(&kind, &id))
        .await
        .map_err(interrupted)?
}

/// Bounded static parent projection over already-applied partial overlays.
/// Does not claim runtime parity with RobustToolbox C# DataField semantics.
#[tauri::command]
async fn prototype_inheritance_preview(
    kind: String,
    id: String,
    state: State<'_, WorkspaceState>,
) -> Result<PrototypeInheritancePreview, StudioError> {
    let project = current_project(&state)?;
    tauri::async_runtime::spawn_blocking(move || project.prototype_inheritance_preview(&kind, &id))
        .await
        .map_err(interrupted)?
}

/// Read-only SS14 partial overlay preview (no parent or C# inheritance).
#[tauri::command]
async fn prototype_partial_preview(
    kind: String,
    id: String,
    state: State<'_, WorkspaceState>,
) -> Result<PrototypePartialPreview, StudioError> {
    let project = current_project(&state)?;
    tauri::async_runtime::spawn_blocking(move || project.prototype_partial_preview(&kind, &id))
        .await
        .map_err(interrupted)?
}

/// Inspect explicit field and component declarations through the ancestry
/// graph. This does not apply YAML inheritance or partial merging.
#[tauri::command]
async fn prototype_sources(
    kind: String,
    id: String,
    state: State<'_, WorkspaceState>,
) -> Result<PrototypeSourceReport, StudioError> {
    let project = current_project(&state)?;
    tauri::async_runtime::spawn_blocking(move || project.prototype_sources(&kind, &id))
        .await
        .map_err(interrupted)?
}

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

/// Analyze a YAML draft entirely in Rust without writing to disk.
#[tauri::command]
async fn analyze_yaml_resource(
    path: String,
    content: String,
    state: State<'_, WorkspaceState>,
) -> Result<YamlSyntaxReport, StudioError> {
    let index = current_project(&state)?;
    tauri::async_runtime::spawn_blocking(move || index.analyze_yaml(&path, &content))
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

/// Analyze a live Fluent draft without writing it to disk. Parsing runs away
/// from the UI thread, and only indexed .ftl paths are accepted.
#[tauri::command]
async fn analyze_fluent_resource(
    path: String,
    content: String,
    state: State<'_, WorkspaceState>,
) -> Result<FluentInspection, StudioError> {
    let index = current_project(&state)?;
    tauri::async_runtime::spawn_blocking(move || index.analyze_fluent(&path, &content))
        .await
        .map_err(interrupted)?
}

/// Native Fluent source save. Preserves user text and refuses stale revisions.
#[tauri::command]
async fn save_ftl_resource(
    path: String,
    expected_revision: String,
    content: String,
    state: State<'_, WorkspaceState>,
) -> Result<SaveResult, StudioError> {
    let index = current_project(&state)?;
    tauri::async_runtime::spawn_blocking(move || index.save_ftl(&path, &expected_revision, content))
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
        let items = entries
            .into_iter()
            .map(|entry| DraftSummary {
                source_indexed: project.is_editable_text_indexed(&entry.path),
                path: entry.path,
                saved_at_ms: entry.saved_at_ms,
            })
            .collect();
        Ok(DraftList { items, warnings })
    })
    .await
    .map_err(interrupted)?
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
    })
    .await
    .map_err(interrupted)?
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
    if !project.is_editable_text_indexed(&path) {
        return Err(StudioError::new(
            "DRAFT_SOURCE_NOT_INDEXED",
            "Автосохранение доступно только для YAML и FTL из открытого проекта.",
            "Выберите существующий текстовый файл в списке ресурсов Studio.",
        ));
    }
    let root = draft_storage_root(&app)?;
    let lock = drafts.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock.lock().map_err(|_| internal_lock())?;
        DraftJournal::new(&root, &project.overview().project_root).write(
            &path,
            &base_revision,
            &content,
        )
    })
    .await
    .map_err(interrupted)?
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
    })
    .await
    .map_err(interrupted)?
}

#[derive(Debug, Serialize)]
struct CreateRsiResult {
    path: String,
    warning: Option<String>,
    overview: Option<ProjectOverview>,
}

#[tauri::command]
async fn preview_new_rsi(
    draft: RsiDraft,
    state: State<'_, WorkspaceState>,
) -> Result<RsiCreationPreview, StudioError> {
    let project = current_project(&state)?;
    tauri::async_runtime::spawn_blocking(move || project.preview_new_rsi(&draft))
        .await
        .map_err(interrupted)?
}

/// Create a new RSI directory with meta.json exclusively. Publish a fresh
/// resource index only if the same project is still open.
#[tauri::command]
async fn create_new_rsi(
    draft: RsiDraft,
    state: State<'_, WorkspaceState>,
) -> Result<CreateRsiResult, StudioError> {
    let original = current_project(&state)?;
    let project = original.clone();
    let (created, refreshed) = tauri::async_runtime::spawn_blocking(move || {
        let created = project.create_new_rsi(&draft)?;
        let refreshed = ProjectIndex::open(&project.overview().project_root);
        Ok::<_, StudioError>((created, refreshed))
    })
    .await
    .map_err(interrupted)??;

    let mut warning = created.warning;
    let mut overview = None;
    match refreshed {
        Ok(rebuilt) => {
            let mut active = state.0.lock().map_err(|_| internal_lock())?;
            if active
                .as_ref()
                .is_some_and(|index| Arc::ptr_eq(index, &original))
            {
                overview = Some(rebuilt.overview().clone());
                *active = Some(Arc::new(rebuilt));
            } else {
                warning = Some(
                    "RSI создан, но активный проект сменился. Вернитесь к исходному проекту и обновите индекс."
                        .into(),
                );
            }
        }
        Err(error) => {
            warning = Some(format!(
                "RSI создан, но обновить индекс не удалось: {} [{}]. Обновите индекс вручную.",
                error.message, error.code,
            ));
        }
    }
    Ok(CreateRsiResult {
        path: created.path,
        warning,
        overview,
    })
}

#[derive(Debug, Serialize)]
struct CreateFluentResult {
    file: String,
    warning: Option<String>,
    overview: Option<ProjectOverview>,
}

#[tauri::command]
async fn preview_new_fluent(
    draft: FluentDraft,
    state: State<'_, WorkspaceState>,
) -> Result<FluentPreview, StudioError> {
    let project = current_project(&state)?;
    tauri::async_runtime::spawn_blocking(move || project.preview_new_fluent(&draft))
        .await
        .map_err(interrupted)?
}

/// Create a new FTL exclusively and publish the fresh resource index only
/// after scanning succeeds; unrelated in-memory drafts remain untouched.
#[tauri::command]
async fn create_new_fluent(
    draft: FluentDraft,
    state: State<'_, WorkspaceState>,
) -> Result<CreateFluentResult, StudioError> {
    let original = current_project(&state)?;
    let project = original.clone();
    let (created, refreshed) = tauri::async_runtime::spawn_blocking(move || {
        let created = project.create_new_fluent(&draft)?;
        let refreshed = ProjectIndex::open(&project.overview().project_root);
        Ok::<_, StudioError>((created, refreshed))
    })
    .await
    .map_err(interrupted)??;

    let mut warning = created.warning;
    let mut overview = None;
    match refreshed {
        Ok(rebuilt) => {
            let mut active = state.0.lock().map_err(|_| internal_lock())?;
            if active
                .as_ref()
                .is_some_and(|index| Arc::ptr_eq(index, &original))
            {
                overview = Some(rebuilt.overview().clone());
                *active = Some(Arc::new(rebuilt));
            } else {
                warning = Some(
                    "FTL записан, но активный проект сменился. Вернитесь к исходному проекту и обновите индекс."
                        .into(),
                );
            }
        }
        Err(error) => {
            warning = Some(format!(
                "FTL создан, но обновить индекс не удалось: {} [{}]. Обновите индекс вручную.",
                error.message, error.code,
            ));
        }
    }
    Ok(CreateFluentResult {
        file: created.file,
        warning,
        overview,
    })
}

#[derive(Debug, Serialize)]
struct CreatePrototypeResult {
    file: String,
    kind: String,
    id: String,
    yaml: String,
    warning: Option<String>,
    overview: Option<ProjectOverview>,
}

#[tauri::command]
async fn preview_new_prototype(
    draft: PrototypeDraft,
    state: State<'_, WorkspaceState>,
) -> Result<PrototypePreview, StudioError> {
    let project = current_project(&state)?;
    tauri::async_runtime::spawn_blocking(move || project.preview_new_prototype(&draft))
        .await
        .map_err(interrupted)?
}

/// Creation writes only a brand-new file. The existing workspace state is
/// atomically swapped with a rescan, without clearing frontend editor drafts.
#[tauri::command]
async fn create_new_prototype(
    draft: PrototypeDraft,
    state: State<'_, WorkspaceState>,
) -> Result<CreatePrototypeResult, StudioError> {
    let original = current_project(&state)?;
    let project = original.clone();
    let (created, refreshed) = tauri::async_runtime::spawn_blocking(move || {
        let created = project.create_new_prototype(&draft)?;
        let refreshed = ProjectIndex::open(&project.overview().project_root);
        Ok::<_, StudioError>((created, refreshed))
    })
    .await
    .map_err(interrupted)??;

    let mut warning = created.warning.clone();
    let mut overview = None;
    match refreshed {
        Ok(refreshed) => {
            let mut active = state.0.lock().map_err(|_| internal_lock())?;
            if active
                .as_ref()
                .is_some_and(|existing| Arc::ptr_eq(existing, &original))
            {
                overview = Some(refreshed.overview().clone());
                *active = Some(Arc::new(refreshed));
            } else {
                warning = Some("Новый файл записан, но активный проект уже изменился. Вернитесь к исходному проекту для обновления каталога.".into());
            }
        }
        Err(error) => {
            warning = Some(format!(
                "YAML создан, но обновить каталог не удалось: {} [{}]. Переоткройте проект.",
                error.message, error.code
            ));
        }
    }

    Ok(CreatePrototypeResult {
        file: created.file,
        kind: created.kind,
        id: created.id,
        yaml: created.yaml,
        warning,
        overview,
    })
}

#[tauri::command]
async fn preview_append_prototype(
    draft: PrototypeDraft,
    state: State<'_, WorkspaceState>,
) -> Result<AppendPreview, StudioError> {
    let project = current_project(&state)?;
    tauri::async_runtime::spawn_blocking(move || project.preview_append_prototype(&draft))
        .await
        .map_err(interrupted)?
}

#[tauri::command]
async fn append_prototype(
    draft: PrototypeDraft,
    expected_revision: String,
    state: State<'_, WorkspaceState>,
) -> Result<CreatePrototypeResult, StudioError> {
    let original = current_project(&state)?;
    let project = original.clone();
    let created = tauri::async_runtime::spawn_blocking(move || {
        project.append_prototype(&draft, &expected_revision)
    })
    .await
    .map_err(interrupted)??;

    let mut warning = created.warning;
    let overview = {
        let active = state.0.lock().map_err(|_| internal_lock())?;
        if active
            .as_ref()
            .is_some_and(|existing| Arc::ptr_eq(existing, &original))
        {
            Some(original.overview().clone())
        } else {
            warning = Some(
                "YAML изменён, но активный проект уже переключён. Откройте исходный проект, чтобы увидеть изменения.".into(),
            );
            None
        }
    };

    Ok(CreatePrototypeResult {
        file: created.file,
        kind: created.kind,
        id: created.id,
        yaml: created.yaml,
        warning,
        overview,
    })
}

#[tauri::command]
async fn inspect_prototype_parents(
    locator: FieldLocator,
    source: String,
    state: State<'_, WorkspaceState>,
) -> Result<ParentInspection, StudioError> {
    let project = current_project(&state)?;
    tauri::async_runtime::spawn_blocking(move || {
        project.inspect_prototype_parents(&locator, &source)
    })
    .await
    .map_err(interrupted)?
}

#[tauri::command]
async fn patch_prototype_parents(
    locator: FieldLocator,
    source: String,
    parents: Vec<String>,
    state: State<'_, WorkspaceState>,
) -> Result<FieldPatch, StudioError> {
    let project = current_project(&state)?;
    tauri::async_runtime::spawn_blocking(move || {
        project.patch_prototype_parents(&locator, &source, &parents)
    })
    .await
    .map_err(interrupted)?
}

#[tauri::command]
async fn inspect_yaml_outline(
    path: String,
    source: String,
    state: State<'_, WorkspaceState>,
) -> Result<SourceOutline, StudioError> {
    let project = current_project(&state)?;
    tauri::async_runtime::spawn_blocking(move || project.inspect_yaml_outline(&path, &source))
        .await
        .map_err(interrupted)?
}

#[tauri::command]
async fn inspect_prototype_fields(
    locator: FieldLocator,
    source: String,
    state: State<'_, WorkspaceState>,
) -> Result<FieldInspection, StudioError> {
    let project = current_project(&state)?;
    tauri::async_runtime::spawn_blocking(move || {
        project.inspect_prototype_fields(&locator, &source)
    })
    .await
    .map_err(interrupted)?
}

#[tauri::command]
async fn inspect_entity_localization(
    locator: FieldLocator,
    source: String,
    state: State<'_, WorkspaceState>,
) -> Result<EntityLocalizationSource, StudioError> {
    let project = current_project(&state)?;
    tauri::async_runtime::spawn_blocking(move || {
        project.inspect_entity_localization(&locator, &source)
    })
    .await
    .map_err(interrupted)?
}

#[tauri::command]
async fn analyze_entity_localization(
    locator: FieldLocator,
    source: String,
    required_locales: Vec<String>,
    state: State<'_, WorkspaceState>,
) -> Result<EntityLocalizationAnalysis, StudioError> {
    let project = current_project(&state)?;
    tauri::async_runtime::spawn_blocking(move || {
        project.analyze_entity_localization(&locator, &source, &required_locales)
    })
    .await
    .map_err(interrupted)?
}

#[tauri::command]
async fn patch_prototype_fields(
    locator: FieldLocator,
    source: String,
    fields: PrototypeFields,
    state: State<'_, WorkspaceState>,
) -> Result<FieldPatch, StudioError> {
    let project = current_project(&state)?;
    tauri::async_runtime::spawn_blocking(move || {
        project.patch_prototype_fields(&locator, &source, &fields)
    })
    .await
    .map_err(interrupted)?
}

#[tauri::command]
async fn inspect_prototype_components(
    locator: FieldLocator,
    source: String,
    state: State<'_, WorkspaceState>,
) -> Result<ComponentInspection, StudioError> {
    let project = current_project(&state)?;
    tauri::async_runtime::spawn_blocking(move || {
        project.inspect_prototype_components(&locator, &source)
    })
    .await
    .map_err(interrupted)?
}

#[tauri::command]
async fn patch_prototype_components(
    locator: FieldLocator,
    source: String,
    operation: ComponentOperation,
    state: State<'_, WorkspaceState>,
) -> Result<FieldPatch, StudioError> {
    let project = current_project(&state)?;
    tauri::async_runtime::spawn_blocking(move || {
        project.patch_prototype_components(&locator, &source, &operation)
    })
    .await
    .map_err(interrupted)?
}

pub fn run() -> Result<(), tauri::Error> {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(WorkspaceState::default())
        .manage(ProjectWatcher::default())
        .manage(DraftStorageLock::default())
        .invoke_handler(tauri::generate_handler![
            open_project,
            refresh_project,
            search_resources,
            browse_resource_folder,
            search_ui_sources,
            read_ui_source,
            probe_open_revisions,
            search_resource_content,
            search_csharp_definitions,
            read_csharp_source,
            inspect_component_schemas,
            search_prototypes,
            prototype_relations,
            prototype_sources,
            prototype_partial_preview,
            prototype_inheritance_preview,
            prototype_linked_references,
            list_prototype_diagnostics,
            read_resource,
            list_rsi_sheets,
            read_rsi_sheet,
            import_rsi_state,
            replace_rsi_state,
            rename_rsi_state,
            update_rsi_timing,
            update_rsi_credits,
            delete_rsi_state,
            list_rsi_archives,
            restore_rsi_state,
            preview_new_rsi,
            create_new_rsi,
            analyze_yaml_resource,
            save_yaml_resource,
            analyze_fluent_resource,
            save_ftl_resource,
            preview_new_fluent,
            create_new_fluent,
            preview_new_prototype,
            create_new_prototype,
            preview_append_prototype,
            append_prototype,
            inspect_prototype_fields,
            inspect_yaml_outline,
            inspect_prototype_parents,
            patch_prototype_parents,
            inspect_entity_localization,
            analyze_entity_localization,
            patch_prototype_fields,
            inspect_prototype_components,
            patch_prototype_components,
            list_drafts,
            read_draft,
            persist_draft,
            delete_draft
        ])
        .run(tauri::generate_context!())
}

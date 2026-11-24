use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::Serialize;

use crate::csharp_index::{CSharpCatalog, CSharpPage, ComponentSchemaBatch};
use crate::error::{internal_lock, StudioError};
use crate::fluent_create::{self, CreatedFluent, FluentDraft, FluentPreview};
use crate::fluent_diagnostics;
use crate::fluent_locale::{self, FluentInspection, LocaleSnapshot};
use crate::prototype_append::{self, AppendPreview};
use crate::prototype_components::{self, ComponentInspection, ComponentOperation};
use crate::prototype_create::{self, CreatedPrototype, PrototypeDraft, PrototypePreview};
use crate::prototype_fields::{self, FieldInspection, FieldLocator, FieldPatch, PrototypeFields};
use crate::prototype_localization::{self, EntityLocalizationSource};
use crate::prototype_merge::{
    self, LinkedPrototypeReport, PrototypeInheritancePreview, PrototypePartialPreview,
};
use crate::prototype_parents::{self, ParentInspection};
use crate::prototype_sources::{self, PrototypeSourceReport};
use crate::prototypes::{self, PrototypeCatalog, SourceOutline};
use crate::resource_browser::{self, ResourceBrowserPage};
use crate::resource_edit::{self, SaveResult};
use crate::rsi_create::{self, CreatedRsi, RsiCreationPreview, RsiDraft};
use crate::rsi_credits::{self, RsiCreditsUpdate};
use crate::rsi_delete::{self, DeletedRsiState, RsiDeleteRequest};
use crate::rsi_import::{self, ImportedRsiState, RsiStateImport};
use crate::rsi_preview::{self, RsiSheetImage, RsiSheetList};
use crate::rsi_rename::{self, RenamedRsiState, RsiRenameRequest};
use crate::rsi_replace;
use crate::rsi_restore::{self, RestoredRsiState, RsiArchiveList, RsiRestoreRequest};
use crate::rsi_size::{self, RsiSizeUpdate};
use crate::rsi_timing::{self, RsiTimingUpdate};
use crate::ui_sources::{UiSourceCatalog, UiSourcePage};

const MAX_SCAN_ENTRIES: usize = 250_000;
const MAX_READ_BYTES: u64 = 4 * 1024 * 1024;
const MAX_CSHARP_PREVIEW_BYTES: u64 = 2 * 1024 * 1024;
const MAX_RESULTS: usize = 250;

const MAX_CONTENT_SEARCH_FILES: usize = 8_192;
const MAX_CONTENT_SEARCH_BYTES: usize = 64 * 1024 * 1024;
const MAX_CONTENT_SEARCH_HITS: usize = 200;
const MAX_CONTENT_HITS_PER_FILE: usize = 12;

#[derive(Debug, Serialize)]
pub struct ContentSearchHit {
    pub path: String,
    pub kind: &'static str,
    pub line: usize,
    pub preview: String,
}

#[derive(Debug, Serialize)]
pub struct ContentSearchResults {
    pub items: Vec<ContentSearchHit>,
    pub files_scanned: usize,
    pub bytes_scanned: usize,
    pub complete: bool,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProjectOverview {
    pub project_root: String,
    pub prototype_files: usize,
    pub rsi_directories: usize,
    pub locale_files: usize,
    pub total_resources: usize,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ResourceEntry {
    pub path: String,
    pub kind: &'static str,
    #[serde(skip)]
    search_key: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProjectRefresh {
    pub overview: ProjectOverview,
    pub added_resources: usize,
    pub removed_resources: usize,
}

#[derive(Debug, Serialize)]
pub struct ResourcePage {
    pub total: usize,
    pub items: Vec<ResourceEntry>,
}

#[derive(Debug, Serialize)]
pub struct ResourceDocument {
    pub path: String,
    pub content: String,
    pub bytes: usize,
    pub revision: String,
}

#[derive(Debug)]
pub struct ProjectIndex {
    root: PathBuf,
    overview: ProjectOverview,
    resources: Vec<ResourceEntry>,
    positions: HashMap<String, usize>,
    prototype_catalog: Mutex<Option<Arc<PrototypeCatalog>>>,
    csharp_catalog: Mutex<Option<Arc<CSharpCatalog>>>,
    ui_catalog: Mutex<Option<Arc<UiSourceCatalog>>>,
    fluent_locale_cache: Mutex<HashMap<String, Arc<LocaleSnapshot>>>,
    edit_lock: Mutex<()>,
}

#[derive(Copy, Clone)]
enum ScanScope {
    Prototype,
    Texture,
    Locale,
}

impl ProjectIndex {
    pub fn open(input: &str) -> Result<Self, StudioError> {
        Self::open_with_progress(input, |_, _| {})
    }

    /// Report completed scan phases without inventing a percentage.
    /// The callback is deliberately non-fallible: event listeners must never
    /// break a valid project scan when their webview is closing.
    pub fn open_with_progress(
        input: &str,
        mut on_progress: impl FnMut(&'static str, usize),
    ) -> Result<Self, StudioError> {
        if input.trim().is_empty() {
            return Err(StudioError::new(
                "PROJECT_PATH_EMPTY",
                "Путь к проекту не указан.",
                "Выберите корневую папку исходников SS14, содержащую Resources/Prototypes.",
            ));
        }

        let root = fs::canonicalize(input.trim()).map_err(|error| {
            let (code, message, hint) = match error.kind() {
                std::io::ErrorKind::NotFound => (
                    "PROJECT_NOT_FOUND",
                    "Указанная папка проекта не найдена.",
                    "Проверьте путь, название папки и доступность диска.",
                ),
                std::io::ErrorKind::PermissionDenied => (
                    "PROJECT_ACCESS_DENIED",
                    "Нет доступа к папке проекта.",
                    "Проверьте права чтения на папку и содержащиеся в ней каталоги.",
                ),
                _ => (
                    "PROJECT_OPEN_FAILED",
                    "Не удалось открыть папку проекта.",
                    "Проверьте путь, права доступа и состояние диска.",
                ),
            };
            StudioError::new(code, message, hint).with_details(error.to_string())
        })?;

        if !root.is_dir() {
            return Err(StudioError::new(
                "PROJECT_NOT_DIRECTORY",
                "Выбранный путь ведёт к файлу, а не к папке.",
                "Укажите корневую директорию исходников SS14.",
            ));
        }

        let resources_root = root.join("Resources");
        let prototypes = resources_root.join("Prototypes");
        if !prototypes.is_dir() {
            return Err(StudioError::new(
                "PROJECT_STRUCTURE_INVALID",
                "В этой папке не найден каталог Resources/Prototypes.",
                "Откройте именно корень исходников SS14, а не вложенную папку Resources.",
            )
            .with_details(prototypes.display().to_string()));
        }

        validate_scope(&root, &prototypes)?;
        validate_scope(&root, &resources_root.join("Textures"))?;
        validate_scope(&root, &resources_root.join("Locale"))?;

        let mut resources = Vec::new();
        let mut traversed = 0;
        on_progress("prototypes", resources.len());
        scan(
            &root,
            &prototypes,
            ScanScope::Prototype,
            &mut traversed,
            &mut resources,
        )?;
        on_progress("textures", resources.len());
        scan(
            &root,
            &resources_root.join("Textures"),
            ScanScope::Texture,
            &mut traversed,
            &mut resources,
        )?;
        on_progress("locale", resources.len());
        scan(
            &root,
            &resources_root.join("Locale"),
            ScanScope::Locale,
            &mut traversed,
            &mut resources,
        )?;
        on_progress("finalizing", resources.len());
        Self::from_resources(root, resources)
    }

    fn from_resources(
        root: PathBuf,
        mut resources: Vec<ResourceEntry>,
    ) -> Result<Self, StudioError> {
        resources.sort_unstable_by(|a, b| a.path.cmp(&b.path));
        let mut positions = HashMap::with_capacity(resources.len());
        for (index, item) in resources.iter().enumerate() {
            if positions.insert(item.path.clone(), index).is_some() {
                return Err(StudioError::new(
                    "PROJECT_PATH_COLLISION",
                    "Некоторые пути ресурсов невозможно однозначно различить.",
                    "Проверьте имена файлов проекта и используемую кодировку файловой системы.",
                ));
            }
        }

        let resources_root = root.join("Resources");
        let mut warnings = Vec::new();
        if !resources_root.join("Textures").is_dir() {
            warnings
                .push("Каталог Resources/Textures отсутствует: RSI не проиндексированы.".into());
        }
        if !resources_root.join("Locale").is_dir() {
            warnings.push(
                "Каталог Resources/Locale отсутствует: локализации не проиндексированы.".into(),
            );
        }
        let count = |kind: &str| resources.iter().filter(|item| item.kind == kind).count();
        let prototype_files = count("yaml");
        let rsi_directories = count("rsi");
        let locale_files = count("ftl");
        if prototype_files == 0 {
            warnings.push("В Resources/Prototypes не найдено ни одного YAML-файла.".into());
        }
        let overview = ProjectOverview {
            project_root: root.to_string_lossy().into_owned(),
            prototype_files,
            rsi_directories,
            locale_files,
            total_resources: resources.len(),
            warnings,
        };

        Ok(Self {
            root,
            overview,
            resources,
            positions,
            prototype_catalog: Mutex::new(None),
            csharp_catalog: Mutex::new(None),
            ui_catalog: Mutex::new(None),
            fluent_locale_cache: Mutex::new(HashMap::new()),
            edit_lock: Mutex::new(()),
        })
    }

    pub fn overview(&self) -> &ProjectOverview {
        &self.overview
    }

    /// Full, explicit rescan. The old immutable snapshot remains usable until
    /// the new one is built; future watcher updates can reuse this boundary.
    pub fn refresh(&self) -> Result<(Self, ProjectRefresh), StudioError> {
        let refreshed = Self::open(&self.overview.project_root)?;
        let added_resources = refreshed
            .positions
            .keys()
            .filter(|path| !self.positions.contains_key(*path))
            .count();
        let removed_resources = self
            .positions
            .keys()
            .filter(|path| !refreshed.positions.contains_key(*path))
            .count();
        let summary = ProjectRefresh {
            overview: refreshed.overview.clone(),
            added_resources,
            removed_resources,
        };
        Ok((refreshed, summary))
    }

    /// Update only paths reported by the native watcher. The immutable old
    /// snapshot remains usable until the caller atomically publishes this one.
    /// Ambiguous/large event sets always fall back to the full validated scan.
    pub fn refresh_paths(
        &self,
        changed_paths: &[String],
    ) -> Result<(Self, ProjectRefresh), StudioError> {
        if changed_paths.is_empty() || changed_paths.len() > 256 {
            return self.refresh();
        }
        let prototypes = self.root.join("Resources/Prototypes");
        if !prototypes.is_dir() {
            return self.refresh();
        }
        for scope in [
            "Resources/Prototypes",
            "Resources/Textures",
            "Resources/Locale",
        ] {
            validate_scope(&self.root, &self.root.join(scope))?;
        }

        let mut targets = HashMap::<String, ScanScope>::new();
        for path in changed_paths {
            if path.is_empty() || path.len() > 1024 || path.contains('\\') {
                return self.refresh();
            }
            let relative = Path::new(path);
            if !relative
                .components()
                .all(|component| matches!(component, Component::Normal(_)))
            {
                return self.refresh();
            }
            // Content.* changes invalidate lazy C#/UI caches by publishing a
            // new ProjectIndex; these paths never enter the resource list.
            if relative.components().next().is_some_and(|part| {
                matches!(part, Component::Normal(name) if name.to_string_lossy().starts_with("Content."))
            }) {
                continue;
            }
            let (scope, target) = if relative.starts_with("Resources/Prototypes") {
                (ScanScope::Prototype, path.to_owned())
            } else if relative.starts_with("Resources/Locale") {
                (ScanScope::Locale, path.to_owned())
            } else if let Ok(texture_relative) = relative.strip_prefix("Resources/Textures") {
                let mut rsi = PathBuf::from("Resources/Textures");
                let mut detected = false;
                for component in texture_relative.components() {
                    rsi.push(component.as_os_str());
                    if has_extension(&rsi, "rsi") {
                        detected = true;
                        break;
                    }
                }
                if detected {
                    (ScanScope::Texture, rsi.to_string_lossy().replace('\\', "/"))
                } else {
                    (ScanScope::Texture, path.to_owned())
                }
            } else {
                return self.refresh();
            };
            targets.insert(target, scope);
        }

        // A directory notification and its children may occur in the same
        // burst. Scan the directory only once; otherwise the new snapshot
        // would contain duplicate paths.
        let all_targets = targets.keys().cloned().collect::<Vec<_>>();
        targets.retain(|target, _| {
            !all_targets
                .iter()
                .any(|parent| parent != target && target.starts_with(&format!("{parent}/")))
        });

        // Recheck all candidate paths before constructing the new index.
        // Never follow a newly introduced symlink into a different checkout.
        let mut updates = Vec::<ResourceEntry>::new();
        let mut visited = 0;
        for (target, scope) in &targets {
            let absolute = self.root.join(target);
            if has_symlink_ancestor(&self.root, &absolute)? {
                // Symlinked entries are not indexed; drop the old affected
                // subtree without traversing the symlink target.
                continue;
            }
            match fs::symlink_metadata(&absolute) {
                Ok(metadata) if metadata.is_dir() => {
                    if matches!(scope, ScanScope::Texture) && has_extension(&absolute, "rsi") {
                        updates.push(resource_entry(&self.root, &absolute, "rsi")?);
                    } else {
                        scan(&self.root, &absolute, *scope, &mut visited, &mut updates)?;
                    }
                }
                Ok(metadata) if metadata.is_file() => {
                    let kind = match scope {
                        ScanScope::Prototype
                            if has_extension(&absolute, "yml")
                                || has_extension(&absolute, "yaml") =>
                        {
                            Some("yaml")
                        }
                        ScanScope::Locale if has_extension(&absolute, "ftl") => Some("ftl"),
                        _ => None,
                    };
                    if let Some(kind) = kind {
                        updates.push(resource_entry(&self.root, &absolute, kind)?);
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(walk_error(&absolute, error)),
                _ => {}
            }
        }
        let mut entries = self
            .resources
            .iter()
            .filter(|entry| {
                !targets.keys().any(|target| {
                    entry.path == *target || entry.path.starts_with(&format!("{target}/"))
                })
            })
            .cloned()
            .collect::<Vec<_>>();
        entries.extend(updates);
        let fresh = Self::from_resources(self.root.clone(), entries)?;
        let summary = ProjectRefresh {
            added_resources: fresh
                .positions
                .keys()
                .filter(|path| !self.positions.contains_key(*path))
                .count(),
            removed_resources: self
                .positions
                .keys()
                .filter(|path| !fresh.positions.contains_key(*path))
                .count(),
            overview: fresh.overview.clone(),
        };
        Ok((fresh, summary))
    }

    /// Lazy, one-shot source scan. Concurrent requests share one result and
    /// never block the Tauri webview thread (IPC uses spawn_blocking).
    /// Explicit workspace refresh replaces the entire immutable index.
    fn csharp_catalog(&self) -> Result<Arc<CSharpCatalog>, StudioError> {
        let mut cache = self.csharp_catalog.lock().map_err(|_| internal_lock())?;
        if cache.is_none() {
            *cache = Some(Arc::new(CSharpCatalog::scan(&self.root)?));
        }
        cache.clone().ok_or_else(internal_lock)
    }

    fn ui_catalog(&self) -> Result<Arc<UiSourceCatalog>, StudioError> {
        let mut cache = self.ui_catalog.lock().map_err(|_| internal_lock())?;
        if cache.is_none() {
            *cache = Some(Arc::new(UiSourceCatalog::scan(&self.root)?));
        }
        cache.clone().ok_or_else(internal_lock)
    }

    pub fn ui_sources_page(
        &self,
        query: &str,
        offset: usize,
        limit: usize,
    ) -> Result<UiSourcePage, StudioError> {
        Ok(self.ui_catalog()?.page(query, offset, limit))
    }

    pub fn read_ui_source(&self, path: &str) -> Result<ResourceDocument, StudioError> {
        self.ui_catalog()?.read(&self.root, path)
    }

    pub fn csharp_page(
        &self,
        query: &str,
        kind: Option<&str>,
        offset: usize,
        limit: usize,
    ) -> Result<CSharpPage, StudioError> {
        Ok(self.csharp_catalog()?.page(query, kind, offset, limit))
    }

    /// A bounded, read-only lookup for the component editor. A missing name
    /// is not a YAML error: its class might be inherited or generated.
    pub fn csharp_component_schemas(
        &self,
        names: &[String],
    ) -> Result<ComponentSchemaBatch, StudioError> {
        if names.len() > 128
            || names.iter().any(|name| {
                name.is_empty()
                    || name.len() > 128
                    || !name
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.'))
            })
        {
            return Err(StudioError::new(
                "CSHARP_SCHEMA_INPUT_INVALID",
                "Список типов компонентов слишком велик или содержит неверное имя.",
                "Передайте не более 128 обычных имён компонентов из выбранного YAML-объявления.",
            ));
        }
        Ok(self.csharp_catalog()?.component_schemas(names))
    }

    /// Read an indexed C# declaration's source for the inspector, never write it.
    pub fn read_csharp_source(&self, rel_path: &str) -> Result<ResourceDocument, StudioError> {
        if !self.csharp_catalog()?.has_source(rel_path) {
            return Err(StudioError::new(
                "CSHARP_SOURCE_NOT_INDEXED",
                "Файл C# отсутствует в каталоге распознанных объявлений.",
                "Выберите класс через каталог C# и обновите индекс при изменении исходников.",
            ));
        }
        let path = fs::canonicalize(self.root.join(rel_path)).map_err(|error| {
            StudioError::new(
                "CSHARP_SOURCE_UNAVAILABLE",
                "Не удалось открыть исходник C#.",
                "Проверьте, что файл не был перемещён или удалён.",
            )
            .with_details(error.to_string())
        })?;
        if !path.starts_with(&self.root) {
            return Err(StudioError::new(
                "CSHARP_SOURCE_OUTSIDE_PROJECT",
                "Исходник C# оказался за пределами открытого проекта.",
                "Не открывайте исходники через внешние символические ссылки.",
            ));
        }
        let meta = fs::metadata(&path).map_err(|error| {
            StudioError::new(
                "CSHARP_SOURCE_UNAVAILABLE",
                "Не удалось получить сведения о C# файле.",
                "Проверьте права доступа.",
            )
            .with_details(error.to_string())
        })?;
        if !meta.is_file() || meta.len() > MAX_CSHARP_PREVIEW_BYTES {
            return Err(StudioError::new(
                "CSHARP_SOURCE_SIZE_INVALID",
                "Исходник C# не является обычным файлом или превышает 2 МиБ.",
                "Откройте этот файл во внешнем редакторе.",
            ));
        }
        let mut bytes = Vec::new();
        fs::File::open(&path)
            .and_then(|file| {
                file.take(MAX_CSHARP_PREVIEW_BYTES + 1)
                    .read_to_end(&mut bytes)
            })
            .map_err(|error| {
                StudioError::new(
                    "CSHARP_SOURCE_UNAVAILABLE",
                    "Не удалось прочитать исходник C#.",
                    "Проверьте файл на диске.",
                )
                .with_details(error.to_string())
            })?;
        if bytes.len() as u64 > MAX_CSHARP_PREVIEW_BYTES {
            return Err(StudioError::new(
                "CSHARP_SOURCE_SIZE_INVALID",
                "Исходник C# вырос во время чтения и превысил лимит 2 МиБ.",
                "Откройте файл во внешнем редакторе.",
            ));
        }
        let length = bytes.len();
        let content = String::from_utf8(bytes).map_err(|error| {
            StudioError::new(
                "CSHARP_SOURCE_ENCODING_INVALID",
                "Исходник C# не является UTF-8.",
                "Проверьте кодировку файла.",
            )
            .with_details(error.to_string())
        })?;
        Ok(ResourceDocument {
            path: rel_path.into(),
            revision: resource_edit::revision(content.as_bytes()),
            bytes: length,
            content,
        })
    }

    pub fn browse_resource_folder(
        &self,
        directory: &str,
        offset: usize,
        limit: usize,
    ) -> Result<ResourceBrowserPage, StudioError> {
        resource_browser::browse(&self.resources, directory, offset, limit)
    }

    pub fn is_yaml_indexed(&self, path: &str) -> bool {
        self.positions
            .get(path)
            .and_then(|index| self.resources.get(*index))
            .is_some_and(|entry| entry.kind == "yaml")
    }

    pub fn inspect_entity_localization(
        &self,
        locator: &FieldLocator,
        source: &str,
    ) -> Result<EntityLocalizationSource, StudioError> {
        if !self.is_yaml_indexed(&locator.file) {
            return Err(StudioError::new(
                "YAML_NOT_INDEXED",
                "Прототип отсутствует в индексе проекта.",
                "Обновите индекс ресурсов и выберите объявление заново.",
            ));
        }
        prototype_localization::inspect(locator, source)
    }

    pub fn is_editable_text_indexed(&self, path: &str) -> bool {
        self.positions
            .get(path)
            .and_then(|index| self.resources.get(*index))
            .is_some_and(|entry| matches!(entry.kind, "yaml" | "ftl"))
    }

    /// Parse only the active in-memory YAML draft. The resource path itself
    /// must already be indexed; source text is never persisted by inspection.
    pub fn inspect_yaml_outline(
        &self,
        path: &str,
        source: &str,
    ) -> Result<SourceOutline, StudioError> {
        if !self.is_yaml_indexed(path) {
            return Err(StudioError::new(
                "OUTLINE_NOT_INDEXED",
                "Объявления доступны только для YAML-файлов открытого проекта.",
                "Откройте YAML из каталога ресурсов Studio.",
            ));
        }
        prototypes::inspect_source_outline(&self.root, path, source, |rsi| {
            self.positions
                .get(rsi)
                .and_then(|index| self.resources.get(*index))
                .is_some_and(|entry| entry.kind == "rsi")
        })
    }

    /// Restore Electron Inspector's navigable links from referenced prototype
    /// IDs inside resolved source fields/components. Read-only and indexed.
    pub fn prototype_linked_references(
        &self,
        kind: &str,
        id: &str,
    ) -> Result<LinkedPrototypeReport, StudioError> {
        let catalog = self.prototypes()?;
        prototype_merge::linked_prototypes(&catalog, kind, id, |path| {
            if !self.is_yaml_indexed(path) {
                return Err(StudioError::new(
                    "PROTOTYPE_LINKS_NOT_INDEXED",
                    "YAML-источник отсутствует в индексе проекта.",
                    "Обновите каталог перед поиском связанных прототипов.",
                ));
            }
            self.read_resource(path).map(|document| document.content)
        })
    }

    /// Structural source inheritance + partials, read-only. C# DataField
    /// inheritance is deliberately not treated as fully resolved.
    pub fn prototype_inheritance_preview(
        &self,
        kind: &str,
        id: &str,
    ) -> Result<PrototypeInheritancePreview, StudioError> {
        let catalog = self.prototypes()?;
        prototype_merge::preview_inheritance(
            &catalog,
            kind,
            id,
            |path| {
                if !self.is_yaml_indexed(path) {
                    return Err(StudioError::new(
                        "PROTOTYPE_INHERITANCE_NOT_INDEXED",
                        "YAML-источник отсутствует в индексе проекта.",
                        "Обновите индекс и повторите просмотр цепочки.",
                    ));
                }
                self.read_resource(path).map(|document| document.content)
            },
            |rsi| {
                self.positions
                    .get(rsi)
                    .and_then(|index| self.resources.get(*index))
                    .is_some_and(|entry| entry.kind == "rsi")
            },
        )
    }

    /// Preview base + partial modifications without mutating project files.
    /// Does not apply parent inheritance or C# DataField defaults.
    pub fn prototype_partial_preview(
        &self,
        kind: &str,
        id: &str,
    ) -> Result<PrototypePartialPreview, StudioError> {
        let catalog = self.prototypes()?;
        prototype_merge::preview(&catalog, kind, id, |path| {
            if !self.is_yaml_indexed(path) {
                return Err(StudioError::new(
                    "PROTOTYPE_PARTIAL_NOT_INDEXED",
                    "YAML-источник отсутствует в индексе проекта.",
                    "Обновите каталог и повторите вычисление partial-правок.",
                ));
            }
            self.read_resource(path).map(|document| document.content)
        })
    }

    /// Read-only, bounded YAML field/component provenance across source-level
    /// ancestry. All source reads pass the indexed resource boundary.
    pub fn prototype_sources(
        &self,
        kind: &str,
        id: &str,
    ) -> Result<PrototypeSourceReport, StudioError> {
        let catalog = self.prototypes()?;
        prototype_sources::inspect(&catalog, kind, id, |path| {
            if !self.is_yaml_indexed(path) {
                return Err(StudioError::new(
                    "PROTOTYPE_SOURCE_NOT_INDEXED",
                    "YAML-источник больше не находится в индексе проекта.",
                    "Обновите индекс и повторите просмотр происхождения полей.",
                ));
            }
            self.read_resource(path).map(|document| document.content)
        })
    }

    pub fn prototypes(&self) -> Result<Arc<PrototypeCatalog>, StudioError> {
        let mut cache = self.prototype_catalog.lock().map_err(|_| internal_lock())?;
        Ok(cache
            .get_or_insert_with(|| Arc::new(PrototypeCatalog::build(&self.root, &self.resources)))
            .clone())
    }

    /// Analyze only an indexed YAML resource, using the in-memory source draft.
    pub fn analyze_yaml(
        &self,
        rel_path: &str,
        source: &str,
    ) -> Result<resource_edit::YamlSyntaxReport, StudioError> {
        if !self.is_yaml_indexed(rel_path) {
            return Err(StudioError::new(
                "YAML_NOT_INDEXED",
                "Файл не найден в индексе YAML текущего проекта.",
                "Выберите YAML через список ресурсов или обновите индекс.",
            ));
        }
        resource_edit::analyze_yaml(source)
    }

    /// Electron parity: check direct entity name/description/suffix in selected game locales.
    /// Read-only, index-backed and explicitly incomplete if any locale could not be scanned.
    pub fn analyze_entity_localization(
        &self,
        locator: &FieldLocator,
        source: &str,
        required_locales: &[String],
    ) -> Result<prototype_localization::EntityLocalizationAnalysis, StudioError> {
        let entity = self.inspect_entity_localization(locator, source)?;
        if required_locales.is_empty() || required_locales.len() > 24 {
            return Err(StudioError::new(
                "ENTITY_LOCALE_SELECTION_INVALID",
                "Список обязательных локалей пуст или слишком велик.",
                "Укажите от 1 до 24 игровых локалей в настройках.",
            ));
        }
        let mut locales = Vec::new();
        let mut seen = std::collections::HashSet::new();
        for locale in required_locales {
            let valid = locale.len() >= 2
                && locale.len() <= 48
                && locale.split('-').all(|part| {
                    !part.is_empty()
                        && part.len() <= 8
                        && part.bytes().all(|byte| byte.is_ascii_alphanumeric())
                })
                && locale
                    .as_bytes()
                    .first()
                    .is_some_and(u8::is_ascii_alphabetic);
            if !valid {
                return Err(StudioError::new(
                    "ENTITY_LOCALE_SELECTION_INVALID",
                    "В списке игровых локалей есть некорректный идентификатор.",
                    "Используйте имена каталогов вроде ru-RU или en-US.",
                ));
            }
            if seen.insert(locale.to_ascii_lowercase()) {
                locales.push(locale.clone());
            }
        }

        let mut targets = Vec::new();
        let mut complete = true;
        let mut warnings = Vec::new();
        let filename = std::path::Path::new(&locator.file)
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("entities.yml");
        let filename = format!(
            "{}.ftl",
            filename.trim_end_matches(".yml").trim_end_matches(".yaml")
        );
        let module = locator
            .file
            .split('/')
            .nth(2)
            .filter(|part| part.starts_with('_'));
        for locale in &locales {
            let snapshot = self.locale_snapshot_for(locale)?;
            if !snapshot.complete || snapshot.has_invalid_files() {
                complete = false;
                warnings.push(format!(
                    "{}: индекс FTL неполон или содержит ошибки синтаксиса.",
                    locale
                ));
            }
            let definitions = snapshot.entity_definitions(&entity.localization_id);
            if definitions.len() > 1 {
                complete = false;
                warnings.push(format!(
                    "{}: Fluent ID {} объявлен неоднократно; исправьте дубликаты.",
                    locale, entity.localization_id
                ));
            }
            let matching_file = snapshot
                .file_paths()
                .filter(|path| {
                    std::path::Path::new(path)
                        .file_name()
                        .and_then(|name| name.to_str())
                        == Some(filename.as_str())
                })
                .find(|path| module.is_none_or(|segment| path.contains(&format!("/{segment}/"))));
            let fallback = match module {
                Some(segment) => format!("Resources/Locale/{locale}/{segment}/{filename}"),
                None => format!("Resources/Locale/{locale}/{filename}"),
            };
            let destination = definitions
                .first()
                .map(|definition| definition.file.clone())
                .or_else(|| matching_file.map(ToString::to_string))
                .unwrap_or(fallback);
            let definition = definitions.first();
            targets.push(prototype_localization::EntityLocaleTarget {
                locale: locale.clone(),
                path: destination.clone(),
                file_exists: self.positions.contains_key(&destination),
                exists: prototype_localization::EntityLocalePresence {
                    name: definition.is_some_and(|definition| definition.name),
                    description: definition.is_some_and(|definition| definition.description),
                    suffix: definition.is_some_and(|definition| definition.suffix),
                },
            });
        }
        Ok(prototype_localization::build_analysis(
            entity, targets, complete, warnings,
        ))
    }

    fn locale_snapshot_for(&self, locale: &str) -> Result<Arc<LocaleSnapshot>, StudioError> {
        let snapshot = {
            let mut cache = self
                .fluent_locale_cache
                .lock()
                .map_err(|_| internal_lock())?;
            if let Some(existing) = cache.get(locale) {
                Arc::clone(existing)
            } else {
                let mut indexed = Vec::new();
                let mut warnings = Vec::new();
                let mut complete = true;
                let mut bytes = 0usize;
                let candidates = self.resources.iter().filter(|entry| {
                    entry.kind == "ftl" && fluent_locale::belongs_to_locale(&entry.path, locale)
                });
                for (number, entry) in candidates.enumerate() {
                    if number >= fluent_locale::MAX_LOCALE_FILES {
                        complete = false;
                        warnings.push(
                            "Лимит индекса локали — 4096 FTL-файлов. Проверка ссылок неполная."
                                .into(),
                        );
                        break;
                    }
                    match self.read_resource(&entry.path) {
                        Ok(document) => {
                            if bytes.saturating_add(document.bytes)
                                > fluent_locale::MAX_LOCALE_BYTES
                            {
                                complete = false;
                                warnings.push("Индекс локали достиг лимита памяти 64 МиБ. Проверка ссылок неполная.".into());
                                break;
                            }
                            bytes += document.bytes;
                            indexed.push(fluent_locale::scan_file(&entry.path, &document.content));
                        }
                        Err(error) => {
                            complete = false;
                            warnings.push(format!(
                                "Не удалось прочитать {}: {} [{}].",
                                entry.path, error.message, error.code,
                            ));
                        }
                    }
                }
                let built = Arc::new(LocaleSnapshot::new(locale, indexed, warnings, complete));
                cache.insert(locale.into(), Arc::clone(&built));
                built
            }
        };
        Ok(snapshot)
    }

    pub fn analyze_fluent(
        &self,
        rel_path: &str,
        source: &str,
    ) -> Result<FluentInspection, StudioError> {
        let indexed_ftl = self
            .positions
            .get(rel_path)
            .and_then(|index| self.resources.get(*index))
            .is_some_and(|entry| entry.kind == "ftl");
        if !indexed_ftl {
            return Err(StudioError::new(
                "FTL_NOT_INDEXED",
                "Файл отсутствует в каталоге Fluent-локализаций проекта.",
                "Выберите существующий .ftl в списке ресурсов или обновите индекс.",
            ));
        }
        // Check draft size before expensive locale indexing.
        let syntax = fluent_diagnostics::analyze(source)?;
        let locale = fluent_locale::locale_of(rel_path).ok_or_else(|| {
            StudioError::new(
                "FTL_LOCALE_INVALID",
                "Невозможно определить язык Fluent-файла.",
                "Используйте путь внутри Resources/Locale/<язык>/.",
            )
        })?;

        let snapshot = self.locale_snapshot_for(locale)?;
        Ok(FluentInspection {
            syntax,
            locale: snapshot.inspect(rel_path, source),
        })
    }

    pub fn preview_new_rsi(&self, draft: &RsiDraft) -> Result<RsiCreationPreview, StudioError> {
        rsi_create::preview(draft)
    }

    pub fn create_new_rsi(&self, draft: &RsiDraft) -> Result<CreatedRsi, StudioError> {
        let _guard = self.edit_lock.lock().map_err(|_| internal_lock())?;
        rsi_create::create(&self.root, draft)
    }

    pub fn preview_new_fluent(&self, draft: &FluentDraft) -> Result<FluentPreview, StudioError> {
        fluent_create::preview(draft)
    }

    pub fn create_new_fluent(&self, draft: &FluentDraft) -> Result<CreatedFluent, StudioError> {
        let _guard = self.edit_lock.lock().map_err(|_| internal_lock())?;
        fluent_create::create(&self.root, draft)
    }

    pub fn preview_new_prototype(
        &self,
        draft: &PrototypeDraft,
    ) -> Result<PrototypePreview, StudioError> {
        let mut preview = prototype_create::preview(draft)?;
        let catalog = self.prototypes()?;
        if catalog.has_identity(&preview.kind, &preview.id) {
            return Err(StudioError::new(
                "PROTOTYPE_ID_EXISTS",
                "Прототип с таким сочетанием типа и ID уже объявлен в проекте.",
                "Измените ID либо откройте существующее объявление из каталога.",
            ));
        }
        if !draft.parent.is_empty() && !catalog.has_identity(&draft.kind, &draft.parent) {
            preview.warnings.push(format!(
                "Родитель '{}' не найден в текущем индексе проекта; индекс может быть неполным или устаревшим.",
                draft.parent
            ));
        }
        if !draft.sprite.is_empty() {
            let indexed = prototypes::normalize_sprite_path(&draft.sprite)
                .and_then(|path| self.positions.get(&path))
                .and_then(|index| self.resources.get(*index))
                .is_some_and(|entry| entry.kind == "rsi");
            if !indexed {
                preview.warnings.push(format!(
                    "RSI '{}' не найден в текущем индексе проекта; индекс может быть неполным или устаревшим.",
                    draft.sprite
                ));
            }
        }
        Ok(preview)
    }

    /// Create a new, exclusive YAML file. The app command handles refreshing
    /// the immutable resource index after this succeeds.
    pub fn create_new_prototype(
        &self,
        draft: &PrototypeDraft,
    ) -> Result<CreatedPrototype, StudioError> {
        let _guard = self.edit_lock.lock().map_err(|_| internal_lock())?;
        self.preview_new_prototype(draft)?;
        prototype_create::create(&self.root, draft)
    }

    pub fn preview_append_prototype(
        &self,
        draft: &PrototypeDraft,
    ) -> Result<AppendPreview, StudioError> {
        if !self.is_yaml_indexed(&draft.file) {
            return Err(StudioError::new(
                "APPEND_NOT_INDEXED",
                "Файл для добавления отсутствует в индексе прототипов.",
                "Выберите существующий YAML-файл через список ресурсов проекта.",
            ));
        }
        let catalog = self.prototypes()?;
        if catalog.has_partial_declarations(&draft.file) {
            return Err(StudioError::new(
                "APPEND_PARTIAL_UNSUPPORTED",
                "Добавление в Partial Prototypes пока не поддерживается.",
                "Для такого файла используйте ручной YAML-редактор.",
            ));
        }
        let generated = self.preview_new_prototype(draft)?;
        let original = self.read_resource(&draft.file)?;
        prototype_append::preview_append(&original.content, generated)
    }

    pub fn append_prototype(
        &self,
        draft: &PrototypeDraft,
        expected_revision: &str,
    ) -> Result<CreatedPrototype, StudioError> {
        let _guard = self.edit_lock.lock().map_err(|_| internal_lock())?;
        let prepared = self.preview_append_prototype(draft)?;
        if prepared.expected_revision != expected_revision {
            return Err(StudioError::new(
                "RESOURCE_CHANGED_ON_DISK",
                "YAML изменился после предпросмотра добавления.",
                "Обновите предпросмотр и проверьте изменения. Файл не перезаписан.",
            ));
        }
        let original = self.read_resource(&draft.file)?;
        let combined = prototype_append::prepare_append(&original.content, &prepared.yaml)?;
        let saved = resource_edit::save_yaml(&self.root, &draft.file, expected_revision, combined)?;
        let mut warning = saved.durability_warning;
        match self.prototype_catalog.lock() {
            Ok(mut cache) => *cache = None,
            Err(_) => {
                warning = Some(
                    "YAML записан, но индекс прототипов не обновился. Переоткройте проект.".into(),
                )
            }
        };
        Ok(CreatedPrototype {
            file: prepared.file,
            kind: prepared.kind,
            id: prepared.id,
            yaml: prepared.yaml,
            warning,
        })
    }

    /// Changes made here produce only draft content; they cannot touch disk.
    pub fn inspect_prototype_components(
        &self,
        locator: &FieldLocator,
        source: &str,
    ) -> Result<ComponentInspection, StudioError> {
        if !self.is_yaml_indexed(&locator.file) {
            return Err(StudioError::new(
                "COMPONENT_NOT_INDEXED",
                "Файл прототипа не входит в индекс проекта.",
                "Откройте прототип из каталога Studio.",
            ));
        }
        if self.prototypes()?.has_partial_declarations(&locator.file) {
            return Err(StudioError::new(
                "COMPONENT_PARTIAL_UNSUPPORTED",
                "Редактор компонентов пока не поддерживает Partial Prototypes.",
                "Используйте текстовый редактор для нестандартных объявлений.",
            ));
        }
        prototype_components::inspect(source, locator)
    }

    pub fn patch_prototype_components(
        &self,
        locator: &FieldLocator,
        source: &str,
        operation: &ComponentOperation,
    ) -> Result<FieldPatch, StudioError> {
        self.inspect_prototype_components(locator, source)?;
        prototype_components::patch(source, locator, operation)
    }

    /// Ordered explicit parent IDs; never guesses partial-prototype merging.
    pub fn inspect_prototype_parents(
        &self,
        locator: &FieldLocator,
        source: &str,
    ) -> Result<ParentInspection, StudioError> {
        if !self.is_yaml_indexed(&locator.file) {
            return Err(StudioError::new(
                "PARENT_NOT_INDEXED",
                "YAML-файл не входит в индекс проекта.",
                "Откройте прототип из каталога Studio.",
            ));
        }
        if self.prototypes()?.has_partial_declarations(&locator.file) {
            return Err(StudioError::new(
                "PARENT_PARTIAL_UNSUPPORTED",
                "Редактор родителей не поддерживает Partial Prototypes.",
                "Используйте Monaco для сложных объявлений.",
            ));
        }
        prototype_parents::inspect(source, locator)
    }

    pub fn patch_prototype_parents(
        &self,
        locator: &FieldLocator,
        source: &str,
        parents: &[String],
    ) -> Result<FieldPatch, StudioError> {
        self.inspect_prototype_parents(locator, source)?;
        prototype_parents::patch(source, locator, parents)
    }

    /// Both operations only transform in-memory text: the user commits through
    /// the existing conflict-aware YAML save flow.
    pub fn inspect_prototype_fields(
        &self,
        locator: &FieldLocator,
        source: &str,
    ) -> Result<FieldInspection, StudioError> {
        if !self.is_yaml_indexed(&locator.file) {
            return Err(StudioError::new(
                "FIELDS_NOT_INDEXED",
                "Прототип находится вне проиндексированных YAML-файлов.",
                "Переоткройте проект и выберите прототип в каталоге.",
            ));
        }
        if self.prototypes()?.has_partial_declarations(&locator.file) {
            return Err(StudioError::new(
                "FIELDS_PARTIAL_UNSUPPORTED",
                "Форма пока недоступна для файлов с Partial Prototypes.",
                "Используйте текстовый редактор для tagged/configured partial.",
            ));
        }
        prototype_fields::inspect(source, locator)
    }

    pub fn patch_prototype_fields(
        &self,
        locator: &FieldLocator,
        source: &str,
        requested: &PrototypeFields,
    ) -> Result<FieldPatch, StudioError> {
        self.inspect_prototype_fields(locator, source)?;
        prototype_fields::patch(source, locator, requested)
    }

    /// Only indexed YAML resources may be edited. A mutex serializes saves
    /// performed by this Studio process. External writers are detected via
    /// optimistic revision checks, not silently overwritten.
    pub fn save_yaml(
        &self,
        rel_path: &str,
        expected_revision: &str,
        content: String,
    ) -> Result<SaveResult, StudioError> {
        let item = self
            .positions
            .get(rel_path)
            .and_then(|index| self.resources.get(*index))
            .ok_or_else(|| {
                StudioError::new(
                    "RESOURCE_NOT_INDEXED",
                    "Этот файл отсутствует в индексе проекта.",
                    "Сначала откройте YAML из списка ресурсов Studio.",
                )
            })?;
        if item.kind != "yaml" {
            return Err(StudioError::new(
                "RESOURCE_EDIT_NOT_SUPPORTED",
                "Запись доступна только для исходных YAML-файлов прототипов.",
                "RSI и FTL пока доступны для просмотра без изменений.",
            ));
        }
        let _guard = self.edit_lock.lock().map_err(|_| internal_lock())?;
        let mut result =
            resource_edit::save_yaml(&self.root, rel_path, expected_revision, content)?;
        match self.prototype_catalog.lock() {
            Ok(mut cache) => *cache = None,
            Err(_) => {
                result.durability_warning = Some(
                    "Файл записан, но каталог прототипов обновить не удалось. Переоткройте проект."
                        .into(),
                );
            }
        }
        Ok(result)
    }

    /// Edit indexed Fluent files with the same revision and atomic-write
    /// safeguards as YAML. The prototype cache is unaffected by FTL edits.
    pub fn save_ftl(
        &self,
        rel_path: &str,
        expected_revision: &str,
        content: String,
    ) -> Result<SaveResult, StudioError> {
        let item = self
            .positions
            .get(rel_path)
            .and_then(|index| self.resources.get(*index))
            .ok_or_else(|| {
                StudioError::new(
                    "RESOURCE_NOT_INDEXED",
                    "Файл локализации отсутствует в индексе проекта.",
                    "Обновите индекс и выберите существующий FTL-файл.",
                )
            })?;
        if item.kind != "ftl" {
            return Err(StudioError::new(
                "RESOURCE_EDIT_NOT_SUPPORTED",
                "Этим действием разрешено сохранять только Fluent-файлы.",
                "Для YAML используйте сохранение YAML; RSI пока доступны только для просмотра.",
            ));
        }
        let _guard = self.edit_lock.lock().map_err(|_| internal_lock())?;
        let mut saved = resource_edit::save_ftl(&self.root, rel_path, expected_revision, content)?;
        if let Some(locale) = fluent_locale::locale_of(rel_path) {
            match self.fluent_locale_cache.lock() {
                Ok(mut cache) => {
                    cache.remove(locale);
                }
                Err(_) => {
                    saved.durability_warning = Some(
                        "FTL сохранён, но индекс ссылок Fluent не сброшен. Обновите индекс проекта.".into(),
                    );
                }
            }
        }
        Ok(saved)
    }

    pub fn search(
        &self,
        query: &str,
        kind: Option<&str>,
        offset: usize,
        limit: usize,
    ) -> ResourcePage {
        let needle = query.trim().to_lowercase();
        let requested_kind = kind.unwrap_or("all");
        let filtered = self.resources.iter().filter(|entry| {
            (requested_kind == "all" || requested_kind == entry.kind)
                && (needle.is_empty() || entry.search_key.contains(&needle))
        });
        let mut total = 0;
        let mut items = Vec::new();
        let max = limit.clamp(1, MAX_RESULTS);
        for entry in filtered {
            if total >= offset && items.len() < max {
                items.push(entry.clone());
            }
            total += 1;
        }
        ResourcePage { total, items }
    }

    pub fn rsi_prefix_candidates(&self, query: &str) -> Vec<ResourceEntry> {
        let prefix = format!("resources/textures/{}", query.to_lowercase());
        self.resources.iter().filter(|entry| {
            entry.kind == "rsi"
                && entry.path.starts_with("Resources/Textures/")
                && entry.search_key.starts_with(&prefix)
                && entry.path.ends_with(".rsi")
                && !entry.path.chars().any(|c| c == '\\' || c <= '\u{1f}' || c == '\u{7f}')
                && entry.path.split('/').all(|part| !part.is_empty() && part != "." && part != "..")
        }).take(80).cloned().collect()
    }

    /// Bounded search in indexed resource text. No regex, writes or filesystem
    /// traversal beyond the existing project index. Large forks return a
    /// clearly labelled partial result instead of blocking indefinitely.
    pub fn search_content(
        &self,
        query: &str,
        kind: Option<&str>,
    ) -> Result<ContentSearchResults, StudioError> {
        let trimmed = query.trim();
        if trimmed.is_empty() || trimmed.len() > 128 || trimmed.chars().any(char::is_control) {
            return Err(StudioError::new(
                "CONTENT_SEARCH_QUERY_INVALID",
                "Поисковая строка должна содержать от 1 до 128 байт без управляющих символов.",
                "Укажите обычный текст для поиска по ресурсам проекта.",
            ));
        }
        let requested_kind = kind.unwrap_or("all");
        if !matches!(requested_kind, "all" | "yaml" | "ftl" | "rsi") {
            return Err(StudioError::new(
                "CONTENT_SEARCH_KIND_INVALID",
                "Неизвестный тип ресурса для поиска.",
                "Выберите все ресурсы, YAML, FTL или RSI.",
            ));
        }
        let needle = trimmed.to_lowercase();
        let mut result = ContentSearchResults {
            items: Vec::new(),
            files_scanned: 0,
            bytes_scanned: 0,
            complete: true,
            warnings: Vec::new(),
        };
        let mut read_failures = 0usize;
        let mut truncated_files = 0usize;
        for entry in &self.resources {
            if requested_kind != "all" && entry.kind != requested_kind {
                continue;
            }
            if result.files_scanned >= MAX_CONTENT_SEARCH_FILES {
                result.complete = false;
                result.warnings.push(format!(
                    "Достигнут лимит {} просмотренных файлов. Уточните запрос.",
                    MAX_CONTENT_SEARCH_FILES
                ));
                break;
            }
            let document = match self.read_resource(&entry.path) {
                Ok(document) => document,
                Err(error) => {
                    result.complete = false;
                    read_failures += 1;
                    if result.warnings.len() < 5 {
                        result
                            .warnings
                            .push(format!("{}: файл пропущен [{}].", entry.path, error.code));
                    }
                    continue;
                }
            };
            if result.bytes_scanned.saturating_add(document.bytes) > MAX_CONTENT_SEARCH_BYTES {
                result.complete = false;
                result.warnings.push(
                    "Лимит чтения 64 МиБ достигнут. Уточните запрос или выберите тип файлов."
                        .into(),
                );
                break;
            }
            result.files_scanned += 1;
            result.bytes_scanned += document.bytes;
            let mut file_hits = 0usize;
            for (line_index, line) in document.content.lines().enumerate() {
                if !line.to_lowercase().contains(&needle) {
                    continue;
                }
                if file_hits >= MAX_CONTENT_HITS_PER_FILE {
                    result.complete = false;
                    truncated_files += 1;
                    break;
                }
                if result.items.len() >= MAX_CONTENT_SEARCH_HITS {
                    result.complete = false;
                    result
                        .warnings
                        .push("Показаны первые 200 совпадений. Уточните поисковую строку.".into());
                    return Ok(result);
                }
                let preview: String = line.trim().chars().take(180).collect();
                result.items.push(ContentSearchHit {
                    path: entry.path.clone(),
                    kind: entry.kind,
                    line: line_index + 1,
                    preview,
                });
                file_hits += 1;
            }
        }
        if read_failures > 5 {
            result.warnings.push(format!(
                "Всего пропущено недоступных или слишком больших файлов: {}.",
                read_failures
            ));
        }
        if truncated_files > 0 {
            result.warnings.push(format!(
                "В {} файлах показаны только первые 12 совпадений. Уточните запрос.",
                truncated_files
            ));
        }
        Ok(result)
    }

    fn verify_indexed_rsi(&self, rel_path: &str) -> Result<(), StudioError> {
        let indexed = self
            .positions
            .get(rel_path)
            .and_then(|index| self.resources.get(*index))
            .is_some_and(|entry| entry.kind == "rsi");
        if !indexed {
            return Err(StudioError::new(
                "RSI_NOT_INDEXED",
                "RSI отсутствует в индексе проекта.",
                "Выберите RSI через список ресурсов открытого проекта.",
            ));
        }
        Ok(())
    }

    pub fn list_rsi_sheets(&self, rel_path: &str) -> Result<RsiSheetList, StudioError> {
        self.verify_indexed_rsi(rel_path)?;
        rsi_preview::list(&self.root, rel_path)
    }

    pub fn read_rsi_sheet(&self, rel_path: &str, name: &str) -> Result<RsiSheetImage, StudioError> {
        self.verify_indexed_rsi(rel_path)?;
        rsi_preview::read(&self.root, rel_path, name)
    }

    pub fn import_rsi_state(
        &self,
        request: &RsiStateImport,
    ) -> Result<ImportedRsiState, StudioError> {
        self.verify_indexed_rsi(&request.path)?;
        let _guard = self.edit_lock.lock().map_err(|_| internal_lock())?;
        rsi_import::import(&self.root, request)
    }

    pub fn attach_rsi_state(
        &self,
        request: &RsiStateImport,
    ) -> Result<ImportedRsiState, StudioError> {
        self.verify_indexed_rsi(&request.path)?;
        let _guard = self.edit_lock.lock().map_err(|_| internal_lock())?;
        rsi_import::attach(&self.root, request)
    }

    pub fn create_rsi_state(
        &self,
        request: &RsiStateImport,
    ) -> Result<ImportedRsiState, StudioError> {
        self.verify_indexed_rsi(&request.path)?;
        let _guard = self.edit_lock.lock().map_err(|_| internal_lock())?;
        rsi_import::create_metadata_only(&self.root, request)
    }

    pub fn replace_rsi_state(
        &self,
        request: &RsiStateImport,
    ) -> Result<ImportedRsiState, StudioError> {
        self.verify_indexed_rsi(&request.path)?;
        let _guard = self.edit_lock.lock().map_err(|_| internal_lock())?;
        rsi_replace::replace(&self.root, request)
    }

    pub fn rename_rsi_state(
        &self,
        request: &RsiRenameRequest,
    ) -> Result<RenamedRsiState, StudioError> {
        self.verify_indexed_rsi(&request.path)?;
        let _guard = self.edit_lock.lock().map_err(|_| internal_lock())?;
        rsi_rename::rename(&self.root, request)
    }

    pub fn update_rsi_credits(
        &self,
        request: &RsiCreditsUpdate,
    ) -> Result<ImportedRsiState, StudioError> {
        self.verify_indexed_rsi(&request.path)?;
        let _guard = self.edit_lock.lock().map_err(|_| internal_lock())?;
        rsi_credits::update(&self.root, request)
    }

    pub fn update_rsi_size(
        &self,
        request: &RsiSizeUpdate,
    ) -> Result<ImportedRsiState, StudioError> {
        self.verify_indexed_rsi(&request.path)?;
        let _guard = self.edit_lock.lock().map_err(|_| internal_lock())?;
        rsi_size::update(&self.root, request)
    }

    pub fn update_rsi_timing(
        &self,
        request: &RsiTimingUpdate,
    ) -> Result<ImportedRsiState, StudioError> {
        self.verify_indexed_rsi(&request.path)?;
        let _guard = self.edit_lock.lock().map_err(|_| internal_lock())?;
        rsi_timing::update(&self.root, request)
    }

    pub fn delete_rsi_state(
        &self,
        request: &RsiDeleteRequest,
    ) -> Result<DeletedRsiState, StudioError> {
        self.verify_indexed_rsi(&request.path)?;
        let _guard = self.edit_lock.lock().map_err(|_| internal_lock())?;
        rsi_delete::delete(&self.root, request)
    }

    pub fn list_rsi_archives(&self, path: &str) -> Result<RsiArchiveList, StudioError> {
        self.verify_indexed_rsi(path)?;
        rsi_restore::list(&self.root, path)
    }

    pub fn restore_rsi_state(
        &self,
        request: &RsiRestoreRequest,
    ) -> Result<RestoredRsiState, StudioError> {
        self.verify_indexed_rsi(&request.path)?;
        let _guard = self.edit_lock.lock().map_err(|_| internal_lock())?;
        rsi_restore::restore(&self.root, request)
    }

    pub fn read_resource(&self, rel_path: &str) -> Result<ResourceDocument, StudioError> {
        let item = self
            .positions
            .get(rel_path)
            .and_then(|index| self.resources.get(*index))
            .ok_or_else(|| {
                StudioError::new(
                    "RESOURCE_NOT_INDEXED",
                    "Запрошенный ресурс не найден в открытом проекте.",
                    "Обновите проект или выберите существующий файл в списке ресурсов.",
                )
            })?;

        let mut absolute_path = self.root.join(&item.path);
        if item.kind == "rsi" {
            absolute_path.push("meta.json");
        }
        let canonical = fs::canonicalize(&absolute_path).map_err(|error| {
            StudioError::new(
                "RESOURCE_READ_FAILED",
                "Не удалось открыть выбранный ресурс.",
                "Убедитесь, что файл не был перемещён или удалён другим приложением.",
            )
            .with_details(error.to_string())
        })?;

        if !canonical.starts_with(&self.root) {
            return Err(StudioError::new(
                "RESOURCE_OUTSIDE_PROJECT",
                "Ресурс находится за пределами выбранного проекта.",
                "Откройте ресурс непосредственно в его собственном проекте.",
            ));
        }

        let metadata = fs::metadata(&canonical).map_err(|error| {
            StudioError::new(
                "RESOURCE_READ_FAILED",
                "Не удалось получить свойства ресурса.",
                "Проверьте права доступа к выбранному файлу.",
            )
            .with_details(error.to_string())
        })?;
        if !metadata.is_file() {
            return Err(StudioError::new(
                "RESOURCE_NOT_FILE",
                "Ожидаемый файл ресурса отсутствует.",
                "Проверьте содержимое каталога ресурса.",
            ));
        }
        if metadata.len() > MAX_READ_BYTES {
            return Err(StudioError::new(
                "RESOURCE_TOO_LARGE",
                "Файл слишком большой для предварительного просмотра.",
                "Откройте его в отдельном редакторе. Позднее Studio получит потоковую загрузку.",
            )
            .with_details(format!("{} bytes", metadata.len())));
        }

        // Re-check the read size: the file may have grown after metadata().
        let handle = fs::File::open(&canonical).map_err(|error| {
            StudioError::new(
                "RESOURCE_READ_FAILED",
                "Не удалось открыть ресурс для чтения.",
                "Проверьте права доступа к выбранному файлу.",
            )
            .with_details(error.to_string())
        })?;
        let mut bytes = Vec::new();
        handle
            .take(MAX_READ_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|error| {
                StudioError::new(
                    "RESOURCE_READ_FAILED",
                    "Не удалось прочитать ресурс.",
                    "Проверьте доступность файла и повторите действие.",
                )
                .with_details(error.to_string())
            })?;
        if bytes.len() as u64 > MAX_READ_BYTES {
            return Err(StudioError::new(
                "RESOURCE_TOO_LARGE",
                "Файл увеличился во время чтения и превысил лимит просмотра.",
                "Закройте меняющий этот файл процесс и повторите действие.",
            ));
        }
        let bytes_len = bytes.len();
        let content = String::from_utf8(bytes).map_err(|error| {
            StudioError::new(
                "RESOURCE_NOT_UTF8",
                "Файл невозможно показать как UTF-8 текст.",
                "Проверьте кодировку ресурса или откройте его в другом редакторе.",
            )
            .with_details(error.to_string())
        })?;
        let revision = resource_edit::revision(content.as_bytes());
        Ok(ResourceDocument {
            path: item.path.clone(),
            content,
            bytes: bytes_len,
            revision,
        })
    }
}

fn validate_scope(root: &Path, scope: &Path) -> Result<(), StudioError> {
    if !scope.exists() {
        return Ok(());
    }
    let relative = scope.strip_prefix(root).map_err(|error| {
        StudioError::new(
            "PROJECT_PATH_INVALID",
            "Внутренний путь проекта оказался некорректным.",
            "Проверьте структуру папок исходников.",
        )
        .with_details(error.to_string())
    })?;
    let mut current = root.to_path_buf();
    for part in relative.components() {
        current.push(part);
        let metadata =
            fs::symlink_metadata(&current).map_err(|error| walk_error(&current, error))?;
        if metadata.file_type().is_symlink() {
            return Err(StudioError::new(
                "PROJECT_SYMLINKED_SCOPE",
                "Каталог ресурсов проекта использует символическую ссылку.",
                "Для начального сканера используйте обычную папку. Поддержка внешних каталогов появится отдельно.",
            )
            .with_details(current.display().to_string()));
        }
    }
    let canonical = fs::canonicalize(scope).map_err(|error| walk_error(scope, error))?;
    if !canonical.starts_with(root) {
        return Err(StudioError::new(
            "PROJECT_SCOPE_OUTSIDE_ROOT",
            "Каталог ресурсов находится за пределами проекта.",
            "Используйте проект с ресурсами внутри выбранного корня.",
        )
        .with_details(canonical.display().to_string()));
    }
    Ok(())
}

/// Only inspect path metadata; do not canonicalize through a symlink.
fn has_symlink_ancestor(root: &Path, path: &Path) -> Result<bool, StudioError> {
    let relative = path.strip_prefix(root).map_err(|error| {
        StudioError::new(
            "PROJECT_PATH_INVALID",
            "Путь обновления вышел за границы проекта.",
            "Выполните полный перескан проекта.",
        )
        .with_details(error.to_string())
    })?;
    let mut current = root.to_path_buf();
    for component in relative.components() {
        current.push(component);
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() => return Ok(true),
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            Err(error) => return Err(walk_error(&current, error)),
        }
    }
    Ok(false)
}

fn scan(
    project_root: &Path,
    scope_root: &Path,
    scope: ScanScope,
    visited: &mut usize,
    result: &mut Vec<ResourceEntry>,
) -> Result<(), StudioError> {
    if !scope_root.exists() {
        return Ok(());
    }

    let mut stack = vec![scope_root.to_path_buf()];
    while let Some(folder) = stack.pop() {
        let entries = fs::read_dir(&folder).map_err(|error| walk_error(&folder, error))?;
        for next in entries {
            let entry = next.map_err(|error| walk_error(&folder, error))?;
            *visited += 1;
            if *visited > MAX_SCAN_ENTRIES {
                return Err(StudioError::new(
                    "PROJECT_SCAN_LIMIT",
                    "В проекте превышен лимит начального обхода файлов.",
                    "Исключите лишние каталоги или используйте проект меньшего размера до внедрения расширенного индексатора.",
                ));
            }

            let kind = entry
                .file_type()
                .map_err(|error| walk_error(&entry.path(), error))?;
            // No symlinks: prevent cycles and escaping the user-selected root.
            if kind.is_symlink() {
                continue;
            }

            let path = entry.path();
            if kind.is_dir() {
                if matches!(scope, ScanScope::Texture) && has_extension(&path, "rsi") {
                    result.push(resource_entry(project_root, &path, "rsi")?);
                } else {
                    stack.push(path);
                }
            } else if kind.is_file() {
                let entry_kind = match scope {
                    ScanScope::Prototype
                        if has_extension(&path, "yml") || has_extension(&path, "yaml") =>
                    {
                        Some("yaml")
                    }
                    ScanScope::Locale if has_extension(&path, "ftl") => Some("ftl"),
                    _ => None,
                };
                if let Some(entry_kind) = entry_kind {
                    result.push(resource_entry(project_root, &path, entry_kind)?);
                }
            }
        }
    }
    Ok(())
}

fn has_extension(path: &Path, extension: &str) -> bool {
    path.extension()
        .and_then(|part| part.to_str())
        .is_some_and(|part| part.eq_ignore_ascii_case(extension))
}

fn resource_entry(
    root: &Path,
    path: &Path,
    kind: &'static str,
) -> Result<ResourceEntry, StudioError> {
    let relative = path.strip_prefix(root).map_err(|error| {
        StudioError::new(
            "PROJECT_PATH_INVALID",
            "Ошибка определения относительного пути ресурса.",
            "Проверьте расположение файлов внутри корня проекта.",
        )
        .with_details(error.to_string())
    })?;

    let path = relative.to_string_lossy().replace('\\', "/");
    Ok(ResourceEntry {
        search_key: path.to_lowercase(),
        path,
        kind,
    })
}

fn walk_error(path: &Path, error: std::io::Error) -> StudioError {
    StudioError::new(
        "PROJECT_SCAN_FAILED",
        "Невозможно прочитать один из каталогов проекта.",
        "Проверьте права доступа на чтение и состояние диска.",
    )
    .with_details(format!("{}: {}", path.display(), error))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_ID: AtomicU64 = AtomicU64::new(0);

    struct Fixture {
        root: PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            let n = NEXT_ID.fetch_add(1, Ordering::Relaxed);
            let root =
                std::env::temp_dir().join(format!("ss14-studio-rust-{}-{}", std::process::id(), n));
            fs::create_dir_all(root.join("Resources/Prototypes")).unwrap();
            Self { root }
        }

        fn write(&self, path: &str, text: &str) {
            let full = self.root.join(path);
            fs::create_dir_all(full.parent().unwrap()).unwrap();
            fs::write(full, text).unwrap();
        }

        fn root_str(&self) -> &str {
            self.root.to_str().unwrap()
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn inherited_sprite_preview_respects_overrides_and_reports_ambiguity() {
        let fx = Fixture::new();
        fx.write("Resources/Prototypes/parent.yml", "- type: entity\n  id: Parent\n  components:\n  - type: Sprite\n    sprite: Objects/parent.rsi\n    state: base\n    layers:\n    - state: parent-layer\n");
        fx.write("Resources/Prototypes/child.yml", "- type: entity\n  id: Child\n  parent: Parent\n  components:\n  - type: Sprite\n    state: child\n    layers:\n    - state: child-layer\n");
        fx.write("Resources/Prototypes/other.yml", "- type: entity\n  id: Other\n  components:\n  - type: Sprite\n    sprite: Objects/other.rsi\n- type: entity\n  id: Inherited\n  parent: Parent\n- type: entity\n  id: Multi\n  parent: [Parent, Other]\n- type: entity\n  id: Missing\n  parent: Absent\n");
        let project = ProjectIndex::open(fx.root_str()).unwrap();
        let report = project
            .prototype_inheritance_preview("entity", "Child")
            .unwrap();
        assert!(report.structural_complete);
        assert!(!report.runtime_exact);
        let sprite = report.sprite.unwrap();
        let link = sprite.sprite.unwrap();
        assert_eq!(link.path, "Resources/Textures/Objects/parent.rsi");
        assert_eq!(link.state.as_deref(), Some("child"));
        assert_eq!(sprite.layers_total, 1);
        assert_eq!(sprite.layers[0].state.as_deref(), Some("child-layer"));
        assert_eq!(sprite.layers[0].path.as_deref(), Some(link.path.as_str()));
        let source = sprite.source.unwrap();
        assert_eq!(source.file, "Resources/Prototypes/child.yml");
        assert_eq!(source.line, 1);
        let inherited = project
            .prototype_inheritance_preview("entity", "Inherited")
            .unwrap();
        let parent_sprite = inherited.sprite.unwrap();
        assert_eq!(parent_sprite.sprite.unwrap().state.as_deref(), Some("base"));
        assert_eq!(
            parent_sprite.source.unwrap().file,
            "Resources/Prototypes/parent.yml"
        );
        let multi = project
            .prototype_inheritance_preview("entity", "Multi")
            .unwrap();
        assert!(!multi.structural_complete);
        assert!(!multi.warnings.is_empty());
        let missing = project
            .prototype_inheritance_preview("entity", "Missing")
            .unwrap();
        assert!(!missing.structural_complete);
        assert!(!missing.warnings.is_empty());
    }

    #[test]
    fn inheritance_preview_resolves_chain_and_component_overrides_without_disk_writes() {
        let fx = Fixture::new();
        fx.write("Resources/Prototypes/root.yml",
            "- type: entity\n  id: Root\n  name: Grand\n  components:\n  - type: Sprite\n    state: grand\n    shader: unshaded\n");
        fx.write("Resources/Prototypes/parent.yml",
            "- type: entity\n  id: Parent\n  parent: Root\n  name: Parent\n  components:\n  - type: Physics\n    mass: 5\n");
        fx.write("Resources/Prototypes/child.yml",
            "- type: entity\n  id: Child\n  parent: Parent\n  name: Child\n  components:\n  - type: Sprite\n    state: child\n");
        let project = ProjectIndex::open(fx.root_str()).unwrap();
        let report = project
            .prototype_inheritance_preview("entity", "Child")
            .unwrap();
        assert!(report.structural_complete, "{:?}", report.warnings);
        assert!(!report.runtime_exact);
        assert_eq!(report.lineage, ["Root", "Parent", "Child"]);
        assert_eq!(report.direct_parents, ["Parent"]);
        assert_eq!(report.components.len(), 2);
        let sprite = report
            .components
            .iter()
            .find(|component| component.type_name == "Sprite")
            .unwrap();
        assert_eq!(sprite.keys, ["state", "shader"]);
        assert_eq!(sprite.source_file, "Resources/Prototypes/child.yml");
        assert_eq!(
            report
                .fields
                .iter()
                .find(|field| field.key == "name")
                .unwrap()
                .preview,
            "Child"
        );
        assert!(project
            .read_resource("Resources/Prototypes/root.yml")
            .unwrap()
            .content
            .contains("grand"));
    }

    #[test]
    fn inheritance_preview_warns_on_cycles_and_missing_parents() {
        let fx = Fixture::new();
        fx.write("Resources/Prototypes/cycle.yml",
            "- type: entity\n  id: A\n  parent: B\n  name: A\n- type: entity\n  id: B\n  parent: A\n  description: B\n");
        fx.write(
            "Resources/Prototypes/missing.yml",
            "- type: entity\n  id: M\n  parent: MissingParent\n  name: M\n",
        );
        let project = ProjectIndex::open(fx.root_str()).unwrap();
        let cycle = project
            .prototype_inheritance_preview("entity", "A")
            .unwrap();
        assert!(!cycle.structural_complete);
        assert!(cycle
            .warnings
            .iter()
            .any(|warning| matches!(warning, prototype_merge::PrototypeWarning::Raw(message) if message.contains("Цикл"))));
        let missing = project
            .prototype_inheritance_preview("entity", "M")
            .unwrap();
        assert!(!missing.structural_complete);
        assert!(missing
            .warnings
            .iter()
            .any(|warning| matches!(warning, prototype_merge::PrototypeWarning::Raw(message) if message.contains("MissingParent"))));
        assert_eq!(missing.fields[0].preview, "M");
    }

    #[test]
    fn linked_prototypes_matches_electron_inspector_fields_and_deduplicates_ids() {
        let fx = Fixture::new();
        fx.write("Resources/Prototypes/targets.yml",
            "- type: entity\n  id: Other\n  name: Other\n- type: entity\n  id: Third\n  name: Third\n");
        fx.write("Resources/Prototypes/source.yml",
            "- type: entity\n  id: Sample\n  components:\n  - type: Spawn\n    prototype: Other\n    possible: [Other, Third]\n    sprite: Objects/Other.rsi\n  description: Some text with spaces\n");
        let project = ProjectIndex::open(fx.root_str()).unwrap();
        let result = project
            .prototype_linked_references("entity", "Sample")
            .unwrap();
        assert!(result.source_complete, "{:?}", result.warnings);
        assert!(!result.limited);
        assert_eq!(result.items.len(), 2);
        assert_eq!(result.items[0].id, "Other");
        assert_eq!(result.items[0].field, "components[0].prototype");
        assert_eq!(result.items[1].id, "Third");
        assert_eq!(result.items[1].field, "components[0].possible[1]");
    }

    #[test]
    fn linked_prototypes_can_find_references_from_parent_components() {
        let fx = Fixture::new();
        fx.write("Resources/Prototypes/prototypes.yml",
            "- type: entity\n  id: Target\n- type: entity\n  id: Base\n  components:\n  - type: Spawn\n    prototype: Target\n- type: entity\n  id: Child\n  parent: Base\n");
        let project = ProjectIndex::open(fx.root_str()).unwrap();
        let result = project
            .prototype_linked_references("entity", "Child")
            .unwrap();
        assert!(result.source_complete, "{:?}", result.warnings);
        assert!(
            result
                .items
                .iter()
                .any(|ref_item| ref_item.id == "Target"
                    && ref_item.field == "components[0].prototype")
        );
    }

    #[test]
    fn inheritance_diamond_counts_shared_parent_partials_once() {
        let fx = Fixture::new();
        fx.write("Resources/Prototypes/root.yml",
            "- type: entity\n  id: Shared\n  name: Base\n- type: entity\n  id: Left\n  parent: Shared\n- type: entity\n  id: Right\n  parent: Shared\n- type: entity\n  id: Diamond\n  parent: [Left, Right]\n");
        fx.write(
            "Resources/PartialPrototypes/partialPrototypes.yml",
            "- /Prototypes/patches\n",
        );
        fx.write(
            "Resources/Prototypes/patches/patch.yml",
            "- type: entity\n  id: Shared\n  name: Patched\n",
        );
        let index = ProjectIndex::open(fx.root_str()).unwrap();
        let report = index
            .prototype_inheritance_preview("entity", "Diamond")
            .unwrap();
        assert_eq!(report.total_partials, 1);
        assert_eq!(report.lineage, ["Shared", "Left", "Right", "Diamond"]);
        assert_eq!(
            report
                .fields
                .iter()
                .find(|field| field.key == "name")
                .unwrap()
                .preview,
            "Patched"
        );
        assert!(!report.structural_complete);
    }

    #[test]
    fn inheritance_preview_applies_parent_partials_before_child_and_marks_multi_parent() {
        let fx = Fixture::new();
        fx.write("Resources/Prototypes/base.yml",
            "- type: entity\n  id: First\n  name: First\n  components:\n  - type: Sprite\n    state: old\n- type: entity\n  id: Second\n  name: Second\n");
        fx.write(
            "Resources/PartialPrototypes/partialPrototypes.yml",
            "- /Prototypes/patches\n",
        );
        fx.write(
            "Resources/Prototypes/patches/patch.yml",
            "- type: entity\n  id: First\n  components:\n  - type: Sprite\n    state: new\n",
        );
        fx.write("Resources/Prototypes/child.yml",
            "- type: entity\n  id: Child\n  parent: First\n  name: Child\n- type: entity\n  id: Multi\n  parent: [First, Second]\n");
        let project = ProjectIndex::open(fx.root_str()).unwrap();
        let single = project
            .prototype_inheritance_preview("entity", "Child")
            .unwrap();
        assert!(single.structural_complete, "{:?}", single.warnings);
        assert_eq!(single.total_partials, 1);
        assert_eq!(
            single.components[0].source_file,
            "Resources/Prototypes/patches/patch.yml"
        );
        let multiple = project
            .prototype_inheritance_preview("entity", "Multi")
            .unwrap();
        assert!(!multiple.structural_complete);
        assert!(multiple
            .warnings
            .iter()
            .any(|warning| matches!(warning, prototype_merge::PrototypeWarning::Structured { code: "INHERIT_MULTIPLE_PARENTS", params, .. } if params["count"] == 2)));
    }

    #[test]
    fn prototype_partial_preview_applies_clear_and_component_modifications_without_writing() {
        let fx = Fixture::new();
        fx.write("Resources/Prototypes/base.yml",
            "- type: entity\n  id: Item\n  parent: [Old]\n  name: Before\n  components:\n  - type: Sprite\n    state: old\n  - type: Physics\n");
        fx.write(
            "Resources/PartialPrototypes/partialPrototypes.yml",
            "- /Prototypes/patches\n",
        );
        fx.write("Resources/Prototypes/patches/patch.yml",
            "- type: entity\n  id: Item\n  parent: !Clear [New]\n  name: After\n  components:\n  - !Remove type: Physics\n  - type: Sprite\n    state: new\n");
        let project = ProjectIndex::open(fx.root_str()).unwrap();
        let report = project.prototype_partial_preview("entity", "Item").unwrap();
        assert!(report.exact, "{:?}", report.warnings);
        assert_eq!(report.parents, ["New"]);
        assert_eq!(report.applied_partials, 1);
        assert_eq!(report.components.len(), 1);
        assert_eq!(report.components[0].type_name, "Sprite");
        assert_eq!(
            report
                .fields
                .iter()
                .find(|field| field.key == "name")
                .unwrap()
                .preview,
            "After"
        );
        assert!(project
            .read_resource("Resources/Prototypes/base.yml")
            .unwrap()
            .content
            .contains("Before"));
    }

    #[test]
    fn prototype_source_provenance_reads_declared_fields_from_parent_and_child() {
        let fx = Fixture::new();
        fx.write("Resources/Prototypes/base.yml",
            "- type: entity\n  id: Base\n  name: Parent\n  components:\n  - type: Transform\n  - type: Sprite\n");
        fx.write("Resources/Prototypes/child.yml",
            "- type: entity\n  id: Child\n  parent: Base\n  description: Child\n  components:\n  - type: Physics\n");
        let index = ProjectIndex::open(fx.root_str()).unwrap();
        let report = index.prototype_sources("entity", "Child").unwrap();
        assert_eq!(report.items.len(), 2);
        assert_eq!(report.items[0].id, "Child");
        assert_eq!(report.items[0].depth, 0);
        assert_eq!(report.items[0].fields, ["parent", "description"]);
        assert_eq!(report.items[0].components, ["Physics"]);
        assert_eq!(report.items[1].id, "Base");
        assert_eq!(report.items[1].depth, 1);
        assert_eq!(report.items[1].components, ["Transform", "Sprite"]);
        assert!(report.ancestry_complete);
        assert!(!report.truncated);
    }

    #[test]
    fn prototype_source_provenance_handles_deleted_files_without_fabricating_values() {
        let fx = Fixture::new();
        let file = "Resources/Prototypes/source.yml";
        fx.write(file, "- type: entity\n  id: Source\n  name: Before\n");
        let index = ProjectIndex::open(fx.root_str()).unwrap();
        let _ = index.prototypes().unwrap();
        fs::remove_file(fx.root.join(file)).unwrap();
        let report = index.prototype_sources("entity", "Source").unwrap();
        assert_eq!(report.items.len(), 1);
        assert!(report.items[0].notice.is_some());
        assert!(report.items[0].fields.is_empty());
        assert!(!report.ancestry_complete);
    }

    #[test]
    fn live_outline_reads_unsaved_prototypes_without_modifying_disk() {
        let fx = Fixture::new();
        let file = "Resources/Prototypes/live.yml";
        fx.write(file, "- type: entity\n  id: Before\n");
        fx.write("Resources/Textures/Test.rsi/meta.json", r#"{"version":1}"#);
        let index = ProjectIndex::open(fx.root_str()).unwrap();
        let unsaved =
            "- type: entity\n  id: After\n  components:\n  - type: Sprite\n    sprite: Test.rsi\n";
        let report = index.inspect_yaml_outline(file, unsaved).unwrap();
        assert_eq!(report.declarations[0].declaration.id, "After");
        assert!(report.declarations[0].sprite.as_ref().unwrap().indexed);
        assert!(index
            .read_resource(file)
            .unwrap()
            .content
            .contains("Before"));
        assert_eq!(
            index
                .inspect_yaml_outline("secret.yml", unsaved)
                .unwrap_err()
                .code,
            "OUTLINE_NOT_INDEXED"
        );
    }

    #[test]
    fn open_progress_tracks_scanned_resource_counts_without_guessing_percentages() {
        let fx = Fixture::new();
        fx.write(
            "Resources/Prototypes/Example.yml",
            "- type: entity\n  id: Example\n",
        );
        fx.write(
            "Resources/Locale/en-US/Example.ftl",
            "ent-Example = Example\n",
        );
        let mut observed = Vec::new();
        let index = ProjectIndex::open_with_progress(fx.root_str(), |phase, count| {
            observed.push((phase, count));
        })
        .unwrap();
        assert_eq!(
            observed.iter().map(|(phase, _)| *phase).collect::<Vec<_>>(),
            vec!["prototypes", "textures", "locale", "finalizing"]
        );
        assert!(observed.windows(2).all(|window| window[0].1 <= window[1].1));
        assert_eq!(observed.last().unwrap().1, index.overview().total_resources);
    }

    #[test]
    fn csharp_source_preview_requires_indexed_declaration() {
        let fx = Fixture::new();
        let file = "Content.Shared/Components/SpriteComponent.cs";
        fx.write(
            file,
            "[RegisterComponent]\npublic class SpriteComponent : Component {}\n",
        );
        fx.write(
            "Content.Shared/Components/Unlisted.cs",
            "public class Unlisted {}\n",
        );
        let index = ProjectIndex::open(fx.root_str()).unwrap();
        let document = index.read_csharp_source(file).unwrap();
        assert_eq!(document.path, file);
        assert!(document.content.contains("RegisterComponent"));
        assert_eq!(
            index
                .read_csharp_source("Content.Shared/Components/Unlisted.cs")
                .unwrap_err()
                .code,
            "CSHARP_SOURCE_NOT_INDEXED"
        );
        assert_eq!(
            index.read_csharp_source("../outside.cs").unwrap_err().code,
            "CSHARP_SOURCE_NOT_INDEXED"
        );
    }

    #[cfg(unix)]
    #[test]
    fn csharp_preview_blocks_source_symlink_outside_project() {
        use std::os::unix::fs::symlink;
        let fx = Fixture::new();
        let file = "Content.Shared/Components/SpriteComponent.cs";
        fx.write(
            file,
            "[RegisterComponent]\npublic class SpriteComponent : Component {}\n",
        );
        let index = ProjectIndex::open(fx.root_str()).unwrap();
        index.read_csharp_source(file).unwrap();
        let path = fx.root.join(file);
        fs::remove_file(&path).unwrap();
        symlink("/etc/hosts", &path).unwrap();
        assert_eq!(
            index.read_csharp_source(file).unwrap_err().code,
            "CSHARP_SOURCE_OUTSIDE_PROJECT"
        );
    }

    #[test]
    fn csharp_schema_cache_is_shared_and_rebuilt_on_project_refresh() {
        let fx = Fixture::new();
        let file = "Content.Shared/Components/SpriteComponent.cs";
        fx.write(file, "[RegisterComponent]\npublic class SpriteComponent : Component {\n    [DataField]\n    public bool Visible = true;\n}\n");
        let index = ProjectIndex::open(fx.root_str()).unwrap();
        let names = vec!["Sprite".into(), "NotRegistered".into()];
        let initial = index.csharp_component_schemas(&names).unwrap();
        assert!(initial.index_complete);
        assert_eq!(initial.components[0].status, "unique");
        assert_eq!(
            initial.components[0].declarations[0].fields[0].name,
            "visible"
        );
        assert_eq!(initial.components[1].status, "not_indexed");

        // Same C# snapshot is reused for inspector and catalog pages.
        assert_eq!(
            index
                .csharp_page("Sprite", Some("component"), 0, 10)
                .unwrap()
                .total,
            1
        );
        fx.write(file, "public class SpriteComponent {}\n");
        let cached = index.csharp_component_schemas(&names).unwrap();
        assert_eq!(cached.components[0].status, "unique");

        let (fresh, _) = index.refresh().unwrap();
        let after = fresh.csharp_component_schemas(&names).unwrap();
        assert_eq!(after.components[0].status, "not_indexed");
        assert_eq!(
            index
                .csharp_component_schemas(&["bad/path".into()])
                .unwrap_err()
                .code,
            "CSHARP_SCHEMA_INPUT_INVALID"
        );
    }

    #[test]
    fn empty_root_produces_explanation() {
        let err = ProjectIndex::open(" ").unwrap_err();
        assert_eq!(err.code, "PROJECT_PATH_EMPTY");
        assert!(!err.message.is_empty() && !err.hint.is_empty());
    }

    #[test]
    fn missing_root_is_not_found() {
        let fx = Fixture::new();
        let missing = fx.root.join("missing");
        let err = ProjectIndex::open(missing.to_str().unwrap()).unwrap_err();
        assert_eq!(err.code, "PROJECT_NOT_FOUND");
    }

    #[test]
    fn rejects_file_path() {
        let fx = Fixture::new();
        fx.write("test.txt", "text");
        let err = ProjectIndex::open(fx.root.join("test.txt").to_str().unwrap()).unwrap_err();
        assert_eq!(err.code, "PROJECT_NOT_DIRECTORY");
    }

    #[test]
    fn rejects_missing_prototypes_directory() {
        let fx = Fixture::new();
        fs::remove_dir(fx.root.join("Resources/Prototypes")).unwrap();
        let err = ProjectIndex::open(fx.root_str()).unwrap_err();
        assert_eq!(err.code, "PROJECT_STRUCTURE_INVALID");
    }

    #[test]
    fn indexes_resources_and_keeps_counts_distinct_from_prototype_counts() {
        let fx = Fixture::new();
        fx.write(
            "Resources/Prototypes/A/items.yml",
            "- type: entity\n  id: Foo",
        );
        fx.write(
            "Resources/Prototypes/A/other.YAML",
            "- type: entity\n  id: Bar",
        );
        fx.write("Resources/Textures/Objects/test.rsi/meta.json", "{}");
        fx.write("Resources/Locale/en-US/items.ftl", "item = Item");
        let index = ProjectIndex::open(fx.root_str()).unwrap();
        assert_eq!(index.overview().prototype_files, 2);
        assert_eq!(index.overview().rsi_directories, 1);
        assert_eq!(index.overview().locale_files, 1);
        assert_eq!(index.overview().total_resources, 4);
        assert!(index.overview().warnings.is_empty());
    }

    #[test]
    fn folder_browser_navigates_indexed_resources_with_page_limits() {
        let fx = Fixture::new();
        fx.write(
            "Resources/Prototypes/Entities/a.yml",
            "- type: entity\n  id: A",
        );
        fx.write(
            "Resources/Prototypes/Entities/b.yml",
            "- type: entity\n  id: B",
        );
        fx.write(
            "Resources/Prototypes/Weapons/gun.yml",
            "- type: entity\n  id: Gun",
        );
        fx.write(
            "Resources/Prototypes/root.yml",
            "- type: entity\n  id: Root",
        );
        fx.write("Resources/Textures/Human/body.rsi/meta.json", "{}");
        fx.write("Resources/Locale/en-US/ui.ftl", "label = Hello");
        let index = ProjectIndex::open(fx.root_str()).unwrap();
        let root = index.browse_resource_folder("Resources", 0, 50).unwrap();
        assert_eq!(root.total, 3);
        assert!(root.items.iter().all(|item| item.kind == "folder"));
        let proto = index
            .browse_resource_folder("Resources/Prototypes", 0, 50)
            .unwrap();
        assert_eq!(proto.total, 3);
        assert_eq!(proto.parent.as_deref(), Some("Resources"));
        assert_eq!(proto.items[0].name, "Entities");
        assert_eq!(proto.items[0].descendant_resources, 2);
        assert_eq!(proto.items[1].name, "Weapons");
        assert_eq!(proto.items[2].name, "root.yml");
        let first = index
            .browse_resource_folder("Resources/Prototypes/Entities", 0, 1)
            .unwrap();
        let second = index
            .browse_resource_folder("Resources/Prototypes/Entities", 1, 1)
            .unwrap();
        assert_eq!(first.total, 2);
        assert_eq!(first.items[0].name, "a.yml");
        assert_eq!(first.items[0].kind, "yaml");
        assert_eq!(second.items[0].name, "b.yml");
        assert!(index
            .browse_resource_folder("Resources/Prototypes/Entities", 2, 10)
            .unwrap()
            .items
            .is_empty());
    }

    #[test]
    fn folder_browser_does_not_expose_paths_outside_index() {
        let fx = Fixture::new();
        fx.write("Resources/Prototypes/Item.yml", "id: Item");
        fx.write("secrets.txt", "hidden");
        let index = ProjectIndex::open(fx.root_str()).unwrap();
        for invalid in [
            "../",
            "/",
            "/Resources",
            "Resources/../secrets",
            "Resources\\Prototypes",
            "Resources//Prototypes",
            "Resources/Prototypes/",
            "Other",
        ] {
            assert_eq!(
                index
                    .browse_resource_folder(invalid, 0, 100)
                    .unwrap_err()
                    .code,
                "RESOURCE_BROWSER_PATH_INVALID",
            );
        }
        assert!(index
            .browse_resource_folder("Resources/Nonexistent", 0, 100)
            .unwrap()
            .items
            .is_empty());
        assert!(index
            .browse_resource_folder("Resources", 0, 100)
            .unwrap()
            .items
            .iter()
            .all(|item| !item.path.contains("secrets")));
    }

    #[test]
    fn incremental_refresh_matches_full_scan_for_changed_files_and_directories() {
        let fx = Fixture::new();
        fx.write(
            "Resources/Prototypes/A.yml",
            "- type: entity\n  id: Before\n",
        );
        fx.write(
            "Resources/Prototypes/Remove.yml",
            "- type: entity\n  id: Gone\n",
        );
        fx.write("Resources/Locale/en-US/remove.ftl", "old = Old\n");
        let old = ProjectIndex::open(fx.root_str()).unwrap();
        assert_eq!(
            old.prototypes()
                .unwrap()
                .search("Before", None, 0, 10)
                .total,
            1
        );

        fx.write(
            "Resources/Prototypes/A.yml",
            "- type: entity\n  id: After\n",
        );
        fx.write(
            "Resources/Prototypes/New/Child.yaml",
            "- type: entity\n  id: Added\n",
        );
        fx.write("Resources/Locale/en-US/new.ftl", "new = Updated\n");
        fx.write(
            "Resources/Textures/Items/new.rsi/meta.json",
            "{\"version\":1}",
        );
        fs::remove_file(fx.root.join("Resources/Prototypes/Remove.yml")).unwrap();
        fs::remove_file(fx.root.join("Resources/Locale/en-US/remove.ftl")).unwrap();

        let paths = vec![
            "Resources/Prototypes/A.yml".into(),
            "Resources/Prototypes/Remove.yml".into(),
            "Resources/Prototypes/New".into(),
            "Resources/Prototypes/New/Child.yaml".into(),
            "Resources/Locale/en-US".into(),
            "Resources/Locale/en-US/new.ftl".into(),
            "Resources/Textures/Items/new.rsi/meta.json".into(),
        ];
        let (incremental, summary) = old.refresh_paths(&paths).unwrap();
        let (full, _) = old.refresh().unwrap();
        let entries = |index: &ProjectIndex| {
            index
                .resources
                .iter()
                .map(|entry| (entry.path.clone(), entry.kind))
                .collect::<Vec<_>>()
        };
        assert_eq!(entries(&incremental), entries(&full));
        assert_eq!(incremental.overview().total_resources, 4);
        assert_eq!(summary.added_resources, 3);
        assert_eq!(summary.removed_resources, 2);
        assert_eq!(
            incremental
                .prototypes()
                .unwrap()
                .search("After", None, 0, 10)
                .total,
            1
        );
        assert_eq!(
            incremental
                .prototypes()
                .unwrap()
                .search("Before", None, 0, 10)
                .total,
            0
        );
        assert_eq!(
            old.prototypes()
                .unwrap()
                .search("Before", None, 0, 10)
                .total,
            1
        );
    }

    #[test]
    fn incremental_refresh_rebuilds_lazy_csharp_cache_on_content_change() {
        let fx = Fixture::new();
        let file = "Content.Shared/Components/WidgetComponent.cs";
        fx.write(file, "[RegisterComponent]\npublic class WidgetComponent : Component {\n [DataField]\n public bool OldField = true;\n}\n");
        let original = ProjectIndex::open(fx.root_str()).unwrap();
        let before = original
            .csharp_component_schemas(&["Widget".into()])
            .unwrap();
        assert_eq!(
            before.components[0].declarations[0].fields[0].name,
            "oldField"
        );
        fx.write(file, "[RegisterComponent]\npublic class WidgetComponent : Component {\n [DataField]\n public bool NewField = true;\n}\n");
        let (fresh, summary) = original.refresh_paths(&[file.into()]).unwrap();
        assert_eq!(summary.added_resources, 0);
        assert_eq!(summary.removed_resources, 0);
        let after = fresh.csharp_component_schemas(&["Widget".into()]).unwrap();
        assert_eq!(
            after.components[0].declarations[0].fields[0].name,
            "newField"
        );
        assert_eq!(
            original
                .csharp_component_schemas(&["Widget".into()])
                .unwrap()
                .components[0]
                .declarations[0]
                .fields[0]
                .name,
            "oldField"
        );
    }

    #[test]
    fn incremental_refresh_unknown_or_invalid_hints_use_full_scan() {
        let fx = Fixture::new();
        let original = ProjectIndex::open(fx.root_str()).unwrap();
        fx.write(
            "Resources/Prototypes/new.yml",
            "- type: entity\n  id: New\n",
        );
        let (invalid, _) = original.refresh_paths(&["../outside".into()]).unwrap();
        assert!(invalid.is_yaml_indexed("Resources/Prototypes/new.yml"));
        let (unknown, _) = original.refresh_paths(&[".git/index".into()]).unwrap();
        assert!(unknown.is_yaml_indexed("Resources/Prototypes/new.yml"));
        let (no_hints, _) = original.refresh_paths(&[]).unwrap();
        assert!(no_hints.is_yaml_indexed("Resources/Prototypes/new.yml"));
    }

    #[cfg(unix)]
    #[test]
    fn incremental_refresh_ignores_new_symlinked_resource() {
        use std::os::unix::fs::symlink;
        let fx = Fixture::new();
        fx.write(
            "Resources/Prototypes/real.yml",
            "- type: entity\n  id: Real\n",
        );
        let old = ProjectIndex::open(fx.root_str()).unwrap();
        symlink(
            fx.root.join("Resources/Prototypes/real.yml"),
            fx.root.join("Resources/Prototypes/link.yml"),
        )
        .unwrap();
        let (fresh, _) = old
            .refresh_paths(&["Resources/Prototypes/link.yml".into()])
            .unwrap();
        assert!(!fresh.is_yaml_indexed("Resources/Prototypes/link.yml"));
        assert!(fresh.is_yaml_indexed("Resources/Prototypes/real.yml"));
    }

    #[test]
    fn refresh_detects_created_and_removed_resources_without_mutating_old_snapshot() {
        let fx = Fixture::new();
        fx.write(
            "Resources/Prototypes/one.yml",
            "- type: entity\n  id: One\n",
        );
        fx.write("Resources/Locale/en-US/old.ftl", "old = old");
        let old = ProjectIndex::open(fx.root_str()).unwrap();
        fx.write(
            "Resources/Prototypes/two.yml",
            "- type: entity\n  id: Two\n",
        );
        fx.write("Resources/Textures/item.rsi/meta.json", "{\"version\":1}");
        fs::remove_file(fx.root.join("Resources/Locale/en-US/old.ftl")).unwrap();

        let (new, result) = old.refresh().unwrap();
        assert_eq!(result.added_resources, 2);
        assert_eq!(result.removed_resources, 1);
        assert_eq!(result.overview.prototype_files, 2);
        assert_eq!(result.overview.rsi_directories, 1);
        assert_eq!(result.overview.locale_files, 0);
        assert_eq!(old.search("two.yml", None, 0, 100).total, 0);
        assert_eq!(new.search("two.yml", None, 0, 100).total, 1);
        assert_eq!(old.search("old.ftl", None, 0, 100).total, 1);
        assert_eq!(new.search("old.ftl", None, 0, 100).total, 0);
    }

    #[test]
    fn failed_refresh_leaves_previous_index_available() {
        let fx = Fixture::new();
        fx.write(
            "Resources/Prototypes/one.yml",
            "- type: entity\n  id: One\n",
        );
        let index = ProjectIndex::open(fx.root_str()).unwrap();
        fs::remove_dir_all(fx.root.join("Resources/Prototypes")).unwrap();
        assert_eq!(
            index.refresh().unwrap_err().code,
            "PROJECT_STRUCTURE_INVALID"
        );
        assert_eq!(index.search("one.yml", None, 0, 100).total, 1);
    }

    #[test]
    fn missing_optional_scopes_are_warnings() {
        let fx = Fixture::new();
        let index = ProjectIndex::open(fx.root_str()).unwrap();
        assert_eq!(index.overview().prototype_files, 0);
        assert_eq!(index.overview().warnings.len(), 3);
    }

    #[test]
    fn content_search_returns_resource_matches_and_line_numbers() {
        let fx = Fixture::new();
        fx.write(
            "Resources/Prototypes/one.yml",
            "# note\n- type: entity\n  id: TestAlpha\n",
        );
        fx.write("Resources/Locale/en-US/a.ftl", "name = TESTALPHA\n");
        fx.write(
            "Resources/Textures/icon.rsi/meta.json",
            r#"{"version":1,"note":"testalpha"}"#,
        );
        fx.write("unindexed.txt", "testalpha\n");
        let index = ProjectIndex::open(fx.root_str()).unwrap();
        let result = index.search_content("testalpha", None).unwrap();
        assert!(result.complete);
        assert_eq!(result.items.len(), 3);
        assert!(result
            .items
            .iter()
            .any(|item| item.kind == "yaml" && item.line == 3));
        assert!(result
            .items
            .iter()
            .any(|item| item.kind == "ftl" && item.line == 1));
        assert!(result.items.iter().any(|item| item.kind == "rsi"));
        assert!(result
            .items
            .iter()
            .all(|item| !item.path.contains("unindexed")));
        let yaml = index.search_content("testalpha", Some("yaml")).unwrap();
        assert_eq!(yaml.items.len(), 1);
        assert_eq!(
            index.search_content("missing", None).unwrap().items.len(),
            0
        );
    }

    #[test]
    fn content_search_rejects_bad_requests_and_caps_per_file_results() {
        let fx = Fixture::new();
        fx.write("Resources/Prototypes/one.yml", &"Match\n".repeat(20));
        let index = ProjectIndex::open(fx.root_str()).unwrap();
        assert_eq!(
            index.search_content("", None).unwrap_err().code,
            "CONTENT_SEARCH_QUERY_INVALID"
        );
        assert_eq!(
            index
                .search_content("x", Some("../invalid"))
                .unwrap_err()
                .code,
            "CONTENT_SEARCH_KIND_INVALID"
        );
        assert_eq!(
            index
                .search_content(&"x".repeat(129), None)
                .unwrap_err()
                .code,
            "CONTENT_SEARCH_QUERY_INVALID"
        );
        let result = index.search_content("match", None).unwrap();
        assert_eq!(result.items.len(), 12);
        assert!(!result.complete);
        assert!(!result.warnings.is_empty());
    }

    #[test]
    fn searches_by_scope_and_pages_stably() {
        let fx = Fixture::new();
        fx.write("Resources/Prototypes/B.yml", "- type: entity");
        fx.write("Resources/Prototypes/A.yaml", "- type: entity");
        fx.write("Resources/Locale/en-US/A.ftl", "test = value");
        let index = ProjectIndex::open(fx.root_str()).unwrap();
        let page = index.search("", Some("yaml"), 0, 1);
        assert_eq!(page.total, 2);
        assert_eq!(page.items.len(), 1);
        assert!(page.items[0].path.ends_with("A.yaml"));
        let next = index.search("", Some("yaml"), 1, 1);
        assert!(next.items[0].path.ends_with("B.yml"));
        let match_page = index.search("A.yaml", None, 0, 100);
        assert_eq!(match_page.total, 1);
    }

    #[test]
    fn rsi_prefix_search_skips_substring_matches_and_limits_valid_results() {
        let resources = (0..200).map(|i| format!("Resources/Textures/A/Resources/Textures/Obj{i:03}.rsi"))
            .chain((0..90).map(|i| format!("Resources/Textures/Objects/{i:03}.rsi")))
            .map(|path| ResourceEntry { search_key: path.to_lowercase(), path, kind: "rsi" }).collect();
        let index = ProjectIndex::from_resources(PathBuf::new(), resources).unwrap();
        let result = index.rsi_prefix_candidates("obj");
        assert_eq!(result.len(), 80);
        assert!(result.iter().all(|item| item.path.starts_with("Resources/Textures/Objects/")));
        assert_eq!(index.search("Resources/Textures/Obj", Some("rsi"), 0, 80).total, 290);
    }

    #[test]
    fn search_is_case_insensitive_but_identity_is_exact() {
        let fixture = Fixture::new();
        fixture.write("Resources/Prototypes/Weapons/PISTOL.YML", "- type: entity");
        let index = ProjectIndex::open(fixture.root_str()).unwrap();
        let page = index.search("weapons/pistol", Some("yaml"), 0, 100);
        assert_eq!(page.total, 1);
        assert!(page.items[0].path.ends_with("PISTOL.YML"));
        assert!(index
            .read_resource("Resources/Prototypes/Weapons/pistol.yml")
            .is_err());
        assert!(index
            .read_resource("Resources/Prototypes/Weapons/PISTOL.YML")
            .is_ok());
    }

    #[test]
    fn reads_yaml_without_modifying_source() {
        let fx = Fixture::new();
        let original = "- type: entity\n  id: Visible\n";
        fx.write("Resources/Prototypes/fixture.yml", original);
        let index = ProjectIndex::open(fx.root_str()).unwrap();
        let doc = index
            .read_resource("Resources/Prototypes/fixture.yml")
            .unwrap();
        assert_eq!(doc.content, original);
        assert_eq!(
            fs::read_to_string(fx.root.join("Resources/Prototypes/fixture.yml")).unwrap(),
            original
        );
    }

    #[test]
    fn refuses_non_indexed_path_even_if_file_exists() {
        let fx = Fixture::new();
        fx.write("secret.txt", "outside scope");
        let index = ProjectIndex::open(fx.root_str()).unwrap();
        let err = index.read_resource("secret.txt").unwrap_err();
        assert_eq!(err.code, "RESOURCE_NOT_INDEXED");
    }

    #[test]
    fn creating_prototype_can_be_found_in_fresh_index() {
        let fx = Fixture::new();
        let original = ProjectIndex::open(fx.root_str()).unwrap();
        let draft = crate::prototype_create::PrototypeDraft {
            kind: "entity".into(),
            id: "GeneratedEntity".into(),
            parent: "".into(),
            name: "Generated".into(),
            description: "".into(),
            suffix: String::new(),
            abstract_prototype: false,
            sprite: "".into(),
            sprite_state: "".into(),
            include_sprite: false,
            include_item: false,
            include_physics: false,
            include_appearance: false,
            file: "Resources/Prototypes/_PrototypeStudio/GeneratedEntity.yml".into(),
        };
        let result = original.create_new_prototype(&draft).unwrap();
        assert_eq!(result.id, "GeneratedEntity");
        assert_eq!(
            original
                .search("GeneratedEntity", Some("yaml"), 0, 20)
                .total,
            0
        );
        let fresh = ProjectIndex::open(fx.root_str()).unwrap();
        assert!(fresh.is_yaml_indexed(&result.file));
        assert_eq!(
            fresh
                .prototypes()
                .unwrap()
                .search("GeneratedEntity", None, 0, 20)
                .total,
            1
        );
        assert!(fresh
            .read_resource(&result.file)
            .unwrap()
            .content
            .contains("GeneratedEntity"));
        assert_eq!(
            fresh.create_new_prototype(&draft).unwrap_err().code,
            "PROTOTYPE_ID_EXISTS"
        );
    }

    #[test]
    fn diagnoses_only_indexed_fluent_without_touching_source() {
        let fx = Fixture::new();
        let path = "Resources/Locale/en-US/items.ftl";
        let original = "valid = Hello\n";
        fx.write(path, original);
        fx.write(
            "Resources/Prototypes/item.yml",
            "- type: entity\n  id: Item\n",
        );
        let index = ProjectIndex::open(fx.root_str()).unwrap();
        let diagnostics = index
            .analyze_fluent(path, "valid = Hello\nbad@name = Broken\n")
            .unwrap();
        assert!(!diagnostics.syntax.diagnostics.is_empty());
        assert_eq!(diagnostics.syntax.diagnostics[0].line, 2);
        assert_eq!(
            fs::read_to_string(fx.root.join(path)).unwrap(),
            original,
            "Diagnostics must never persist a live editor draft",
        );
        assert_eq!(
            index
                .analyze_fluent("Resources/Prototypes/item.yml", original)
                .unwrap_err()
                .code,
            "FTL_NOT_INDEXED"
        );
        assert_eq!(
            index
                .analyze_fluent("Resources/Locale/en-US/missing.ftl", original)
                .unwrap_err()
                .code,
            "FTL_NOT_INDEXED"
        );
    }

    #[test]
    fn locale_index_is_cached_until_a_successful_fluent_save() {
        let fx = Fixture::new();
        let target = "Resources/Locale/en-US/target.ftl";
        let source = "Resources/Locale/en-US/source.ftl";
        fx.write(target, "referenced = Present\n");
        fx.write(source, "use = { referenced }\n");
        let index = ProjectIndex::open(fx.root_str()).unwrap();
        let first = index
            .analyze_fluent(source, "use = { referenced }\n")
            .unwrap();
        assert!(first.locale.complete);
        assert!(first.locale.issues.is_empty());
        assert_eq!(first.locale.file_count, 2);

        // Edits outside Studio require explicit index refresh; no polling.
        fx.write(target, "replaced = Gone\n");
        let cached = index
            .analyze_fluent(source, "use = { referenced }\n")
            .unwrap();
        assert!(cached.locale.issues.is_empty());

        let expected = index.read_resource(target).unwrap().revision;
        index
            .save_ftl(target, &expected, "still-other = Missing\n".into())
            .unwrap();
        let refreshed = index
            .analyze_fluent(source, "use = { referenced }\n")
            .unwrap();
        assert_eq!(refreshed.locale.issues[0].code, "FTL_REFERENCE_MISSING");
    }

    #[test]
    fn locale_index_uses_only_the_selected_language_and_live_draft() {
        let fx = Fixture::new();
        let en_file = "Resources/Locale/en-US/current.ftl";
        let ru_file = "Resources/Locale/ru-RU/target.ftl";
        fx.write(en_file, "source = { local-ref }\n");
        fx.write(ru_file, "local-ref = Другая локаль\n");
        let index = ProjectIndex::open(fx.root_str()).unwrap();
        let report = index
            .analyze_fluent(en_file, "local-ref = Here\nsource = { local-ref }\n")
            .unwrap();
        assert_eq!(report.locale.locale, "en-US");
        assert_eq!(report.locale.file_count, 1);
        assert!(report.locale.issues.is_empty());
        let absent = index
            .analyze_fluent(en_file, "source = { local-ref }\n")
            .unwrap();
        assert_eq!(absent.locale.issues[0].code, "FTL_REFERENCE_MISSING");
    }

    #[test]
    fn incomplete_locale_scan_does_not_claim_missing_reference() {
        let fx = Fixture::new();
        let a = "Resources/Locale/en-US/current.ftl";
        let other = "Resources/Locale/en-US/unreadable.ftl";
        fx.write(a, "a = { missing }\n");
        fx.write(other, &"z".repeat(4 * 1024 * 1024 + 1));
        let index = ProjectIndex::open(fx.root_str()).unwrap();
        let result = index.analyze_fluent(a, "a = { missing }\n").unwrap();
        assert!(!result.locale.complete);
        assert_eq!(result.locale.issue_count, 0);
        assert!(!result.locale.warnings.is_empty());
    }

    #[test]
    fn newly_created_fluent_is_visible_only_after_reindex() {
        let fx = Fixture::new();
        fx.write("Resources/Locale/en-US/old.ftl", "old = Before\n");
        let index = ProjectIndex::open(fx.root_str()).unwrap();
        let draft = FluentDraft {
            file: "Resources/Locale/en-US/new.ftl".into(),
            starter_key: "new-key".into(),
            starter_value: "New value".into(),
            starter_description: None,
            starter_suffix: None,
            allow_empty_value: false,
        };
        let created = index.create_new_fluent(&draft).unwrap();
        assert_eq!(created.file, draft.file);
        assert_eq!(index.search("new.ftl", Some("ftl"), 0, 100).total, 0);
        let fresh = index.refresh().unwrap().0;
        assert_eq!(fresh.search("new.ftl", Some("ftl"), 0, 100).total, 1);
        assert_eq!(
            fresh.read_resource(&draft.file).unwrap().content,
            "new-key = New value\n"
        );
        assert_eq!(
            fresh.create_new_fluent(&draft).unwrap_err().code,
            "FTL_FILE_EXISTS"
        );
    }

    #[test]
    fn saves_only_indexed_fluent_without_affecting_yaml() {
        let fx = Fixture::new();
        let file = "Resources/Locale/ru-RU/proto.ftl";
        fx.write(file, "# original\nthing-name = Before\n");
        fx.write(
            "Resources/Prototypes/test.yml",
            "- type: entity\n  id: Test\n",
        );
        let index = ProjectIndex::open(fx.root_str()).unwrap();
        let loaded = index.read_resource(file).unwrap();
        let updated = "# original\nthing-name = После\n";
        let result = index
            .save_ftl(file, &loaded.revision, updated.into())
            .unwrap();
        assert_eq!(result.document.content, updated);
        assert_eq!(index.read_resource(file).unwrap().content, updated);
        assert_eq!(
            index
                .save_ftl(
                    "Resources/Prototypes/test.yml",
                    &loaded.revision,
                    updated.into(),
                )
                .unwrap_err()
                .code,
            "RESOURCE_EDIT_NOT_SUPPORTED"
        );
        assert_eq!(
            index
                .save_ftl(
                    "Resources/Locale/ru-RU/absent.ftl",
                    &loaded.revision,
                    updated.into(),
                )
                .unwrap_err()
                .code,
            "RESOURCE_NOT_INDEXED"
        );
        assert!(index.is_editable_text_indexed(file));
        assert!(!index.is_yaml_indexed(file));
        assert!(!index.is_editable_text_indexed("Resources/Textures/thing.rsi"));
    }

    #[test]
    fn prototype_preview_reports_unindexed_references_without_claiming_absence() {
        let fx = Fixture::new();
        fx.write(
            "Resources/Prototypes/base.yml",
            "- type: entity\n  id: Base\n",
        );
        fx.write("Resources/Textures/Test.rsi/meta.json", "{}");
        let index = ProjectIndex::open(fx.root_str()).unwrap();
        let mut draft = PrototypeDraft {
            kind: "entity".into(),
            id: "New".into(),
            parent: "Base".into(),
            name: String::new(),
            description: String::new(),
            suffix: String::new(),
            abstract_prototype: false,
            sprite: "Test.rsi".into(),
            sprite_state: String::new(),
            include_sprite: false,
            include_item: false,
            include_physics: false,
            include_appearance: false,
            file: "Resources/Prototypes/base.yml".into(),
        };
        assert!(index
            .preview_new_prototype(&draft)
            .unwrap()
            .warnings
            .is_empty());
        draft.parent = "Missing".into();
        draft.sprite = "Missing.rsi".into();
        let warnings = index.preview_new_prototype(&draft).unwrap().warnings;
        assert!(warnings
            .iter()
            .any(|w| w.contains("Missing") && w.contains("индекс")));
        assert!(warnings
            .iter()
            .any(|w| w.contains("Missing.rsi") && w.contains("индекс")));
        let append_warnings = index.preview_append_prototype(&draft).unwrap().warnings;
        assert!(warnings
            .iter()
            .all(|warning| append_warnings.contains(warning)));
        assert_eq!(append_warnings.len(), warnings.len() + 1);
        draft.sprite = "Resources/Textures/Test.rsi".into();
        assert!(!index
            .preview_new_prototype(&draft)
            .unwrap()
            .warnings
            .iter()
            .any(|w| w.contains("Test.rsi")));
        // An unreadable/invalid YAML makes the catalogue incomplete; describe only its index.
        fx.write("Resources/Prototypes/bad.yml", "[broken");
        let incomplete = ProjectIndex::open(fx.root_str()).unwrap();
        let warnings = incomplete.preview_new_prototype(&draft).unwrap().warnings;
        assert!(warnings
            .iter()
            .any(|w| w.contains("Missing") && w.contains("индекс")));
        assert!(!warnings.iter().any(|w| w.contains("не существует")));
    }

    #[test]
    fn appends_to_existing_yaml_without_replacing_comments() {
        let fx = Fixture::new();
        let file = "Resources/Prototypes/fixture.yml";
        let original = "# Existing comment\r\n- type: entity\r\n  id: Existing\r\n";
        fx.write(file, original);
        let index = ProjectIndex::open(fx.root_str()).unwrap();
        let draft = crate::prototype_create::PrototypeDraft {
            kind: "entity".into(),
            id: "NewEntity".into(),
            parent: "Existing".into(),
            name: "Generated".into(),
            description: String::new(),
            suffix: String::new(),
            abstract_prototype: false,
            sprite: String::new(),
            sprite_state: String::new(),
            include_sprite: false,
            include_item: false,
            include_physics: false,
            include_appearance: false,
            file: file.into(),
        };
        let preview = index.preview_append_prototype(&draft).unwrap();
        assert!(preview.yaml.contains("NewEntity"));
        let saved = index
            .append_prototype(&draft, &preview.expected_revision)
            .unwrap();
        assert_eq!(saved.id, "NewEntity");
        let bytes = fs::read_to_string(fx.root.join(file)).unwrap();
        assert!(bytes.starts_with(original));
        assert!(!bytes.replace("\r\n", "").contains('\n'));
        assert_eq!(
            index
                .prototypes()
                .unwrap()
                .search("NewEntity", None, 0, 10)
                .total,
            1
        );
    }

    #[test]
    fn append_detects_external_changes_after_preview() {
        let fx = Fixture::new();
        let file = "Resources/Prototypes/fixture.yml";
        fx.write(file, "- type: entity\n  id: Existing\n");
        let index = ProjectIndex::open(fx.root_str()).unwrap();
        let draft = crate::prototype_create::PrototypeDraft {
            kind: "entity".into(),
            id: "Other".into(),
            parent: String::new(),
            name: String::new(),
            description: String::new(),
            suffix: String::new(),
            abstract_prototype: false,
            sprite: String::new(),
            sprite_state: String::new(),
            include_sprite: false,
            include_item: false,
            include_physics: false,
            include_appearance: false,
            file: file.into(),
        };
        let preview = index.preview_append_prototype(&draft).unwrap();
        fx.write(file, "- type: entity\n  id: External\n");
        let error = index
            .append_prototype(&draft, &preview.expected_revision)
            .unwrap_err();
        assert_eq!(error.code, "RESOURCE_CHANGED_ON_DISK");
        let content = fs::read_to_string(fx.root.join(file)).unwrap();
        assert!(content.contains("External"));
        assert!(!content.contains("Other"));
    }

    #[test]
    fn refuses_append_to_non_indexed_file() {
        let fx = Fixture::new();
        fx.write(
            "Resources/Prototypes/in_source.yml",
            "- type: entity\n  id: A\n",
        );
        let index = ProjectIndex::open(fx.root_str()).unwrap();
        let draft = crate::prototype_create::PrototypeDraft {
            kind: "entity".into(),
            id: "Other".into(),
            parent: String::new(),
            name: String::new(),
            description: String::new(),
            suffix: String::new(),
            abstract_prototype: false,
            sprite: String::new(),
            sprite_state: String::new(),
            include_sprite: false,
            include_item: false,
            include_physics: false,
            include_appearance: false,
            file: "Resources/Prototypes/missing.yml".into(),
        };
        let error = index.preview_append_prototype(&draft).unwrap_err();
        assert_eq!(error.code, "APPEND_NOT_INDEXED");
    }

    #[test]
    fn saving_yaml_invalidates_prototype_catalog_without_reopening_project() {
        let fx = Fixture::new();
        fx.write(
            "Resources/Prototypes/fixture.yml",
            "- type: entity\n  id: Before\n",
        );
        let index = ProjectIndex::open(fx.root_str()).unwrap();
        assert_eq!(
            index
                .prototypes()
                .unwrap()
                .search("Before", None, 0, 10)
                .total,
            1
        );

        let before = index
            .read_resource("Resources/Prototypes/fixture.yml")
            .unwrap();
        let saved = index
            .save_yaml(
                "Resources/Prototypes/fixture.yml",
                &before.revision,
                "- type: entity\n  id: After\n".into(),
            )
            .unwrap();

        assert_ne!(saved.document.revision, before.revision);
        assert_eq!(
            index
                .prototypes()
                .unwrap()
                .search("Before", None, 0, 10)
                .total,
            0
        );
        assert_eq!(
            index
                .prototypes()
                .unwrap()
                .search("After", None, 0, 10)
                .total,
            1
        );
    }

    #[test]
    fn only_indexed_yaml_can_be_saved() {
        let fx = Fixture::new();
        fx.write("secret.yml", "secret: 1");
        fx.write("Resources/Locale/en-US/sample.ftl", "name = Text");
        let index = ProjectIndex::open(fx.root_str()).unwrap();
        let wrong = index
            .save_yaml("secret.yml", &"a".repeat(64), "secret: 2".into())
            .unwrap_err();
        assert_eq!(wrong.code, "RESOURCE_NOT_INDEXED");

        let locale = index
            .read_resource("Resources/Locale/en-US/sample.ftl")
            .unwrap();
        let wrong = index
            .save_yaml(
                "Resources/Locale/en-US/sample.ftl",
                &locale.revision,
                "name = Changed".into(),
            )
            .unwrap_err();
        assert_eq!(wrong.code, "RESOURCE_EDIT_NOT_SUPPORTED");
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinked_scope_with_explained_error() {
        use std::os::unix::fs::symlink;
        let fixture = Fixture::new();
        let folder = fixture.root.join("Resources/Prototypes");
        fs::remove_dir(&folder).unwrap();
        symlink(std::env::temp_dir(), &folder).unwrap();
        let error = ProjectIndex::open(fixture.root_str()).unwrap_err();
        assert_eq!(error.code, "PROJECT_SYMLINKED_SCOPE");
        assert!(!error.hint.is_empty());
    }

    #[test]
    fn missing_direct_sprite_diagnostics_refresh_with_texture_index() {
        let fx = Fixture::new();
        fx.write("Resources/Textures/Present.rsi/meta.json", "{}");
        fx.write("Resources/Prototypes/sprites.yml", "- type: entity\n  id: Missing\n  components:\n  - type: Sprite\n    sprite: Missing.rsi\n- type: entity\n  id: Present\n  components:\n  - type: Sprite\n    sprite: Present.rsi\n- type: entity\n  id: LayerOnly\n  components:\n  - type: Sprite\n    layers:\n    - sprite: Layer.rsi\n");
        let index = ProjectIndex::open(fx.root_str()).unwrap();
        let issues = index.prototypes().unwrap().diagnostics(0, 200).items;
        let missing: Vec<_> = issues
            .iter()
            .filter(|item| item.code == "SPRITE_RSI_MISSING")
            .collect();
        assert_eq!(missing.len(), 1);
        assert_eq!(missing[0].file, "Resources/Prototypes/sprites.yml");
        assert_eq!(missing[0].line, 1);
        assert!(missing[0].message.contains("Missing.rsi"));
        fx.write("Resources/Textures/Missing.rsi/meta.json", "{}");
        let (fresh, _) = index
            .refresh_paths(&["Resources/Textures/Missing.rsi/meta.json".into()])
            .unwrap();
        assert!(!fresh
            .prototypes()
            .unwrap()
            .diagnostics(0, 200)
            .items
            .iter()
            .any(|item| item.code == "SPRITE_RSI_MISSING"));
    }

    #[test]
    fn sprite_diagnostics_follow_index_snapshot_and_filesystem_case() {
        let fx = Fixture::new();
        fx.write("Resources/Textures/Present.rsi/meta.json", "{}");
        fx.write("Resources/Prototypes/sprites.yml", "- type: entity\n  id: Case\n  components:\n  - type: Sprite\n    sprite: present.rsi\n- type: entity\n  id: Later\n  components:\n  - type: Sprite\n    sprite: Later.rsi\n");
        let index = ProjectIndex::open(fx.root_str()).unwrap();
        fx.write("Resources/Textures/Later.rsi/meta.json", "{}");
        let issues = index.prototypes().unwrap().diagnostics(0, 200).items;
        let missing: Vec<_> = issues
            .iter()
            .filter(|item| item.code == "SPRITE_RSI_MISSING")
            .collect();
        let case_sensitive = !fx.root.join("Resources/Textures/present.rsi").exists();
        assert_eq!(
            missing
                .iter()
                .any(|item| item.message.contains("present.rsi")),
            case_sensitive
        );
        let later = missing
            .iter()
            .find(|item| item.message.contains("Later.rsi"))
            .unwrap();
        assert!(later.message.contains("текущем индексе"));
        let (fresh, _) = index.refresh().unwrap();
        assert!(!fresh
            .prototypes()
            .unwrap()
            .diagnostics(0, 200)
            .items
            .iter()
            .any(|item| item.code == "SPRITE_RSI_MISSING" && item.message.contains("Later.rsi")));
    }

    #[test]
    fn sprite_diagnostics_are_bounded() {
        let fx = Fixture::new();
        fx.write("Resources/Textures/Present.rsi/meta.json", "{}");
        let source: String = (0..501).map(|i| format!("- type: entity\n  id: Item{i}\n  components:\n  - type: Sprite\n    sprite: Missing{i}.rsi\n")).collect();
        fx.write("Resources/Prototypes/many.yml", &source);
        let index = ProjectIndex::open(fx.root_str()).unwrap();
        let catalog = index.prototypes().unwrap();
        let mut issues = catalog.diagnostics(0, 200).items;
        issues.extend(catalog.diagnostics(200, 200).items);
        issues.extend(catalog.diagnostics(400, 200).items);
        assert_eq!(
            issues
                .iter()
                .filter(|item| item.code == "SPRITE_RSI_MISSING")
                .count(),
            500
        );
        assert!(issues
            .iter()
            .any(|item| item.code == "SPRITE_DIAGNOSTICS_TRUNCATED"));
    }

    #[test]
    fn missing_texture_index_does_not_claim_missing_sprite() {
        let fx = Fixture::new();
        fx.write(
            "Resources/Prototypes/sprites.yml",
            "- type: entity\n  id: A\n  components:\n  - type: Sprite\n    sprite: Missing.rsi\n",
        );
        let index = ProjectIndex::open(fx.root_str()).unwrap();
        let issues = index.prototypes().unwrap().diagnostics(0, 200).items;
        assert!(!issues.iter().any(|item| item.code == "SPRITE_RSI_MISSING"));
        assert!(issues
            .iter()
            .any(|item| item.code == "SPRITE_INDEX_INCOMPLETE"));
    }

    #[test]
    fn newly_created_rsi_becomes_indexed_after_refresh() {
        let fx = Fixture::new();
        fx.write("Resources/Textures/seed.rsi/meta.json", "{\"version\":1}");
        let index = ProjectIndex::open(fx.root_str()).unwrap();
        let draft = RsiDraft {
            directory: "Resources/Textures".into(),
            name: "generated".into(),
            size_x: 32,
            size_y: 32,
            license: "CC0-1.0".into(),
            copyright: "Fixture".into(),
        };
        let created = index.create_new_rsi(&draft).unwrap();
        assert_eq!(created.path, "Resources/Textures/generated.rsi");
        assert_eq!(
            index.read_resource(&created.path).unwrap_err().code,
            "RESOURCE_NOT_INDEXED"
        );
        let (fresh, _) = index.refresh().unwrap();
        let doc = fresh.read_resource(&created.path).unwrap();
        assert!(doc.content.contains("\"version\""));
        assert_eq!(fresh.overview().rsi_directories, 2);
    }

    #[test]
    fn timing_edit_requires_index_and_preserves_loaded_resource_revision() {
        let fx = Fixture::new();
        let path = "Resources/Textures/Animated.rsi";
        fx.write(
            &format!("{path}/meta.json"),
            r#"{"version":1,"size":{"x":32,"y":32},"states":[{"name":"walk","directions":1,"delays":[[0.1,0.2]]}]}"#,
        );
        let index = ProjectIndex::open(fx.root_str()).unwrap();
        let first = index.read_resource(path).unwrap();
        let update = RsiTimingUpdate {
            path: path.into(),
            expected_revision: first.revision,
            name: "walk".into(),
            expected_png_revision: None,
            delays: vec![vec![0.5, 0.6]],
        };
        let result = index.update_rsi_timing(&update).unwrap();
        let refreshed = index.read_resource(path).unwrap();
        assert_eq!(result.revision, refreshed.revision);
        assert_eq!(result.content, refreshed.content);
        assert!(refreshed.content.contains("0.5"));
        assert_eq!(
            index.update_rsi_timing(&update).unwrap_err().code,
            "RSI_TIMING_CONFLICT"
        );
        let outside = RsiTimingUpdate {
            path: "Resources/Textures/Other.rsi".into(),
            ..update
        };
        assert_eq!(
            index.update_rsi_timing(&outside).unwrap_err().code,
            "RSI_NOT_INDEXED"
        );
    }

    #[test]
    fn deleting_rsi_state_checks_index_and_updates_visible_meta() {
        let fx = Fixture::new();
        let path = "Resources/Textures/Selected.rsi";
        fx.write(
            &format!("{path}/meta.json"),
            r#"{"version":1,"size":{"x":1,"y":1},"states":[{"name":"idle"}]}"#,
        );
        fx.write(&format!("{path}/idle.png"), "fixture png bytes");
        let index = ProjectIndex::open(fx.root_str()).unwrap();
        let doc = index.read_resource(path).unwrap();
        let request = RsiDeleteRequest {
            path: path.into(),
            expected_revision: doc.revision,
            name: "idle".into(),
            expected_missing_png: false,
        };
        let removed = index.delete_rsi_state(&request).unwrap();
        assert_eq!(removed.name, "idle");
        assert!(!fx.root.join(path).join("idle.png").exists());
        let read_back = index.read_resource(path).unwrap();
        assert_eq!(read_back.revision, removed.revision);
        assert_eq!(
            index.delete_rsi_state(&request).unwrap_err().code,
            "RSI_DELETE_CONFLICT"
        );
        let outside = RsiDeleteRequest {
            path: "Resources/Textures/Missing.rsi".into(),
            ..request
        };
        assert_eq!(
            index.delete_rsi_state(&outside).unwrap_err().code,
            "RSI_NOT_INDEXED"
        );
    }

    #[test]
    fn archived_rsi_restoration_is_available_via_the_indexed_project() {
        let fx = Fixture::new();
        let path = "Resources/Textures/ArchiveTest.rsi";
        fx.write(
            &format!("{path}/meta.json"),
            r#"{"version":1,"size":{"x":1,"y":1},"states":[{"name":"idle"},{"name":"walk"}]}"#,
        );
        fx.write(&format!("{path}/idle.png"), "original data");
        let index = ProjectIndex::open(fx.root_str()).unwrap();
        let original = index.read_resource(path).unwrap();
        let removed = index
            .delete_rsi_state(&RsiDeleteRequest {
                path: path.into(),
                expected_revision: original.revision,
                name: "idle".into(),
                expected_missing_png: false,
            })
            .unwrap();
        let archives = index.list_rsi_archives(path).unwrap();
        assert_eq!(archives.archives.len(), 1);
        assert_eq!(archives.archives[0].state, "idle");
        let restored = index
            .restore_rsi_state(&RsiRestoreRequest {
                path: path.into(),
                expected_revision: removed.revision,
                archive_id: archives.archives[0].id.clone(),
            })
            .unwrap();
        assert!(restored.content.contains(r#""idle""#));
        assert_eq!(
            index.read_resource(path).unwrap().revision,
            restored.revision
        );
        assert_eq!(
            std::fs::read(fx.root.join(path).join("idle.png")).unwrap(),
            b"original data"
        );
        assert!(!index.list_rsi_archives(path).unwrap().archives.is_empty());
        assert_eq!(
            index
                .restore_rsi_state(&RsiRestoreRequest {
                    path: "Resources/Textures/Unindexed.rsi".into(),
                    expected_revision: restored.revision,
                    archive_id: archives.archives[0].id.clone(),
                })
                .unwrap_err()
                .code,
            "RSI_NOT_INDEXED"
        );
    }

    #[test]
    fn rsi_png_is_read_only_indexed_and_bounded() {
        let fx = Fixture::new();
        let path = "Resources/Textures/Test.rsi";
        fx.write("Resources/Textures/Test.rsi/meta.json", "{\"version\":1}");
        fs::write(
            fx.root.join("Resources/Textures/Test.rsi/idle.png"),
            b"\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00",
        )
        .unwrap();
        let index = ProjectIndex::open(fx.root_str()).unwrap();
        let sheets = index.list_rsi_sheets(path).unwrap();
        assert_eq!(sheets.sheets.len(), 1);
        assert_eq!(sheets.sheets[0].name, "idle.png");
        let image = index.read_rsi_sheet(path, "idle.png").unwrap();
        assert!(image.data_url.starts_with("data:image/png;base64,"));
        assert_eq!(image.width, 1);
        assert_eq!(image.height, 1);
        assert_eq!(
            index.read_rsi_sheet(path, "../idle.png").unwrap_err().code,
            "RSI_IMAGE_NAME_INVALID"
        );
        assert_eq!(
            index
                .list_rsi_sheets("Resources/Prototypes")
                .unwrap_err()
                .code,
            "RSI_NOT_INDEXED"
        );
    }

    #[cfg(unix)]
    #[test]
    fn rsi_symlinked_png_is_rejected() {
        use std::os::unix::fs::symlink;
        let fx = Fixture::new();
        fx.write("Resources/Textures/Link.rsi/meta.json", "{}");
        fx.write("outside.png", "not a png");
        symlink(
            fx.root.join("outside.png"),
            fx.root.join("Resources/Textures/Link.rsi/escape.png"),
        )
        .unwrap();
        let index = ProjectIndex::open(fx.root_str()).unwrap();
        let listing = index
            .list_rsi_sheets("Resources/Textures/Link.rsi")
            .unwrap();
        assert!(listing.sheets.is_empty());
        assert!(!listing.warnings.is_empty());
        assert_eq!(
            index
                .read_rsi_sheet("Resources/Textures/Link.rsi", "escape.png")
                .unwrap_err()
                .code,
            "RSI_IMAGE_INVALID"
        );
    }

    #[test]
    fn reads_rsi_metadata() {
        let fx = Fixture::new();
        fx.write("Resources/Textures/Dummy.rsi/meta.json", "{\"version\":1}");
        let index = ProjectIndex::open(fx.root_str()).unwrap();
        let doc = index.read_resource("Resources/Textures/Dummy.rsi").unwrap();
        assert!(doc.content.contains("\"version\""));
    }
}

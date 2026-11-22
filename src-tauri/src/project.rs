use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
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
use crate::prototypes::PrototypeCatalog;
use crate::resource_edit::{self, SaveResult};
use crate::rsi_create::{self, CreatedRsi, RsiCreationPreview, RsiDraft};
use crate::rsi_credits::{self, RsiCreditsUpdate};
use crate::rsi_delete::{self, DeletedRsiState, RsiDeleteRequest};
use crate::rsi_import::{self, ImportedRsiState, RsiStateImport};
use crate::rsi_preview::{self, RsiSheetImage, RsiSheetList};
use crate::rsi_replace;
use crate::rsi_rename::{self, RenamedRsiState, RsiRenameRequest};
use crate::rsi_restore::{self, RestoredRsiState, RsiArchiveList, RsiRestoreRequest};
use crate::rsi_timing::{self, RsiTimingUpdate};

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
        scan(
            &root,
            &prototypes,
            ScanScope::Prototype,
            &mut traversed,
            &mut resources,
        )?;
        scan(
            &root,
            &resources_root.join("Textures"),
            ScanScope::Texture,
            &mut traversed,
            &mut resources,
        )?;
        scan(
            &root,
            &resources_root.join("Locale"),
            ScanScope::Locale,
            &mut traversed,
            &mut resources,
        )?;
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

    pub fn is_yaml_indexed(&self, path: &str) -> bool {
        self.positions
            .get(path)
            .and_then(|index| self.resources.get(*index))
            .is_some_and(|entry| entry.kind == "yaml")
    }

    pub fn is_editable_text_indexed(&self, path: &str) -> bool {
        self.positions
            .get(path)
            .and_then(|index| self.resources.get(*index))
            .is_some_and(|entry| matches!(entry.kind, "yaml" | "ftl"))
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

    /// Validate live editor text without reading or writing the disk.
    /// Restrict this action to indexed Fluent resources.
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
        let preview = prototype_create::preview(draft)?;
        if self.prototypes()?.has_identity(&preview.kind, &preview.id) {
            return Err(StudioError::new(
                "PROTOTYPE_ID_EXISTS",
                "Прототип с таким сочетанием типа и ID уже объявлен в проекте.",
                "Измените ID либо откройте существующее объявление из каталога.",
            ));
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
            abstract_prototype: false,
            sprite: "".into(),
            sprite_state: "".into(),
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
            abstract_prototype: false,
            sprite: String::new(),
            sprite_state: String::new(),
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
            abstract_prototype: false,
            sprite: String::new(),
            sprite_state: String::new(),
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
            abstract_prototype: false,
            sprite: String::new(),
            sprite_state: String::new(),
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

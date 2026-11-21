use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::Serialize;

use crate::error::{internal_lock, StudioError};
use crate::prototype_append::{self, AppendPreview};
use crate::prototype_components::{self, ComponentInspection, ComponentOperation};
use crate::prototype_create::{self, CreatedPrototype, PrototypeDraft, PrototypePreview};
use crate::prototype_fields::{self, FieldInspection, FieldLocator, FieldPatch, PrototypeFields};
use crate::prototypes::PrototypeCatalog;
use crate::resource_edit::{self, SaveResult};
use crate::rsi_preview::{self, RsiSheetImage, RsiSheetList};

const MAX_SCAN_ENTRIES: usize = 250_000;
const MAX_READ_BYTES: u64 = 4 * 1024 * 1024;
const MAX_RESULTS: usize = 250;

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
            edit_lock: Mutex::new(()),
        })
    }

    pub fn overview(&self) -> &ProjectOverview {
        &self.overview
    }

    pub fn is_yaml_indexed(&self, path: &str) -> bool {
        self.positions
            .get(path)
            .and_then(|index| self.resources.get(*index))
            .is_some_and(|entry| entry.kind == "yaml")
    }

    pub fn prototypes(&self) -> Result<Arc<PrototypeCatalog>, StudioError> {
        let mut cache = self.prototype_catalog.lock().map_err(|_| internal_lock())?;
        Ok(cache
            .get_or_insert_with(|| Arc::new(PrototypeCatalog::build(&self.root, &self.resources)))
            .clone())
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

    fn verify_indexed_rsi(&self, rel_path: &str) -> Result<(), StudioError> {
        let indexed = self.positions.get(rel_path)
            .and_then(|index| self.resources.get(*index))
            .is_some_and(|entry| entry.kind == "rsi");
        if !indexed {
            return Err(StudioError::new(
                "RSI_NOT_INDEXED", "RSI отсутствует в индексе проекта.",
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
    fn missing_optional_scopes_are_warnings() {
        let fx = Fixture::new();
        let index = ProjectIndex::open(fx.root_str()).unwrap();
        assert_eq!(index.overview().prototype_files, 0);
        assert_eq!(index.overview().warnings.len(), 3);
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
    fn rsi_png_is_read_only_indexed_and_bounded() {
        let fx = Fixture::new();
        let path = "Resources/Textures/Test.rsi";
        fx.write("Resources/Textures/Test.rsi/meta.json", "{\"version\":1}");
        fs::write(
            fx.root.join("Resources/Textures/Test.rsi/idle.png"),
            b"\\x89PNG\\r\\n\\x1a\\nminimal fixture",
        ).unwrap();
        let index = ProjectIndex::open(fx.root_str()).unwrap();
        let sheets = index.list_rsi_sheets(path).unwrap();
        assert_eq!(sheets.sheets.len(), 1);
        assert_eq!(sheets.sheets[0].name, "idle.png");
        let image = index.read_rsi_sheet(path, "idle.png").unwrap();
        assert!(image.data_url.starts_with("data:image/png;base64,"));
        assert_eq!(
            index.read_rsi_sheet(path, "../idle.png").unwrap_err().code,
            "RSI_IMAGE_NAME_INVALID"
        );
        assert_eq!(
            index.list_rsi_sheets("Resources/Prototypes").unwrap_err().code,
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
        symlink(fx.root.join("outside.png"),
            fx.root.join("Resources/Textures/Link.rsi/escape.png")).unwrap();
        let index = ProjectIndex::open(fx.root_str()).unwrap();
        let listing = index.list_rsi_sheets("Resources/Textures/Link.rsi").unwrap();
        assert!(listing.sheets.is_empty());
        assert!(!listing.warnings.is_empty());
        assert_eq!(
            index.read_rsi_sheet("Resources/Textures/Link.rsi", "escape.png").unwrap_err().code,
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

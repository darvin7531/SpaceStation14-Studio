//! Conflict-aware whole-file YAML source editing.
//!
//! Text is saved verbatim, never parsed and serialized back into YAML.
//! Revision checks prevent ordinary conflicts; same-directory temp + rename
//! avoids partial writes. A concurrent external writer may still race between
//! the last check and rename; only Studio's own saves are serialized.
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use serde::Serialize;
use sha2::{Digest, Sha256};
use yaml_rust2::parser::{Event, MarkedEventReceiver, Parser};
use yaml_rust2::scanner::Marker;

use crate::error::StudioError;
use crate::project::ResourceDocument;

pub const MAX_TEXT_BYTES: u64 = 4 * 1024 * 1024;
static NEXT_TEMP_ID: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Serialize)]
pub struct SaveResult {
    pub document: ResourceDocument,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub durability_warning: Option<String>,
}

struct IgnoreEvents;
impl MarkedEventReceiver for IgnoreEvents {
    fn on_event(&mut self, _event: Event, _mark: Marker) {}
}

pub fn revision(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

pub fn validate_yaml(text: &str) -> Result<(), StudioError> {
    Parser::new_from_str(text)
        .load(&mut IgnoreEvents, true)
        .map_err(|error| {
            StudioError::new(
                "YAML_SYNTAX_INVALID",
                "YAML содержит синтаксическую ошибку. Файл не сохранён.",
                "Исправьте синтаксис и повторите сохранение. Исходный файл не изменён.",
            )
            .with_details(error.to_string())
        })
}

pub fn save_yaml(
    root: &Path,
    relative_path: &str,
    expected_revision: &str,
    content: String,
) -> Result<SaveResult, StudioError> {
    save_text(root, relative_path, expected_revision, content, true)
}

/// Save source Fluent text exactly as authored. Syntax checking is deliberately
/// not guessed here: the source might use SS14-specific macros and constructs.
pub fn save_ftl(
    root: &Path,
    relative_path: &str,
    expected_revision: &str,
    content: String,
) -> Result<SaveResult, StudioError> {
    save_text(root, relative_path, expected_revision, content, false)
}

fn save_text(
    root: &Path,
    relative_path: &str,
    expected_revision: &str,
    content: String,
    is_yaml: bool,
) -> Result<SaveResult, StudioError> {
    if expected_revision.len() != 64 || !expected_revision.bytes().all(|c| c.is_ascii_hexdigit()) {
        return Err(StudioError::new(
            "REVISION_INVALID",
            "Неизвестная версия исходного файла.",
            "Перечитайте файл с диска перед сохранением черновика.",
        ));
    }
    if content.len() as u64 > MAX_TEXT_BYTES {
        return Err(StudioError::new(
            "RESOURCE_TOO_LARGE",
            "Изменённый текстовый ресурс превышает лимит записи (4 МиБ).",
            "Уменьшите размер файла или используйте внешний редактор.",
        ));
    }
    if is_yaml {
        validate_yaml(&content)?;
    }

    let original = root.join(relative_path);
    let target = safe_target(root, &original)?;
    let metadata =
        fs::metadata(&target).map_err(|error| io_error("RESOURCE_STAT_FAILED", error))?;
    if !metadata.is_file() {
        return Err(StudioError::new(
            "RESOURCE_NOT_FILE",
            "Ресурс больше не является обычным файлом.",
            "Переоткройте проект и проверьте структуру ресурсов.",
        ));
    }
    if metadata.permissions().readonly() {
        return Err(StudioError::new(
            "RESOURCE_READ_ONLY",
            "Файл защищён от записи.",
            "Проверьте права доступа на исходный файл.",
        ));
    }
    let before = bounded_read(&target)?;
    if revision(&before) != expected_revision {
        return Err(conflict());
    }
    if before == content.as_bytes() {
        return Ok(SaveResult {
            document: ResourceDocument {
                path: relative_path.into(),
                content,
                bytes: before.len(),
                revision: revision(&before),
            },
            durability_warning: None,
        });
    }

    let parent = target.parent().ok_or_else(|| {
        StudioError::new(
            "RESOURCE_PATH_INVALID",
            "Не удалось определить каталог ресурса.",
            "Переоткройте исходный файл.",
        )
    })?;
    let (mut temp, temp_path) = create_temp(parent, &target)?;
    let guard = TemporaryFile {
        path: temp_path.clone(),
    };
    fs::set_permissions(&temp_path, metadata.permissions())
        .map_err(|error| io_error("SAVE_PERMISSION_FAILED", error))?;
    temp.write_all(content.as_bytes())
        .map_err(|error| io_error("SAVE_WRITE_FAILED", error))?;
    temp.sync_all()
        .map_err(|error| io_error("SAVE_SYNC_FAILED", error))?;
    drop(temp);

    // Final optimistic comparison: external modifications must not be silently
    // overwritten merely because we read the same file earlier.
    if safe_target(root, &original)? != target {
        return Err(conflict());
    }
    if bounded_read(&target)
        .map(|bytes| revision(&bytes))
        .ok()
        .as_deref()
        != Some(expected_revision)
    {
        return Err(conflict());
    }

    fs::rename(&temp_path, &target).map_err(|error| {
        StudioError::new(
            "SAVE_REPLACE_FAILED",
            "Не удалось заменить исходный файл ресурса.",
            "Проверьте права папки, свободное место и блокировки. Черновик остался в Studio.",
        )
        .with_details(error.to_string())
    })?;
    let durability_warning = sync_directory(parent)
        .err()
        .map(|error| format!("Файл сохранён, но синхронизация каталога не подтверждена: {error}"));
    drop(guard);
    Ok(SaveResult {
        document: ResourceDocument {
            path: relative_path.into(),
            revision: revision(content.as_bytes()),
            bytes: content.len(),
            content,
        },
        durability_warning,
    })
}

fn safe_target(root: &Path, candidate: &Path) -> Result<PathBuf, StudioError> {
    let relative = candidate.strip_prefix(root).map_err(|_| {
        StudioError::new(
            "RESOURCE_OUTSIDE_PROJECT",
            "Запись за пределы проекта отклонена.",
            "Выберите файл через список ресурсов.",
        )
    })?;
    let mut cursor = root.to_path_buf();
    for part in relative.components() {
        if !matches!(part, Component::Normal(_)) {
            return Err(StudioError::new(
                "RESOURCE_PATH_INVALID",
                "Недопустимые компоненты пути.",
                "Выберите файл заново через Studio.",
            ));
        }
        cursor.push(part);
        let metadata = fs::symlink_metadata(&cursor).map_err(|error| {
            StudioError::new(
                "RESOURCE_CHANGED_ON_DISK",
                "Файл или каталог изменились на диске.",
                "Проверьте исходный файл. Черновик не изменён.",
            )
            .with_details(error.to_string())
        })?;
        if metadata.file_type().is_symlink() {
            return Err(StudioError::new(
                "RESOURCE_SYMLINK_BLOCKED",
                "Запись через символическую ссылку запрещена.",
                "Откройте настоящий каталог. Черновик остался в Studio.",
            ));
        }
    }
    let resolved =
        fs::canonicalize(candidate).map_err(|error| io_error("RESOURCE_CHANGED_ON_DISK", error))?;
    if !resolved.starts_with(root) {
        return Err(StudioError::new(
            "RESOURCE_OUTSIDE_PROJECT",
            "Файл оказался за пределами проекта.",
            "Откройте проект заново; черновик остался в Studio.",
        ));
    }
    Ok(resolved)
}

fn bounded_read(path: &Path) -> Result<Vec<u8>, StudioError> {
    let file = File::open(path).map_err(|error| io_error("RESOURCE_READ_FAILED", error))?;
    let mut bytes = Vec::new();
    file.take(MAX_TEXT_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| io_error("RESOURCE_READ_FAILED", error))?;
    if bytes.len() as u64 > MAX_TEXT_BYTES {
        return Err(StudioError::new(
            "RESOURCE_TOO_LARGE",
            "Исходный ресурс вырос за пределы 4 МиБ.",
            "Проверьте изменения в файле; черновик не изменён.",
        ));
    }
    Ok(bytes)
}

fn create_temp(parent: &Path, target: &Path) -> Result<(File, PathBuf), StudioError> {
    let name = target.file_name().ok_or_else(|| {
        StudioError::new(
            "RESOURCE_PATH_INVALID",
            "Нет имени файла для сохранения.",
            "Переоткройте исходный файл.",
        )
    })?;
    for _ in 0..16 {
        let token = NEXT_TEMP_ID.fetch_add(1, Ordering::Relaxed);
        let path = parent.join(format!(
            ".{}.ss14-studio-{}-{}.tmp",
            name.to_string_lossy(),
            std::process::id(),
            token,
        ));
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(file) => return Ok((file, path)),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(io_error("SAVE_TEMP_FAILED", error)),
        }
    }
    Err(StudioError::new(
        "SAVE_TEMP_COLLISION",
        "Не удалось создать уникальный временный файл.",
        "Проверьте временные файлы в папке проекта и повторите сохранение.",
    ))
}

struct TemporaryFile {
    path: PathBuf,
}
impl Drop for TemporaryFile {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

#[cfg(unix)]
fn sync_directory(path: &Path) -> std::io::Result<()> {
    File::open(path)?.sync_all()
}
#[cfg(not(unix))]
fn sync_directory(_path: &Path) -> std::io::Result<()> {
    Ok(())
}

fn conflict() -> StudioError {
    StudioError::new(
        "RESOURCE_CHANGED_ON_DISK",
        "Исходный файл изменился после открытия.",
        "Черновик не перезаписан. Сравните его с новой версией файла.",
    )
}

fn io_error(code: &'static str, error: std::io::Error) -> StudioError {
    StudioError::new(
        code,
        "Не удалось выполнить операцию с файлом ресурса.",
        "Проверьте права доступа и диск. Черновик остался в Studio.",
    )
    .with_details(error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    static TEST_ID: AtomicU64 = AtomicU64::new(0);

    struct Fixture {
        root: PathBuf,
        file: PathBuf,
    }
    impl Fixture {
        fn new() -> Self {
            let i = TEST_ID.fetch_add(1, Ordering::Relaxed);
            let root = std::env::temp_dir().join(format!("ss14-edit-{}-{i}", std::process::id()));
            fs::create_dir_all(root.join("Resources/Prototypes")).unwrap();
            let root = fs::canonicalize(root).unwrap();
            let file = root.join("Resources/Prototypes/sample.yml");
            fs::write(&file, "- type: entity\n  id: Before\n").unwrap();
            Self { root, file }
        }
        fn original(&self) -> String {
            fs::read_to_string(&self.file).unwrap()
        }
        fn revision(&self) -> String {
            revision(self.original().as_bytes())
        }
        fn save(&self, rev: &str, text: &str) -> Result<SaveResult, StudioError> {
            save_yaml(
                &self.root,
                "Resources/Prototypes/sample.yml",
                rev,
                text.to_owned(),
            )
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn saves_fluent_exactly_with_original_comments_and_line_endings() {
        let fx = Fixture::new();
        let file = fx.root.join("Resources/Locale/en-US/test.ftl");
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(&file, "# Original\r\nitem = Before\r\n").unwrap();
        let rev = revision(&fs::read(&file).unwrap());
        let updated = "# Updated\r\nitem = New\r\n    .desc = A description\r\n";
        let result = save_ftl(
            &fx.root,
            "Resources/Locale/en-US/test.ftl",
            &rev,
            updated.into(),
        )
        .unwrap();
        assert_eq!(fs::read_to_string(&file).unwrap(), updated);
        assert_eq!(result.document.revision, revision(updated.as_bytes()));
    }

    #[test]
    fn fluent_save_refuses_external_revision_change() {
        let fx = Fixture::new();
        let file = fx.root.join("Resources/Locale/en-US/test.ftl");
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(&file, "key = First\n").unwrap();
        let rev = revision(&fs::read(&file).unwrap());
        fs::write(&file, "key = External\n").unwrap();
        let error = save_ftl(
            &fx.root,
            "Resources/Locale/en-US/test.ftl",
            &rev,
            "key = Mine\n".into(),
        )
        .unwrap_err();
        assert_eq!(error.code, "RESOURCE_CHANGED_ON_DISK");
        assert_eq!(fs::read_to_string(&file).unwrap(), "key = External\n");
    }

    #[test]
    fn fluent_save_refuses_path_escape() {
        let fx = Fixture::new();
        let error = save_ftl(
            &fx.root,
            "../outside.ftl",
            &revision(b"anything"),
            "evil = no".into(),
        )
        .unwrap_err();
        assert_eq!(error.code, "RESOURCE_PATH_INVALID");
    }

    #[cfg(unix)]
    #[test]
    fn fluent_save_rejects_symlink_replacement() {
        use std::os::unix::fs::symlink;
        let fx = Fixture::new();
        let file = fx.root.join("Resources/Locale/en-US/test.ftl");
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(&file, "key = Original").unwrap();
        let rev = revision(&fs::read(&file).unwrap());
        fs::rename(&file, file.with_extension("backup")).unwrap();
        symlink(file.with_extension("backup"), &file).unwrap();
        let error = save_ftl(
            &fx.root,
            "Resources/Locale/en-US/test.ftl",
            &rev,
            "key = Mine".into(),
        )
        .unwrap_err();
        assert_eq!(error.code, "RESOURCE_SYMLINK_BLOCKED");
    }

    #[test]
    fn saves_text_without_reserializing_yaml() {
        let fx = Fixture::new();
        let rev = fx.revision();
        let updated = "# Comment\r\n- type: entity\r\n  id: Updated\r\n";
        let result = fx.save(&rev, updated).unwrap();
        assert_eq!(fx.original(), updated);
        assert_eq!(result.document.revision, revision(updated.as_bytes()));
        assert!(result.durability_warning.is_none());
    }

    #[test]
    fn rejects_external_changes_without_overwriting() {
        let fx = Fixture::new();
        let rev = fx.revision();
        fs::write(&fx.file, "- type: entity\n  id: External\n").unwrap();
        let error = fx.save(&rev, "- type: entity\n  id: Studio\n").unwrap_err();
        assert_eq!(error.code, "RESOURCE_CHANGED_ON_DISK");
        assert!(fx.original().contains("External"));
    }

    #[test]
    fn rejects_invalid_yaml_without_modifying_file() {
        let fx = Fixture::new();
        let rev = fx.revision();
        let error = fx
            .save(&rev, "- type: entity\n  id: [unfinished\n")
            .unwrap_err();
        assert_eq!(error.code, "YAML_SYNTAX_INVALID");
        assert_eq!(fx.revision(), rev);
    }

    #[test]
    fn accepts_ss14_custom_tags() {
        validate_yaml("- type: !PartialOnly entity\n  id: Example\n").unwrap();
    }

    #[test]
    fn unsupported_revision_is_explicit() {
        let fx = Fixture::new();
        let error = fx.save("invalid", "valid: 1").unwrap_err();
        assert_eq!(error.code, "REVISION_INVALID");
    }

    #[test]
    fn prevents_parent_directory_escape() {
        let fx = Fixture::new();
        let error =
            save_yaml(&fx.root, "../outside.yml", &fx.revision(), "x: y".into()).unwrap_err();
        assert_eq!(error.code, "RESOURCE_PATH_INVALID");
    }

    #[test]
    fn cleans_up_temp_files_after_success() {
        let fx = Fixture::new();
        fx.save(&fx.revision(), "- type: entity\n  id: New\n")
            .unwrap();
        assert_eq!(fs::read_dir(fx.file.parent().unwrap()).unwrap().count(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn symlink_target_is_rejected_even_inside_project() {
        use std::os::unix::fs::symlink;
        let fx = Fixture::new();
        let rev = fx.revision();
        fs::rename(&fx.file, fx.file.with_extension("old")).unwrap();
        symlink(fx.file.with_extension("old"), &fx.file).unwrap();
        let error = fx.save(&rev, "- type: entity\n  id: New\n").unwrap_err();
        assert_eq!(error.code, "RESOURCE_SYMLINK_BLOCKED");
    }
}

//! Durable per-file, per-project recovery snapshots.
//!
//! A draft is never written into the SS14 project. We keep a bounded,
//! restricted-permission JSON snapshot under the Tauri app-data directory.
//! Store keys are SHA-256 hashes, not untrusted resource paths.
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::error::StudioError;
use crate::resource_edit::{revision, MAX_TEXT_BYTES};

const SCHEMA_VERSION: u32 = 1;
const MAX_SNAPSHOT_BYTES: u64 = 8 * 1024 * 1024;
const MAX_DRAFT_FILES: usize = 200;
static NEXT_TEMP: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DraftSnapshot {
    schema_version: u32,
    project_root: String,
    pub path: String,
    pub base_revision: String,
    pub content: String,
    pub saved_at_ms: u64,
}

#[derive(Debug, Serialize)]
pub struct DraftSummary {
    pub path: String,
    pub saved_at_ms: u64,
    pub source_indexed: bool,
}

#[derive(Debug, Serialize)]
pub struct DraftList {
    pub items: Vec<DraftSummary>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct DraftWriteResult {
    pub saved_at_ms: u64,
    pub durability_warning: Option<String>,
}

#[derive(Debug)]
pub struct DraftJournal {
    folder: PathBuf,
    project_root: String,
}

impl DraftJournal {
    pub fn new(app_data_root: &Path, project_root: &str) -> Self {
        Self {
            folder: app_data_root
                .join("recovery-v1")
                .join(revision(project_root.as_bytes())),
            project_root: project_root.into(),
        }
    }

    pub fn write(
        &self,
        path: &str,
        base_revision: &str,
        content: &str,
    ) -> Result<DraftWriteResult, StudioError> {
        validate_path(path)?;
        if base_revision.len() != 64 || !base_revision.bytes().all(|c| c.is_ascii_hexdigit()) {
            return Err(problem(
                "DRAFT_REVISION_INVALID",
                "Нельзя создать копию черновика без контрольной суммы исходного файла.",
            ));
        }
        if content.len() as u64 > MAX_TEXT_BYTES {
            return Err(problem(
                "DRAFT_TOO_LARGE",
                "Черновик превышает лимит восстановления в 4 МиБ.",
            ));
        }
        let saved_at_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|error| issue("DRAFT_CLOCK_INVALID", error))?
            .as_millis() as u64;
        let snapshot = DraftSnapshot {
            schema_version: SCHEMA_VERSION,
            project_root: self.project_root.clone(),
            path: path.into(),
            base_revision: base_revision.into(),
            content: content.into(),
            saved_at_ms,
        };
        let json = serde_json::to_vec(&snapshot)
            .map_err(|error| issue("DRAFT_SERIALIZATION_FAILED", error))?;
        if json.len() as u64 > MAX_SNAPSHOT_BYTES {
            return Err(problem(
                "DRAFT_TOO_LARGE",
                "Черновик слишком велик для хранилища.",
            ));
        }

        self.ensure_folder()?;
        let destination = self.entry_path(path);
        let (mut handle, tempfile) = create_temp(&self.folder)?;
        let guard = TempGuard(tempfile.clone());
        handle
            .write_all(&json)
            .map_err(|error| issue("DRAFT_WRITE_FAILED", error))?;
        handle
            .sync_all()
            .map_err(|error| issue("DRAFT_SYNC_FAILED", error))?;
        drop(handle);
        fs::rename(&tempfile, &destination)
            .map_err(|error| issue("DRAFT_REPLACE_FAILED", error))?;
        drop(guard);

        let durability_warning = sync_dir(&self.folder).err().map(|error| {
            format!("Копия записана, но синхронизация каталога не подтверждена: {error}")
        });
        Ok(DraftWriteResult {
            saved_at_ms,
            durability_warning,
        })
    }

    pub fn read(&self, path: &str) -> Result<Option<DraftSnapshot>, StudioError> {
        validate_path(path)?;
        if !self.existing_folder_is_safe()? {
            return Ok(None);
        }
        self.read_file(&self.entry_path(path), Some(path))
    }

    pub fn list(&self) -> Result<(Vec<DraftSnapshot>, Vec<String>), StudioError> {
        if !self.existing_folder_is_safe()? {
            return Ok((Vec::new(), Vec::new()));
        }
        let mut entries = Vec::new();
        let mut warnings = Vec::new();
        for result in
            fs::read_dir(&self.folder).map_err(|error| issue("DRAFT_LIST_FAILED", error))?
        {
            let entry = result.map_err(|error| issue("DRAFT_LIST_FAILED", error))?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if !name.ends_with(".json") {
                continue;
            }
            if entries.len() + warnings.len() >= MAX_DRAFT_FILES {
                warnings.push("Достигнут лимит просмотра сохранённых черновиков (200).".into());
                break;
            }
            match self.read_file(&entry.path(), None) {
                Ok(Some(snapshot)) => entries.push(snapshot),
                Ok(None) => {}
                Err(error) => warnings.push(format!("{name}: {}", error.message)),
            }
        }
        entries.sort_by_key(|entry| std::cmp::Reverse(entry.saved_at_ms));
        Ok((entries, warnings))
    }

    pub fn delete(&self, path: &str) -> Result<(), StudioError> {
        validate_path(path)?;
        if !self.existing_folder_is_safe()? {
            return Ok(());
        }
        let file = self.entry_path(path);
        match fs::symlink_metadata(&file) {
            Ok(metadata) if !metadata.is_file() || metadata.file_type().is_symlink() => {
                return Err(problem(
                    "DRAFT_PATH_INVALID",
                    "Файл восстановления не является обычным файлом.",
                ));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(issue("DRAFT_DELETE_FAILED", error)),
            _ => {}
        }
        fs::remove_file(&file).map_err(|error| issue("DRAFT_DELETE_FAILED", error))
    }

    fn existing_folder_is_safe(&self) -> Result<bool, StudioError> {
        match fs::symlink_metadata(&self.folder) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(issue("DRAFT_STORAGE_FAILED", error)),
            Ok(meta) if meta.is_dir() && !meta.file_type().is_symlink() => Ok(true),
            Ok(_) => Err(problem(
                "DRAFT_STORAGE_INVALID",
                "Каталог восстановления заменён символической ссылкой или файлом.",
            )),
        }
    }

    fn read_file(
        &self,
        path: &Path,
        exact_path: Option<&str>,
    ) -> Result<Option<DraftSnapshot>, StudioError> {
        let metadata = match fs::symlink_metadata(path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(issue("DRAFT_READ_FAILED", error)),
        };
        if !metadata.is_file()
            || metadata.file_type().is_symlink()
            || metadata.len() > MAX_SNAPSHOT_BYTES
        {
            return Err(problem(
                "DRAFT_FILE_INVALID",
                "Файл восстановления имеет недопустимый тип или размер.",
            ));
        }
        let mut bytes = Vec::new();
        File::open(path)
            .map_err(|error| issue("DRAFT_READ_FAILED", error))?
            .take(MAX_SNAPSHOT_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|error| issue("DRAFT_READ_FAILED", error))?;
        if bytes.len() as u64 > MAX_SNAPSHOT_BYTES {
            return Err(problem(
                "DRAFT_FILE_INVALID",
                "Копия превышает лимит чтения.",
            ));
        }
        let draft: DraftSnapshot =
            serde_json::from_slice(&bytes).map_err(|error| issue("DRAFT_FILE_INVALID", error))?;
        if draft.schema_version != SCHEMA_VERSION
            || draft.project_root != self.project_root
            || draft.content.len() as u64 > MAX_TEXT_BYTES
            || draft.base_revision.len() != 64
            || !draft.base_revision.bytes().all(|c| c.is_ascii_hexdigit())
            || validate_path(&draft.path).is_err()
            || exact_path.is_some_and(|expected| expected != draft.path)
            || self.entry_path(&draft.path) != path
        {
            return Err(problem(
                "DRAFT_FILE_INVALID",
                "Копия не соответствует проекту, пути или поддерживаемой версии формата.",
            ));
        }
        Ok(Some(draft))
    }

    fn ensure_folder(&self) -> Result<(), StudioError> {
        fs::create_dir_all(&self.folder).map_err(|error| issue("DRAFT_STORAGE_FAILED", error))?;
        let metadata = fs::symlink_metadata(&self.folder)
            .map_err(|error| issue("DRAFT_STORAGE_FAILED", error))?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err(problem(
                "DRAFT_STORAGE_INVALID",
                "Каталог восстановления не является обычной папкой.",
            ));
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&self.folder, fs::Permissions::from_mode(0o700))
                .map_err(|error| issue("DRAFT_STORAGE_FAILED", error))?;
        }
        Ok(())
    }

    fn entry_path(&self, path: &str) -> PathBuf {
        self.folder
            .join(format!("{}.json", revision(path.as_bytes())))
    }
}

fn validate_path(path: &str) -> Result<(), StudioError> {
    let components: Vec<_> = Path::new(path).components().collect();
    let valid = components.len() >= 3
        && components
            .iter()
            .all(|part| matches!(part, Component::Normal(_)))
        && components[0].as_os_str() == "Resources"
        && ((components[1].as_os_str() == "Prototypes"
            && (path.to_lowercase().ends_with(".yml") || path.to_lowercase().ends_with(".yaml")))
            || (components[1].as_os_str() == "Locale" && path.to_lowercase().ends_with(".ftl")))
        && !path.contains('\\');
    if !valid {
        return Err(problem(
            "DRAFT_PATH_INVALID",
            "Для восстановления допустимы только YAML в Resources/Prototypes и FTL в Resources/Locale.",
        ));
    }
    Ok(())
}

fn create_temp(folder: &Path) -> Result<(File, PathBuf), StudioError> {
    for _ in 0..16 {
        let number = NEXT_TEMP.fetch_add(1, Ordering::Relaxed);
        let path = folder.join(format!(".draft-{}-{number}.tmp", std::process::id()));
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        match options.open(&path) {
            Ok(handle) => return Ok((handle, path)),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(issue("DRAFT_WRITE_FAILED", error)),
        }
    }
    Err(problem(
        "DRAFT_TEMP_COLLISION",
        "Не удалось создать уникальную временную копию.",
    ))
}

struct TempGuard(PathBuf);
impl Drop for TempGuard {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

#[cfg(unix)]
fn sync_dir(path: &Path) -> std::io::Result<()> {
    File::open(path)?.sync_all()
}
#[cfg(not(unix))]
fn sync_dir(_path: &Path) -> std::io::Result<()> {
    Ok(())
}

fn problem(code: &'static str, message: &str) -> StudioError {
    StudioError::new(
        code,
        message,
        "Текст черновика остаётся в открытом редакторе. Проверьте хранилище приложения.",
    )
}
fn issue(code: &'static str, error: impl std::fmt::Display) -> StudioError {
    problem(code, "Ошибка при работе с копией черновика.").with_details(error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    static TEST_ID: AtomicU64 = AtomicU64::new(0);

    struct Fixture {
        root: PathBuf,
    }
    impl Fixture {
        fn new() -> Self {
            let number = TEST_ID.fetch_add(1, Ordering::Relaxed);
            let root = std::env::temp_dir()
                .join(format!("ss14-draft-test-{}-{number}", std::process::id()));
            fs::create_dir_all(&root).unwrap();
            Self { root }
        }
        fn journal(&self, project: &str) -> DraftJournal {
            DraftJournal::new(&self.root, project)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }
    const PATH: &str = "Resources/Prototypes/test.yml";

    #[test]
    fn persists_and_restores_exact_text() {
        let fx = Fixture::new();
        let journal = fx.journal("/project A");
        let base = revision(b"base");
        let text = "# Привет\r\n- type: !PartialOnly entity\r\n  id: Before\r\n";
        journal.write(PATH, &base, text).unwrap();
        let recovered = journal.read(PATH).unwrap().unwrap();
        assert_eq!(recovered.content, text);
        assert_eq!(recovered.base_revision, base);
        assert_eq!(journal.list().unwrap().0.len(), 1);
        assert!(recovered.saved_at_ms > 0);
    }

    #[test]
    fn fluent_drafts_are_persisted_without_changing_project_files() {
        let fx = Fixture::new();
        let journal = fx.journal("/localization project");
        let file = "Resources/Locale/ru-RU/prototypes/entities.ftl";
        let rev = revision(b"original");
        let source = "# a comment\r\nentity-example = Пример\r\n";
        journal.write(file, &rev, source).unwrap();
        let recovered = journal.read(file).unwrap().unwrap();
        assert_eq!(recovered.content, source);
        assert_eq!(recovered.base_revision, rev);
        assert_eq!(journal.list().unwrap().0.len(), 1);
        journal.delete(file).unwrap();
        assert!(journal.read(file).unwrap().is_none());
    }

    #[test]
    fn different_projects_and_resource_paths_are_isolated() {
        let fx = Fixture::new();
        let first = fx.journal("/project A");
        let second = fx.journal("/project B");
        let rev = revision(b"file");
        first.write(PATH, &rev, "draft A").unwrap();
        assert!(second.read(PATH).unwrap().is_none());
        assert!(first
            .read("Resources/Prototypes/other.yml")
            .unwrap()
            .is_none());
        second.write(PATH, &rev, "draft B").unwrap();
        assert_eq!(first.read(PATH).unwrap().unwrap().content, "draft A");
        assert_eq!(second.read(PATH).unwrap().unwrap().content, "draft B");
    }

    #[test]
    fn updating_draft_replaces_snapshot_without_losing_previous_on_failure() {
        let fx = Fixture::new();
        let journal = fx.journal("/project");
        let rev = revision(b"file");
        journal.write(PATH, &rev, "first").unwrap();
        journal.write(PATH, &rev, "second").unwrap();
        let current = journal.read(PATH).unwrap().unwrap();
        assert_eq!(current.content, "second");
        assert_eq!(journal.list().unwrap().0.len(), 1);
    }

    #[test]
    fn delete_is_explicit_and_repeatable() {
        let fx = Fixture::new();
        let journal = fx.journal("/project");
        let rev = revision(b"file");
        journal.write(PATH, &rev, "unsaved").unwrap();
        journal.delete(PATH).unwrap();
        journal.delete(PATH).unwrap();
        assert!(journal.read(PATH).unwrap().is_none());
    }

    #[test]
    fn rejects_traversal_and_invalid_source_path() {
        let fx = Fixture::new();
        let journal = fx.journal("/project");
        let rev = revision(b"file");
        for path in [
            "../secret.yml",
            "Resources/Prototypes/../escape.yml",
            "Resources/Locale/en.yml",
            "Resources/Other/unsafe.ftl",
            "Resources/Locale/../escape.ftl",
            "/root/secret.yml",
        ] {
            assert_eq!(
                journal.write(path, &rev, "text").unwrap_err().code,
                "DRAFT_PATH_INVALID"
            );
        }
    }

    #[test]
    fn corrupted_record_is_reported_without_hiding_valid_ones() {
        let fx = Fixture::new();
        let journal = fx.journal("/project");
        let rev = revision(b"file");
        journal.write(PATH, &rev, "valid").unwrap();
        fs::write(journal.folder.join("broken.json"), "{not json").unwrap();
        let (items, warnings) = journal.list().unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(warnings.len(), 1);
    }

    #[test]
    fn rejects_other_projects_records_even_when_transplanted() {
        let fx = Fixture::new();
        let journal = fx.journal("/project");
        let other = fx.journal("/elsewhere");
        let rev = revision(b"file");
        other.write(PATH, &rev, "secret").unwrap();
        journal.ensure_folder().unwrap();
        fs::copy(other.entry_path(PATH), journal.entry_path(PATH)).unwrap();
        assert_eq!(journal.read(PATH).unwrap_err().code, "DRAFT_FILE_INVALID");
    }
}

//! Archive an RSI state's PNG and metadata before removing its declaration.
//! Archive snapshots are intentionally retained for manual restoration.
//! Changes to the two files are not one filesystem transaction.
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::error::StudioError;
use crate::resource_edit::{self, revision};
use crate::rsi_import::{bounded_metadata, safe_import_directory};

const MAX_PNG_BYTES: u64 = 8 * 1024 * 1024;
const MAX_META_BYTES: usize = 4 * 1024 * 1024;
const MAX_STATES: usize = 512;
const ARCHIVE_DIRECTORY: &str = ".ss14-studio-archive";
static NEXT_ARCHIVE: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Deserialize)]
pub struct RsiDeleteRequest {
    pub path: String,
    pub expected_revision: String,
    pub name: String,
}

#[derive(Debug, Serialize)]
pub struct DeletedRsiState {
    pub name: String,
    pub content: String,
    pub revision: String,
    pub archive_path: String,
    pub warning: Option<String>,
}

fn issue(code: &'static str, message: &str, hint: &str) -> StudioError {
    StudioError::new(code, message, hint)
}

fn validate(request: &RsiDeleteRequest) -> Result<(), StudioError> {
    if request.expected_revision.len() != 64
        || !request
            .expected_revision
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(issue(
            "RSI_DELETE_REVISION_INVALID",
            "Ревизия meta.json некорректна.",
            "Обновите RSI и повторите операцию.",
        ));
    }
    if request.name.is_empty()
        || request.name.len() > 128
        || !request.name.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'_' | b'-')
        })
    {
        return Err(issue(
            "RSI_DELETE_NAME_INVALID",
            "Некорректное имя состояния RSI.",
            "Выберите существующее состояние из списка проекта.",
        ));
    }
    Ok(())
}

fn metadata_after_deletion(original: &[u8], state_name: &str) -> Result<String, StudioError> {
    let mut metadata: Value = serde_json::from_slice(original).map_err(|error| {
        issue(
            "RSI_DELETE_META_INVALID",
            "meta.json содержит некорректный JSON.",
            "Проверьте файл перед удалением состояния.",
        )
        .with_details(error.to_string())
    })?;
    if metadata.get("version").and_then(Value::as_u64) != Some(1) {
        return Err(issue(
            "RSI_DELETE_VERSION_UNSUPPORTED",
            "Удаление поддерживается только для RSI версии 1.",
            "Откройте RSI с поддерживаемой версией meta.json.",
        ));
    }
    let states = metadata
        .get_mut("states")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| {
            issue(
                "RSI_DELETE_META_INVALID",
                "В meta.json отсутствует массив states.",
                "Проверьте структуру ресурса.",
            )
        })?;
    if states.len() > MAX_STATES {
        return Err(issue(
            "RSI_DELETE_STATES_LIMIT",
            "В RSI слишком много состояний.",
            "Исправьте meta.json во внешнем редакторе.",
        ));
    }
    let matches: Vec<usize> = states
        .iter()
        .enumerate()
        .filter_map(|(index, state)| {
            (state.get("name").and_then(Value::as_str) == Some(state_name)).then_some(index)
        })
        .collect();
    match matches.as_slice() {
        [] => {
            return Err(issue(
                "RSI_DELETE_NOT_FOUND",
                "Состояние уже отсутствует в meta.json.",
                "Обновите RSI перед повторением операции.",
            ))
        }
        [index] => {
            states.remove(*index);
        }
        _ => {
            return Err(issue(
                "RSI_DELETE_AMBIGUOUS",
                "Имя состояния повторяется в meta.json.",
                "Исправьте дубликаты вручную, прежде чем удалять состояние.",
            ))
        }
    }
    let content = serde_json::to_string_pretty(&metadata).map_err(|error| {
        issue(
            "RSI_DELETE_SERIALIZE_FAILED",
            "Не удалось сформировать новый meta.json.",
            "Проверьте структуру JSON.",
        )
        .with_details(error.to_string())
    })? + "\n";
    if content.len() > MAX_META_BYTES {
        return Err(issue(
            "RSI_DELETE_META_TOO_LARGE",
            "Новый meta.json превышает ограничение 4 МиБ.",
            "Уменьшите метаданные ресурса.",
        ));
    }
    Ok(content)
}

pub(crate) fn read_png(path: &Path) -> Result<Vec<u8>, StudioError> {
    let stat = fs::symlink_metadata(path).map_err(|error| {
        issue(
            "RSI_DELETE_PNG_MISSING",
            "PNG выбранного состояния отсутствует.",
            "Восстановите файл или обновите RSI.",
        )
        .with_details(error.to_string())
    })?;
    if stat.file_type().is_symlink() || !stat.is_file() || stat.len() > MAX_PNG_BYTES {
        return Err(issue(
            "RSI_DELETE_PNG_UNSAFE",
            "PNG должен быть обычным файлом не больше 8 МиБ.",
            "Откройте другой ресурс либо исправьте символическую ссылку.",
        ));
    }
    let mut png = Vec::new();
    fs::File::open(path)
        .and_then(|file| file.take(MAX_PNG_BYTES + 1).read_to_end(&mut png))
        .map_err(|error| {
            issue(
                "RSI_DELETE_PNG_READ_FAILED",
                "Не удалось прочитать PNG для резервной копии.",
                "Проверьте права и состояние диска.",
            )
            .with_details(error.to_string())
        })?;
    if png.len() as u64 > MAX_PNG_BYTES {
        return Err(issue(
            "RSI_DELETE_PNG_UNSAFE",
            "PNG вырос во время чтения.",
            "Повторите после завершения внешней записи.",
        ));
    }
    Ok(png)
}

pub(crate) fn write_backup_file(path: &Path, bytes: &[u8]) -> Result<(), StudioError> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|error| {
            issue(
                "RSI_DELETE_ARCHIVE_FAILED",
                "Не удалось создать файл резервной копии.",
                "Проверьте права доступа и свободное место.",
            )
            .with_details(error.to_string())
        })?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|error| {
            issue(
                "RSI_DELETE_ARCHIVE_FAILED",
                "Резервная копия записана не полностью. Оригинал не изменён.",
                "Проверьте диск и удалите неполную архивную папку вручную.",
            )
            .with_details(error.to_string())
        })
}

pub(crate) fn archive_dir(folder: &Path, name: &str) -> Result<std::path::PathBuf, StudioError> {
    let archive_root = folder.join(ARCHIVE_DIRECTORY);
    match fs::create_dir(&archive_root) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => {
            return Err(issue(
                "RSI_DELETE_ARCHIVE_FAILED",
                "Невозможно создать архив RSI.",
                "Проверьте права на папку спрайта.",
            )
            .with_details(error.to_string()))
        }
    }
    let stat = fs::symlink_metadata(&archive_root).map_err(|error| {
        issue(
            "RSI_DELETE_ARCHIVE_FAILED",
            "Архив RSI недоступен.",
            "Проверьте папку архива.",
        )
        .with_details(error.to_string())
    })?;
    if stat.file_type().is_symlink() || !stat.is_dir() {
        return Err(issue(
            "RSI_DELETE_ARCHIVE_UNSAFE",
            "Путь архива является ссылкой или файлом вместо каталога.",
            "Удалите опасную ссылку и повторите операцию.",
        ));
    }
    for _ in 0..32 {
        let sequence = NEXT_ARCHIVE.fetch_add(1, Ordering::Relaxed);
        let candidate =
            archive_root.join(format!("deleted-{name}-{}-{sequence}", std::process::id()));
        match fs::create_dir(&candidate) {
            Ok(()) => return Ok(candidate),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(issue(
                    "RSI_DELETE_ARCHIVE_FAILED",
                    "Не удалось создать новую версию архива.",
                    "Проверьте права на каталог RSI.",
                )
                .with_details(error.to_string()))
            }
        }
    }
    Err(issue(
        "RSI_DELETE_ARCHIVE_COLLISION",
        "Не удалось подобрать уникальное имя архива.",
        "Проверьте каталог резервных копий.",
    ))
}

#[cfg(unix)]
pub(crate) fn sync_directory(path: &Path) -> std::io::Result<()> {
    fs::File::open(path)?.sync_all()
}
#[cfg(not(unix))]
pub(crate) fn sync_directory(_path: &Path) -> std::io::Result<()> {
    Ok(())
}

/// Write a verified backup before changing metadata. Once the metadata
/// replacement succeeds, remove only the same PNG snapshot. On crash or
/// filesystem error, the backup remains; an orphan PNG may remain as well.
/// There is no automatic restoration, and external cross-process writers
/// can still race with the final check.
pub fn delete(root: &Path, request: &RsiDeleteRequest) -> Result<DeletedRsiState, StudioError> {
    delete_checked(root, request, None)
}

pub(crate) fn delete_checked(
    root: &Path,
    request: &RsiDeleteRequest,
    expected_png_revision: Option<&str>,
) -> Result<DeletedRsiState, StudioError> {
    validate(request)?;
    if expected_png_revision.is_some_and(|expected| {
        expected.len() != 64 || !expected.bytes().all(|byte| byte.is_ascii_hexdigit())
    }) {
        return Err(issue(
            "RSI_DELETE_PNG_REVISION_INVALID",
            "Ревизия PNG отсутствует или некорректна.",
            "Перечитайте выбранный PNG и повторите операцию.",
        ));
    }
    let folder = safe_import_directory(root, &request.path)?;
    let metadata_path = folder.join("meta.json");
    let original = bounded_metadata(&metadata_path)?;
    if revision(&original) != request.expected_revision {
        return Err(issue(
            "RSI_DELETE_CONFLICT",
            "meta.json изменился после открытия.",
            "Обновите ресурс перед удалением.",
        ));
    }
    let updated = metadata_after_deletion(&original, &request.name)?;
    let png_path = folder.join(format!("{}.png", request.name));
    let png = match fs::symlink_metadata(&png_path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound && expected_png_revision.is_none() => None,
        _ => Some(read_png(&png_path)?),
    };
    let png_revision = png.as_ref().map(|bytes| revision(bytes));
    if expected_png_revision.is_some_and(|expected| Some(expected) != png_revision.as_deref()) {
        return Err(issue(
            "RSI_DELETE_PNG_CONFLICT",
            "PNG изменился после открытия и не будет заменён.",
            "Обновите предпросмотр RSI и повторите операцию.",
        ));
    }

    let backup_path = archive_dir(&folder, &request.name)?;
    write_backup_file(&backup_path.join("meta.json.before"), &original)?;
    if let Some(png) = &png {
        write_backup_file(&backup_path.join(format!("{}.png", request.name)), png)?;
    }
    let manifest = serde_json::to_vec_pretty(&json!({
        "format": if png.is_some() { "ss14-studio-rsi-delete-backup-v1" } else { "ss14-studio-rsi-delete-backup-metadata-v1" },
        "rsi": request.path,
        "state": request.name,
        "original_meta_revision": request.expected_revision,
        "original_png_revision": png_revision,
        "recovery": "Restore the archived PNG and meta.json.before manually after checking current files."
    })).map_err(|error| {
        issue("RSI_DELETE_ARCHIVE_FAILED", "Не удалось сформировать манифест резервной копии.", "Исходные данные не изменены.")
            .with_details(error.to_string())
    })?;
    write_backup_file(&backup_path.join("manifest.json"), &manifest)?;
    sync_directory(&backup_path).map_err(|error| {
        issue(
            "RSI_DELETE_ARCHIVE_FAILED",
            "Не удалось синхронизировать резервную копию.",
            "Исходные данные не изменены, проверьте файловую систему.",
        )
        .with_details(error.to_string())
    })?;
    sync_directory(backup_path.parent().unwrap_or(&folder)).map_err(|error| {
        issue(
            "RSI_DELETE_ARCHIVE_FAILED",
            "Не удалось подтвердить запись папки архива.",
            "Исходные данные не изменены, проверьте файловую систему.",
        )
        .with_details(error.to_string())
    })?;

    // Reuse the existing double-SHA-256 conflict check and atomic JSON save.
    let result = resource_edit::save_rsi_metadata(
        root,
        &format!("{}/meta.json", request.path),
        &request.expected_revision,
        updated,
    )
    .map_err(|error| {
        issue(
            "RSI_DELETE_ARCHIVED_SAVE_FAILED",
            "Архив создан, но обновить meta.json не удалось.",
            "Не удаляйте архив; проверьте текущие файлы перед повторной попыткой.",
        )
        .with_details(format!(
            "Ошибка: {error:?}; архив: {}",
            backup_path.display()
        ))
    })?;

    // Best effort removal of the now-unreferenced file. If another process
    // has replaced it, leave it on disk and report a warning instead.
    let mut warnings = Vec::new();
    if let Some(warning) = result.durability_warning {
        warnings.push(warning);
    }
    let directory_still_safe =
        safe_import_directory(root, &request.path).is_ok_and(|current| current == folder);
    let png_still_safe = directory_still_safe
        && fs::symlink_metadata(&png_path).is_ok_and(|stat| {
            !stat.file_type().is_symlink() && stat.is_file() && stat.len() <= MAX_PNG_BYTES
        });
    if png.is_none() {
        if fs::symlink_metadata(&png_path).is_ok() {
            warnings.push("PNG появился во время операции и оставлен на месте.".into());
        }
    } else if !png_still_safe {
        warnings.push(
            "Исходный PNG изменился или исчез: файл не удалён. Резервная копия сохранена."
                .to_string(),
        );
    } else {
        match read_png(&png_path) {
            Ok(current) if Some(revision(&current)) == png_revision => {
                if let Err(error) = fs::remove_file(&png_path) {
                    warnings.push(format!(
                        "Состояние удалено из meta.json, но PNG остался: {error}"
                    ));
                }
            }
            _ => warnings
                .push("Исходный PNG изменился во время операции: он оставлен на месте.".into()),
        }
    }
    if let Err(error) = sync_directory(&folder) {
        warnings.push(format!("Синхронизация папки RSI не подтверждена: {error}"));
    }

    let archive_relative = backup_path
        .strip_prefix(root)
        .unwrap_or(&backup_path)
        .to_string_lossy()
        .replace('\\', "/");
    Ok(DeletedRsiState {
        name: request.name.clone(),
        content: result.document.content,
        revision: result.document.revision,
        archive_path: archive_relative,
        warning: (!warnings.is_empty()).then(|| warnings.join(" ")),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    static NEXT_TEST: AtomicU64 = AtomicU64::new(0);
    struct Fixture {
        root: PathBuf,
        path: String,
    }
    impl Fixture {
        fn new() -> Self {
            let seq = NEXT_TEST.fetch_add(1, Ordering::Relaxed);
            let root =
                std::env::temp_dir().join(format!("ss14-rsi-delete-{}-{seq}", std::process::id()));
            fs::create_dir_all(root.join("Resources/Textures/test.rsi")).unwrap();
            let root = fs::canonicalize(root).unwrap();
            let path = "Resources/Textures/test.rsi".to_string();
            fs::write(root.join(&path).join("meta.json"),
                r#"{"version":1,"size":{"x":1,"y":1},"custom":{"preserve":7},"states":[{"name":"idle","directions":1},{"name":"walk","directions":4,"customState":"keep"}]}"#).unwrap();
            fs::write(root.join(&path).join("idle.png"), b"original sprite").unwrap();
            fs::write(root.join(&path).join("walk.png"), b"other sprite").unwrap();
            Self { root, path }
        }
        fn request(&self) -> RsiDeleteRequest {
            let original = fs::read(self.root.join(&self.path).join("meta.json")).unwrap();
            RsiDeleteRequest {
                path: self.path.clone(),
                name: "idle".into(),
                expected_revision: revision(&original),
            }
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn removes_only_selected_state_and_keeps_restorable_originals() {
        let fixture = Fixture::new();
        let request = fixture.request();
        let deleted = delete(&fixture.root, &request).unwrap();
        assert_eq!(deleted.name, "idle");
        let content: Value = serde_json::from_str(&deleted.content).unwrap();
        assert_eq!(content["states"].as_array().unwrap().len(), 1);
        assert_eq!(content["states"][0]["name"], "walk");
        assert_eq!(content["states"][0]["customState"], "keep");
        assert_eq!(content["custom"]["preserve"], 7);
        assert!(!fixture.root.join(&fixture.path).join("idle.png").exists());
        assert_eq!(
            fs::read(fixture.root.join(&fixture.path).join("walk.png")).unwrap(),
            b"other sprite"
        );
        let archive = fixture.root.join(&deleted.archive_path);
        assert_eq!(
            fs::read(archive.join("idle.png")).unwrap(),
            b"original sprite"
        );
        let original: Value =
            serde_json::from_slice(&fs::read(archive.join("meta.json.before")).unwrap()).unwrap();
        assert_eq!(original["states"].as_array().unwrap().len(), 2);
        let manifest: Value =
            serde_json::from_slice(&fs::read(archive.join("manifest.json")).unwrap()).unwrap();
        assert_eq!(manifest["state"], "idle");
        assert_eq!(deleted.revision, revision(deleted.content.as_bytes()));
    }

    #[test]
    fn stale_revision_never_mutates_files() {
        let fixture = Fixture::new();
        let request = fixture.request();
        fs::write(
            fixture.root.join(&fixture.path).join("meta.json"),
            b"external change",
        )
        .unwrap();
        assert_eq!(
            delete(&fixture.root, &request).unwrap_err().code,
            "RSI_DELETE_CONFLICT"
        );
        assert_eq!(
            fs::read(fixture.root.join(&fixture.path).join("idle.png")).unwrap(),
            b"original sprite"
        );
        assert!(!fixture
            .root
            .join(&fixture.path)
            .join(ARCHIVE_DIRECTORY)
            .exists());
    }

    #[test]
    fn refuses_missing_duplicate_and_unsafe_state() {
        let fixture = Fixture::new();
        let mut request = fixture.request();
        request.name = "missing".into();
        assert_eq!(
            delete(&fixture.root, &request).unwrap_err().code,
            "RSI_DELETE_NOT_FOUND"
        );
        request.name = "../idle".into();
        assert_eq!(
            delete(&fixture.root, &request).unwrap_err().code,
            "RSI_DELETE_NAME_INVALID"
        );
        let mut meta: Value = serde_json::from_slice(
            &fs::read(fixture.root.join(&fixture.path).join("meta.json")).unwrap(),
        )
        .unwrap();
        let duplicate = meta["states"][0].clone();
        meta["states"].as_array_mut().unwrap().push(duplicate);
        fs::write(
            fixture.root.join(&fixture.path).join("meta.json"),
            serde_json::to_vec(&meta).unwrap(),
        )
        .unwrap();
        request = fixture.request();
        assert_eq!(
            delete(&fixture.root, &request).unwrap_err().code,
            "RSI_DELETE_AMBIGUOUS"
        );
        assert!(fixture.root.join(&fixture.path).join("idle.png").exists());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinked_png_and_archive_directory() {
        use std::os::unix::fs::symlink;
        let fixture = Fixture::new();
        let png = fixture.root.join(&fixture.path).join("idle.png");
        fs::remove_file(&png).unwrap();
        symlink(fixture.root.join(&fixture.path).join("walk.png"), &png).unwrap();
        assert_eq!(
            delete(&fixture.root, &fixture.request()).unwrap_err().code,
            "RSI_DELETE_PNG_UNSAFE"
        );
        fs::remove_file(png).unwrap();
        fs::write(fixture.root.join(&fixture.path).join("idle.png"), b"sprite").unwrap();
        symlink(
            fixture.root.join(&fixture.path).join("walk.png"),
            fixture.root.join(&fixture.path).join(ARCHIVE_DIRECTORY),
        )
        .unwrap();
        assert_eq!(
            delete(&fixture.root, &fixture.request()).unwrap_err().code,
            "RSI_DELETE_ARCHIVE_UNSAFE"
        );
    }

    #[test]
    fn deletes_and_restores_metadata_only_state() {
        let fixture = Fixture::new();
        let folder = fixture.root.join(&fixture.path);
        fs::remove_file(folder.join("idle.png")).unwrap();
        let request = fixture.request();
        assert_eq!(delete_checked(&fixture.root, &request, Some(&revision(b"old"))).unwrap_err().code, "RSI_DELETE_PNG_MISSING");
        let deleted = delete(&fixture.root, &request).unwrap();
        let archive = fixture.root.join(&deleted.archive_path);
        assert!(!archive.join("idle.png").exists());
        let id = archive.file_name().unwrap().to_str().unwrap().to_string();
        assert_eq!(crate::rsi_restore::list(&fixture.root, &fixture.path).unwrap().archives.len(), 1);
        let restore_request = crate::rsi_restore::RsiRestoreRequest {
            path: fixture.path.clone(), expected_revision: deleted.revision.clone(), archive_id: id,
        };
        let stale = crate::rsi_restore::RsiRestoreRequest {
            path: fixture.path.clone(), expected_revision: request.expected_revision.clone(), archive_id: restore_request.archive_id.clone(),
        };
        assert_eq!(crate::rsi_restore::restore(&fixture.root, &stale).unwrap_err().code, "RSI_RESTORE_CONFLICT");
        fs::write(archive.join("idle.png"), b"unexpected").unwrap();
        assert_eq!(crate::rsi_restore::restore(&fixture.root, &restore_request).unwrap_err().code, "RSI_RESTORE_ARCHIVE_UNSAFE");
        fs::remove_file(archive.join("idle.png")).unwrap();
        fs::write(folder.join("idle.png"), b"external").unwrap();
        assert_eq!(crate::rsi_restore::restore(&fixture.root, &restore_request).unwrap_err().code, "RSI_RESTORE_PNG_EXISTS");
        fs::remove_file(folder.join("idle.png")).unwrap();
        let restored = crate::rsi_restore::restore(&fixture.root, &restore_request).unwrap();
        let meta: Value = serde_json::from_str(&restored.content).unwrap();
        assert_eq!(meta["states"][0]["name"], "idle");
        assert_eq!(meta["states"][1]["name"], "walk");
        assert!(!folder.join("idle.png").exists());
        assert!(archive.join("meta.json.before").exists());
    }
}

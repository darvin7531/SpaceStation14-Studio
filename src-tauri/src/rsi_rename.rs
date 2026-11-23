//! Rename one RSI v1 state, with or without a PNG, without clobbering files.
//! Copy-on-write order: snapshot originals -> create+sync new PNG -> commit meta ->
//! remove old PNG only if its bytes still match. Interrupted operations leave
//! the original PNG or a restorable backup, never an unbacked overwritten PNG.
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::error::StudioError;
use crate::resource_edit::{self, revision};
use crate::rsi_delete::{archive_dir, read_png, sync_directory, write_backup_file};
use crate::rsi_import::{bounded_metadata, safe_import_directory};

const MAX_META_BYTES: usize = 4 * 1024 * 1024;

#[derive(Debug, Deserialize)]
pub struct RsiRenameRequest {
    pub path: String,
    pub expected_revision: String,
    pub expected_png_revision: Option<String>,
    #[serde(default)]
    pub expected_missing_png: bool,
    pub old_name: String,
    pub new_name: String,
}

#[derive(Debug, Serialize)]
pub struct RenamedRsiState {
    pub name: String,
    pub old_name: String,
    pub content: String,
    pub revision: String,
    pub archive_path: String,
    pub warning: Option<String>,
}

fn issue(code: &'static str, message: &str, hint: &str) -> StudioError {
    StudioError::new(code, message, hint)
}

fn valid_sha(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn valid_state(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'_' | b'-')
        })
}

fn validate(request: &RsiRenameRequest) -> Result<(), StudioError> {
    if !valid_sha(&request.expected_revision)
        || (request.expected_missing_png && request.expected_png_revision.is_some())
        || (!request.expected_missing_png && !request.expected_png_revision.as_deref().is_some_and(valid_sha))
    {
        return Err(issue(
            "RSI_RENAME_REVISION_INVALID",
            "Неверная контрольная сумма метаданных либо PNG.",
            "Перечитайте выбранный RSI и повторите переименование.",
        ));
    }
    if !valid_state(&request.old_name) || !valid_state(&request.new_name) {
        return Err(issue(
            "RSI_RENAME_NAME_INVALID",
            "Имя состояния должно содержать от 1 до 128 латинских строчных букв, цифр, _ или -.",
            "Укажите простое имя состояния без расширения .png.",
        ));
    }
    if request.old_name == request.new_name {
        return Err(issue(
            "RSI_RENAME_NO_CHANGE",
            "Новое имя должно отличаться от исходного.",
            "Укажите другое имя состояния.",
        ));
    }
    Ok(())
}

fn metadata_after_rename(
    original: &[u8],
    request: &RsiRenameRequest,
) -> Result<String, StudioError> {
    let mut metadata: Value = serde_json::from_slice(original).map_err(|error| {
        issue(
            "RSI_RENAME_META_INVALID",
            "meta.json содержит некорректный JSON.",
            "Исправьте файл до переименования.",
        )
        .with_details(error.to_string())
    })?;
    if metadata.get("version").and_then(Value::as_u64) != Some(1)
        || !metadata.get("size").is_some_and(Value::is_object)
    {
        return Err(issue(
            "RSI_RENAME_FORMAT_UNSUPPORTED",
            "Переименование поддерживается для корректного RSI v1.",
            "Проверьте version и size в meta.json.",
        ));
    }
    let states = metadata
        .get_mut("states")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| {
            issue(
                "RSI_RENAME_META_INVALID",
                "В meta.json нет массива states.",
                "Исправьте структуру файла.",
            )
        })?;
    if states.len() > 512 {
        return Err(issue(
            "RSI_RENAME_STATES_LIMIT",
            "Слишком много состояний в meta.json.",
            "Уменьшите количество состояний.",
        ));
    }

    let mut matches = states.iter().enumerate().filter_map(|(index, state)| {
        (state.get("name").and_then(Value::as_str) == Some(&request.old_name)).then_some(index)
    });
    let index = matches.next().ok_or_else(|| {
        issue(
            "RSI_RENAME_STATE_NOT_FOUND",
            "Исходное состояние уже отсутствует в meta.json.",
            "Обновите RSI.",
        )
    })?;
    if matches.next().is_some() {
        return Err(issue(
            "RSI_RENAME_STATE_AMBIGUOUS",
            "В meta.json несколько состояний с исходным именем.",
            "Устраните дубликаты, чтобы избежать неверной правки.",
        ));
    }
    if states
        .iter()
        .any(|state| state.get("name").and_then(Value::as_str) == Some(&request.new_name))
    {
        return Err(issue(
            "RSI_RENAME_STATE_EXISTS",
            "Состояние с новым именем уже есть в meta.json.",
            "Выберите ещё не занятое имя.",
        ));
    }
    states[index]
        .as_object_mut()
        .ok_or_else(|| {
            issue(
                "RSI_RENAME_META_INVALID",
                "Исходное состояние не является JSON-объектом.",
                "Исправьте meta.json.",
            )
        })?
        .insert("name".into(), Value::String(request.new_name.clone()));

    let content = serde_json::to_string_pretty(&metadata).map_err(|error| {
        issue(
            "RSI_RENAME_META_INVALID",
            "Не удалось сериализовать meta.json.",
            "Проверьте состояние файла.",
        )
        .with_details(error.to_string())
    })? + "\n";
    if content.len() > MAX_META_BYTES {
        return Err(issue(
            "RSI_RENAME_META_LIMIT",
            "Новые метаданные превышают лимит 4 МиБ.",
            "Уменьшите размер meta.json.",
        ));
    }
    Ok(content)
}

fn require_absent(path: &Path) -> Result<(), StudioError> {
    match fs::symlink_metadata(path) {
        Ok(_) => Err(issue("RSI_RENAME_TARGET_EXISTS", "Путь PNG уже занят.", "Обновите RSI и проверьте файлы.")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(issue("RSI_RENAME_TARGET_UNREADABLE", "Не удалось проверить путь PNG.", "Проверьте права доступа.").with_details(error.to_string())),
    }
}

fn clean_own_png(path: &Path, expected: &[u8]) -> Result<(), StudioError> {
    if revision(&read_png(path)?) != revision(expected) {
        return Err(issue(
            "RSI_RENAME_CLEANUP_CONFLICT",
            "Созданный PNG изменился в ходе операции и оставлен на месте.",
            "Проверьте PNG вручную. Оригинал и его архив сохранены.",
        ));
    }
    fs::remove_file(path).map_err(|error| {
        issue(
            "RSI_RENAME_CLEANUP_FAILED",
            "Не удалось удалить временно созданный PNG.",
            "Проверьте каталог RSI вручную; оригинал не был перезаписан.",
        )
        .with_details(error.to_string())
    })
}

pub fn rename(root: &Path, request: &RsiRenameRequest) -> Result<RenamedRsiState, StudioError> {
    validate(request)?;
    let folder = safe_import_directory(root, &request.path)?;
    let meta_path = folder.join("meta.json");
    let original = bounded_metadata(&meta_path)?;
    if revision(&original) != request.expected_revision {
        return Err(issue(
            "RSI_RENAME_META_CONFLICT",
            "meta.json изменился после открытия RSI.",
            "Обновите RSI и повторите переименование.",
        ));
    }
    let updated = metadata_after_rename(&original, request)?;
    let source_path = folder.join(format!("{}.png", request.old_name));
    let target_path = folder.join(format!("{}.png", request.new_name));
    let old_png = if request.expected_missing_png {
        require_absent(&source_path)?;
        None
    } else {
        Some(read_png(&source_path)?)
    };
    if old_png.as_ref().is_some_and(|png| Some(revision(png).as_str()) != request.expected_png_revision.as_deref()) {
        return Err(issue(
            "RSI_RENAME_PNG_CONFLICT",
            "Исходный PNG был изменён вне Studio.",
            "Обновите предпросмотр и повторите переименование.",
        ));
    }

    require_absent(&target_path)?;

    if fs::metadata(&meta_path)
        .map_err(|error| {
            issue(
                "RSI_RENAME_META_UNREADABLE",
                "Не удалось проверить права meta.json.",
                "Проверьте каталог RSI.",
            )
            .with_details(error.to_string())
        })?
        .permissions()
        .readonly()
    {
        return Err(issue(
            "RSI_RENAME_META_READONLY",
            "meta.json доступен только для чтения.",
            "Разрешите запись в метаданные перед переименованием.",
        ));
    }

    // PNG backups are restorable in Studio; metadata-only backups require manual recovery.
    let archive = archive_dir(&folder, &request.old_name)?;
    write_backup_file(&archive.join("meta.json.before"), &original)?;
    if let Some(png) = &old_png {
        write_backup_file(&archive.join(format!("{}.png", request.old_name)), png)?;
    }
    let manifest = serde_json::to_vec_pretty(&json!({
        "format": if old_png.is_some() { "ss14-studio-rsi-delete-backup-v1" } else { "ss14-studio-rsi-delete-backup-metadata-v1" },
        "rsi": request.path,
        "state": request.old_name,
        "original_meta_revision": request.expected_revision,
        "original_png_revision": request.expected_png_revision,
        "operation": "rename",
        "new_name": request.new_name,
        "recovery": if old_png.is_some() { "Restore the old-name state using Studio's RSI archive panel if needed." } else { "Stop external writers and inspect both PNG paths and current metadata. Manually reconcile the archived state with the renamed state; do not replace meta.json wholesale." }
    }))
    .map_err(|error| {
        issue(
            "RSI_RENAME_ARCHIVE_FAILED",
            "Не удалось записать манифест резервной копии.",
            "Исходные файлы не изменены.",
        )
        .with_details(error.to_string())
    })?;
    write_backup_file(&archive.join("manifest.json"), &manifest)?;
    for directory in [&archive, archive.parent().unwrap_or(&folder)] {
        sync_directory(directory).map_err(|error| {
            issue(
                "RSI_RENAME_ARCHIVE_FAILED",
                "Не удалось синхронизировать архив. Переименование отменено.",
                "Проверьте свободное место и права.",
            )
            .with_details(error.to_string())
        })?;
    }

    if request.expected_missing_png {
        require_absent(&source_path)?;
        require_absent(&target_path)?;
        let result = resource_edit::save_rsi_metadata(
            root, &format!("{}/meta.json", request.path), &request.expected_revision, updated,
        )?;
        // ponytail: cross-process writes can race the final checks; OS-level locking would be needed.
        let mut warnings = vec!["PNG не изменялись; внешний процесс мог изменить метаданные или создать PNG во время операции. Архив метаданных восстанавливается вручную.".to_owned()];
        if let Some(warning) = result.durability_warning { warnings.push(warning); }
        return Ok(RenamedRsiState {
            name: request.new_name.clone(), old_name: request.old_name.clone(),
            content: result.document.content, revision: result.document.revision,
            archive_path: archive.strip_prefix(root).unwrap_or(&archive).to_string_lossy().replace('\\', "/"),
            warning: Some(warnings.join(" ")),
        });
    }
    let old_png = old_png.expect("PNG mode validated above");
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&target_path)
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::AlreadyExists {
                issue(
                    "RSI_RENAME_TARGET_EXISTS",
                    "Новый PNG появился во время архивирования.",
                    "Проверьте каталог RSI и выберите другое имя.",
                )
            } else {
                issue(
                    "RSI_RENAME_WRITE_FAILED",
                    "Не удалось создать PNG с новым именем.",
                    "Проверьте свободное место и права.",
                )
                .with_details(error.to_string())
            }
        })?;
    let wrote = output.write_all(&old_png).and_then(|_| output.sync_all());
    drop(output);
    let prepared = wrote
        .map_err(|error| {
            issue(
                "RSI_RENAME_WRITE_FAILED",
                "Не удалось полностью записать PNG с новым именем.",
                "Оригинальный PNG не удалён. Проверьте неполный файл вручную.",
            )
            .with_details(error.to_string())
        })
        .and_then(|_| {
            sync_directory(&folder).map_err(|error| {
                issue(
                    "RSI_RENAME_DURABILITY_FAILED",
                    "Синхронизация нового PNG перед обновлением meta.json не удалась.",
                    "Исходный PNG сохранён. Проверьте состояние диска.",
                )
                .with_details(error.to_string())
            })
        })
        .and_then(|_| {
            if revision(&bounded_metadata(&meta_path)?) != request.expected_revision {
                return Err(issue(
                    "RSI_RENAME_META_CONFLICT",
                    "meta.json изменился во время копирования PNG.",
                    "Обновите RSI перед повторной попыткой.",
                ));
            }
            if revision(&read_png(&source_path)?) != request.expected_png_revision.as_deref().unwrap_or("") {
                return Err(issue(
                    "RSI_RENAME_PNG_CONFLICT",
                    "Исходный PNG изменился во время копирования.",
                    "Обновите RSI перед повторной попыткой.",
                ));
            }
            Ok(())
        });

    if let Err(error) = prepared {
        if let Err(cleanup) = clean_own_png(&target_path, &old_png) {
            return Err(issue(
                "RSI_RENAME_CLEANUP_REQUIRED",
                "Переименование не завершено, и новый PNG остался в каталоге.",
                "Исходный PNG не удалён. Проверьте новый файл вручную.",
            )
            .with_details(format!("Ошибка: {error:?}; очистка: {cleanup:?}")));
        }
        return Err(error);
    }

    let committed = resource_edit::save_rsi_metadata(
        root,
        &format!("{}/meta.json", request.path),
        &request.expected_revision,
        updated,
    );
    let result = match committed {
        Ok(result) => result,
        Err(error) => {
            if let Err(cleanup) = clean_own_png(&target_path, &old_png) {
                return Err(issue(
                    "RSI_RENAME_CLEANUP_REQUIRED",
                    "Сохранение meta.json не удалось, и новый PNG остался в каталоге.",
                    "Исходное состояние сохранено. Проверьте файлы вручную.",
                )
                .with_details(format!("Ошибка: {error:?}; очистка: {cleanup:?}")));
            }
            return Err(error);
        }
    };

    let mut warnings = Vec::new();
    if let Some(warning) = result.durability_warning {
        warnings.push(warning);
    }
    let safe_folder =
        safe_import_directory(root, &request.path).is_ok_and(|candidate| candidate == folder);
    if !safe_folder {
        warnings.push(
            "Каталог RSI изменился во время переименования; исходный PNG оставлен на месте."
                .to_owned(),
        );
    } else {
        match read_png(&source_path) {
            Ok(bytes) if revision(&bytes) == request.expected_png_revision.as_deref().unwrap_or("") => {
                if let Err(error) = fs::remove_file(&source_path) {
                    warnings.push(format!(
                        "Новый файл записан, но исходный PNG остался: {error}"
                    ));
                }
            }
            _ => warnings.push(
                "Исходный PNG изменился после обновления meta.json и оставлен на месте.".to_owned(),
            ),
        }
    }
    if let Err(error) = sync_directory(&folder) {
        warnings.push(format!(
            "Не удалось подтвердить синхронизацию каталога RSI: {error}"
        ));
    }

    Ok(RenamedRsiState {
        name: request.new_name.clone(),
        old_name: request.old_name.clone(),
        content: result.document.content,
        revision: result.document.revision,
        archive_path: archive
            .strip_prefix(root)
            .unwrap_or(&archive)
            .to_string_lossy()
            .replace('\\', "/"),
        warning: (!warnings.is_empty()).then(|| warnings.join(" ")),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rsi_restore::{self, RsiRestoreRequest};
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT: AtomicU64 = AtomicU64::new(0);
    struct Fixture {
        root: PathBuf,
        path: String,
    }
    impl Fixture {
        fn new() -> Self {
            let seq = NEXT.fetch_add(1, Ordering::Relaxed);
            let root =
                std::env::temp_dir().join(format!("ss14-rsi-rename-{}-{seq}", std::process::id()));
            let path = "Resources/Textures/sample.rsi".to_string();
            let folder = root.join(&path);
            fs::create_dir_all(&folder).unwrap();
            fs::write(folder.join("meta.json"),
                r#"{"version":1,"size":{"x":32,"y":32},"custom":{"preserve":true},"states":[{"name":"idle","directions":1,"delays":[[0.25]],"customState":"keep"},{"name":"other","directions":1}]}"#).unwrap();
            fs::write(folder.join("idle.png"), b"original-idle-image").unwrap();
            fs::write(folder.join("other.png"), b"other-image").unwrap();
            Self {
                root: fs::canonicalize(root).unwrap(),
                path,
            }
        }

        fn request(&self) -> RsiRenameRequest {
            let folder = self.root.join(&self.path);
            let metadata = fs::read(folder.join("meta.json")).unwrap();
            let png = fs::read(folder.join("idle.png")).unwrap();
            RsiRenameRequest {
                path: self.path.clone(),
                expected_revision: revision(&metadata),
                expected_png_revision: Some(revision(&png)),
                expected_missing_png: false,
                old_name: "idle".into(),
                new_name: "idle_new".into(),
            }
        }
        fn folder(&self) -> std::path::PathBuf {
            self.root.join(&self.path)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn renames_state_with_backup_and_preserves_other_files_and_fields() {
        let fixture = Fixture::new();
        let renamed = rename(&fixture.root, &fixture.request()).unwrap();
        assert_eq!(renamed.name, "idle_new");
        assert_eq!(renamed.old_name, "idle");
        let doc: Value = serde_json::from_str(&renamed.content).unwrap();
        assert_eq!(doc["custom"]["preserve"], true);
        assert_eq!(doc["states"][0]["name"], "idle_new");
        assert_eq!(doc["states"][0]["customState"], "keep");
        assert_eq!(doc["states"][0]["delays"][0][0], 0.25);
        assert_eq!(doc["states"][1]["name"], "other");
        assert_eq!(renamed.revision, revision(renamed.content.as_bytes()));
        assert!(!fixture.folder().join("idle.png").exists());
        assert_eq!(
            fs::read(fixture.folder().join("idle_new.png")).unwrap(),
            b"original-idle-image"
        );
        assert_eq!(
            fs::read(fixture.folder().join("other.png")).unwrap(),
            b"other-image"
        );
        let archive = fixture.root.join(&renamed.archive_path);
        assert_eq!(
            fs::read(archive.join("idle.png")).unwrap(),
            b"original-idle-image"
        );
        let manifest: Value =
            serde_json::from_slice(&fs::read(archive.join("manifest.json")).unwrap()).unwrap();
        assert_eq!(manifest["operation"], "rename");

        // The old-name backup is restorable without overwriting the renamed state.
        let archives = rsi_restore::list(&fixture.root, &fixture.path).unwrap();
        assert_eq!(archives.archives.len(), 1);
        let restored = rsi_restore::restore(
            &fixture.root,
            &RsiRestoreRequest {
                path: fixture.path.clone(),
                expected_revision: renamed.revision,
                archive_id: archives.archives[0].id.clone(),
            },
        )
        .unwrap();
        let recovered: Value = serde_json::from_str(&restored.content).unwrap();
        assert_eq!(recovered["states"][0]["name"], "idle");
        assert_eq!(recovered["states"][1]["name"], "idle_new");
    }

    #[test]
    fn refuses_existing_target_and_duplicate_state_without_mutation() {
        let fixture = Fixture::new();
        let request = fixture.request();
        fs::write(fixture.folder().join("idle_new.png"), b"external").unwrap();
        assert_eq!(
            rename(&fixture.root, &request).unwrap_err().code,
            "RSI_RENAME_TARGET_EXISTS"
        );
        assert_eq!(
            fs::read(fixture.folder().join("idle_new.png")).unwrap(),
            b"external"
        );
        assert!(!fixture.folder().join(".ss14-studio-archive").exists());

        let fixture = Fixture::new();
        let mut request = fixture.request();
        request.new_name = "other".into();
        assert_eq!(
            rename(&fixture.root, &request).unwrap_err().code,
            "RSI_RENAME_STATE_EXISTS"
        );
        assert!(!fixture.folder().join(".ss14-studio-archive").exists());
    }

    #[test]
    fn refuses_stale_metadata_png_and_bad_names_without_mutation() {
        let fixture = Fixture::new();
        let mut request = fixture.request();
        request.new_name = "../escape".into();
        assert_eq!(
            rename(&fixture.root, &request).unwrap_err().code,
            "RSI_RENAME_NAME_INVALID"
        );
        request.new_name = "idle".into();
        assert_eq!(
            rename(&fixture.root, &request).unwrap_err().code,
            "RSI_RENAME_NO_CHANGE"
        );

        request.new_name = "idle_new".into();
        fs::write(fixture.folder().join("idle.png"), b"changed externally").unwrap();
        assert_eq!(
            rename(&fixture.root, &request).unwrap_err().code,
            "RSI_RENAME_PNG_CONFLICT"
        );
        assert!(!fixture.folder().join(".ss14-studio-archive").exists());

        let fixture = Fixture::new();
        let request = fixture.request();
        fs::write(fixture.folder().join("meta.json"), b"external").unwrap();
        assert_eq!(
            rename(&fixture.root, &request).unwrap_err().code,
            "RSI_RENAME_META_CONFLICT"
        );
        assert!(!fixture.folder().join(".ss14-studio-archive").exists());
    }

    #[test]
    fn metadata_only_rename_preserves_metadata_and_archives_without_png() {
        let fixture = Fixture::new();
        let mut request = fixture.request();
        fs::remove_file(fixture.folder().join("idle.png")).unwrap();
        request.expected_png_revision = None;
        request.expected_missing_png = true;
        let renamed = rename(&fixture.root, &request).unwrap();
        let doc: Value = serde_json::from_str(&renamed.content).unwrap();
        assert_eq!(doc["states"][0]["name"], "idle_new");
        assert_eq!(doc["states"][0]["customState"], "keep");
        assert_eq!(doc["custom"]["preserve"], true);
        assert!(!fixture.folder().join("idle.png").exists());
        assert!(!fixture.folder().join("idle_new.png").exists());
        let archive = fixture.root.join(&renamed.archive_path);
        assert!(archive.join("meta.json.before").exists());
        assert!(!archive.join("idle.png").exists());
        assert!(renamed.warning.is_some());
        let manifest: Value = serde_json::from_slice(&fs::read(archive.join("manifest.json")).unwrap()).unwrap();
        assert!(manifest["recovery"].as_str().unwrap().contains("do not replace meta.json wholesale"));
        let listed = rsi_restore::list(&fixture.root, &fixture.path).unwrap();
        assert_eq!(listed.archives.len(), 1);
        assert!(!listed.archives[0].automatic_restore);
        let error = rsi_restore::restore(&fixture.root, &RsiRestoreRequest {
            path: fixture.path.clone(), expected_revision: renamed.revision,
            archive_id: listed.archives[0].id.clone(),
        }).unwrap_err();
        assert_eq!(error.code, "RSI_RESTORE_MANUAL_REQUIRED");
        assert!(error.details.unwrap().contains(&listed.archives[0].id));
    }

    #[test]
    fn metadata_only_rejects_source_destination_stale_and_contradictory_requests() {
        let fixture = Fixture::new();
        let mut request = fixture.request();
        request.expected_missing_png = true;
        assert_eq!(rename(&fixture.root, &request).unwrap_err().code, "RSI_RENAME_REVISION_INVALID");
        request.expected_png_revision = None;
        assert_eq!(rename(&fixture.root, &request).unwrap_err().code, "RSI_RENAME_TARGET_EXISTS");
        fs::remove_file(fixture.folder().join("idle.png")).unwrap();
        fs::write(fixture.folder().join("idle_new.png"), b"orphan").unwrap();
        assert_eq!(rename(&fixture.root, &request).unwrap_err().code, "RSI_RENAME_TARGET_EXISTS");
        assert_eq!(fs::read(fixture.folder().join("idle_new.png")).unwrap(), b"orphan");
        fs::remove_file(fixture.folder().join("idle_new.png")).unwrap();
        fs::write(fixture.folder().join("meta.json"), b"external").unwrap();
        assert_eq!(rename(&fixture.root, &request).unwrap_err().code, "RSI_RENAME_META_CONFLICT");
    }

    #[cfg(unix)]
    #[test]
    fn metadata_only_rejects_dangling_symlinks_at_both_paths() {
        use std::os::unix::fs::symlink;
        let fixture = Fixture::new();
        let mut request = fixture.request();
        request.expected_png_revision = None;
        request.expected_missing_png = true;
        fs::remove_file(fixture.folder().join("idle.png")).unwrap();
        symlink("missing", fixture.folder().join("idle.png")).unwrap();
        assert_eq!(rename(&fixture.root, &request).unwrap_err().code, "RSI_RENAME_TARGET_EXISTS");
        fs::remove_file(fixture.folder().join("idle.png")).unwrap();
        symlink("missing", fixture.folder().join("idle_new.png")).unwrap();
        assert_eq!(rename(&fixture.root, &request).unwrap_err().code, "RSI_RENAME_TARGET_EXISTS");
    }

    #[cfg(unix)]
    #[test]
    fn rejects_target_symlink_and_path_symlinks() {
        use std::os::unix::fs::symlink;
        let fixture = Fixture::new();
        let request = fixture.request();
        symlink("missing.png", fixture.folder().join("idle_new.png")).unwrap();
        assert_eq!(
            rename(&fixture.root, &request).unwrap_err().code,
            "RSI_RENAME_TARGET_EXISTS"
        );
        assert!(!fixture.folder().join(".ss14-studio-archive").exists());
    }
}

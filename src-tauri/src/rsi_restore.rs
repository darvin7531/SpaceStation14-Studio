//! Restore an archived RSI state without replacing existing files.
//! Archive snapshots are retained; failed metadata publication may leave a PNG.
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::StudioError;
use crate::resource_edit::{self, revision};
use crate::rsi_import::{bounded_metadata, safe_import_directory};

const ARCHIVE_DIR: &str = ".ss14-studio-archive";
const FORMAT: &str = "ss14-studio-rsi-delete-backup-v1";
const MAX_ARCHIVES: usize = 512;
const MAX_MANIFEST_BYTES: u64 = 16 * 1024;
const MAX_PNG_BYTES: u64 = 8 * 1024 * 1024;
const MAX_METADATA_BYTES: usize = 4 * 1024 * 1024;
const MAX_STATES: usize = 512;

#[derive(Debug, Deserialize)]
pub struct RsiRestoreRequest {
    pub path: String,
    pub expected_revision: String,
    pub archive_id: String,
}

#[derive(Debug, Serialize)]
pub struct RsiArchive {
    pub id: String,
    pub state: String,
}

#[derive(Debug, Serialize)]
pub struct RsiArchiveList {
    pub archives: Vec<RsiArchive>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct RestoredRsiState {
    pub name: String,
    pub content: String,
    pub revision: String,
    pub archive_path: String,
    pub warning: Option<String>,
}

#[derive(Debug, Deserialize)]
struct Manifest {
    format: String,
    rsi: String,
    state: String,
    original_meta_revision: String,
    original_png_revision: String,
}

fn issue(code: &'static str, message: &str, hint: &str) -> StudioError {
    StudioError::new(code, message, hint)
}

fn valid_state(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && name.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'_' | b'-')
        })
}

fn valid_archive_id(id: &str) -> bool {
    id.starts_with("deleted-")
        && id.len() <= 200
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn valid_sha(revision: &str) -> bool {
    revision.len() == 64 && revision.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn read_regular(path: &Path, max_bytes: u64, kind: &'static str) -> Result<Vec<u8>, StudioError> {
    let stat = fs::symlink_metadata(path).map_err(|error| {
        issue(
            "RSI_RESTORE_ARCHIVE_MISSING",
            "Не удалось открыть файл резервной копии.",
            "Проверьте, что архив не был перемещён или удалён.",
        )
        .with_details(format!("{kind}: {error}"))
    })?;
    if stat.file_type().is_symlink() || !stat.is_file() || stat.len() > max_bytes {
        return Err(issue(
            "RSI_RESTORE_ARCHIVE_UNSAFE",
            "Архив содержит ссылку, не-файл или слишком большой файл.",
            "Используйте архив, созданный Studio, без изменения его содержимого.",
        ));
    }
    let mut bytes = Vec::new();
    fs::File::open(path)
        .and_then(|file| file.take(max_bytes + 1).read_to_end(&mut bytes))
        .map_err(|error| {
            issue(
                "RSI_RESTORE_ARCHIVE_READ_FAILED",
                "Не удалось прочитать содержимое архива.",
                "Проверьте права на файлы.",
            )
            .with_details(format!("{kind}: {error}"))
        })?;
    if bytes.len() as u64 > max_bytes {
        return Err(issue(
            "RSI_RESTORE_ARCHIVE_UNSAFE",
            "Файл резервной копии вырос во время чтения.",
            "Повторите после окончания внешней записи.",
        ));
    }
    Ok(bytes)
}

fn archive_root(folder: &Path, required: bool) -> Result<Option<PathBuf>, StudioError> {
    let root = folder.join(ARCHIVE_DIR);
    let stat = match fs::symlink_metadata(&root) {
        Ok(stat) => stat,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound && !required => return Ok(None),
        Err(error) => {
            return Err(issue(
                "RSI_RESTORE_ARCHIVE_MISSING",
                "Каталог резервных копий недоступен.",
                "Проверьте архив внутри каталога RSI.",
            )
            .with_details(error.to_string()))
        }
    };
    if stat.file_type().is_symlink() || !stat.is_dir() {
        return Err(issue(
            "RSI_RESTORE_ARCHIVE_UNSAFE",
            "Каталог архива является ссылкой либо не является папкой.",
            "Для восстановления нужна обычная директория архивов.",
        ));
    }
    Ok(Some(root))
}

fn read_manifest(
    archive: &Path,
    rsi_path: &str,
    archive_id: &str,
) -> Result<Manifest, StudioError> {
    let content = read_regular(
        &archive.join("manifest.json"),
        MAX_MANIFEST_BYTES,
        "manifest.json",
    )?;
    let manifest: Manifest = serde_json::from_slice(&content).map_err(|error| {
        issue(
            "RSI_RESTORE_MANIFEST_INVALID",
            "Манифест архива повреждён.",
            "Проверьте manifest.json.",
        )
        .with_details(error.to_string())
    })?;
    if manifest.format != FORMAT
        || manifest.rsi != rsi_path
        || !valid_state(&manifest.state)
        || !archive_id.starts_with(&format!("deleted-{}-", manifest.state))
        || !valid_sha(&manifest.original_meta_revision)
        || !valid_sha(&manifest.original_png_revision)
    {
        return Err(issue(
            "RSI_RESTORE_MANIFEST_INVALID",
            "Манифест архива не соответствует выбранному RSI или состоянию.",
            "Выберите архив исходного спрайта, созданный Studio.",
        ));
    }
    Ok(manifest)
}

fn archive_path(
    folder: &Path,
    rsi_path: &str,
    id: &str,
) -> Result<(PathBuf, Manifest), StudioError> {
    if !valid_archive_id(id) {
        return Err(issue(
            "RSI_RESTORE_ID_INVALID",
            "Недопустимый идентификатор архива.",
            "Выберите архив из списка Studio.",
        ));
    }
    let root = archive_root(folder, true)?.ok_or_else(|| {
        issue(
            "RSI_RESTORE_ARCHIVE_MISSING",
            "Архивы отсутствуют.",
            "Проверьте папку RSI.",
        )
    })?;
    let archive = root.join(id);
    let stat = fs::symlink_metadata(&archive).map_err(|error| {
        issue(
            "RSI_RESTORE_ARCHIVE_MISSING",
            "Выбранный архив отсутствует.",
            "Обновите список архивов.",
        )
        .with_details(error.to_string())
    })?;
    if stat.file_type().is_symlink() || !stat.is_dir() {
        return Err(issue(
            "RSI_RESTORE_ARCHIVE_UNSAFE",
            "Архив не является обычным каталогом.",
            "Проверьте содержимое архивной папки.",
        ));
    }
    let manifest = read_manifest(&archive, rsi_path, id)?;
    Ok((archive, manifest))
}

pub fn list(root: &Path, rsi_path: &str) -> Result<RsiArchiveList, StudioError> {
    let folder = safe_import_directory(root, rsi_path)?;
    let Some(archive_root) = archive_root(&folder, false)? else {
        return Ok(RsiArchiveList {
            archives: Vec::new(),
            warnings: Vec::new(),
        });
    };
    let entries = fs::read_dir(archive_root).map_err(|error| {
        issue(
            "RSI_RESTORE_LIST_FAILED",
            "Не удалось прочитать архивы.",
            "Проверьте права каталога.",
        )
        .with_details(error.to_string())
    })?;
    let mut archives = Vec::new();
    let mut warnings = Vec::new();
    for (index, entry) in entries.enumerate() {
        if index >= MAX_ARCHIVES {
            warnings.push("Показаны только первые 512 записей архива.".into());
            break;
        }
        let entry = entry.map_err(|error| {
            issue(
                "RSI_RESTORE_LIST_FAILED",
                "Ошибка чтения архивов.",
                "Проверьте папку.",
            )
            .with_details(error.to_string())
        })?;
        let id = entry.file_name().to_string_lossy().into_owned();
        if !valid_archive_id(&id) {
            continue;
        }
        let kind = entry.file_type().map_err(|error| {
            issue(
                "RSI_RESTORE_LIST_FAILED",
                "Не удалось проверить архив.",
                "Проверьте права.",
            )
            .with_details(error.to_string())
        })?;
        if !kind.is_dir() || kind.is_symlink() {
            warnings.push(format!("Пропущен небезопасный архив: {id}"));
            continue;
        }
        match read_manifest(&entry.path(), rsi_path, &id) {
            Ok(manifest) => archives.push(RsiArchive {
                id,
                state: manifest.state,
            }),
            Err(_) => warnings.push(format!("Пропущен неполный архив: {id}")),
        }
    }
    archives.sort_unstable_by(|a, b| a.id.cmp(&b.id));
    Ok(RsiArchiveList { archives, warnings })
}

fn restored_metadata(current: &[u8], original: &[u8], name: &str) -> Result<String, StudioError> {
    let mut current_meta: Value = serde_json::from_slice(current).map_err(|error| {
        issue(
            "RSI_RESTORE_META_INVALID",
            "Текущий meta.json некорректен.",
            "Исправьте JSON.",
        )
        .with_details(error.to_string())
    })?;
    let backup_meta: Value = serde_json::from_slice(original).map_err(|error| {
        issue(
            "RSI_RESTORE_ARCHIVE_INVALID",
            "Архивный meta.json некорректен.",
            "Проверьте архив.",
        )
        .with_details(error.to_string())
    })?;
    if current_meta.get("version").and_then(Value::as_u64) != Some(1)
        || backup_meta.get("version").and_then(Value::as_u64) != Some(1)
        || current_meta.get("size") != backup_meta.get("size")
    {
        return Err(issue(
            "RSI_RESTORE_FORMAT_CHANGED",
            "Версия или размеры кадров RSI изменились после удаления состояния.",
            "Используйте прежние размеры и формат, либо восстановите вручную после проверки.",
        ));
    }
    let original_states = backup_meta
        .get("states")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            issue(
                "RSI_RESTORE_ARCHIVE_INVALID",
                "Архив не содержит states.",
                "Проверьте meta.json.before.",
            )
        })?;
    let matches = original_states
        .iter()
        .enumerate()
        .filter(|(_, state)| state.get("name").and_then(Value::as_str) == Some(name))
        .collect::<Vec<_>>();
    let (position, restored_state) = match matches.as_slice() {
        [(position, state)] => (*position, (**state).clone()),
        _ => {
            return Err(issue(
                "RSI_RESTORE_ARCHIVE_INVALID",
                "Архив не содержит единственного определения выбранного состояния.",
                "Проверьте целостность архивного meta.json.",
            ))
        }
    };

    let states = current_meta
        .get_mut("states")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| {
            issue(
                "RSI_RESTORE_META_INVALID",
                "В текущем RSI отсутствует states.",
                "Проверьте meta.json.",
            )
        })?;
    if states.len() >= MAX_STATES {
        return Err(issue(
            "RSI_RESTORE_STATES_LIMIT",
            "Слишком много состояний RSI.",
            "Уменьшите их количество.",
        ));
    }
    if states
        .iter()
        .any(|state| state.get("name").and_then(Value::as_str) == Some(name))
    {
        return Err(issue(
            "RSI_RESTORE_STATE_EXISTS",
            "Состояние уже существует, архив не будет применён.",
            "Выберите другое состояние либо сначала сохраните текущие изменения.",
        ));
    }
    states.insert(position.min(states.len()), restored_state);
    let result = serde_json::to_string_pretty(&current_meta).map_err(|error| {
        issue(
            "RSI_RESTORE_META_INVALID",
            "Не удалось сформировать новые метаданные.",
            "Проверьте JSON.",
        )
        .with_details(error.to_string())
    })? + "\n";
    if result.len() > MAX_METADATA_BYTES {
        return Err(issue(
            "RSI_RESTORE_META_TOO_LARGE",
            "Метаданные после восстановления превышают лимит.",
            "Уменьшите размер meta.json.",
        ));
    }
    Ok(result)
}

#[cfg(unix)]
fn sync_directory(path: &Path) -> std::io::Result<()> {
    fs::File::open(path)?.sync_all()
}
#[cfg(not(unix))]
fn sync_directory(_path: &Path) -> std::io::Result<()> {
    Ok(())
}

/// Stages only a new PNG; never replaces existing PNG or archive files.
/// After successful commit it updates only meta.json, retaining the archive.
pub fn restore(root: &Path, request: &RsiRestoreRequest) -> Result<RestoredRsiState, StudioError> {
    restore_with_save(root, request, |root, path, revision, updated| {
        resource_edit::save_rsi_metadata(root, path, revision, updated)
    })
}

fn restore_with_save(
    root: &Path,
    request: &RsiRestoreRequest,
    save: impl FnOnce(&Path, &str, &str, String) -> Result<resource_edit::SaveResult, StudioError>,
) -> Result<RestoredRsiState, StudioError> {
    if !valid_sha(&request.expected_revision) {
        return Err(issue(
            "RSI_RESTORE_REVISION_INVALID",
            "Неверная ревизия meta.json.",
            "Обновите RSI перед восстановлением.",
        ));
    }
    let folder = safe_import_directory(root, &request.path)?;
    let (archive, manifest) = archive_path(&folder, &request.path, &request.archive_id)?;
    let metadata_path = folder.join("meta.json");
    let current = bounded_metadata(&metadata_path)?;
    if revision(&current) != request.expected_revision {
        return Err(issue(
            "RSI_RESTORE_CONFLICT",
            "meta.json изменился после открытия.",
            "Обновите RSI и повторите восстановление.",
        ));
    }
    let original = read_regular(
        &archive.join("meta.json.before"),
        MAX_METADATA_BYTES as u64,
        "meta.json.before",
    )?;
    let png = read_regular(
        &archive.join(format!("{}.png", manifest.state)),
        MAX_PNG_BYTES,
        "PNG",
    )?;
    if revision(&original) != manifest.original_meta_revision
        || revision(&png) != manifest.original_png_revision
    {
        return Err(issue(
            "RSI_RESTORE_ARCHIVE_CORRUPTED",
            "Контрольные суммы архивных файлов не совпадают с манифестом.",
            "Не изменяйте архивные файлы. Восстановление остановлено.",
        ));
    }
    let updated = restored_metadata(&current, &original, &manifest.state)?;
    let png_path = folder.join(format!("{}.png", manifest.state));
    // symlink_metadata catches dangling symlinks, unlike Path::exists().
    match fs::symlink_metadata(&png_path) {
        Ok(_) => {
            return Err(issue(
                "RSI_RESTORE_PNG_EXISTS",
                "PNG этого состояния уже присутствует и не будет перезаписан.",
                "Проверьте файл перед восстановлением.",
            ))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(issue(
                "RSI_RESTORE_PNG_CHECK_FAILED",
                "Невозможно проверить имя нового PNG.",
                "Проверьте права каталога.",
            )
            .with_details(error.to_string()))
        }
    }
    let mut new_png = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&png_path)
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::AlreadyExists {
                issue(
                    "RSI_RESTORE_PNG_EXISTS",
                    "PNG появился во время восстановления.",
                    "Обновите RSI.",
                )
            } else {
                issue(
                    "RSI_RESTORE_PNG_WRITE_FAILED",
                    "Невозможно создать PNG.",
                    "Проверьте свободное место и права.",
                )
                .with_details(error.to_string())
            }
        })?;
    let write_result = new_png.write_all(&png).and_then(|_| new_png.sync_all());
    drop(new_png);
    let metadata_result = write_result
        .map_err(|error| {
            issue(
                "RSI_RESTORE_PNG_WRITE_FAILED",
                "Не удалось записать PNG.",
                "Проверьте свободное место и права.",
            )
            .with_details(error.to_string())
        })
        .and_then(|_| {
            // Catch accidental metadata writes before publishing new metadata.
            if revision(&bounded_metadata(&metadata_path)?) != request.expected_revision {
                return Err(issue(
                    "RSI_RESTORE_CONFLICT",
                    "meta.json изменился в процессе восстановления.",
                    "Обновите RSI перед повторной попыткой.",
                ));
            }
            save(
                root,
                &format!("{}/meta.json", request.path),
                &request.expected_revision,
                updated,
            )
        });
    let result = match metadata_result {
        Ok(result) => result,
        Err(failure) => {
            // ponytail: leave the pathname untouched; unlink is not conditional on
            // inode identity. Manual cleanup is required after a failed restore.
            return Err(issue(
                "RSI_RESTORE_CLEANUP_FAILED",
                "Восстановление прервано; PNG может остаться в каталоге.",
                "Проверьте PNG вручную перед повторным восстановлением; архив сохранён.",
            )
            .with_details(format!("Ошибка: {failure:?}; PNG: {}; архив: {}", png_path.display(), archive.display())));

        }
    };
    let mut warnings = Vec::new();
    if let Some(warning) = result.durability_warning {
        warnings.push(warning);
    }
    if let Err(error) = sync_directory(&folder) {
        warnings.push(format!(
            "Синхронизация каталога после восстановления не подтверждена: {error}"
        ));
    }
    let archive_path = archive
        .strip_prefix(root)
        .unwrap_or(&archive)
        .to_string_lossy()
        .replace('\\', "/");
    Ok(RestoredRsiState {
        name: manifest.state,
        content: result.document.content,
        revision: result.document.revision,
        archive_path,
        warning: (!warnings.is_empty()).then(|| warnings.join(" ")),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rsi_delete::{delete, RsiDeleteRequest};
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);

    struct Fixture {
        root: PathBuf,
        path: String,
    }
    impl Fixture {
        fn new() -> Self {
            let id = NEXT.fetch_add(1, Ordering::Relaxed);
            let root =
                std::env::temp_dir().join(format!("ss14-rsi-restore-{}-{id}", std::process::id()));
            fs::create_dir_all(root.join("Resources/Textures/test.rsi")).unwrap();
            let root = fs::canonicalize(root).unwrap();
            let path = "Resources/Textures/test.rsi".into();
            fs::write(root.join(&path).join("meta.json"),
                r#"{"version":1,"size":{"x":1,"y":1},"custom":{"original":true},"states":[{"name":"idle","directions":1,"custom":"keep"},{"name":"walk","directions":1}]}"#).unwrap();
            fs::write(root.join(&path).join("idle.png"), b"original PNG").unwrap();
            fs::write(root.join(&path).join("walk.png"), b"unrelated PNG").unwrap();
            Self { root, path }
        }
        fn archive(&self) -> (String, String) {
            let revision =
                revision(&fs::read(self.root.join(&self.path).join("meta.json")).unwrap());
            let removed = delete(
                &self.root,
                &RsiDeleteRequest {
                    path: self.path.clone(),
                    expected_revision: revision,
                    name: "idle".into(),
                },
            )
            .unwrap();
            let id = Path::new(&removed.archive_path)
                .file_name()
                .unwrap()
                .to_string_lossy()
                .into_owned();
            (id, removed.revision)
        }
        fn request(&self, id: String, revision: String) -> RsiRestoreRequest {
            RsiRestoreRequest {
                path: self.path.clone(),
                archive_id: id,
                expected_revision: revision,
            }
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn failed_save_preserves_a_concurrently_replaced_png() {
        let fixture = Fixture::new();
        let (id, revision) = fixture.archive();
        let png = fixture.root.join(&fixture.path).join("idle.png");
        let replacement = fixture.root.join(&fixture.path).join("external.png");
        fs::write(&replacement, b"external PNG").unwrap();
        let error = restore_with_save(&fixture.root, &fixture.request(id.clone(), revision), |_, _, _, _| {
            fs::rename(&replacement, &png).unwrap();
            Err(issue("INJECTED", "save failed", "retry").with_details("disk failure"))
        }).unwrap_err();
        assert_eq!(fs::read(&png).unwrap(), b"external PNG");
        let details = error.details.unwrap();
        assert!(details.contains("disk failure"));
        assert!(details.contains(&id));
        assert!(fixture.root.join(&fixture.path).join(ARCHIVE_DIR).join(id).join("idle.png").exists());
    }

    #[test]
    fn lists_restores_and_keeps_backup_without_touching_other_states() {
        let fixture = Fixture::new();
        assert!(list(&fixture.root, &fixture.path)
            .unwrap()
            .archives
            .is_empty());
        let (id, current_revision) = fixture.archive();
        let found = list(&fixture.root, &fixture.path).unwrap();
        assert_eq!(found.archives.len(), 1);
        assert_eq!(found.archives[0].state, "idle");
        assert_eq!(found.archives[0].id, id);
        let restored = restore(&fixture.root, &fixture.request(id, current_revision)).unwrap();
        let meta: Value = serde_json::from_str(&restored.content).unwrap();
        assert_eq!(meta["states"][0]["name"], "idle");
        assert_eq!(meta["states"][0]["custom"], "keep");
        assert_eq!(meta["states"][1]["name"], "walk");
        assert_eq!(
            fs::read(fixture.root.join(&fixture.path).join("idle.png")).unwrap(),
            b"original PNG"
        );
        assert_eq!(
            fs::read(fixture.root.join(&fixture.path).join("walk.png")).unwrap(),
            b"unrelated PNG"
        );
        assert!(fixture
            .root
            .join(restored.archive_path)
            .join("manifest.json")
            .exists());
    }

    #[test]
    fn stale_metadata_and_existing_png_are_not_overwritten() {
        let fixture = Fixture::new();
        let (id, old_revision) = fixture.archive();
        fs::write(
            fixture.root.join(&fixture.path).join("meta.json"),
            b"external",
        )
        .unwrap();
        assert_eq!(
            restore(&fixture.root, &fixture.request(id.clone(), old_revision))
                .unwrap_err()
                .code,
            "RSI_RESTORE_CONFLICT"
        );
        assert!(!fixture.root.join(&fixture.path).join("idle.png").exists());

        let fixture = Fixture::new();
        let (id, revision) = fixture.archive();
        fs::write(
            fixture.root.join(&fixture.path).join("idle.png"),
            b"other user's file",
        )
        .unwrap();
        assert_eq!(
            restore(&fixture.root, &fixture.request(id, revision))
                .unwrap_err()
                .code,
            "RSI_RESTORE_PNG_EXISTS"
        );
        assert_eq!(
            fs::read(fixture.root.join(&fixture.path).join("idle.png")).unwrap(),
            b"other user's file"
        );
    }

    #[test]
    fn preserves_changes_made_after_deletion() {
        let fixture = Fixture::new();
        let (id, _) = fixture.archive();
        let meta_path = fixture.root.join(&fixture.path).join("meta.json");
        let mut meta: Value = serde_json::from_slice(&fs::read(&meta_path).unwrap()).unwrap();
        meta["new"] = Value::Bool(true);
        meta["states"]
            .as_array_mut()
            .unwrap()
            .push(serde_json::json!({"name":"new","directions":1}));
        fs::write(&meta_path, serde_json::to_vec(&meta).unwrap()).unwrap();
        let current_revision = revision(&fs::read(&meta_path).unwrap());
        let result = restore(&fixture.root, &fixture.request(id, current_revision)).unwrap();
        let restored: Value = serde_json::from_str(&result.content).unwrap();
        assert_eq!(restored["new"], true);
        assert_eq!(restored["states"].as_array().unwrap().len(), 3);
        assert_eq!(restored["states"][2]["name"], "new");
    }

    #[test]
    fn refuses_tampered_archived_files_and_traversal() {
        let fixture = Fixture::new();
        let (id, current_revision) = fixture.archive();
        let archive = fixture.root.join(&fixture.path).join(ARCHIVE_DIR).join(&id);
        fs::write(archive.join("idle.png"), b"tampered").unwrap();
        assert_eq!(
            restore(
                &fixture.root,
                &fixture.request(id.clone(), current_revision.clone())
            )
            .unwrap_err()
            .code,
            "RSI_RESTORE_ARCHIVE_CORRUPTED"
        );
        assert!(!fixture.root.join(&fixture.path).join("idle.png").exists());

        let bad = fixture.request("../elsewhere".into(), current_revision);
        assert_eq!(
            restore(&fixture.root, &bad).unwrap_err().code,
            "RSI_RESTORE_ID_INVALID"
        );
    }

    #[test]
    fn refuses_existing_state_even_with_fresh_revision() {
        let fixture = Fixture::new();
        let (id, _) = fixture.archive();
        let meta_path = fixture.root.join(&fixture.path).join("meta.json");
        let mut meta: Value = serde_json::from_slice(&fs::read(&meta_path).unwrap()).unwrap();
        meta["states"]
            .as_array_mut()
            .unwrap()
            .push(serde_json::json!({"name":"idle","directions":1}));
        fs::write(&meta_path, serde_json::to_vec(&meta).unwrap()).unwrap();
        let rev = revision(&fs::read(&meta_path).unwrap());
        assert_eq!(
            restore(&fixture.root, &fixture.request(id, rev))
                .unwrap_err()
                .code,
            "RSI_RESTORE_STATE_EXISTS"
        );
    }

    #[test]
    fn refuses_incompatible_current_size_and_archive_symlinks() {
        let fixture = Fixture::new();
        let (id, _) = fixture.archive();
        let meta_path = fixture.root.join(&fixture.path).join("meta.json");
        let mut meta: Value = serde_json::from_slice(&fs::read(&meta_path).unwrap()).unwrap();
        meta["size"]["x"] = Value::from(2);
        fs::write(&meta_path, serde_json::to_vec(&meta).unwrap()).unwrap();
        let rev = revision(&fs::read(&meta_path).unwrap());
        assert_eq!(
            restore(&fixture.root, &fixture.request(id, rev))
                .unwrap_err()
                .code,
            "RSI_RESTORE_FORMAT_CHANGED"
        );

        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            let fixture = Fixture::new();
            let (id, current) = fixture.archive();
            let archive = fixture.root.join(&fixture.path).join(ARCHIVE_DIR).join(&id);
            fs::remove_file(archive.join("idle.png")).unwrap();
            symlink(
                fixture.root.join(&fixture.path).join("walk.png"),
                archive.join("idle.png"),
            )
            .unwrap();
            assert_eq!(
                restore(&fixture.root, &fixture.request(id, current))
                    .unwrap_err()
                    .code,
                "RSI_RESTORE_ARCHIVE_UNSAFE"
            );
        }
    }
}

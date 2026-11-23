//! Replace an existing RSI state PNG and its frame grid without losing the old version.
//! The old state is archived first; failed imports attempt a guarded restore.
use std::fs;
use std::path::Path;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde_json::Value;

use crate::error::StudioError;
use crate::resource_edit::revision;
use crate::rsi_delete::{self, RsiDeleteRequest};
use crate::rsi_import::{
    self, bounded_metadata, safe_import_directory, ImportedRsiState, RsiStateImport,
};
use crate::rsi_restore::{self, RsiRestoreRequest};

fn issue(code: &'static str, message: &str, hint: &str) -> StudioError {
    StudioError::new(code, message, hint)
}

fn valid_sha(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

/// Validate both the metadata and old PNG snapshots before the first mutation.
/// Returns the original state index so replacement preserves metadata ordering.
fn prevalidate(root: &Path, request: &RsiStateImport) -> Result<(usize, Value), StudioError> {
    rsi_import::validate_request(request)?;
    let expected_png = request.expected_png_revision.as_deref().ok_or_else(|| {
        issue(
            "RSI_REPLACE_PNG_REVISION_MISSING",
            "Не задана исходная ревизия PNG.",
            "Перечитайте PNG в предпросмотре и повторите замену.",
        )
    })?;
    if !valid_sha(expected_png) {
        return Err(issue(
            "RSI_REPLACE_PNG_REVISION_INVALID",
            "Ревизия PNG имеет некорректный формат.",
            "Обновите предпросмотр RSI.",
        ));
    }

    let folder = safe_import_directory(root, &request.path)?;
    let metadata = bounded_metadata(&folder.join("meta.json"))?;
    if revision(&metadata) != request.expected_revision {
        return Err(issue(
            "RSI_REPLACE_META_CONFLICT",
            "meta.json изменился после открытия RSI.",
            "Обновите ресурс перед заменой PNG.",
        ));
    }

    let mut base: Value = serde_json::from_slice(&metadata).map_err(|error| {
        issue(
            "RSI_REPLACE_META_INVALID",
            "meta.json содержит некорректный JSON.",
            "Исправьте метаданные перед заменой.",
        )
        .with_details(error.to_string())
    })?;
    let states = base
        .get_mut("states")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| {
            issue(
                "RSI_REPLACE_META_INVALID",
                "В meta.json отсутствует массив states.",
                "Проверьте структуру RSI.",
            )
        })?;
    let matches: Vec<usize> = states
        .iter()
        .enumerate()
        .filter_map(|(index, state)| {
            (state.get("name").and_then(Value::as_str) == Some(request.name.as_str()))
                .then_some(index)
        })
        .collect();
    let original_index = match matches.as_slice() {
        [index] => *index,
        [] => {
            return Err(issue(
                "RSI_REPLACE_STATE_NOT_FOUND",
                "Состояние для замены отсутствует в meta.json.",
                "Обновите список состояний RSI.",
            ))
        }
        _ => {
            return Err(issue(
                "RSI_REPLACE_STATE_AMBIGUOUS",
                "Имя состояния повторяется в meta.json.",
                "Исправьте дубликаты перед заменой PNG.",
            ))
        }
    };
    let preserved_state = states.remove(original_index);
    let base_bytes = serde_json::to_vec(&base).map_err(|error| {
        issue(
            "RSI_REPLACE_META_INVALID",
            "Не удалось подготовить проверочную копию meta.json.",
            "Проверьте структуру метаданных.",
        )
        .with_details(error.to_string())
    })?;

    let encoded = request
        .data_url
        .strip_prefix("data:image/png;base64,")
        .ok_or_else(|| {
            issue(
                "RSI_REPLACE_PNG_INVALID",
                "Новое изображение не является PNG Data URL.",
                "Выберите корректный PNG-лист.",
            )
        })?;
    let new_png = STANDARD.decode(encoded).map_err(|error| {
        issue(
            "RSI_REPLACE_PNG_INVALID",
            "Не удалось декодировать новый PNG.",
            "Выберите PNG повторно.",
        )
        .with_details(error.to_string())
    })?;
    // This checks RSI v1 metadata, frame-grid dimensions, PNG chunks and CRC,
    // as well as the preserved insertion point, without touching disk.
    rsi_import::updated_metadata_at(
        &base_bytes,
        request,
        Some(&new_png),
        Some(original_index),
        Some(&preserved_state),
    )?;

    let old_png = rsi_delete::read_png(&folder.join(format!("{}.png", request.name)))?;
    if revision(&old_png) != expected_png {
        return Err(issue(
            "RSI_REPLACE_PNG_CONFLICT",
            "Исходный PNG изменился после предпросмотра и не будет перезаписан.",
            "Обновите предпросмотр RSI и повторите замену.",
        ));
    }
    Ok((original_index, preserved_state))
}

fn recovery_error(
    failure: &StudioError,
    rollback: Option<&StudioError>,
    archive_path: &str,
) -> StudioError {
    match rollback {
        Some(rollback) => issue(
            "RSI_REPLACE_RECOVERY_REQUIRED",
            "Замена не завершена, и автоматическое восстановление не удалось. Оригинал сохранён в архиве.",
            "Не удаляйте каталог резервной копии. Проверьте текущий PNG и восстановите архив после устранения конфликта.",
        )
        .with_details(format!(
            "Ошибка замены: {} [{}]. Ошибка восстановления: {} [{}]. Архив: {}",
            failure.message, failure.code, rollback.message, rollback.code, archive_path
        )),
        None => issue(
            "RSI_REPLACE_ROLLED_BACK",
            "Новая PNG не установлена. Исходное состояние восстановлено из архива.",
            "Перечитайте RSI после отката и повторите замену. Резервная копия исходной версии сохранена.",
        )
        .with_details(format!(
            "Причина замены: {} [{}]. Архив: {}",
            failure.message, failure.code, archive_path
        )),
    }
}

pub fn replace(root: &Path, request: &RsiStateImport) -> Result<ImportedRsiState, StudioError> {
    let (original_index, preserved_state) = prevalidate(root, request)?;
    let expected_png = request.expected_png_revision.as_deref().ok_or_else(|| {
        issue(
            "RSI_REPLACE_PNG_REVISION_MISSING",
            "Не задана исходная ревизия PNG.",
            "Обновите предпросмотр RSI.",
        )
    })?;
    let deleted = rsi_delete::delete_checked(
        root,
        &RsiDeleteRequest {
            path: request.path.clone(),
            expected_revision: request.expected_revision.clone(),
            name: request.name.clone(),
        },
        Some(expected_png),
    )?;

    let folder = safe_import_directory(root, &request.path)?;
    let target = folder.join(format!("{}.png", request.name));
    match fs::symlink_metadata(&target) {
        Ok(_) => {
            return Err(issue(
                "RSI_REPLACE_RECOVERY_REQUIRED",
                "Старый PNG остался в каталоге после архивирования; новый файл не записан.",
                "Не удаляйте архив. Проверьте файл и переместите его вручную, затем восстановите исходное состояние из резервной копии.",
            )
            .with_details(format!("Архив исходной версии: {}", deleted.archive_path)));
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(issue(
                "RSI_REPLACE_RECOVERY_REQUIRED",
                "Не удалось проверить каталог после архивирования исходного PNG.",
                "Не удаляйте резервную копию; проверьте каталог RSI.",
            )
            .with_details(format!(
                "{}; архив исходной версии: {}",
                error, deleted.archive_path
            )));
        }
    }

    let archive_id = Path::new(&deleted.archive_path)
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| {
            issue(
                "RSI_REPLACE_ARCHIVE_INVALID",
                "Не удалось определить ID резервной копии.",
                "Исходные файлы сохранены в каталоге архива; не удаляйте его.",
            )
        })?;
    let mut import_request = request.clone();
    import_request.expected_revision = deleted.revision.clone();
    import_request.expected_png_revision = None;

    match rsi_import::import_at(
        root,
        &import_request,
        Some(original_index),
        Some(preserved_state),
    ) {
        Ok(mut imported) => {
            let mut warnings = Vec::new();
            if let Some(warning) = deleted.warning {
                warnings.push(warning);
            }
            if let Some(warning) = imported.warning.take() {
                warnings.push(warning);
            }
            imported.archive_path = Some(deleted.archive_path);
            imported.warning = (!warnings.is_empty()).then(|| warnings.join(" "));
            Ok(imported)
        }
        Err(failure) => {
            let restore_request = RsiRestoreRequest {
                path: request.path.clone(),
                expected_revision: deleted.revision,
                archive_id: archive_id.to_owned(),
            };
            let rollback = rsi_restore::restore(root, &restore_request).err();
            Err(recovery_error(
                &failure,
                rollback.as_ref(),
                &deleted.archive_path,
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rsi_delete::{delete, RsiDeleteRequest};
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT: AtomicU64 = AtomicU64::new(0);
    const NEW_PNG: &str = "iVBORw0KGgoAAAANSUhEUgAAAAQAAAABCAYAAAD5PA/NAAAAFElEQVR4nGP4z8DwHwwZ/gMBw38AQ80I+GhaO24AAAAASUVORK5CYII=";
    const ONE_PIXEL_PNG: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";

    struct Fixture {
        root: PathBuf,
        path: String,
        old_png: Vec<u8>,
    }

    impl Fixture {
        fn new() -> Self {
            let id = NEXT.fetch_add(1, Ordering::Relaxed);
            let root =
                std::env::temp_dir().join(format!("ss14-rsi-replace-{}-{id}", std::process::id()));
            let path = "Resources/Textures/sample.rsi".to_string();
            let folder = root.join(&path);
            fs::create_dir_all(&folder).unwrap();
            fs::write(
                folder.join("meta.json"),
                r#"{"version":1,"size":{"x":1,"y":1},"license":"CC0","custom":{"keep":true},"states":[{"name":"idle","directions":1,"delays":[[0.25]],"customState":"preserve"},{"name":"other"}]}"#,
            )
            .unwrap();
            let old_png = b"original-idle-png".to_vec();
            fs::write(folder.join("idle.png"), &old_png).unwrap();
            fs::write(folder.join("other.png"), b"other-state-unchanged").unwrap();
            Self {
                root,
                path,
                old_png,
            }
        }

        fn request(&self) -> RsiStateImport {
            let folder = self.root.join(&self.path);
            let metadata = fs::read(folder.join("meta.json")).unwrap();
            RsiStateImport {
                path: self.path.clone(),
                expected_revision: revision(&metadata),
                name: "idle".into(),
                directions: 4,
                frames_per_direction: 1,
                delay_seconds: 0.2,
                data_url: format!("data:image/png;base64,{NEW_PNG}"),
                expected_png_revision: Some(revision(&self.old_png)),
                delays: None,
            }
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn replacement_rebuilds_grid_preserves_order_and_keeps_a_restorable_backup() {
        let fixture = Fixture::new();
        let request = fixture.request();
        let replaced = replace(&fixture.root, &request).unwrap();
        assert_eq!(replaced.name, "idle");
        assert!(replaced.archive_path.is_some());
        let metadata: Value = serde_json::from_str(&replaced.content).unwrap();
        assert_eq!(metadata["custom"]["keep"], true);
        assert_eq!(metadata["states"][0]["name"], "idle");
        assert_eq!(metadata["states"][0]["directions"], 4);
        assert_eq!(metadata["states"][0]["delays"].as_array().unwrap().len(), 4);
        assert_eq!(metadata["states"][0]["customState"], "preserve");
        assert_eq!(metadata["states"][1]["name"], "other");
        assert_eq!(
            fs::read(fixture.root.join(&fixture.path).join("other.png")).unwrap(),
            b"other-state-unchanged"
        );
        let new_png = STANDARD.decode(NEW_PNG).unwrap();
        assert_eq!(
            fs::read(fixture.root.join(&fixture.path).join("idle.png")).unwrap(),
            new_png
        );

        let old_archive_id = Path::new(replaced.archive_path.as_deref().unwrap())
            .file_name()
            .unwrap()
            .to_str()
            .unwrap()
            .to_owned();
        let deleted_new = delete(
            &fixture.root,
            &RsiDeleteRequest {
                path: fixture.path.clone(),
                expected_revision: replaced.revision.clone(),
                name: "idle".into(),
            },
        )
        .unwrap();
        let restored = rsi_restore::restore(
            &fixture.root,
            &RsiRestoreRequest {
                path: fixture.path.clone(),
                expected_revision: deleted_new.revision,
                archive_id: old_archive_id,
            },
        )
        .unwrap();
        assert_eq!(restored.name, "idle");
        assert_eq!(
            fs::read(fixture.root.join(&fixture.path).join("idle.png")).unwrap(),
            fixture.old_png
        );
        let restored_meta: Value = serde_json::from_str(&restored.content).unwrap();
        assert_eq!(
            restored_meta["states"]
                .as_array()
                .unwrap()
                .iter()
                .find(|state| state["name"] == "idle")
                .unwrap()["directions"],
            1
        );
        assert_eq!(
            restored_meta["states"]
                .as_array()
                .unwrap()
                .iter()
                .find(|state| state["name"] == "idle")
                .unwrap()["customState"],
            "preserve"
        );
    }

    #[test]
    fn replacement_preserves_per_frame_delays_when_the_grid_is_unchanged() {
        let fixture = Fixture::new();
        let mut request = fixture.request();
        request.directions = 1;
        request.frames_per_direction = 1;
        request.data_url = format!("data:image/png;base64,{ONE_PIXEL_PNG}");
        request.delays = Some(vec![vec![0.25]]);

        let replaced = replace(&fixture.root, &request).unwrap();
        let metadata: Value = serde_json::from_str(&replaced.content).unwrap();
        assert_eq!(metadata["states"][0]["delays"][0][0], 0.25);
        assert_eq!(metadata["states"][0]["customState"], "preserve");
    }

    #[test]
    fn stale_png_or_invalid_new_image_is_rejected_before_archiving() {
        let fixture = Fixture::new();
        let mut request = fixture.request();
        fs::write(
            fixture.root.join(&fixture.path).join("idle.png"),
            b"external change",
        )
        .unwrap();
        assert_eq!(
            replace(&fixture.root, &request).unwrap_err().code,
            "RSI_REPLACE_PNG_CONFLICT"
        );
        let metadata_path = fixture.root.join(&fixture.path).join("meta.json");
        let metadata_before = fs::read(&metadata_path).unwrap();
        assert!(metadata_before.windows(4).any(|window| window == b"idle"));
        assert_eq!(
            fs::read(fixture.root.join(&fixture.path).join("idle.png")).unwrap(),
            b"external change"
        );
        assert!(!fixture
            .root
            .join(&fixture.path)
            .join(".ss14-studio-archive")
            .exists());

        let fixture = Fixture::new();
        request = fixture.request();
        request.data_url = "data:image/png;base64,bm90LXBuZw==".into();
        assert!(replace(&fixture.root, &request).is_err());
        assert_eq!(
            fs::read(fixture.root.join(&fixture.path).join("idle.png")).unwrap(),
            fixture.old_png
        );
        assert!(!fixture
            .root
            .join(&fixture.path)
            .join(".ss14-studio-archive")
            .exists());
    }
}

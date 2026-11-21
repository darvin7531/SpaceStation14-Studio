//! Edit RSI attribution without touching sprite sheets, frame grids, or unknown JSON fields.
use serde::Deserialize;
use serde_json::Value;
use std::path::Path;

use crate::error::StudioError;
use crate::resource_edit::{self, revision};
use crate::rsi_import::{bounded_metadata, safe_import_directory, ImportedRsiState};

#[derive(Debug, Deserialize)]
pub struct RsiCreditsUpdate {
    pub path: String,
    pub expected_revision: String,
    pub license: String,
    pub copyright: String,
}

fn issue(code: &'static str, message: &str, hint: &str) -> StudioError {
    StudioError::new(code, message, hint)
}

fn checked_content(
    original: &[u8],
    update: &RsiCreditsUpdate,
) -> Result<Option<String>, StudioError> {
    if update.license.len() > 128
        || update.license.chars().any(char::is_control)
        || update.copyright.len() > 8192
        || update.copyright.contains('\0')
    {
        return Err(issue(
            "RSI_CREDITS_INVALID",
            "Лицензия или поле авторства содержит недопустимые символы либо превышает лимит.",
            "Ограничьте лицензию 128 байтами, а авторство 8 КиБ. Управляющие символы в лицензии запрещены.",
        ));
    }
    let mut doc: Value = serde_json::from_slice(original).map_err(|error| {
        issue(
            "RSI_CREDITS_META_INVALID",
            "meta.json содержит повреждённый JSON.",
            "Исправьте метаданные перед редактированием атрибуции.",
        )
        .with_details(error.to_string())
    })?;
    if doc.get("version").and_then(Value::as_u64) != Some(1)
        || !doc.get("size").is_some_and(Value::is_object)
        || !doc.get("states").is_some_and(Value::is_array)
    {
        return Err(issue(
            "RSI_CREDITS_FORMAT_UNSUPPORTED",
            "Для редактирования атрибуции необходим корректный RSI v1.",
            "Проверьте version, size и states в meta.json.",
        ));
    }
    let object = doc.as_object_mut().ok_or_else(|| {
        issue(
            "RSI_CREDITS_META_INVALID",
            "Корень meta.json должен быть объектом.",
            "Исправьте метаданные перед редактированием.",
        )
    })?;
    let current_license = object.get("license").and_then(Value::as_str);
    let current_copyright = object.get("copyright").and_then(Value::as_str);
    if object.get("license").is_some_and(|v| !v.is_string())
        || object.get("copyright").is_some_and(|v| !v.is_string())
    {
        return Err(issue(
            "RSI_CREDITS_META_INVALID",
            "license и copyright в meta.json должны быть строками.",
            "Проверьте структуру метаданных.",
        ));
    }
    // Keep absent empty fields absent, so a no-op never changes formatting.
    if current_license.unwrap_or("") == update.license
        && current_copyright.unwrap_or("") == update.copyright
    {
        return Ok(None);
    }
    object.insert("license".into(), Value::String(update.license.clone()));
    object.insert("copyright".into(), Value::String(update.copyright.clone()));
    let content = serde_json::to_string_pretty(&doc).map_err(|error| {
        issue(
            "RSI_CREDITS_SERIALIZE_FAILED",
            "Не удалось сериализовать метаданные RSI.",
            "Проверьте состояние файла и повторите.",
        )
        .with_details(error.to_string())
    })? + "\n";
    Ok(Some(content))
}

pub fn update(root: &Path, request: &RsiCreditsUpdate) -> Result<ImportedRsiState, StudioError> {
    if request.expected_revision.len() != 64
        || !request
            .expected_revision
            .bytes()
            .all(|value| value.is_ascii_hexdigit())
    {
        return Err(issue(
            "RSI_CREDITS_REVISION_INVALID",
            "Ревизия meta.json не задана либо некорректна.",
            "Перечитайте RSI перед сохранением метаданных.",
        ));
    }
    let folder = safe_import_directory(root, &request.path)?;
    let original = bounded_metadata(&folder.join("meta.json"))?;
    if revision(&original) != request.expected_revision {
        return Err(issue(
            "RSI_CREDITS_CONFLICT",
            "meta.json изменился после открытия RSI.",
            "Обновите спрайт перед повторным сохранением.",
        ));
    }
    let Some(content) = checked_content(&original, request)? else {
        return Ok(ImportedRsiState {
            name: "meta.json".into(),
            content: String::from_utf8(original).map_err(|error| {
                issue(
                    "RSI_CREDITS_META_INVALID",
                    "meta.json не является UTF-8.",
                    "Исправьте кодировку файла.",
                )
                .with_details(error.to_string())
            })?,
            revision: request.expected_revision.clone(),
            warning: None,
        });
    };
    let result = resource_edit::save_rsi_metadata(
        root,
        &format!("{}/meta.json", request.path),
        &request.expected_revision,
        content,
    )?;
    Ok(ImportedRsiState {
        name: "meta.json".into(),
        content: result.document.content,
        revision: result.document.revision,
        warning: result.durability_warning,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
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
                std::env::temp_dir().join(format!("ss14-rsi-credits-{}-{id}", std::process::id()));
            let path = "Resources/Textures/sample.rsi".to_string();
            let folder = root.join(&path);
            fs::create_dir_all(&folder).unwrap();
            fs::write(
                folder.join("meta.json"),
                r#"{"version":1,"size":{"x":32,"y":32},"license":"Old","copyright":"Before","states":[{"name":"idle","directions":1}],"custom":{"preserve":true}}"#,
            )
            .unwrap();
            fs::write(folder.join("idle.png"), b"png unchanged").unwrap();
            Self { root, path }
        }

        fn request(&self) -> RsiCreditsUpdate {
            RsiCreditsUpdate {
                path: self.path.clone(),
                expected_revision: revision(
                    &fs::read(self.root.join(&self.path).join("meta.json")).unwrap(),
                ),
                license: "CC-BY-SA-3.0".into(),
                copyright: "Artist".into(),
            }
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn edits_attribution_without_changing_states_png_or_unknown_fields() {
        let fixture = Fixture::new();
        let result = update(&fixture.root, &fixture.request()).unwrap();
        let json: Value = serde_json::from_str(&result.content).unwrap();
        assert_eq!(json["license"], "CC-BY-SA-3.0");
        assert_eq!(json["copyright"], "Artist");
        assert_eq!(json["custom"]["preserve"], true);
        assert_eq!(json["states"][0]["name"], "idle");
        assert_eq!(
            fs::read(fixture.root.join(&fixture.path).join("idle.png")).unwrap(),
            b"png unchanged"
        );
    }

    #[test]
    fn unchanged_values_do_not_reformat_source() {
        let fixture = Fixture::new();
        let mut request = fixture.request();
        request.license = "Old".into();
        request.copyright = "Before".into();
        let original =
            fs::read_to_string(fixture.root.join(&fixture.path).join("meta.json")).unwrap();
        let result = update(&fixture.root, &request).unwrap();
        assert_eq!(result.content, original);
        assert_eq!(result.revision, request.expected_revision);
    }

    #[test]
    fn external_change_refuses_overwrite() {
        let fixture = Fixture::new();
        let request = fixture.request();
        let file = fixture.root.join(&fixture.path).join("meta.json");
        fs::write(
            &file,
            r#"{"version":1,"size":{},"states":[],"external":true}"#,
        )
        .unwrap();
        let error = update(&fixture.root, &request).unwrap_err();
        assert_eq!(error.code, "RSI_CREDITS_CONFLICT");
        assert!(fs::read_to_string(file).unwrap().contains("external"));
    }

    #[test]
    fn invalid_metadata_and_inputs_do_not_change_file() {
        let fixture = Fixture::new();
        let file = fixture.root.join(&fixture.path).join("meta.json");
        let before = fs::read(&file).unwrap();
        let mut request = fixture.request();
        request.license = "\ninvalid".into();
        assert_eq!(
            update(&fixture.root, &request).unwrap_err().code,
            "RSI_CREDITS_INVALID"
        );
        assert_eq!(fs::read(&file).unwrap(), before);
        request.license = "Normal".into();
        fs::write(&file, r#"{"version":2,"size":{},"states":[]}"#).unwrap();
        request.expected_revision = revision(&fs::read(&file).unwrap());
        assert_eq!(
            update(&fixture.root, &request).unwrap_err().code,
            "RSI_CREDITS_FORMAT_UNSUPPORTED"
        );
    }
}

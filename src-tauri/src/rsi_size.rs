//! Electron RSI-editor parity: edit frame size while preserving existing PNGs.
//! Every declared state sheet must remain a valid whole-cell grid. No PNG is
//! ever modified, and changes to meta.json use the conflict-safe atomic writer.
use std::fs;
use std::io::Read;
use std::path::Path;

use serde::Deserialize;
use serde_json::{json, Value};

use crate::error::StudioError;
use crate::resource_edit::{self, revision};
use crate::rsi_import::{bounded_metadata, safe_import_directory, ImportedRsiState};
use crate::rsi_preview::png_dimensions;

const MAX_PNG_BYTES: u64 = 8 * 1024 * 1024;
const MAX_STATES: usize = 512;

#[derive(Debug, Deserialize)]
pub struct RsiSizeUpdate {
    pub path: String,
    pub expected_revision: String,
    pub size_x: u32,
    pub size_y: u32,
}

fn issue(code: &'static str, message: &str, hint: &str) -> StudioError {
    StudioError::new(code, message, hint)
}

fn count_frames(state: &Value) -> Result<usize, StudioError> {
    let directions = match state.get("directions") {
        None => 1,
        Some(value) => value.as_u64().unwrap_or(0),
    };
    if !matches!(directions, 1 | 4 | 8) {
        return Err(issue(
            "RSI_SIZE_DIRECTIONS_INVALID",
            "В meta.json обнаружено состояние с некорректным количеством направлений.",
            "Исправьте метаданные или перестройте PNG через редактор состояний.",
        ));
    }
    let frames = match state.get("delays") {
        None => directions as usize,
        Some(value) => {
            let delays = value.as_array().ok_or_else(|| {
                issue(
                    "RSI_SIZE_DELAYS_INVALID",
                    "У состояния неверный формат задержек.",
                    "Исправьте метаданные перед изменением размера кадра.",
                )
            })?;
            if delays.len() != directions as usize {
                return Err(issue(
                    "RSI_SIZE_DELAYS_INVALID",
                    "Количество массивов delays не совпадает с направлениями.",
                    "Проверьте кадры и направления состояния.",
                ));
            }
            let mut total = 0_usize;
            for values in delays {
                let row = values.as_array().ok_or_else(|| {
                    issue(
                        "RSI_SIZE_DELAYS_INVALID",
                        "delays должен содержать массивы длительностей.",
                        "Исправьте метаданные RSI.",
                    )
                })?;
                if row.is_empty()
                    || row.iter().any(|value| {
                        !value
                            .as_f64()
                            .is_some_and(|number| number.is_finite() && number > 0.0)
                    })
                {
                    return Err(issue(
                        "RSI_SIZE_DELAYS_INVALID",
                        "Состояние содержит пустой или некорректный список задержек.",
                        "Исправьте задержки перед изменением размера.",
                    ));
                }
                total = total.saturating_add(row.len());
            }
            total
        }
    };
    if frames == 0 || frames > 256 {
        return Err(issue(
            "RSI_SIZE_FRAMES_LIMIT",
            "У состояния слишком много кадров для безопасного пересчёта сетки.",
            "Используйте максимум 256 кадров на состояние.",
        ));
    }
    Ok(frames)
}

fn validate_sheets(folder: &Path, doc: &Value, request: &RsiSizeUpdate) -> Result<(), StudioError> {
    let states = doc.get("states").and_then(Value::as_array).ok_or_else(|| {
        issue(
            "RSI_SIZE_META_INVALID",
            "В meta.json отсутствует массив states.",
            "Проверьте структуру RSI v1.",
        )
    })?;
    if states.len() > MAX_STATES {
        return Err(issue(
            "RSI_SIZE_STATES_LIMIT",
            "Слишком много состояний в meta.json.",
            "Используйте не более 512 состояний.",
        ));
    }
    let mut names = std::collections::HashSet::new();
    for state in states {
        let name = state.get("name").and_then(Value::as_str).ok_or_else(|| {
            issue(
                "RSI_SIZE_STATE_INVALID",
                "У состояния нет корректного имени.",
                "Исправьте записи states в meta.json.",
            )
        })?;
        if name.is_empty()
            || name.len() > 128
            || !name.bytes().all(|byte| {
                byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'_' | b'-')
            })
            || !names.insert(name)
        {
            return Err(issue(
                "RSI_SIZE_STATE_INVALID",
                "Имя состояния недопустимо или повторяется.",
                "Исправьте дубли и имена до изменения размеров.",
            ));
        }
        let frames = count_frames(state)?;
        let file = folder.join(format!("{name}.png"));
        let meta = fs::symlink_metadata(&file).map_err(|reason| {
            issue(
                "RSI_SIZE_PNG_MISSING",
                "PNG выбранного состояния отсутствует.",
                "Восстановите PNG либо удалите некорректное состояние перед изменением размера.",
            )
            .with_details(format!("{name}: {reason}"))
        })?;
        if meta.file_type().is_symlink() || !meta.is_file() || meta.len() > MAX_PNG_BYTES {
            return Err(issue(
                "RSI_SIZE_PNG_INVALID",
                "PNG состояния является ссылкой, файлом неподдерживаемого размера или каталогом.",
                "Используйте обычный PNG не более 8 МиБ.",
            ));
        }
        let mut header = Vec::new();
        fs::File::open(&file)
            .and_then(|opened| opened.take(32).read_to_end(&mut header))
            .map_err(|reason| {
                issue(
                    "RSI_SIZE_PNG_READ_FAILED",
                    "Невозможно прочитать заголовок PNG.",
                    "Проверьте права доступа к изображению.",
                )
                .with_details(reason.to_string())
            })?;
        let (width, height) = png_dimensions(&header)?;
        if width % request.size_x != 0 || height % request.size_y != 0 {
            return Err(issue(
                "RSI_SIZE_GRID_INVALID",
                "Размер PNG не кратен новому размеру кадра.",
                "Укажите размер, который точно делит ширину и высоту всех PNG состояний.",
            )
            .with_details(format!("{name}.png: {width}×{height}")));
        }
        let cells = u64::from(width / request.size_x) * u64::from(height / request.size_y);
        if cells != frames as u64 {
            return Err(issue(
                "RSI_SIZE_FRAME_COUNT_MISMATCH",
                "Новый размер кадра меняет количество кадров в состоянии.",
                "Нужна перестройка PNG и delays; одна смена размера метаданных недопустима.",
            )
            .with_details(format!(
                "{name}.png: {cells} ячеек, {frames} кадров в meta.json"
            )));
        }
    }
    Ok(())
}

fn checked_content(
    folder: &Path,
    source: &[u8],
    request: &RsiSizeUpdate,
) -> Result<Option<String>, StudioError> {
    if !(1..=2048).contains(&request.size_x) || !(1..=2048).contains(&request.size_y) {
        return Err(issue(
            "RSI_SIZE_INVALID",
            "Размер кадра RSI должен быть от 1 до 2048 пикселей.",
            "Укажите положительные целые значения ширины и высоты.",
        ));
    }
    let mut doc: Value = serde_json::from_slice(source).map_err(|reason| {
        issue(
            "RSI_SIZE_META_INVALID",
            "meta.json содержит некорректный JSON.",
            "Исправьте метаданные перед изменением размера.",
        )
        .with_details(reason.to_string())
    })?;
    if doc.get("version").and_then(Value::as_u64) != Some(1)
        || !doc.get("size").is_some_and(Value::is_object)
    {
        return Err(issue(
            "RSI_SIZE_FORMAT_UNSUPPORTED",
            "Изменение размера поддерживается только для RSI v1.",
            "Проверьте поля version и size в meta.json.",
        ));
    }
    let old_x = doc["size"]["x"].as_u64();
    let old_y = doc["size"]["y"].as_u64();
    if old_x == Some(request.size_x as u64) && old_y == Some(request.size_y as u64) {
        return Ok(None);
    }
    validate_sheets(folder, &doc, request)?;
    let size = doc
        .get_mut("size")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| {
            issue(
                "RSI_SIZE_META_INVALID",
                "size должен быть объектом.",
                "Исправьте meta.json.",
            )
        })?;
    size.insert("x".into(), json!(request.size_x));
    size.insert("y".into(), json!(request.size_y));
    let content = serde_json::to_string_pretty(&doc).map_err(|reason| {
        issue(
            "RSI_SIZE_SERIALIZE_FAILED",
            "Невозможно сформировать изменённый meta.json.",
            "Проверьте права и повторите сохранение.",
        )
        .with_details(reason.to_string())
    })? + "\n";
    Ok(Some(content))
}

pub fn update(root: &Path, request: &RsiSizeUpdate) -> Result<ImportedRsiState, StudioError> {
    if request.expected_revision.len() != 64
        || !request
            .expected_revision
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(issue(
            "RSI_SIZE_REVISION_INVALID",
            "Ревизия meta.json некорректна.",
            "Перечитайте RSI перед сохранением.",
        ));
    }
    let folder = safe_import_directory(root, &request.path)?;
    let original = bounded_metadata(&folder.join("meta.json"))?;
    if revision(&original) != request.expected_revision {
        return Err(issue(
            "RSI_SIZE_CONFLICT",
            "meta.json изменился после открытия RSI.",
            "Обновите RSI и повторите действие.",
        ));
    }
    let Some(content) = checked_content(&folder, &original, request)? else {
        return Ok(ImportedRsiState {
            name: "meta.json".into(),
            content: String::from_utf8(original).map_err(|reason| {
                issue(
                    "RSI_SIZE_META_INVALID",
                    "meta.json не является UTF-8.",
                    "Исправьте кодировку файла.",
                )
                .with_details(reason.to_string())
            })?,
            revision: request.expected_revision.clone(),
            warning: None,
            archive_path: None,
        });
    };
    let saved = resource_edit::save_rsi_metadata(
        root,
        &format!("{}/meta.json", request.path),
        &request.expected_revision,
        content,
    )?;
    Ok(ImportedRsiState {
        name: "meta.json".into(),
        content: saved.document.content,
        revision: saved.document.revision,
        warning: saved.durability_warning,
        archive_path: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT: AtomicU64 = AtomicU64::new(0);

    struct Fixture {
        root: std::path::PathBuf,
        relative: String,
    }

    impl Fixture {
        fn new() -> Self {
            let id = NEXT.fetch_add(1, Ordering::Relaxed);
            let root =
                std::env::temp_dir().join(format!("ss14-rsi-size-{}-{id}", std::process::id()));
            let relative = "Resources/Textures/sample.rsi".to_string();
            let folder = root.join(&relative);
            fs::create_dir_all(&folder).unwrap();
            fs::write(
                folder.join("meta.json"),
                r#"{"version":1,"size":{"x":32,"y":32,"other":"keep"},"states":[{"name":"idle","directions":1,"delays":[[0.2,0.3]]}],"custom":{"keep":true}}"#,
            ).unwrap();
            let mut png = vec![0_u8; 32];
            png[0..8].copy_from_slice(b"\x89PNG\r\n\x1a\n");
            png[8..12].copy_from_slice(&13_u32.to_be_bytes());
            png[12..16].copy_from_slice(b"IHDR");
            png[16..20].copy_from_slice(&32_u32.to_be_bytes());
            png[20..24].copy_from_slice(&64_u32.to_be_bytes());
            fs::write(folder.join("idle.png"), png).unwrap();
            Self { root, relative }
        }

        fn request(&self) -> RsiSizeUpdate {
            RsiSizeUpdate {
                path: self.relative.clone(),
                expected_revision: revision(
                    &fs::read(self.root.join(&self.relative).join("meta.json")).unwrap(),
                ),
                size_x: 16,
                size_y: 64,
            }
        }

        fn file(&self) -> std::path::PathBuf {
            self.root.join(&self.relative).join("meta.json")
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn changes_only_frame_size_preserving_unknown_fields_and_png_bytes() {
        let fixture = Fixture::new();
        let png = fs::read(fixture.root.join(&fixture.relative).join("idle.png")).unwrap();
        let changed = update(&fixture.root, &fixture.request()).unwrap();
        let updated: Value = serde_json::from_str(&changed.content).unwrap();
        assert_eq!(updated["size"]["x"], 16);
        assert_eq!(updated["size"]["y"], 64);
        assert_eq!(updated["size"]["other"], "keep");
        assert_eq!(updated["custom"]["keep"], true);
        assert_eq!(updated["states"][0]["delays"][0][1], 0.3);
        assert_eq!(
            fs::read(fixture.root.join(&fixture.relative).join("idle.png")).unwrap(),
            png
        );
        assert_eq!(fs::read_to_string(fixture.file()).unwrap(), changed.content);
    }

    #[test]
    fn no_op_and_revision_conflict_never_rewrite_metadata() {
        let fixture = Fixture::new();
        let before = fs::read(&fixture.file()).unwrap();
        let mut same = fixture.request();
        same.size_x = 32;
        same.size_y = 32;
        let result = update(&fixture.root, &same).unwrap();
        assert_eq!(result.revision, same.expected_revision);
        assert_eq!(fs::read(&fixture.file()).unwrap(), before);
        fs::write(fixture.file(), b"external update").unwrap();
        assert_eq!(
            update(&fixture.root, &fixture.request()).unwrap_err().code,
            "RSI_SIZE_CONFLICT"
        );
    }

    #[test]
    fn rejects_non_divisible_sheets_and_frame_count_changes() {
        let fixture = Fixture::new();
        let before = fs::read(&fixture.file()).unwrap();
        let mut request = fixture.request();
        request.size_x = 31;
        assert_eq!(
            update(&fixture.root, &request).unwrap_err().code,
            "RSI_SIZE_GRID_INVALID"
        );
        request.size_x = 16;
        request.size_y = 16;
        assert_eq!(
            update(&fixture.root, &request).unwrap_err().code,
            "RSI_SIZE_FRAME_COUNT_MISMATCH"
        );
        assert_eq!(fs::read(&fixture.file()).unwrap(), before);
    }

    #[test]
    fn rejects_invalid_frame_size_and_missing_png_before_write() {
        let fixture = Fixture::new();
        let mut request = fixture.request();
        request.size_x = 0;
        assert_eq!(
            update(&fixture.root, &request).unwrap_err().code,
            "RSI_SIZE_INVALID"
        );
        request.size_x = 16;
        fs::remove_file(fixture.root.join(&fixture.relative).join("idle.png")).unwrap();
        assert_eq!(
            update(&fixture.root, &request).unwrap_err().code,
            "RSI_SIZE_PNG_MISSING"
        );
    }
}

//! Conservative timing-only edits to existing RSI v1 states.
//! This never modifies PNGs or changes the number/order of frames.
use std::path::Path;
use serde::Deserialize;
use serde_json::Value;

use crate::error::StudioError;
use crate::resource_edit::{self, revision};
use crate::rsi_import::{bounded_metadata, safe_import_directory, ImportedRsiState};

const MAX_DIRECTIONS: usize = 8;
const MAX_FRAMES_PER_DIRECTION: usize = 128;
const MAX_TOTAL_FRAMES: usize = 256;
const MAX_DELAY_SECONDS: f64 = 60.0;
const MIN_DELAY_SECONDS: f64 = 0.01;

#[derive(Debug, Deserialize)]
pub struct RsiTimingUpdate {
    pub path: String,
    pub expected_revision: String,
    pub name: String,
    pub delays: Vec<Vec<f64>>,
}

fn issue(code: &'static str, message: &str, hint: &str) -> StudioError {
    StudioError::new(code, message, hint)
}

fn validated_delays(delays: &[Vec<f64>]) -> Result<(), StudioError> {
    if delays.is_empty() || delays.len() > MAX_DIRECTIONS {
        return Err(issue(
            "RSI_TIMING_SHAPE_INVALID",
            "Количество направлений выходит за допустимые пределы.",
            "Выберите состояние с 1, 4 или 8 направлениями.",
        ));
    }
    let mut total = 0_usize;
    for values in delays {
        total = total.saturating_add(values.len());
        if values.is_empty() || values.len() > MAX_FRAMES_PER_DIRECTION
            || values.iter().any(|value| !value.is_finite()
                || !(MIN_DELAY_SECONDS..=MAX_DELAY_SECONDS).contains(value))
        {
            return Err(issue(
                "RSI_TIMING_VALUE_INVALID",
                "Задана недопустимая длительность либо число кадров.",
                "Длительности должны быть конечными числами от 0.01 до 60 секунд; максимум 128 кадров на направление.",
            ));
        }
    }
    if total > MAX_TOTAL_FRAMES {
        return Err(issue(
            "RSI_TIMING_FRAMES_LIMIT",
            "Количество кадров превышает лимит 256.",
            "Редактируйте анимацию во внешнем редакторе.",
        ));
    }
    Ok(())
}

fn updated_metadata(original: &[u8], update: &RsiTimingUpdate) -> Result<Option<String>, StudioError> {
    validated_delays(&update.delays)?;
    let mut doc: Value = serde_json::from_slice(original).map_err(|error| {
        issue(
            "RSI_TIMING_META_INVALID",
            "meta.json содержит повреждённый JSON.",
            "Исправьте файл или восстановите его из резервной копии.",
        ).with_details(error.to_string())
    })?;
    if doc.get("version").and_then(Value::as_u64) != Some(1) {
        return Err(issue(
            "RSI_TIMING_VERSION_UNSUPPORTED",
            "Редактирование поддерживается только для RSI v1.",
            "Откройте ресурс с поддерживаемой версией meta.json.",
        ));
    }
    let states = doc.get_mut("states")
        .and_then(Value::as_array_mut).ok_or_else(|| {
            issue("RSI_TIMING_META_INVALID", "В meta.json отсутствует массив states.", "Проверьте структуру RSI.")
        })?;
    let matches: Vec<usize> = states.iter().enumerate()
        .filter(|(_, state)| state.get("name").and_then(Value::as_str) == Some(update.name.as_str()))
        .map(|(index, _)| index)
        .collect();
    let index = match matches.as_slice() {
        [index] => *index,
        [] => return Err(issue(
            "RSI_TIMING_STATE_NOT_FOUND",
            "Выбранное состояние отсутствует в meta.json.",
            "Обновите список состояний.",
        )),
        _ => return Err(issue(
            "RSI_TIMING_STATE_AMBIGUOUS",
            "В meta.json повторяется имя выбранного состояния.",
            "Исправьте дублированные записи вручную перед редактированием.",
        )),
    };
    let state = &mut states[index];
    let directions = match state.get("directions") {
        None => 1,
        Some(value) => value.as_u64().ok_or_else(|| {
            issue(
                "RSI_TIMING_META_INVALID",
                "В выбранном состоянии directions должен быть целым числом.",
                "Исправьте meta.json перед редактированием.",
            )
        })?,
    };
    if !matches!(directions, 1 | 4 | 8)
        || update.delays.len() != directions as usize
    {
        return Err(issue(
            "RSI_TIMING_SHAPE_INVALID",
            "Число направлений не совпадает с исходным состоянием.",
            "Редактирование направлений и числа кадров требует безопасной перестройки PNG, которая пока не поддерживается.",
        ));
    }

    let old_delays: Vec<Vec<f64>> = match state.get("delays") {
        None => vec![vec![1.0]; directions as usize],
        Some(value) => {
            let values: Vec<Vec<f64>> = serde_json::from_value(value.clone())
                .map_err(|_| issue(
                    "RSI_TIMING_META_INVALID",
                    "В выбранном состоянии некорректный массив delays.",
                    "Исправьте metadata вручную перед изменением длительности.",
                ))?;
            if values.len() != directions as usize
                || values.iter().any(|values| values.is_empty())
            {
                return Err(issue(
                    "RSI_TIMING_META_INVALID",
                    "В выбранном состоянии число массивов delays не совпадает с направлениями.",
                    "Проверьте метаданные RSI.",
                ));
            }
            values
        }
    };

    if old_delays.iter().map(Vec::len).collect::<Vec<_>>()
        != update.delays.iter().map(Vec::len).collect::<Vec<_>>()
    {
        return Err(issue(
            "RSI_TIMING_FRAME_COUNT_CHANGED",
            "Число кадров нельзя менять в редакторе длительностей.",
            "Изменение количества кадров требует изменения PNG-листа.",
        ));
    }
    if old_delays == update.delays {
        return Ok(None);
    }

    let state_object = state.as_object_mut().ok_or_else(|| {
        issue("RSI_TIMING_META_INVALID", "Состояние не является JSON-объектом.", "Исправьте meta.json.")
    })?;
    state_object.insert("delays".into(), serde_json::to_value(&update.delays).map_err(|e| {
        issue("RSI_TIMING_SERIALIZE_FAILED", "Не удалось сформировать delays.", "Проверьте значения.").with_details(e.to_string())
    })?);
    let content = serde_json::to_string_pretty(&doc).map_err(|e| {
        issue("RSI_TIMING_SERIALIZE_FAILED", "Не удалось сформировать meta.json.", "Проверьте JSON.").with_details(e.to_string())
    })? + "\n";
    Ok(Some(content))
}

/// Keep metadata source conflict-aware and PNG bytes untouched.
/// save_ftl is a generic byte-preserving text writer with two revision
/// checks, temp file, fsync, and atomic same-directory rename.
pub fn update(root: &Path, request: &RsiTimingUpdate) -> Result<ImportedRsiState, StudioError> {
    if request.expected_revision.len() != 64
        || !request.expected_revision.bytes().all(|value| value.is_ascii_hexdigit())
    {
        return Err(issue(
            "RSI_TIMING_REVISION_INVALID",
            "Устаревшая или некорректная ревизия meta.json.",
            "Перечитайте открытый RSI с диска.",
        ));
    }
    if request.name.is_empty() || request.name.len() > 128 {
        return Err(issue("RSI_TIMING_NAME_INVALID", "Некорректное имя состояния.", "Выберите состояние из списка."));
    }
    let folder = safe_import_directory(root, &request.path)?;
    let metadata_file = folder.join("meta.json");
    let original = bounded_metadata(&metadata_file)?;
    if revision(&original) != request.expected_revision {
        return Err(issue(
            "RSI_TIMING_CONFLICT",
            "meta.json был изменён другим процессом.",
            "Обновите RSI и повторите изменение длительности.",
        ));
    }
    let Some(content) = updated_metadata(&original, request)? else {
        return Ok(ImportedRsiState {
            name: request.name.clone(),
            revision: revision(&original),
            content: String::from_utf8(original).map_err(|error| {
                issue("RSI_TIMING_META_INVALID", "meta.json не является UTF-8.", "Проверьте файл.")
                    .with_details(error.to_string())
            })?,
            warning: None,
        });
    };
    let result = resource_edit::save_ftl(
        root,
        &format!("{}/meta.json", request.path),
        &request.expected_revision,
        content,
    )?;
    Ok(ImportedRsiState {
        name: request.name.clone(),
        revision: result.document.revision,
        content: result.document.content,
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

    struct Fixture { root: PathBuf, relative: String }
    impl Fixture {
        fn new() -> Self {
            let id = NEXT.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!("ss14-rsi-timing-{}-{id}", std::process::id()));
            fs::create_dir_all(path.join("Resources/Textures/animal.rsi")).unwrap();
            let root = fs::canonicalize(path).unwrap();
            let relative = "Resources/Textures/animal.rsi".to_string();
            fs::write(root.join(&relative).join("meta.json"),
                r#"{"version":1,"size":{"x":32,"y":32},"license":"CC0","custom":{"keep":true},"states":[{"name":"walk","directions":4,"delays":[[0.1,0.2],[0.3,0.4],[0.5,0.6],[0.7,0.8]],"customState":"safe"},{"name":"idle","directions":1}]}"#).unwrap();
            fs::write(root.join(&relative).join("walk.png"), b"unchanged PNG").unwrap();
            Self { root, relative }
        }
        fn request(&self) -> RsiTimingUpdate {
            let original = fs::read(self.root.join(&self.relative).join("meta.json")).unwrap();
            RsiTimingUpdate {
                path: self.relative.clone(),
                expected_revision: revision(&original),
                name: "walk".into(),
                delays: vec![vec![0.15,0.25],vec![0.35,0.45],vec![0.55,0.65],vec![0.75,0.85]],
            }
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) { let _ = fs::remove_dir_all(&self.root); }
    }

    #[test]
    fn saves_only_delays_preserving_other_metadata_and_png() {
        let fixture = Fixture::new();
        let request = fixture.request();
        let updated = update(&fixture.root, &request).unwrap();
        assert_ne!(updated.revision, request.expected_revision);
        let parsed: Value = serde_json::from_str(&updated.content).unwrap();
        assert_eq!(parsed["custom"]["keep"], true);
        assert_eq!(parsed["states"][0]["customState"], "safe");
        assert_eq!(parsed["states"][1]["name"], "idle");
        assert_eq!(parsed["states"][0]["delays"][1][1], 0.45);
        assert_eq!(fs::read(fixture.root.join(&fixture.relative).join("walk.png")).unwrap(), b"unchanged PNG");
        assert_eq!(fs::read_to_string(fixture.root.join(&fixture.relative).join("meta.json")).unwrap(), updated.content);
    }

    #[test]
    fn refuses_old_revision_without_touching_png_or_metadata() {
        let fixture = Fixture::new();
        let request = fixture.request();
        let meta_file = fixture.root.join(&fixture.relative).join("meta.json");
        fs::write(&meta_file, b"external").unwrap();
        assert_eq!(update(&fixture.root, &request).unwrap_err().code, "RSI_TIMING_CONFLICT");
        assert_eq!(fs::read(&meta_file).unwrap(), b"external");
        assert_eq!(fs::read(fixture.root.join(&fixture.relative).join("walk.png")).unwrap(), b"unchanged PNG");
    }

    #[test]
    fn rejects_frame_or_direction_change_without_persisting() {
        let fixture = Fixture::new();
        let mut request = fixture.request();
        let meta_file = fixture.root.join(&fixture.relative).join("meta.json");
        let original = fs::read(&meta_file).unwrap();
        request.delays[0].push(0.2);
        assert_eq!(update(&fixture.root, &request).unwrap_err().code, "RSI_TIMING_FRAME_COUNT_CHANGED");
        request.delays[0].pop();
        request.delays.pop();
        assert_eq!(update(&fixture.root, &request).unwrap_err().code, "RSI_TIMING_SHAPE_INVALID");
        assert_eq!(fs::read(&meta_file).unwrap(), original);
    }

    #[test]
    fn rejects_nonfinite_and_out_of_range_delays() {
        let fixture = Fixture::new();
        let mut request = fixture.request();
        request.delays[0][0] = f64::NAN;
        assert_eq!(update(&fixture.root, &request).unwrap_err().code, "RSI_TIMING_VALUE_INVALID");
        request.delays[0][0] = 0.001;
        assert_eq!(update(&fixture.root, &request).unwrap_err().code, "RSI_TIMING_VALUE_INVALID");
        request.delays[0][0] = 61.0;
        assert_eq!(update(&fixture.root, &request).unwrap_err().code, "RSI_TIMING_VALUE_INVALID");
    }

    #[test]
    fn edits_implicit_static_delay_and_avoids_unnecessary_rewrite() {
        let fixture = Fixture::new();
        let mut request = fixture.request();
        let original_path = fixture.root.join(&fixture.relative).join("meta.json");
        let original = fs::read(&original_path).unwrap();
        request.name = "idle".into();
        request.delays = vec![vec![1.0]];
        let no_op = update(&fixture.root, &request).unwrap();
        assert_eq!(no_op.revision, request.expected_revision);
        assert_eq!(fs::read(&original_path).unwrap(), original);
        request.delays = vec![vec![2.0]];
        let changed = update(&fixture.root, &request).unwrap();
        assert_eq!(serde_json::from_str::<Value>(&changed.content).unwrap()["states"][1]["delays"][0][0], 2.0);
    }

    #[test]
    fn refuses_ambiguous_and_missing_state() {
        let fixture = Fixture::new();
        let mut request = fixture.request();
        request.name = "missing".into();
        assert_eq!(update(&fixture.root, &request).unwrap_err().code, "RSI_TIMING_STATE_NOT_FOUND");
        let path = fixture.root.join(&fixture.relative).join("meta.json");
        let mut meta: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        let duplicate = meta["states"][0].clone();
        meta["states"].as_array_mut().unwrap().push(duplicate);
        fs::write(&path, serde_json::to_vec(&meta).unwrap()).unwrap();
        request.name = "walk".into();
        request.expected_revision = revision(&fs::read(&path).unwrap());
        assert_eq!(update(&fixture.root, &request).unwrap_err().code, "RSI_TIMING_STATE_AMBIGUOUS");
    }

    #[cfg(unix)]
    #[test]
    fn refuses_symlinked_ancestor_before_writing() {
        use std::os::unix::fs::symlink;
        let fixture = Fixture::new();
        symlink(
            fixture.root.join("Resources/Textures"),
            fixture.root.join("Resources/Textures/alias"),
        ).unwrap();
        let mut request = fixture.request();
        request.path = "Resources/Textures/alias/animal.rsi".into();
        assert_eq!(update(&fixture.root, &request).unwrap_err().code, "RSI_IMPORT_SYMLINK_FORBIDDEN");
    }
}

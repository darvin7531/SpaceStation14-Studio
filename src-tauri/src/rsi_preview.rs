//! Read-only, bounded RSI sprite-sheet access. Only indexed directories reach this module.
use crate::error::StudioError;
use crate::resource_edit::revision;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::Serialize;
use serde_json::Value;
use std::collections::HashSet;
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
};

const MAX_FILES: usize = 4096;
const MAX_SHEETS: usize = 256;
const MAX_PNG: u64 = 8 * 1024 * 1024;
const MAX_IMAGE_DIMENSION: u32 = 16_384;
const MAX_IMAGE_PIXELS: u64 = 16_777_216;
const PNG_HEADER: &[u8] = b"\x89PNG\r\n\x1a\n";

/// Validate the PNG IHDR before returning compressed data to the WebView.
/// An 8 MiB PNG can otherwise decompress to gigabytes of pixels.
pub(crate) fn png_dimensions(bytes: &[u8]) -> Result<(u32, u32), StudioError> {
    if !bytes.starts_with(PNG_HEADER)
        || bytes.len() < 29
        || &bytes[12..16] != b"IHDR"
        || u32::from_be_bytes(bytes[8..12].try_into().unwrap_or([0; 4])) != 13
    {
        return Err(StudioError::new(
            "RSI_PNG_HEADER_INVALID",
            "PNG не содержит корректного заголовка IHDR.",
            "Проверьте исходное изображение RSI.",
        ));
    }
    let width = u32::from_be_bytes(bytes[16..20].try_into().unwrap_or([0; 4]));
    let height = u32::from_be_bytes(bytes[20..24].try_into().unwrap_or([0; 4]));
    if width == 0
        || height == 0
        || width > MAX_IMAGE_DIMENSION
        || height > MAX_IMAGE_DIMENSION
        || u64::from(width) * u64::from(height) > MAX_IMAGE_PIXELS
    {
        return Err(StudioError::new(
            "RSI_IMAGE_DIMENSIONS_LIMIT",
            "Размер PNG слишком велик для безопасного предпросмотра.",
            "Используйте изображение меньшего размера или откройте его во внешнем редакторе.",
        ));
    }
    Ok((width, height))
}

#[derive(Debug, Serialize)]
pub struct RsiSheetInfo {
    pub name: String,
    pub bytes: u64,
    pub previewable: bool,
}
#[derive(Debug, Serialize)]
pub struct RsiSheetList {
    pub sheets: Vec<RsiSheetInfo>,
    pub warnings: Vec<String>,
}
#[derive(Debug, Serialize)]
pub struct RsiSheetImage {
    pub data_url: String,
    pub bytes: usize,
    pub width: u32,
    pub height: u32,
    pub revision: String,
}

pub(crate) fn directory(root: &Path, relative: &str) -> Result<PathBuf, StudioError> {
    let path = root.join(relative);
    let meta = fs::symlink_metadata(&path).map_err(|e| {
        StudioError::new(
            "RSI_DIRECTORY_MISSING",
            "Каталог RSI больше не доступен.",
            "Обновите проект и проверьте расположение спрайта.",
        )
        .with_details(e.to_string())
    })?;
    if meta.file_type().is_symlink() || !meta.is_dir() {
        return Err(StudioError::new(
            "RSI_DIRECTORY_INVALID",
            "RSI не является обычным каталогом.",
            "Символические ссылки и файлы вместо каталогов запрещены.",
        ));
    }
    let resolved = fs::canonicalize(&path).map_err(|e| {
        StudioError::new(
            "RSI_DIRECTORY_MISSING",
            "Не удалось разрешить каталог RSI.",
            "Проверьте права на каталог.",
        )
        .with_details(e.to_string())
    })?;
    if !resolved.starts_with(root.join("Resources/Textures")) {
        return Err(StudioError::new(
            "RSI_OUTSIDE_TEXTURES",
            "RSI находится за пределами текстур проекта.",
            "Откройте ресурс из каталога текущего проекта.",
        ));
    }
    Ok(resolved)
}

fn png_name(name: &str) -> bool {
    !name.is_empty()
        && !name.contains('/')
        && !name.contains('\\')
        && Path::new(name).file_name().and_then(|part| part.to_str()) == Some(name)
        && Path::new(name)
            .extension()
            .and_then(|ext| ext.to_str())
            .is_some_and(|ext| ext.eq_ignore_ascii_case("png"))
}

/// Diagnose an interrupted append/restore without guessing which PNG may be deleted.
/// Extra sheets may be intentionally kept by a fork, so this is advisory only.
fn metadata_sheet_warnings(folder: &Path, sheets: &[RsiSheetInfo]) -> Vec<String> {
    const MAX_META_BYTES: u64 = 4 * 1024 * 1024;
    let path = folder.join("meta.json");
    let _stat = match fs::symlink_metadata(&path) {
        Ok(stat) if stat.is_file() && !stat.file_type().is_symlink() && stat.len() <= MAX_META_BYTES => stat,
        _ => return vec!["Нельзя проверить соответствие PNG и meta.json: метаданные отсутствуют, небезопасны или слишком велики.".into()],
    };
    let mut raw = Vec::new();
    let read =
        fs::File::open(&path).and_then(|file| file.take(MAX_META_BYTES + 1).read_to_end(&mut raw));
    if read.is_err() || raw.len() as u64 > MAX_META_BYTES {
        return vec!["Не удалось безопасно прочитать meta.json для сверки PNG.".into()];
    }
    let value: Value = match serde_json::from_slice(&raw) {
        Ok(value) => value,
        Err(_) => {
            return vec![
                "meta.json содержит некорректный JSON; соответствие PNG не проверено.".into(),
            ]
        }
    };
    if value.get("version").and_then(Value::as_u64) != Some(1) {
        return vec!["Сверка PNG доступна только для RSI v1.".into()];
    }
    let Some(states) = value.get("states").and_then(Value::as_array) else {
        return vec!["meta.json не содержит корректного массива states.".into()];
    };
    if states.len() > 512 {
        return vec!["В meta.json слишком много состояний для безопасной сверки PNG.".into()];
    }
    let mut expected = HashSet::new();
    for state in states {
        let Some(name) = state.get("name").and_then(Value::as_str) else {
            return vec!["В meta.json есть состояние без имени; сверка PNG неполная.".into()];
        };
        let filename = format!("{name}.png");
        if !png_name(&filename) || !expected.insert(filename) {
            return vec![
                "В meta.json обнаружены некорректные или повторяющиеся имена состояний.".into(),
            ];
        }
    }
    let present: HashSet<&str> = sheets.iter().map(|sheet| sheet.name.as_str()).collect();
    let mut missing: Vec<_> = expected
        .iter()
        .filter(|name| !present.contains(name.as_str()))
        .cloned()
        .collect();
    let mut extra: Vec<_> = sheets
        .iter()
        .filter(|sheet| !expected.contains(&sheet.name))
        .map(|sheet| sheet.name.clone())
        .collect();
    missing.sort();
    extra.sort();
    let mut warnings = Vec::new();
    if !missing.is_empty() {
        warnings.push(format!(
            "Отсутствуют PNG для {} состояний: {}. Проверьте исходники RSI.",
            missing.len(),
            summarize_names(&missing)
        ));
    }
    if !extra.is_empty() {
        warnings.push(format!("Найдены {} PNG вне states meta.json: {}. Это могут быть остатки прерванного импорта/восстановления или файлы форка. Ничего не удалено.", extra.len(), summarize_names(&extra)));
    }
    warnings
}

fn summarize_names(names: &[String]) -> String {
    let shown = names
        .iter()
        .take(8)
        .map(String::as_str)
        .collect::<Vec<_>>()
        .join(", ");
    if names.len() > 8 {
        format!("{shown} и ещё {}", names.len() - 8)
    } else {
        shown
    }
}

pub fn list(root: &Path, relative: &str) -> Result<RsiSheetList, StudioError> {
    let folder = directory(root, relative)?;
    let entries = fs::read_dir(&folder).map_err(|e| {
        StudioError::new(
            "RSI_LIST_FAILED",
            "Не удалось прочитать каталог RSI.",
            "Проверьте права чтения.",
        )
        .with_details(e.to_string())
    })?;
    let mut sheets = Vec::new();
    let mut skipped_links = 0;
    for (index, entry) in entries.enumerate() {
        if index >= MAX_FILES {
            return Err(StudioError::new(
                "RSI_DIRECTORY_LIMIT",
                "В RSI слишком много файлов.",
                "Уменьшите число файлов в каталоге.",
            ));
        }
        let entry = entry.map_err(|e| {
            StudioError::new(
                "RSI_LIST_FAILED",
                "Ошибка чтения записи каталога RSI.",
                "Проверьте каталог.",
            )
            .with_details(e.to_string())
        })?;
        let kind = entry.file_type().map_err(|e| {
            StudioError::new(
                "RSI_LIST_FAILED",
                "Не удалось определить тип файла RSI.",
                "Проверьте права.",
            )
            .with_details(e.to_string())
        })?;
        if kind.is_symlink() {
            skipped_links += 1;
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if !kind.is_file() || !png_name(&name) {
            continue;
        }
        if sheets.len() >= MAX_SHEETS {
            return Err(StudioError::new(
                "RSI_SHEET_LIMIT",
                "Слишком много PNG-листов в RSI.",
                "Разделите изображения на несколько RSI.",
            ));
        }
        let bytes = entry
            .metadata()
            .map_err(|e| {
                StudioError::new(
                    "RSI_LIST_FAILED",
                    "Невозможно определить размер PNG.",
                    "Проверьте доступ к файлу.",
                )
                .with_details(e.to_string())
            })?
            .len();
        sheets.push(RsiSheetInfo {
            name,
            bytes,
            previewable: bytes <= MAX_PNG,
        });
    }
    sheets.sort_unstable_by(|a, b| a.name.cmp(&b.name));
    let mut warnings = Vec::new();
    if skipped_links > 0 {
        warnings.push(format!("Пропущено символических ссылок: {skipped_links}."));
    }
    if sheets.iter().any(|s| !s.previewable) {
        warnings.push("PNG больше 8 МиБ недоступны для предпросмотра.".into());
    }
    warnings.extend(metadata_sheet_warnings(&folder, &sheets));
    Ok(RsiSheetList { sheets, warnings })
}

pub fn read(root: &Path, relative: &str, name: &str) -> Result<RsiSheetImage, StudioError> {
    if !png_name(name) {
        return Err(StudioError::new(
            "RSI_IMAGE_NAME_INVALID",
            "Некорректное имя PNG-листа.",
            "Выберите изображение из списка RSI.",
        ));
    }
    let folder = directory(root, relative)?;
    let path = folder.join(name);
    let meta = fs::symlink_metadata(&path).map_err(|e| {
        StudioError::new(
            "RSI_IMAGE_MISSING",
            "PNG больше не доступен.",
            "Обновите список изображений.",
        )
        .with_details(e.to_string())
    })?;
    if meta.file_type().is_symlink() || !meta.is_file() {
        return Err(StudioError::new(
            "RSI_IMAGE_INVALID",
            "PNG не является обычным файлом.",
            "Символические ссылки для предпросмотра запрещены.",
        ));
    }
    if meta.len() > MAX_PNG {
        return Err(StudioError::new(
            "RSI_IMAGE_TOO_LARGE",
            "PNG превышает лимит 8 МиБ.",
            "Откройте PNG внешним редактором.",
        ));
    }
    let canonical = fs::canonicalize(path).map_err(|e| {
        StudioError::new(
            "RSI_IMAGE_MISSING",
            "PNG больше не доступен.",
            "Обновите список изображений.",
        )
        .with_details(e.to_string())
    })?;
    if canonical.parent() != Some(folder.as_path()) {
        return Err(StudioError::new(
            "RSI_IMAGE_OUTSIDE",
            "PNG расположен вне выбранного RSI.",
            "Используйте файл из каталога этого спрайта.",
        ));
    }
    let file = fs::File::open(canonical).map_err(|e| {
        StudioError::new(
            "RSI_IMAGE_READ_FAILED",
            "Не удалось открыть PNG.",
            "Проверьте права чтения.",
        )
        .with_details(e.to_string())
    })?;
    let mut bytes = Vec::new();
    file.take(MAX_PNG + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| {
            StudioError::new(
                "RSI_IMAGE_READ_FAILED",
                "Не удалось прочитать PNG.",
                "Повторите попытку.",
            )
            .with_details(e.to_string())
        })?;
    if bytes.len() as u64 > MAX_PNG {
        return Err(StudioError::new(
            "RSI_IMAGE_TOO_LARGE",
            "PNG увеличился во время чтения и превышает 8 МиБ.",
            "Дождитесь окончания внешней записи файла.",
        ));
    }
    if !bytes.starts_with(PNG_HEADER) {
        return Err(StudioError::new(
            "RSI_IMAGE_NOT_PNG",
            "Файл не содержит PNG-изображение.",
            "Проверьте формат файла в исходном проекте.",
        ));
    }
    let (width, height) = png_dimensions(&bytes)?;
    let image_revision = revision(&bytes);
    Ok(RsiSheetImage {
        data_url: format!("data:image/png;base64,{}", STANDARD.encode(&bytes)),
        bytes: bytes.len(),
        width,
        height,
        revision: image_revision,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_png_decompression_bombs_and_malformed_headers() {
        let mut png = b"\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR\x00\x00\x00\x20\x00\x00\x00\x20\x08\x06\x00\x00\x00".to_vec();
        assert_eq!(png_dimensions(&png).unwrap(), (32, 32));
        png[16..20].copy_from_slice(&16_384_u32.to_be_bytes());
        png[20..24].copy_from_slice(&16_384_u32.to_be_bytes());
        assert_eq!(
            png_dimensions(&png).unwrap_err().code,
            "RSI_IMAGE_DIMENSIONS_LIMIT"
        );
        png[12..16].copy_from_slice(b"IDAT");
        assert_eq!(
            png_dimensions(&png).unwrap_err().code,
            "RSI_PNG_HEADER_INVALID"
        );
    }

    #[test]
    fn detects_unreferenced_and_missing_sheets_without_modifying_files() {
        let folder = std::env::temp_dir().join(format!(
            "rsi-audit-{}-{}",
            std::process::id(),
            std::thread::current().name().unwrap_or("test")
        ));
        fs::create_dir_all(&folder).unwrap();
        fs::write(
            folder.join("meta.json"),
            r#"{"version":1,"states":[{"name":"idle"},{"name":"missing"}]}"#,
        )
        .unwrap();
        let sheets = vec![
            RsiSheetInfo {
                name: "idle.png".into(),
                bytes: 1,
                previewable: true,
            },
            RsiSheetInfo {
                name: "orphan.png".into(),
                bytes: 1,
                previewable: true,
            },
        ];
        let warnings = metadata_sheet_warnings(&folder, &sheets);
        assert!(warnings.iter().any(|w| w.contains("missing.png")));
        assert!(warnings
            .iter()
            .any(|w| w.contains("orphan.png") && w.contains("Ничего не удалено")));
        assert!(folder.join("meta.json").exists());
        fs::remove_dir_all(folder).unwrap();
    }

    #[test]
    fn unsafe_or_invalid_metadata_never_labels_sheets_orphans() {
        let folder = std::env::temp_dir().join(format!("rsi-audit-invalid-{}", std::process::id()));
        fs::create_dir_all(&folder).unwrap();
        let sheets = vec![RsiSheetInfo {
            name: "idle.png".into(),
            bytes: 1,
            previewable: true,
        }];
        fs::write(folder.join("meta.json"), "not json").unwrap();
        let warnings = metadata_sheet_warnings(&folder, &sheets);
        assert_eq!(warnings.len(), 1);
        assert!(!warnings[0].contains("вне states"));
        fs::write(
            folder.join("meta.json"),
            r#"{"version":1,"states":[{"name":"idle"}]}"#,
        )
        .unwrap();
        assert!(metadata_sheet_warnings(&folder, &sheets).is_empty());
        fs::remove_dir_all(folder).unwrap();
    }

    #[test]
    fn image_names_cannot_traverse() {
        for name in ["../a.png", "dir/a.png", "dir\\a.png", "meta.json", "", "."] {
            assert!(!png_name(name), "{name}");
        }
        assert!(png_name("idle.png"));
        assert!(png_name("walk.PNG"));
    }
}

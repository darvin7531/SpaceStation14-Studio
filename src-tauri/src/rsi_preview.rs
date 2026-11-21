//! Read-only, bounded RSI sprite-sheet access. Only indexed directories reach this module.
use crate::error::StudioError;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::Serialize;
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
};

const MAX_FILES: usize = 4096;
const MAX_SHEETS: usize = 256;
const MAX_PNG: u64 = 8 * 1024 * 1024;
const PNG_HEADER: &[u8] = b"\x89PNG\r\n\x1a\n";

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
}

fn directory(root: &Path, relative: &str) -> Result<PathBuf, StudioError> {
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

pub fn list(root: &Path, relative: &str) -> Result<RsiSheetList, StudioError> {
    let folder = directory(root, relative)?;
    let entries = fs::read_dir(folder).map_err(|e| {
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
    Ok(RsiSheetImage {
        data_url: format!("data:image/png;base64,{}", STANDARD.encode(&bytes)),
        bytes: bytes.len(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn image_names_cannot_traverse() {
        for name in ["../a.png", "dir/a.png", "dir\\a.png", "meta.json", "", "."] {
            assert!(!png_name(name), "{name}");
        }
        assert!(png_name("idle.png"));
        assert!(png_name("walk.PNG"));
    }
}

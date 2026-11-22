//! Add a new RSI state and its PNG without overwriting existing data.
//! This is intentionally a bounded, append-only operation. A revision
//! check rejects stale meta.json, and PNG creation uses create_new(true).
use crate::error::StudioError;
use crate::resource_edit::revision;
use crate::rsi_preview::{directory, png_dimensions};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path};
use std::sync::atomic::{AtomicU64, Ordering};

const MAX_PNG_BYTES: usize = 8 * 1024 * 1024;
const MAX_META_BYTES: u64 = 4 * 1024 * 1024;
const MAX_DATA_URL_CHARS: usize = 12 * 1024 * 1024;
const MAX_STATES: usize = 512;
const MAX_FRAMES: u32 = 128;
const PNG_DATA_PREFIX: &str = "data:image/png;base64,";
static NEXT_TEMP: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, Deserialize)]
pub struct RsiStateImport {
    pub path: String,
    pub expected_revision: String,
    pub name: String,
    pub directions: u32,
    pub frames_per_direction: u32,
    pub delay_seconds: f64,
    pub data_url: String,
    /// Required only when replacing an existing state; protects against external PNG edits.
    #[serde(default)]
    pub expected_png_revision: Option<String>,
    /// Preserve per-frame timings when a replacement keeps the same grid.
    #[serde(default)]
    pub delays: Option<Vec<Vec<f64>>>,
}

#[derive(Debug, Serialize)]
pub struct ImportedRsiState {
    pub name: String,
    pub content: String,
    pub revision: String,
    pub warning: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub archive_path: Option<String>,
}

fn issue(code: &'static str, message: &str, hint: &str) -> StudioError {
    StudioError::new(code, message, hint)
}

pub(crate) fn validate_request(request: &RsiStateImport) -> Result<(), StudioError> {
    if request.expected_revision.len() != 64
        || !request
            .expected_revision
            .bytes()
            .all(|ch| ch.is_ascii_hexdigit())
    {
        return Err(issue(
            "RSI_IMPORT_REVISION_INVALID",
            "Ревизия meta.json не задана или некорректна.",
            "Обновите RSI перед добавлением состояния.",
        ));
    }
    if request.name.is_empty()
        || request.name.len() > 128
        || !request
            .name
            .bytes()
            .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || matches!(ch, b'_' | b'-'))
    {
        return Err(issue(
            "RSI_IMPORT_NAME_INVALID",
            "Имя состояния должно состоять из строчных латинских букв, цифр, '-' и '_'.",
            "Используйте имя от 1 до 128 символов без расширения PNG.",
        ));
    }
    if !matches!(request.directions, 1 | 4 | 8)
        || !(1..=MAX_FRAMES).contains(&request.frames_per_direction)
        || request.directions * request.frames_per_direction > 256
        || !request.delay_seconds.is_finite()
        || !(0.01..=60.0).contains(&request.delay_seconds)
    {
        return Err(issue(
            "RSI_IMPORT_TIMING_INVALID",
            "Некорректные направления, количество кадров или задержка.",
            "Используйте 1/4/8 направлений, до 128 кадров на направление (всего до 256) и длительность 0.01–60 с.",
        ));
    }
    if let Some(delays) = &request.delays {
        if delays.len() != request.directions as usize
            || delays.iter().any(|direction| {
                direction.len() != request.frames_per_direction as usize
                    || direction
                        .iter()
                        .any(|seconds| !seconds.is_finite() || !(0.01..=60.0).contains(seconds))
            })
        {
            return Err(issue(
                "RSI_IMPORT_TIMING_INVALID",
                "Массив задержек не совпадает с числом направлений и кадров.",
                "Передавайте одну длительность для каждого кадра либо оставьте прежние задержки без изменения.",
            ));
        }
    }
    if !request.data_url.starts_with(PNG_DATA_PREFIX) || request.data_url.len() > MAX_DATA_URL_CHARS
    {
        return Err(issue(
            "RSI_IMPORT_DATA_INVALID",
            "Изображение не является допустимым PNG Data URL либо превышает ограничение.",
            "Выберите PNG размером не более 8 МиБ.",
        ));
    }
    Ok(())
}

pub(crate) fn bounded_metadata(path: &Path) -> Result<Vec<u8>, StudioError> {
    let meta = fs::symlink_metadata(path).map_err(|e| {
        issue(
            "RSI_IMPORT_META_MISSING",
            "meta.json больше не доступен.",
            "Переоткройте RSI и проверьте его каталог.",
        )
        .with_details(e.to_string())
    })?;
    if meta.file_type().is_symlink() || !meta.is_file() || meta.len() > MAX_META_BYTES {
        return Err(issue(
            "RSI_IMPORT_META_UNSAFE",
            "meta.json должен быть обычным файлом до 4 МиБ.",
            "Уберите символические ссылки или откройте корректный RSI.",
        ));
    }
    let mut bytes = Vec::new();
    fs::File::open(path)
        .and_then(|file| file.take(MAX_META_BYTES + 1).read_to_end(&mut bytes))
        .map_err(|e| {
            issue(
                "RSI_IMPORT_META_READ_FAILED",
                "Не удалось прочитать meta.json.",
                "Проверьте права и повторите действие.",
            )
            .with_details(e.to_string())
        })?;
    if bytes.len() as u64 > MAX_META_BYTES {
        return Err(issue(
            "RSI_IMPORT_META_UNSAFE",
            "meta.json увеличился во время чтения.",
            "Обновите RSI после завершения внешней записи.",
        ));
    }
    Ok(bytes)
}

/// Check each PNG chunk CRC without introducing a dependency on an image
/// decoding library. The browser still performs final pixel decoding.
fn crc32(bytes: &[u8]) -> u32 {
    let mut crc = !0_u32;
    for &byte in bytes {
        crc ^= u32::from(byte);
        for _ in 0..8 {
            crc = (crc >> 1) ^ (0xedb8_8320_u32 & (0_u32.wrapping_sub(crc & 1)));
        }
    }
    !crc
}

/// Restrict import to structurally complete PNG streams. The WebView still
/// performs image decoding; no arbitrary file bytes are executed or rewritten.
fn validate_png(
    bytes: &[u8],
    expected_width: u32,
    expected_height: u32,
) -> Result<(), StudioError> {
    if bytes.len() > MAX_PNG_BYTES {
        return Err(issue(
            "RSI_IMPORT_PNG_TOO_LARGE",
            "PNG превышает 8 МиБ.",
            "Уменьшите файл перед импортом.",
        ));
    }
    let (width, height) = png_dimensions(bytes)?;
    if width != expected_width || height != expected_height {
        return Err(issue(
            "RSI_IMPORT_PNG_SIZE_MISMATCH",
            "Размер PNG не соответствует числу кадров и направлениям.",
            "Лист должен содержать указанное количество ячеек размера RSI, без дополнительных кадров.",
        ));
    }
    let mut cursor = 8_usize;
    let mut chunk_count = 0_usize;
    let mut saw_image_data = false;
    let mut saw_iend = false;
    while cursor < bytes.len() {
        if cursor + 12 > bytes.len() || chunk_count >= 4096 {
            return Err(issue(
                "RSI_IMPORT_PNG_INVALID",
                "PNG содержит неполные или слишком многочисленные блоки.",
                "Выберите корректный PNG.",
            ));
        }
        let chunk_len =
            u32::from_be_bytes(bytes[cursor..cursor + 4].try_into().unwrap_or([0; 4])) as usize;
        let end = cursor
            .checked_add(12)
            .and_then(|v| v.checked_add(chunk_len));
        let Some(end) = end else {
            return Err(issue(
                "RSI_IMPORT_PNG_INVALID",
                "PNG содержит некорректную длину блока.",
                "Проверьте файл.",
            ));
        };
        if end > bytes.len() {
            return Err(issue(
                "RSI_IMPORT_PNG_INVALID",
                "PNG обрывается посреди блока.",
                "Проверьте файл.",
            ));
        }
        let kind = &bytes[cursor + 4..cursor + 8];
        let stored_crc = u32::from_be_bytes(bytes[end - 4..end].try_into().unwrap_or([0; 4]));
        if crc32(&bytes[cursor + 4..end - 4]) != stored_crc {
            return Err(issue(
                "RSI_IMPORT_PNG_CRC_INVALID",
                "PNG содержит блок с неверной контрольной суммой.",
                "Пересохраните PNG и повторите импорт.",
            ));
        }
        if chunk_count == 0 && (kind != b"IHDR" || chunk_len != 13) {
            return Err(issue(
                "RSI_IMPORT_PNG_INVALID",
                "PNG не начинается с корректного IHDR.",
                "Проверьте файл.",
            ));
        }
        if kind == b"IDAT" {
            saw_image_data = true;
        }
        if kind == b"IEND" {
            if chunk_len != 0 || end != bytes.len() {
                return Err(issue(
                    "RSI_IMPORT_PNG_INVALID",
                    "Некорректный завершающий блок PNG.",
                    "Проверьте файл.",
                ));
            }
            saw_iend = true;
        }
        chunk_count += 1;
        cursor = end;
    }
    if !saw_iend || !saw_image_data {
        return Err(issue(
            "RSI_IMPORT_PNG_INVALID",
            "В PNG отсутствуют данные изображения или завершающий блок.",
            "Используйте полностью сохранённый PNG.",
        ));
    }
    Ok(())
}

pub(crate) fn updated_metadata_at(
    bytes: &[u8],
    request: &RsiStateImport,
    png: &[u8],
    insert_at: Option<usize>,
    preserve_state: Option<&Value>,
) -> Result<String, StudioError> {
    let mut meta: Value = serde_json::from_slice(bytes).map_err(|e| {
        issue(
            "RSI_IMPORT_META_INVALID",
            "meta.json содержит некорректный JSON.",
            "Исправьте метаданные перед импортом.",
        )
        .with_details(e.to_string())
    })?;
    if meta.get("version").and_then(Value::as_i64) != Some(1) {
        return Err(issue(
            "RSI_IMPORT_VERSION_INVALID",
            "Поддерживается только RSI версии 1.",
            "Откройте ресурс, совместимый с форматом RSI v1.",
        ));
    }
    let Some(size) = meta.get("size") else {
        return Err(issue(
            "RSI_IMPORT_META_INVALID",
            "В meta.json отсутствует size.",
            "Укажите размер кадра.",
        ));
    };
    let width = size
        .get("x")
        .and_then(Value::as_u64)
        .and_then(|n| u32::try_from(n).ok());
    let height = size
        .get("y")
        .and_then(Value::as_u64)
        .and_then(|n| u32::try_from(n).ok());
    let (Some(width), Some(height)) = (width, height) else {
        return Err(issue(
            "RSI_IMPORT_META_INVALID",
            "Размеры кадра некорректны.",
            "Укажите целые x и y.",
        ));
    };
    if width == 0 || height == 0 || width > 2048 || height > 2048 {
        return Err(issue(
            "RSI_IMPORT_META_INVALID",
            "Размеры кадра выходят за допустимые пределы.",
            "Используйте размер кадра до 2048×2048.",
        ));
    }
    let total_frames = request.directions * request.frames_per_direction;
    let expected_cells = total_frames;
    // Accept row-major sheets containing exactly total_frames cells, not an
    // arbitrary pack with unused padding. Rows and columns can vary.
    let (png_width, png_height) = png_dimensions(png)?;
    if png_width % width != 0
        || png_height % height != 0
        || u64::from(png_width / width) * u64::from(png_height / height)
            != u64::from(expected_cells)
    {
        return Err(issue(
            "RSI_IMPORT_PNG_SIZE_MISMATCH",
            "Сетка PNG не совпадает с указанными кадрами.",
            "Используйте PNG с точным числом ячеек по направлениям (без пустых слотов).",
        ));
    }
    validate_png(png, png_width, png_height)?;
    let states = meta
        .get_mut("states")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| {
            issue(
                "RSI_IMPORT_META_INVALID",
                "В meta.json нет массива states.",
                "Исправьте существующие метаданные.",
            )
        })?;
    if states.len() >= MAX_STATES {
        return Err(issue(
            "RSI_IMPORT_STATES_LIMIT",
            "Достигнут лимит 512 состояний.",
            "Удалите ненужные состояния перед импортом.",
        ));
    }
    if states
        .iter()
        .any(|state| state.get("name").and_then(Value::as_str) == Some(request.name.as_str()))
    {
        return Err(issue(
            "RSI_IMPORT_STATE_EXISTS",
            "Состояние с таким именем уже записано в meta.json.",
            "Укажите новое имя состояния.",
        ));
    }
    let delays = request.delays.clone().unwrap_or_else(|| {
        (0..request.directions)
            .map(|_| {
                (0..request.frames_per_direction)
                    .map(|_| request.delay_seconds)
                    .collect::<Vec<_>>()
            })
            .collect::<Vec<_>>()
    });
    let mut new_state = preserve_state.cloned().unwrap_or_else(|| json!({}));
    let Some(state_object) = new_state.as_object_mut() else {
        return Err(issue(
            "RSI_IMPORT_META_INVALID",
            "Исходное состояние не является JSON-объектом.",
            "Проверьте структуру состояния перед заменой PNG.",
        ));
    };
    state_object.insert("name".into(), json!(request.name));
    state_object.insert("directions".into(), json!(request.directions));
    state_object.insert("delays".into(), json!(delays));
    if let Some(index) = insert_at {
        if index > states.len() {
            return Err(issue(
                "RSI_IMPORT_META_INVALID",
                "Невозможно сохранить исходный порядок состояния RSI.",
                "Обновите ресурс и повторите замену.",
            ));
        }
        states.insert(index, new_state);
    } else {
        states.push(new_state);
    }
    let serialized = serde_json::to_string_pretty(&meta).map_err(|e| {
        issue(
            "RSI_IMPORT_META_INVALID",
            "Невозможно сформировать JSON.",
            "Проверьте метаданные.",
        )
        .with_details(e.to_string())
    })? + "\n";
    if serialized.len() as u64 > MAX_META_BYTES {
        return Err(issue(
            "RSI_IMPORT_META_TOO_LARGE",
            "meta.json стал слишком большим.",
            "Уменьшите количество состояний.",
        ));
    }
    Ok(serialized)
}

/// Reject symlinks in every ancestor: read-only previews may resolve links
/// inside Textures, but a write operation must never follow them.
pub(crate) fn safe_import_directory(
    root: &Path,
    relative: &str,
) -> Result<std::path::PathBuf, StudioError> {
    let mut cursor = root.to_path_buf();
    for part in Path::new(relative).components() {
        let Component::Normal(segment) = part else {
            return Err(issue(
                "RSI_IMPORT_PATH_INVALID",
                "Путь к RSI содержит недопустимые компоненты.",
                "Выберите ресурс из списка текущего проекта.",
            ));
        };
        cursor.push(segment);
        let meta = fs::symlink_metadata(&cursor).map_err(|e| {
            issue(
                "RSI_IMPORT_PATH_INVALID",
                "Часть пути к RSI не доступна.",
                "Обновите индекс проекта.",
            )
            .with_details(e.to_string())
        })?;
        if meta.file_type().is_symlink() || !meta.is_dir() {
            return Err(issue(
                "RSI_IMPORT_SYMLINK_FORBIDDEN",
                "Путь к RSI содержит символическую ссылку или файл вместо каталога.",
                "Для записи выберите обычную папку без символических ссылок.",
            ));
        }
    }
    directory(root, relative)
}

/// The caller serializes actions in a project-local mutex. A second precommit
/// revision check catches external edits during PNG staging. Power loss can
/// leave an orphan PNG, which is intentionally never deleted on startup.
pub fn import(root: &Path, request: &RsiStateImport) -> Result<ImportedRsiState, StudioError> {
    import_at(root, request, None, None)
}

pub(crate) fn import_at(
    root: &Path,
    request: &RsiStateImport,
    insert_at: Option<usize>,
    preserve_state: Option<Value>,
) -> Result<ImportedRsiState, StudioError> {
    validate_request(request)?;
    let folder = safe_import_directory(root, &request.path)?;
    let meta_path = folder.join("meta.json");
    let original = bounded_metadata(&meta_path)?;
    if revision(&original) != request.expected_revision {
        return Err(issue(
            "RSI_IMPORT_CONFLICT",
            "meta.json изменился после открытия.",
            "Обновите ресурс и повторите импорт.",
        ));
    }
    let encoded = &request.data_url[PNG_DATA_PREFIX.len()..];
    let png = STANDARD.decode(encoded).map_err(|e| {
        issue(
            "RSI_IMPORT_PNG_INVALID",
            "Невозможно разобрать PNG из Base64.",
            "Выберите PNG повторно.",
        )
        .with_details(e.to_string())
    })?;
    let content =
        updated_metadata_at(&original, request, &png, insert_at, preserve_state.as_ref())?;
    let target_png = folder.join(format!("{}.png", request.name));
    if target_png.exists() {
        return Err(issue(
            "RSI_IMPORT_PNG_EXISTS",
            "PNG с таким именем уже существует и не будет перезаписан.",
            "Выберите другое имя состояния.",
        ));
    }
    let metadata_permissions = fs::metadata(&meta_path)
        .map_err(|e| {
            issue(
                "RSI_IMPORT_META_MISSING",
                "Не удалось определить права meta.json.",
                "Обновите RSI.",
            )
            .with_details(e.to_string())
        })?
        .permissions();
    if metadata_permissions.readonly() {
        return Err(issue(
            "RSI_IMPORT_META_READONLY",
            "meta.json доступен только для чтения.",
            "Проверьте права на файл.",
        ));
    }

    let mut temp_metadata = None;
    for _ in 0..32 {
        let number = NEXT_TEMP.fetch_add(1, Ordering::Relaxed);
        let candidate = folder.join(format!(
            ".studio-rsi-meta-{}-{number}.tmp",
            std::process::id()
        ));
        match OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&candidate)
        {
            Ok(handle) => {
                temp_metadata = Some((candidate, handle));
                break;
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => {
                return Err(issue(
                    "RSI_IMPORT_TEMP_FAILED",
                    "Не удалось подготовить новое meta.json.",
                    "Проверьте права на каталог.",
                )
                .with_details(e.to_string()))
            }
        }
    }
    let Some((temp_path, mut temp)) = temp_metadata else {
        return Err(issue(
            "RSI_IMPORT_TEMP_FAILED",
            "Невозможно выделить временный файл.",
            "Проверьте каталог RSI.",
        ));
    };
    let staged = (|| -> Result<(), StudioError> {
        fs::set_permissions(&temp_path, metadata_permissions).map_err(|e| {
            issue(
                "RSI_IMPORT_TEMP_FAILED",
                "Не удалось установить права временного файла.",
                "Проверьте каталог RSI.",
            )
            .with_details(e.to_string())
        })?;
        temp.write_all(content.as_bytes())
            .and_then(|_| temp.sync_all())
            .map_err(|e| {
                issue(
                    "RSI_IMPORT_TEMP_FAILED",
                    "Не удалось записать временный meta.json.",
                    "Проверьте диск.",
                )
                .with_details(e.to_string())
            })
    })();
    drop(temp);
    if let Err(e) = staged {
        let _ = fs::remove_file(&temp_path);
        return Err(e);
    }

    let new_png = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&target_png);
    let mut new_png = match new_png {
        Ok(handle) => handle,
        Err(e) => {
            let _ = fs::remove_file(&temp_path);
            return Err(if e.kind() == std::io::ErrorKind::AlreadyExists {
                issue(
                    "RSI_IMPORT_PNG_EXISTS",
                    "PNG появился до завершения импорта.",
                    "Обновите RSI.",
                )
            } else {
                issue(
                    "RSI_IMPORT_WRITE_FAILED",
                    "Невозможно создать PNG.",
                    "Проверьте права на каталог.",
                )
                .with_details(e.to_string())
            });
        }
    };
    let wrote = new_png.write_all(&png).and_then(|_| new_png.sync_all());
    drop(new_png);
    let precommit = wrote
        .map_err(|e| {
            issue(
                "RSI_IMPORT_WRITE_FAILED",
                "Не удалось полностью записать PNG.",
                "Проверьте диск.",
            )
            .with_details(e.to_string())
        })
        .and_then(|_| {
            if revision(&bounded_metadata(&meta_path)?) != request.expected_revision {
                Err(issue(
                    "RSI_IMPORT_CONFLICT",
                    "meta.json изменился во время импорта.",
                    "Обновите RSI перед повторной попыткой.",
                ))
            } else {
                Ok(())
            }
        });
    if let Err(error) = precommit {
        let png_cleanup = fs::remove_file(&target_png);
        let _ = fs::remove_file(&temp_path);
        if let Err(cleanup_error) = png_cleanup {
            return Err(issue(
                "RSI_IMPORT_CLEANUP_FAILED",
                "Импорт прерван, но неполный PNG не удалось удалить.",
                "Проверьте PNG вручную, прежде чем повторять импорт.",
            )
            .with_details(format!("{error:?}; очистка PNG: {cleanup_error}")));
        }
        return Err(error);
    }

    if let Err(error) = fs::rename(&temp_path, &meta_path) {
        let png_cleanup = fs::remove_file(&target_png);
        let _ = fs::remove_file(&temp_path);
        return Err(issue(
            "RSI_IMPORT_COMMIT_FAILED",
            "Не удалось атомарно заменить meta.json.",
            "Проверьте права и свободное место.",
        )
        .with_details(format!("{error}; удаление PNG: {png_cleanup:?}")));
    }

    let warning = sync_dir(&folder)
        .err()
        .map(|e| format!("Состояние создано, но синхронизация каталога не подтверждена: {e}"));
    Ok(ImportedRsiState {
        name: request.name.clone(),
        revision: revision(content.as_bytes()),
        content,
        warning,
        archive_path: None,
    })
}

#[cfg(unix)]
fn sync_dir(path: &Path) -> std::io::Result<()> {
    fs::File::open(path)?.sync_all()
}
#[cfg(not(unix))]
fn sync_dir(_path: &Path) -> std::io::Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicU64;
    static NEXT: AtomicU64 = AtomicU64::new(0);

    struct Fixture {
        root: std::path::PathBuf,
        rel: String,
    }
    impl Fixture {
        fn new() -> Self {
            let id = NEXT.fetch_add(1, Ordering::Relaxed);
            let folder =
                std::env::temp_dir().join(format!("rsi-import-{}-{id}", std::process::id()));
            fs::create_dir_all(folder.join("Resources/Textures/sample.rsi")).unwrap();
            let root = fs::canonicalize(folder).unwrap();
            let rel = "Resources/Textures/sample.rsi".to_string();
            fs::write(
                root.join(&rel).join("meta.json"),
                r#"{"version":1,"size":{"x":1,"y":1},"states":[]}"#,
            )
            .unwrap();
            Self { root, rel }
        }
        fn png() -> Vec<u8> {
            // Real 1×1 PNG with IDAT and IEND, structurally complete.
            STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==").unwrap()
        }
        fn request(&self) -> RsiStateImport {
            let meta = fs::read(self.root.join(&self.rel).join("meta.json")).unwrap();
            RsiStateImport {
                path: self.rel.clone(),
                expected_revision: revision(&meta),
                name: "idle".into(),
                directions: 1,
                frames_per_direction: 1,
                delay_seconds: 0.1,
                data_url: format!("{PNG_DATA_PREFIX}{}", STANDARD.encode(Self::png())),
                expected_png_revision: None,
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
    fn imports_state_and_refuses_duplicate_without_overwriting() {
        let fx = Fixture::new();
        let request = fx.request();
        let result = import(&fx.root, &request).unwrap();
        assert_eq!(result.name, "idle");
        assert_eq!(result.revision, revision(result.content.as_bytes()));
        let meta: Value = serde_json::from_str(&result.content).unwrap();
        assert_eq!(meta["states"][0]["name"], "idle");
        assert_eq!(meta["states"][0]["delays"][0][0], 0.1);
        let png_path = fx.root.join(&fx.rel).join("idle.png");
        assert_eq!(fs::read(&png_path).unwrap(), Fixture::png());
        assert_eq!(
            import(&fx.root, &request).unwrap_err().code,
            "RSI_IMPORT_CONFLICT"
        );
        assert_eq!(fs::read(&png_path).unwrap(), Fixture::png());
    }

    #[test]
    fn appends_a_second_state_without_losing_existing_entries() {
        let fx = Fixture::new();
        let first = import(&fx.root, &fx.request()).unwrap();
        let mut next = fx.request();
        next.name = "walk".into();
        next.expected_revision = first.revision;
        let second = import(&fx.root, &next).unwrap();
        let meta: Value = serde_json::from_str(&second.content).unwrap();
        assert_eq!(meta["states"].as_array().unwrap().len(), 2);
        assert_eq!(meta["states"][0]["name"], "idle");
        assert_eq!(meta["states"][1]["name"], "walk");
        assert_eq!(
            fs::read(fx.root.join(&fx.rel).join("idle.png")).unwrap(),
            Fixture::png()
        );
        assert_eq!(
            fs::read(fx.root.join(&fx.rel).join("walk.png")).unwrap(),
            Fixture::png()
        );
        next.expected_revision = second.revision;
        assert_eq!(
            import(&fx.root, &next).unwrap_err().code,
            "RSI_IMPORT_STATE_EXISTS"
        );
    }

    #[test]
    fn refuses_external_revision_change_and_existing_unlisted_png() {
        let fx = Fixture::new();
        let request = fx.request();
        fs::write(fx.root.join(&fx.rel).join("meta.json"), b"modified").unwrap();
        assert_eq!(
            import(&fx.root, &request).unwrap_err().code,
            "RSI_IMPORT_CONFLICT"
        );
        assert!(!fx.root.join(&fx.rel).join("idle.png").exists());

        let fx = Fixture::new();
        let request = fx.request();
        fs::write(fx.root.join(&fx.rel).join("idle.png"), b"external").unwrap();
        assert_eq!(
            import(&fx.root, &request).unwrap_err().code,
            "RSI_IMPORT_PNG_EXISTS"
        );
        assert_eq!(
            fs::read(fx.root.join(&fx.rel).join("idle.png")).unwrap(),
            b"external"
        );
    }

    #[test]
    fn rejects_corrupt_png_crc_and_truncated_chunks() {
        let fx = Fixture::new();
        let mut request = fx.request();
        let mut data = Fixture::png();
        data[45] ^= 1;
        request.data_url = format!("{PNG_DATA_PREFIX}{}", STANDARD.encode(data));
        assert_eq!(
            import(&fx.root, &request).unwrap_err().code,
            "RSI_IMPORT_PNG_CRC_INVALID"
        );
        assert!(!fx.root.join(&fx.rel).join("idle.png").exists());

        let mut data = Fixture::png();
        data.truncate(data.len() - 12);
        request.data_url = format!("{PNG_DATA_PREFIX}{}", STANDARD.encode(data));
        assert_eq!(
            import(&fx.root, &request).unwrap_err().code,
            "RSI_IMPORT_PNG_INVALID"
        );
    }

    #[cfg(unix)]
    #[test]
    fn rejects_parent_symlink_inside_textures() {
        use std::os::unix::fs::symlink;
        let fx = Fixture::new();
        symlink(
            fx.root.join("Resources/Textures"),
            fx.root.join("Resources/Textures/alias"),
        )
        .unwrap();
        let mut request = fx.request();
        request.path = "Resources/Textures/alias/sample.rsi".into();
        assert_eq!(
            import(&fx.root, &request).unwrap_err().code,
            "RSI_IMPORT_SYMLINK_FORBIDDEN"
        );
        assert!(!fx.root.join(&fx.rel).join("idle.png").exists());
    }

    #[test]
    fn rejects_invalid_data_and_grid_mismatch() {
        let fx = Fixture::new();
        let mut request = fx.request();
        request.name = "../evil".into();
        assert_eq!(
            import(&fx.root, &request).unwrap_err().code,
            "RSI_IMPORT_NAME_INVALID"
        );
        request.name = "walk".into();
        request.directions = 4;
        assert_eq!(
            import(&fx.root, &request).unwrap_err().code,
            "RSI_IMPORT_PNG_SIZE_MISMATCH"
        );
        request.directions = 1;
        request.data_url = format!("{PNG_DATA_PREFIX}{}", STANDARD.encode(b"not png"));
        assert!(import(&fx.root, &request).is_err());
        assert!(!fx.root.join(&fx.rel).join("walk.png").exists());
    }
}

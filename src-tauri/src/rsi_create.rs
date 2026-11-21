//! Exclusive RSI creation inside Resources/Textures; never overwrite an
//! existing sprite directory or follow a symlinked destination component.
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::StudioError;

const MAX_PATH_BYTES: usize = 512;
const MAX_COPYRIGHT_BYTES: usize = 8 * 1024;

#[derive(Debug, Clone, Deserialize)]
pub struct RsiDraft {
    pub directory: String,
    pub name: String,
    pub size_x: u32,
    pub size_y: u32,
    pub license: String,
    pub copyright: String,
}

#[derive(Debug, Serialize)]
pub struct RsiCreationPreview {
    pub path: String,
    pub metadata: String,
    pub warnings: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct CreatedRsi {
    pub path: String,
    pub warning: Option<String>,
}

fn error(code: &'static str, message: &str, hint: &str) -> StudioError {
    StudioError::new(code, message, hint)
}

pub fn preview(draft: &RsiDraft) -> Result<RsiCreationPreview, StudioError> {
    let directory = &draft.directory;
    let invalid = || {
        error(
            "RSI_CREATE_PATH_INVALID",
            "RSI можно создать только внутри Resources/Textures.",
            "Укажите существующий каталог, используя прямые слеши без .. и специальных символов.",
        )
    };
    if directory.is_empty()
        || directory.len() > MAX_PATH_BYTES
        || directory.contains('\\')
        || directory
            .chars()
            .any(|ch| ch.is_control() || matches!(ch, ':' | '<' | '>' | '|' | '?' | '*' | '"'))
        || directory
            .split('/')
            .any(|part| part.is_empty() || part.ends_with('.') || part.ends_with(' '))
    {
        return Err(invalid());
    }
    let components: Vec<_> = Path::new(directory).components().collect();
    if components.len() < 2
        || components[0].as_os_str() != "Resources"
        || components[1].as_os_str() != "Textures"
        || !components
            .iter()
            .all(|part| matches!(part, Component::Normal(_)))
    {
        return Err(invalid());
    }

    if draft.name.is_empty()
        || draft.name.len() > 80
        || !draft
            .name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(error(
            "RSI_CREATE_NAME_INVALID",
            "Имя RSI может состоять только из латинских букв, цифр, дефиса и подчёркивания.",
            "Введите имя без расширения .rsi, длиной от 1 до 80 символов.",
        ));
    }
    if !(1..=2048).contains(&draft.size_x) || !(1..=2048).contains(&draft.size_y) {
        return Err(error(
            "RSI_CREATE_SIZE_INVALID",
            "Размер одного кадра RSI должен быть от 1 до 2048 пикселей.",
            "Укажите ширину и высоту будущих кадров, например 32 × 32.",
        ));
    }
    if draft.license.trim().is_empty()
        || draft.license.len() > 128
        || draft.license.chars().any(|ch| {
            ch.is_control()
                || !(ch.is_ascii_alphanumeric()
                    || matches!(ch, ' ' | '-' | '.' | '+' | '(' | ')' | '/'))
        })
    {
        return Err(error(
            "RSI_CREATE_LICENSE_INVALID",
            "Лицензия RSI не задана или содержит недопустимые символы.",
            "Укажите SPDX-идентификатор, например CC-BY-SA-3.0. Строгая SPDX-проверка пока не выполняется.",
        ));
    }
    if draft.copyright.len() > MAX_COPYRIGHT_BYTES || draft.copyright.contains('\0') {
        return Err(error(
            "RSI_CREATE_COPYRIGHT_INVALID",
            "Поле copyright слишком длинное либо содержит нулевой байт.",
            "Ограничьте текст 8 КиБ.",
        ));
    }

    let metadata = serde_json::to_string_pretty(&serde_json::json!({
        "version": 1,
        "size": { "x": draft.size_x, "y": draft.size_y },
        "license": draft.license,
        "copyright": draft.copyright,
        "states": []
    }))
    .map_err(|reason| {
        error(
            "RSI_CREATE_JSON_FAILED",
            "Невозможно сформировать meta.json.",
            "Проверьте введённые значения.",
        )
        .with_details(reason.to_string())
    })?;
    Ok(RsiCreationPreview {
        path: format!("{directory}/{}.rsi", draft.name),
        metadata: format!("{metadata}\n"),
        warnings: vec![
            "Новый RSI создаётся без PNG и состояний. Добавьте кадры позже; исходные файлы не изменяются.".into(),
        ],
    })
}

pub fn create(root: &Path, draft: &RsiDraft) -> Result<CreatedRsi, StudioError> {
    let rendered = preview(draft)?;
    let scope = root.join("Resources/Textures");
    let canonical_scope = fs::canonicalize(&scope).map_err(|reason| {
        error(
            "RSI_CREATE_TEXTURES_MISSING",
            "Каталог Resources/Textures недоступен.",
            "Убедитесь, что открыт корректный проект SS14.",
        )
        .with_details(reason.to_string())
    })?;
    if !canonical_scope.starts_with(root) {
        return Err(error(
            "RSI_CREATE_SCOPE_INVALID",
            "Каталог текстур расположен вне проекта.",
            "Уберите символические ссылки на внешние папки.",
        ));
    }

    let folder = root.join(&rendered.path);
    let parent = folder.parent().ok_or_else(|| {
        error(
            "RSI_CREATE_PATH_INVALID",
            "Невозможно определить родительский каталог RSI.",
            "Выберите существующий каталог в Resources/Textures.",
        )
    })?;
    let relative = parent.strip_prefix(root).map_err(|_| {
        error(
            "RSI_CREATE_PATH_INVALID",
            "Путь вышел за пределы проекта.",
            "Используйте каталог Resources/Textures.",
        )
    })?;
    let mut cursor = PathBuf::from(root);
    for part in relative.components() {
        cursor.push(part);
        let metadata = fs::symlink_metadata(&cursor).map_err(|reason| {
            error(
                "RSI_CREATE_PARENT_MISSING",
                "Папка назначения RSI отсутствует или недоступна.",
                "Создайте нужную папку текстур заранее.",
            )
            .with_details(reason.to_string())
        })?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(error(
                "RSI_CREATE_PARENT_INVALID",
                "Путь назначения содержит символическую ссылку или файл вместо каталога.",
                "Выберите обычную папку внутри Resources/Textures.",
            ));
        }
    }
    let resolved_parent = fs::canonicalize(parent).map_err(|reason| {
        error(
            "RSI_CREATE_PARENT_MISSING",
            "Не удалось открыть папку назначения.",
            "Проверьте права чтения.",
        )
        .with_details(reason.to_string())
    })?;
    if !resolved_parent.starts_with(&canonical_scope) {
        return Err(error(
            "RSI_CREATE_OUTSIDE",
            "Папка назначения оказалась вне Resources/Textures.",
            "Выберите другую папку.",
        ));
    }

    fs::create_dir(&folder).map_err(|reason| {
        if reason.kind() == std::io::ErrorKind::AlreadyExists {
            error(
                "RSI_CREATE_EXISTS",
                "Такой RSI уже существует и не будет перезаписан.",
                "Выберите другое имя или откройте существующий RSI.",
            )
        } else {
            error(
                "RSI_CREATE_DIR_FAILED",
                "Не удалось создать каталог RSI.",
                "Проверьте доступ к папке и свободное место.",
            )
            .with_details(reason.to_string())
        }
    })?;

    let target = folder.join("meta.json");
    let mut options = OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o644);
    }
    let result = (|| -> Result<(), StudioError> {
        let mut handle = options.open(&target).map_err(|reason| {
            error(
                "RSI_CREATE_META_FAILED",
                "Каталог RSI создан, но meta.json открыть не удалось.",
                "Проверьте права и попробуйте снова.",
            )
            .with_details(reason.to_string())
        })?;
        handle
            .write_all(rendered.metadata.as_bytes())
            .and_then(|_| handle.sync_all())
            .map_err(|reason| {
                error(
                    "RSI_CREATE_WRITE_FAILED",
                    "Не удалось записать meta.json полностью.",
                    "Проверьте место на диске и права записи.",
                )
                .with_details(reason.to_string())
            })
    })();
    if let Err(initial_error) = result {
        // File handles have been dropped by the inner scope, including on
        // Windows. Only delete our own newly created directory.
        if target.exists() {
            let _ = fs::remove_file(&target);
        }
        if let Err(cleanup) = fs::remove_dir(&folder) {
            return Err(error(
                "RSI_CREATE_CLEANUP_FAILED",
                "После ошибки записи остался неполный каталог RSI.",
                "Проверьте созданную папку вручную, прежде чем повторять.",
            )
            .with_details(format!("{initial_error:?}; очистка: {cleanup}")));
        }
        return Err(initial_error);
    }

    let warning = sync_directory(parent)
        .err()
        .map(|reason| format!("RSI создан, но синхронизация каталога не подтверждена: {reason}"));
    Ok(CreatedRsi {
        path: rendered.path,
        warning,
    })
}

#[cfg(unix)]
fn sync_directory(parent: &Path) -> std::io::Result<()> {
    fs::File::open(parent)?.sync_all()
}

#[cfg(not(unix))]
fn sync_directory(_parent: &Path) -> std::io::Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_ID: AtomicU64 = AtomicU64::new(0);

    struct Fixture {
        root: PathBuf,
    }
    impl Fixture {
        fn new() -> Self {
            let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
            let root =
                std::env::temp_dir().join(format!("ss14-new-rsi-{}-{id}", std::process::id()));
            fs::create_dir_all(root.join("Resources/Textures/Objects")).unwrap();
            Self {
                root: fs::canonicalize(root).unwrap(),
            }
        }
        fn draft(&self) -> RsiDraft {
            RsiDraft {
                directory: "Resources/Textures/Objects".into(),
                name: "example".into(),
                size_x: 32,
                size_y: 32,
                license: "CC-BY-SA-3.0".into(),
                copyright: "Example Author".into(),
            }
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn creates_exclusively_and_never_overwrites_existing_rsi() {
        let fx = Fixture::new();
        let draft = fx.draft();
        let created = create(&fx.root, &draft).unwrap();
        assert_eq!(created.path, "Resources/Textures/Objects/example.rsi");
        let meta = fs::read_to_string(fx.root.join(&created.path).join("meta.json")).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&meta).unwrap();
        assert_eq!(parsed["size"]["x"], 32);
        assert_eq!(parsed["license"], "CC-BY-SA-3.0");
        assert_eq!(parsed["states"].as_array().unwrap().len(), 0);
        assert_eq!(
            create(&fx.root, &draft).unwrap_err().code,
            "RSI_CREATE_EXISTS"
        );
        assert_eq!(
            fs::read_to_string(fx.root.join(&created.path).join("meta.json")).unwrap(),
            meta
        );
    }

    #[test]
    fn rejects_unsafe_paths_names_and_sizes() {
        let fx = Fixture::new();
        for directory in [
            "../Resources/Textures",
            "Resources/Textures/../Secrets",
            "Resources/Locale",
            "Resources\\Textures",
            "/tmp",
            "Resources/Textures//Objects",
            "Resources/Textures/Objects/",
        ] {
            let draft = RsiDraft {
                directory: directory.into(),
                ..fx.draft()
            };
            assert_eq!(
                preview(&draft).unwrap_err().code,
                "RSI_CREATE_PATH_INVALID",
                "{directory}"
            );
        }
        for name in ["", "../evil", "invalid.rsi", "hello world", "ä"] {
            let draft = RsiDraft {
                name: name.into(),
                ..fx.draft()
            };
            assert_eq!(
                preview(&draft).unwrap_err().code,
                "RSI_CREATE_NAME_INVALID",
                "{name}"
            );
        }
        let draft = RsiDraft {
            size_x: 0,
            ..fx.draft()
        };
        assert_eq!(preview(&draft).unwrap_err().code, "RSI_CREATE_SIZE_INVALID");
    }

    #[test]
    fn rejects_nonexistent_parent_and_does_not_create_anything() {
        let fx = Fixture::new();
        let draft = RsiDraft {
            directory: "Resources/Textures/NotHere".into(),
            ..fx.draft()
        };
        assert_eq!(
            create(&fx.root, &draft).unwrap_err().code,
            "RSI_CREATE_PARENT_MISSING"
        );
        assert!(!fx
            .root
            .join("Resources/Textures/NotHere/example.rsi")
            .exists());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinked_parent_even_inside_project() {
        use std::os::unix::fs::symlink;
        let fx = Fixture::new();
        symlink(
            fx.root.join("Resources/Textures/Objects"),
            fx.root.join("Resources/Textures/Linked"),
        )
        .unwrap();
        let draft = RsiDraft {
            directory: "Resources/Textures/Linked".into(),
            ..fx.draft()
        };
        assert_eq!(
            create(&fx.root, &draft).unwrap_err().code,
            "RSI_CREATE_PARENT_INVALID"
        );
    }
}

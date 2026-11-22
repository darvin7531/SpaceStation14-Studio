//! Safe new Fluent file creation. An existing file is never overwritten.
//! We deliberately do not claim semantic Fluent validation in this first slice.
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::StudioError;

const MAX_PATH_BYTES: usize = 512;
const MAX_VALUE_BYTES: usize = 8 * 1024;

#[derive(Debug, Clone, Deserialize)]
pub struct FluentDraft {
    pub file: String,
    pub starter_key: String,
    pub starter_value: String,
    #[serde(default)]
    pub starter_description: Option<String>,
    #[serde(default)]
    pub starter_suffix: Option<String>,
    #[serde(default)]
    pub allow_empty_value: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct FluentPreview {
    pub file: String,
    pub content: String,
    pub warnings: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct CreatedFluent {
    pub file: String,
    pub warning: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ExternalCreatedFluent {
    pub path: String,
    pub warning: Option<String>,
}

fn problem(code: &'static str, message: &str, hint: &str) -> StudioError {
    StudioError::new(code, message, hint)
}

fn validate_path(path: &str) -> Result<(), StudioError> {
    let invalid = || {
        problem(
        "FTL_PATH_INVALID",
        "Имя файла должно иметь вид Resources/Locale/<язык>/имя.ftl.",
        "Укажите путь к .ftl внутри существующей папки языка. Запрещены .., системные символы и обратные слеши.",
    )
    };
    if path.is_empty()
        || path.len() > MAX_PATH_BYTES
        || path.contains('\\')
        || path
            .chars()
            .any(|c| c.is_control() || matches!(c, ':' | '<' | '>' | '|' | '?' | '*' | '"'))
    {
        return Err(invalid());
    }
    let parts: Vec<_> = Path::new(path).components().collect();
    if parts.len() < 4
        || parts
            .iter()
            .any(|part| !matches!(part, Component::Normal(_)))
        || parts[0].as_os_str() != "Resources"
        || parts[1].as_os_str() != "Locale"
        || !path.to_ascii_lowercase().ends_with(".ftl")
    {
        return Err(invalid());
    }
    // Do not allow ambiguous trailing-dot/space names on Windows.
    if path
        .split('/')
        .any(|part| part.ends_with('.') || part.ends_with(' ') || part.is_empty())
    {
        return Err(invalid());
    }
    Ok(())
}

pub fn preview(draft: &FluentDraft) -> Result<FluentPreview, StudioError> {
    validate_path(&draft.file)?;

    let key = &draft.starter_key;
    let key_valid = key.len() <= 128
        && key.bytes().next().is_some_and(|b| b.is_ascii_alphabetic())
        && key
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'));
    if !key_valid {
        return Err(problem(
            "FTL_KEY_INVALID",
            "Начальный Fluent ID должен начинаться с латинской буквы.",
            "Разрешены латинские буквы, цифры, дефис и подчёркивание, максимум 128 символов.",
        ));
    }
    if (draft.starter_value.trim().is_empty()
        && (!draft.allow_empty_value
            || ![
                draft.starter_description.as_deref(),
                draft.starter_suffix.as_deref(),
            ]
            .iter()
            .any(|value| value.is_some_and(|value| !value.trim().is_empty()))))
        || draft.starter_value.len() > MAX_VALUE_BYTES
        || draft
            .starter_value
            .chars()
            .any(|c| c.is_control() || matches!(c, '{' | '}'))
    {
        return Err(problem(
            "FTL_VALUE_INVALID",
            "Начальное значение слишком длинное или содержит неподдерживаемый синтаксис.",
            "Введите непустой однострочный текст до 8 КиБ без фигурных скобок и управляющих символов. Сложные Fluent-выражения добавьте позже в редакторе.",
        ));
    }
    let mut content = if draft.starter_value.is_empty() {
        format!("{key} =\n")
    } else {
        format!("{key} = {}\n", draft.starter_value)
    };
    for (attribute, value) in [
        ("desc", draft.starter_description.as_deref()),
        ("suffix", draft.starter_suffix.as_deref()),
    ] {
        let Some(value) = value.filter(|value| !value.trim().is_empty()) else {
            continue;
        };
        if value.len() > MAX_VALUE_BYTES
            || value
                .chars()
                .any(|c| c.is_control() || matches!(c, '{' | '}'))
        {
            return Err(problem(
                "FTL_VALUE_INVALID",
                "Дополнительное значение Fluent слишком длинное или содержит неподдерживаемый синтаксис.",
                "Для .desc и .suffix используйте однострочный текст без фигурных скобок.",
            ));
        }
        content.push_str(&format!("    .{attribute} = {value}\n"));
    }
    Ok(FluentPreview {
        file: draft.file.clone(),
        content,
        warnings: vec![
            "Studio ещё не проверяет полный синтаксис Fluent и ссылки на ключи локализации.".into(),
        ],
    })
}

pub fn create(root: &Path, draft: &FluentDraft) -> Result<CreatedFluent, StudioError> {
    let rendered = preview(draft)?;
    let scope = root.join("Resources/Locale");
    let canonical_scope = fs::canonicalize(&scope).map_err(|error| {
        problem(
            "FTL_SCOPE_MISSING",
            "Каталог Resources/Locale недоступен.",
            "Создайте каталог локализаций и повторно откройте проект.",
        )
        .with_details(error.to_string())
    })?;
    if !canonical_scope.starts_with(root) {
        return Err(problem(
            "FTL_SCOPE_INVALID",
            "Каталог локализаций оказался за пределами проекта.",
            "Уберите символические ссылки на внешние каталоги.",
        ));
    }

    let target = root.join(&rendered.file);
    let parent = target.parent().ok_or_else(|| {
        problem(
            "FTL_PATH_INVALID",
            "Невозможно определить папку файла локализации.",
            "Укажите корректный относительный путь.",
        )
    })?;
    // Reject symlinks in every destination component, even if they point
    // somewhere inside the selected project checkout.
    let relative = parent.strip_prefix(root).map_err(|_| {
        problem(
            "FTL_PATH_INVALID",
            "Путь вышел за пределы проекта.",
            "Выберите каталог локализаций.",
        )
    })?;
    let mut cursor = PathBuf::from(root);
    for (index, part) in relative.components().enumerate() {
        cursor.push(part);
        // Resources/Locale must already exist; create only descendants, one at a time.
        if index >= 2 {
            match fs::create_dir(&cursor) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(error) => {
                    return Err(problem(
                        "FTL_FOLDER_MISSING",
                        "Не удалось создать папку назначения.",
                        "Проверьте права записи и структуру каталогов.",
                    )
                    .with_details(error.to_string()))
                }
            }
        }
        let meta = fs::symlink_metadata(&cursor).map_err(|error| {
            problem(
                "FTL_FOLDER_MISSING",
                "Папка назначения отсутствует или недоступна.",
                "Создайте нужную папку языка заранее и обновите индекс Studio.",
            )
            .with_details(error.to_string())
        })?;
        if meta.file_type().is_symlink() || !meta.is_dir() {
            return Err(problem(
                "FTL_FOLDER_INVALID",
                "Путь к новой локализации содержит символическую ссылку или файл вместо каталога.",
                "Выберите обычную существующую папку внутри Resources/Locale.",
            ));
        }
    }
    let resolved_parent = fs::canonicalize(parent).map_err(|error| {
        problem(
            "FTL_FOLDER_MISSING",
            "Невозможно открыть папку назначения.",
            "Проверьте структуру каталогов.",
        )
        .with_details(error.to_string())
    })?;
    if !resolved_parent.starts_with(&canonical_scope) {
        return Err(problem(
            "FTL_OUTSIDE_SCOPE",
            "Новая локализация находится вне Resources/Locale.",
            "Выберите каталог внутри Resources/Locale.",
        ));
    }

    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o644);
    }
    let mut handle = options.open(&target).map_err(|error| {
        if error.kind() == std::io::ErrorKind::AlreadyExists {
            problem(
                "FTL_FILE_EXISTS",
                "Такой FTL уже существует. Он не был перезаписан.",
                "Выберите другое имя либо откройте существующий файл для редактирования.",
            )
        } else {
            problem(
                "FTL_CREATE_FAILED",
                "Не удалось создать файл локализации.",
                "Проверьте права записи и доступное место.",
            )
            .with_details(error.to_string())
        }
    })?;
    // Always close the handle before removing an incomplete file. Deleting an
    // open file is unreliable on Windows, even if Unix permits it.
    let written = (|| {
        handle
            .write_all(rendered.content.as_bytes())
            .map_err(|error| {
                problem(
                    "FTL_WRITE_FAILED",
                    "Не удалось полностью записать новый Fluent-файл.",
                    "Проверьте диск и повторите операцию.",
                )
                .with_details(error.to_string())
            })?;
        handle.sync_all().map_err(|error| {
            problem(
                "FTL_SYNC_FAILED",
                "Не удалось подтвердить запись FTL на диск.",
                "Проверьте диск и повторите операцию.",
            )
            .with_details(error.to_string())
        })
    })();
    drop(handle);
    if let Err(error) = written {
        if let Err(cleanup_error) = fs::remove_file(&target) {
            return Err(problem(
                "FTL_CLEANUP_FAILED",
                "После ошибки записи не удалось удалить неполный FTL.",
                "Проверьте файл вручную, прежде чем повторять создание.",
            )
            .with_details(format!(
                "Исходная ошибка: {error:?}; удаление: {cleanup_error}"
            )));
        }
        return Err(error);
    }
    let warning = sync_directory(parent)
        .err()
        .map(|error| format!("FTL создан, но синхронизация каталога не подтверждена: {error}"));
    Ok(CreatedFluent {
        file: rendered.file,
        warning,
    })
}

/// Only call from a native OS save dialog; the frontend cannot choose arbitrary paths.
pub fn create_external_at(
    chosen_path: &Path,
    draft: &FluentDraft,
) -> Result<ExternalCreatedFluent, StudioError> {
    let rendered = preview(draft)?;
    if chosen_path
        .extension()
        .and_then(|extension| extension.to_str())
        != Some("ftl")
    {
        return Err(problem(
            "FTL_EXTERNAL_EXTENSION",
            "Внешняя локализация должна иметь расширение .ftl.",
            "Выберите имя файла с расширением .ftl.",
        ));
    }
    let parent = chosen_path.parent().ok_or_else(|| {
        problem(
            "FTL_EXTERNAL_PATH_INVALID",
            "Не удалось определить папку назначения.",
            "Выберите корректный путь в системном диалоге.",
        )
    })?;
    let parent = fs::canonicalize(parent).map_err(|reason| {
        problem(
            "FTL_EXTERNAL_PARENT_MISSING",
            "Папка для внешнего FTL недоступна.",
            "Укажите существующий каталог.",
        )
        .with_details(reason.to_string())
    })?;
    if !parent.is_dir() {
        return Err(problem(
            "FTL_EXTERNAL_PARENT_INVALID",
            "Путь назначения не является каталогом.",
            "Выберите существующую папку.",
        ));
    }
    let filename = chosen_path.file_name().ok_or_else(|| {
        problem(
            "FTL_EXTERNAL_PATH_INVALID",
            "Не указано имя внешнего файла.",
            "Укажите имя с расширением .ftl.",
        )
    })?;
    let target = parent.join(filename);
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o644);
    }
    let mut handle = options.open(&target).map_err(|reason| {
        if reason.kind() == std::io::ErrorKind::AlreadyExists {
            problem(
                "FTL_FILE_EXISTS",
                "Внешний FTL уже существует и не будет перезаписан.",
                "Выберите другое имя файла.",
            )
        } else {
            problem(
                "FTL_CREATE_FAILED",
                "Не удалось создать внешний FTL.",
                "Проверьте права записи и место на диске.",
            )
            .with_details(reason.to_string())
        }
    })?;
    let write = handle
        .write_all(rendered.content.as_bytes())
        .and_then(|_| handle.sync_all());
    drop(handle);
    if let Err(reason) = write {
        if let Err(cleanup) = fs::remove_file(&target) {
            return Err(problem(
                "FTL_CLEANUP_FAILED",
                "После ошибки записи остался неполный внешний FTL.",
                "Проверьте файл вручную перед повторной попыткой.",
            )
            .with_details(format!("{reason}; очистка: {cleanup}")));
        }
        return Err(problem(
            "FTL_WRITE_FAILED",
            "Не удалось полностью записать внешний FTL.",
            "Проверьте носитель и повторите создание.",
        )
        .with_details(reason.to_string()));
    }
    let warning = sync_directory(&parent)
        .err()
        .map(|reason| format!("FTL создан, но синхронизация каталога не подтверждена: {reason}"));
    Ok(ExternalCreatedFluent {
        path: target.to_string_lossy().into_owned(),
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

    static NEXT_TEST: AtomicU64 = AtomicU64::new(0);

    struct Fixture {
        root: PathBuf,
    }
    impl Fixture {
        fn new() -> Self {
            let id = NEXT_TEST.fetch_add(1, Ordering::Relaxed);
            let path =
                std::env::temp_dir().join(format!("ss14-ftl-new-{}-{id}", std::process::id()));
            fs::create_dir_all(path.join("Resources/Prototypes")).unwrap();
            fs::create_dir_all(path.join("Resources/Locale/en-US")).unwrap();
            Self {
                root: fs::canonicalize(path).unwrap(),
            }
        }
        fn draft(&self) -> FluentDraft {
            FluentDraft {
                file: "Resources/Locale/en-US/new.ftl".into(),
                starter_key: "item-example".into(),
                starter_value: "Example item".into(),
                starter_description: None,
                starter_suffix: None,
                allow_empty_value: false,
            }
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn creates_new_fluent_only_once() {
        let fx = Fixture::new();
        let draft = fx.draft();
        let created = create(&fx.root, &draft).unwrap();
        assert_eq!(created.file, draft.file);
        assert_eq!(
            fs::read_to_string(fx.root.join(&draft.file)).unwrap(),
            "item-example = Example item\n"
        );
        let error = create(&fx.root, &draft).unwrap_err();
        assert_eq!(error.code, "FTL_FILE_EXISTS");
        assert_eq!(
            fs::read_to_string(fx.root.join(&draft.file)).unwrap(),
            "item-example = Example item\n"
        );
    }

    #[test]
    fn restores_electron_entity_quickfix_with_full_fluent_block() {
        let fx = Fixture::new();
        let draft = FluentDraft {
            starter_key: "ent-Example".into(),
            starter_value: "Example name".into(),
            starter_description: Some("Entity description".into()),
            starter_suffix: Some("Special".into()),
            ..fx.draft()
        };
        let expected =
            "ent-Example = Example name\n    .desc = Entity description\n    .suffix = Special\n";
        assert_eq!(preview(&draft).unwrap().content, expected);
        create(&fx.root, &draft).unwrap();
        assert_eq!(
            fs::read_to_string(fx.root.join(&draft.file)).unwrap(),
            expected
        );
        assert_eq!(
            create(&fx.root, &draft).unwrap_err().code,
            "FTL_FILE_EXISTS"
        );
    }

    #[test]
    fn creates_attribute_only_message_without_overwriting() {
        let fx = Fixture::new();
        let draft = FluentDraft {
            starter_value: String::new(),
            starter_description: Some("Description".into()),
            allow_empty_value: true,
            ..fx.draft()
        };
        assert_eq!(
            preview(&draft).unwrap().content,
            "item-example =\n    .desc = Description\n"
        );
        create(&fx.root, &draft).unwrap();
        assert_eq!(
            create(&fx.root, &draft).unwrap_err().code,
            "FTL_FILE_EXISTS"
        );
        let empty = FluentDraft {
            starter_description: None,
            ..draft
        };
        assert_eq!(preview(&empty).unwrap_err().code, "FTL_VALUE_INVALID");
    }

    #[test]
    fn rejects_unsafe_optional_entity_attributes_before_any_write() {
        let fx = Fixture::new();
        for unsafe_value in ["bad\nnew-key = injected", "{ variable }", "bad\rvalue"] {
            let draft = FluentDraft {
                starter_description: Some(unsafe_value.into()),
                ..fx.draft()
            };
            assert_eq!(preview(&draft).unwrap_err().code, "FTL_VALUE_INVALID");
            assert!(!fx.root.join(&draft.file).exists());
        }
    }

    #[test]
    fn reject_parent_escape_and_wrong_resource_scope() {
        let fx = Fixture::new();
        for path in [
            "../secret.ftl",
            "Resources/Locale/../Prototypes/malicious.ftl",
            "Resources/Prototypes/test.ftl",
            "Resources/Locale/a.ftl",
            "Resources\\Locale\\en-US\\test.ftl",
            "/tmp/evil.ftl",
            "Resources/Locale/en-US/test.ftl/",
        ] {
            let draft = FluentDraft {
                file: path.into(),
                ..fx.draft()
            };
            assert_eq!(
                preview(&draft).unwrap_err().code,
                "FTL_PATH_INVALID",
                "{path}"
            );
        }
    }

    #[test]
    fn rejects_invalid_starter_fields() {
        let fx = Fixture::new();
        for key in ["", "1invalid", "with space", "bad.name"] {
            let draft = FluentDraft {
                starter_key: key.into(),
                ..fx.draft()
            };
            assert_eq!(preview(&draft).unwrap_err().code, "FTL_KEY_INVALID");
        }
        for invalid in ["", "   ", "hello\ninjection", "{ dangerous }"] {
            let invalid_value = FluentDraft {
                starter_value: invalid.into(),
                ..fx.draft()
            };
            assert_eq!(
                preview(&invalid_value).unwrap_err().code,
                "FTL_VALUE_INVALID"
            );
        }
    }

    #[test]
    fn external_fluent_creation_rejects_overwrite_and_invalid_extension() {
        let fx = Fixture::new();
        let target = fx.root.join("external.ftl");
        let draft = fx.draft();
        let result = create_external_at(&target, &draft).unwrap();
        assert_eq!(result.path, target.to_string_lossy());
        assert_eq!(
            fs::read_to_string(&target).unwrap(),
            "item-example = Example item\n"
        );
        assert_eq!(
            create_external_at(&target, &draft).unwrap_err().code,
            "FTL_FILE_EXISTS"
        );
        assert_eq!(
            create_external_at(&fx.root.join("wrong.txt"), &draft)
                .unwrap_err()
                .code,
            "FTL_EXTERNAL_EXTENSION"
        );
    }

    #[test]
    fn creates_missing_parent_directories() {
        let fx = Fixture::new();
        let draft = FluentDraft {
            file: "Resources/Locale/ru-RU/nested/new.ftl".into(),
            ..fx.draft()
        };
        create(&fx.root, &draft).unwrap();
        assert!(fx.root.join(&draft.file).is_file());
    }

    #[test]
    fn later_failure_preserves_successful_creation() {
        let fx = Fixture::new();
        let first = fx.draft();
        create(&fx.root, &first).unwrap();
        let second = FluentDraft {
            starter_value: "{invalid}".into(),
            file: "Resources/Locale/en-US/other.ftl".into(),
            ..fx.draft()
        };
        assert_eq!(
            create(&fx.root, &second).unwrap_err().code,
            "FTL_VALUE_INVALID"
        );
        assert_eq!(
            fs::read_to_string(fx.root.join(&first.file)).unwrap(),
            "item-example = Example item\n"
        );
        assert!(!fx.root.join(&second.file).exists());
    }

    #[cfg(unix)]
    #[test]
    fn refuses_symlink_before_creating_nested_directories() {
        use std::os::unix::fs::symlink;
        let fx = Fixture::new();
        let outside = fx.root.join("outside");
        fs::create_dir(&outside).unwrap();
        symlink(&outside, fx.root.join("Resources/Locale/link")).unwrap();
        let draft = FluentDraft {
            file: "Resources/Locale/link/nested/new.ftl".into(),
            ..fx.draft()
        };
        assert_eq!(
            create(&fx.root, &draft).unwrap_err().code,
            "FTL_FOLDER_INVALID"
        );
        assert!(!outside.join("nested").exists());
    }

    #[cfg(unix)]
    #[test]
    fn refuses_symlink_to_parent_inside_project() {
        use std::os::unix::fs::symlink;
        let fx = Fixture::new();
        fs::create_dir_all(fx.root.join("Resources/Locale/actual")).unwrap();
        symlink(
            fx.root.join("Resources/Locale/actual"),
            fx.root.join("Resources/Locale/linked"),
        )
        .unwrap();
        let draft = FluentDraft {
            file: "Resources/Locale/linked/new.ftl".into(),
            ..fx.draft()
        };
        assert_eq!(
            create(&fx.root, &draft).unwrap_err().code,
            "FTL_FOLDER_INVALID"
        );
    }
}

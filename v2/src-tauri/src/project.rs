use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::error::StudioError;

const MAX_WALK_ENTRIES: usize = 250_000;

/// An inventory, NOT the number of parsed prototypes. Parsing is a later step.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ProjectOverview {
    pub project_root: String,
    pub prototype_files: usize,
    pub rsi_directories: usize,
    pub locale_files: usize,
    pub warnings: Vec<String>,
}

#[derive(Clone, Copy)]
enum Scope {
    Prototypes,
    Textures,
    Locale,
}

pub fn inspect_project(input: &str) -> Result<ProjectOverview, StudioError> {
    if input.trim().is_empty() {
        return Err(StudioError::new(
            "PROJECT_PATH_EMPTY",
            "Путь к проекту не указан.",
            "Укажите корневую папку исходников SS14, содержащую Resources/Prototypes.",
        ));
    }

    let requested = Path::new(input.trim());
    let root = fs::canonicalize(requested).map_err(|error| {
        let (code, message, hint) = match error.kind() {
            std::io::ErrorKind::NotFound => (
                "PROJECT_NOT_FOUND",
                "Указанная папка проекта не найдена.",
                "Проверьте путь и убедитесь, что диск или каталог доступен.",
            ),
            std::io::ErrorKind::PermissionDenied => (
                "PROJECT_ACCESS_DENIED",
                "Нет доступа к папке проекта.",
                "Проверьте права чтения и доступность расположения проекта.",
            ),
            _ => (
                "PROJECT_OPEN_FAILED",
                "Не удалось открыть папку проекта.",
                "Проверьте путь, права доступа и состояние диска.",
            ),
        };
        StudioError::new(code, message, hint).with_details(error.to_string())
    })?;

    if !root.is_dir() {
        return Err(StudioError::new(
            "PROJECT_NOT_DIRECTORY",
            "Указанный путь ведёт к файлу, а не к папке.",
            "Выберите корневую директорию репозитория SS14.",
        ));
    }

    let resources = root.join("Resources");
    let prototypes = resources.join("Prototypes");
    if !prototypes.is_dir() {
        return Err(StudioError::new(
            "PROJECT_STRUCTURE_INVALID",
            "В выбранной папке отсутствует Resources/Prototypes.",
            "Откройте корень исходников SS14, а не папку Resources или отдельный YAML-файл.",
        )
        .with_details(prototypes.display().to_string()));
    }

    let prototype_files = walk_scope(&prototypes, Scope::Prototypes)?;
    let rsi_directories = walk_scope(&resources.join("Textures"), Scope::Textures)?;
    let locale_files = walk_scope(&resources.join("Locale"), Scope::Locale)?;

    let mut warnings = Vec::new();
    if !resources.join("Textures").is_dir() {
        warnings.push("Папка Resources/Textures не найдена: RSI не подсчитаны.".into());
    }
    if !resources.join("Locale").is_dir() {
        warnings.push("Папка Resources/Locale не найдена: локализации не подсчитаны.".into());
    }
    if prototype_files == 0 {
        warnings.push("В Resources/Prototypes пока не найдены YAML-файлы.".into());
    }

    Ok(ProjectOverview {
        project_root: root.to_string_lossy().into_owned(),
        prototype_files,
        rsi_directories,
        locale_files,
        warnings,
    })
}

fn walk_scope(root: &Path, scope: Scope) -> Result<usize, StudioError> {
    if !root.exists() {
        return Ok(0);
    }

    let mut stack: Vec<PathBuf> = vec![root.to_path_buf()];
    let mut visited = 0usize;
    let mut found = 0usize;

    while let Some(folder) = stack.pop() {
        let entries = fs::read_dir(&folder).map_err(|error| scan_error(&folder, error))?;
        for result in entries {
            let entry = result.map_err(|error| scan_error(&folder, error))?;
            visited += 1;
            if visited > MAX_WALK_ENTRIES {
                return Err(StudioError::new(
                    "PROJECT_SCAN_LIMIT",
                    "Проект содержит слишком много файлов для начального сканера.",
                    "Уменьшите область сканирования или дождитесь внедрения инкрементального индексатора.",
                ));
            }

            let kind = entry
                .file_type()
                .map_err(|error| scan_error(&entry.path(), error))?;
            // Deliberately do not follow symlinks: avoids cycles and escaping the chosen root.
            if kind.is_symlink() {
                continue;
            }

            let path = entry.path();
            if kind.is_dir() {
                if matches!(scope, Scope::Textures) && has_extension(&path, "rsi") {
                    found += 1;
                } else {
                    stack.push(path);
                }
            } else if kind.is_file() {
                let matched = match scope {
                    Scope::Prototypes => {
                        has_extension(&path, "yaml") || has_extension(&path, "yml")
                    }
                    Scope::Textures => false,
                    Scope::Locale => has_extension(&path, "ftl"),
                };
                if matched {
                    found += 1;
                }
            }
        }
    }
    Ok(found)
}

fn has_extension(path: &Path, extension: &str) -> bool {
    path.extension()
        .and_then(|part| part.to_str())
        .is_some_and(|part| part.eq_ignore_ascii_case(extension))
}

fn scan_error(path: &Path, error: std::io::Error) -> StudioError {
    StudioError::new(
        "PROJECT_SCAN_FAILED",
        "Не удалось прочитать один из каталогов проекта.",
        "Проверьте права доступа и целостность файлов проекта.",
    )
    .with_details(format!("{}: {}", path.display(), error))
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
            let n = NEXT_ID.fetch_add(1, Ordering::Relaxed);
            let root = std::env::temp_dir().join(format!(
                "ss14-studio-v2-{}-{}",
                std::process::id(),
                n
            ));
            fs::create_dir_all(root.join("Resources/Prototypes")).unwrap();
            Self { root }
        }

        fn write(&self, file: &str, contents: &str) {
            let path = self.root.join(file);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, contents).unwrap();
        }

        fn root_str(&self) -> &str {
            self.root.to_str().unwrap()
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn empty_path_has_explained_error() {
        let error = inspect_project("   ").unwrap_err();
        assert_eq!(error.code, "PROJECT_PATH_EMPTY");
        assert!(!error.message.is_empty());
        assert!(!error.hint.is_empty());
    }

    #[test]
    fn missing_project_has_explained_error() {
        let test = Fixture::new();
        let absent = test.root.join("does-not-exist");
        let error = inspect_project(absent.to_str().unwrap()).unwrap_err();
        assert_eq!(error.code, "PROJECT_NOT_FOUND");
        assert!(!error.hint.is_empty());
    }

    #[test]
    fn invalid_structure_is_reported() {
        let test = Fixture::new();
        fs::remove_dir(test.root.join("Resources/Prototypes")).unwrap();
        let error = inspect_project(test.root_str()).unwrap_err();
        assert_eq!(error.code, "PROJECT_STRUCTURE_INVALID");
    }

    #[test]
    fn file_is_not_project_directory() {
        let test = Fixture::new();
        test.write("file.txt", "data");
        let path = test.root.join("file.txt");
        let error = inspect_project(path.to_str().unwrap()).unwrap_err();
        assert_eq!(error.code, "PROJECT_NOT_DIRECTORY");
    }

    #[test]
    fn inventories_nested_resources_and_extensions() {
        let test = Fixture::new();
        test.write("Resources/Prototypes/Entities/item.yml", "- type: entity");
        test.write("Resources/Prototypes/Entities/other.YAML", "- type: entity");
        test.write("Resources/Prototypes/readme.txt", "ignored");
        test.write("Resources/Textures/Objects/tools.rsi/meta.json", "{}");
        test.write("Resources/Locale/en-US/items.ftl", "item = Item");

        let result = inspect_project(test.root_str()).unwrap();
        assert_eq!(result.prototype_files, 2);
        assert_eq!(result.rsi_directories, 1);
        assert_eq!(result.locale_files, 1);
        assert!(result.warnings.is_empty());
    }

    #[test]
    fn optional_resource_directories_are_warnings() {
        let test = Fixture::new();
        let result = inspect_project(test.root_str()).unwrap();
        assert_eq!(result.prototype_files, 0);
        assert_eq!(result.rsi_directories, 0);
        assert_eq!(result.locale_files, 0);
        assert_eq!(result.warnings.len(), 3);
    }
}

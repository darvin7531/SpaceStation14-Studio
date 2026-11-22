//! Indexed read-only SS14 UI source explorer: XAML/Avalonia and code-behind.
use std::collections::HashSet;
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::error::StudioError;
use crate::project::ResourceDocument;
use crate::resource_edit::revision;

const MAX_VISITED: usize = 100_000;
const MAX_ITEMS: usize = 30_000;
const MAX_PAGE: usize = 100;
const MAX_PREVIEW_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
pub struct UiSourceEntry {
    pub path: String,
    /// xaml, code_behind, or code
    pub kind: &'static str,
    pub paired_with: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct UiSourcePage {
    pub total: usize,
    pub items: Vec<UiSourceEntry>,
    pub files_scanned: usize,
    pub complete: bool,
    pub warnings: Vec<String>,
}

#[derive(Debug)]
pub struct UiSourceCatalog {
    items: Vec<UiSourceEntry>,
    indexed: HashSet<String>,
    files_scanned: usize,
    complete: bool,
    warnings: Vec<String>,
}

fn kind_for(path: &str) -> Option<&'static str> {
    let lower = path.to_ascii_lowercase();
    if lower.ends_with(".xaml") || lower.ends_with(".axaml") {
        Some("xaml")
    } else if lower.ends_with(".xaml.cs") || lower.ends_with(".axaml.cs") {
        Some("code_behind")
    } else if lower.ends_with(".cs")
        && path.split('/').any(|part| {
            part.eq_ignore_ascii_case("UserInterface")
                || part.eq_ignore_ascii_case("UI")
                || part.eq_ignore_ascii_case("UserInterfaces")
        })
    {
        Some("code")
    } else {
        None
    }
}

fn sibling(path: &str, kind: &str) -> Option<String> {
    match kind {
        "xaml" => Some(format!("{path}.cs")),
        "code_behind" => path.strip_suffix(".cs").map(str::to_owned),
        _ => None,
    }
}

fn error(code: &'static str, message: &str, hint: &str) -> StudioError {
    StudioError::new(code, message, hint)
}

impl UiSourceCatalog {
    pub fn scan(root: &Path) -> Result<Self, StudioError> {
        let mut items = Vec::new();
        let mut warnings = Vec::new();
        let mut complete = true;
        let mut visited = 0usize;
        let mut files_scanned = 0usize;
        let mut roots = Vec::new();
        for entry in fs::read_dir(root).map_err(|cause| {
            error(
                "UI_INDEX_ROOT_UNAVAILABLE",
                "Не удалось перечислить каталоги проекта.",
                "Проверьте права чтения корня проекта.",
            )
            .with_details(cause.to_string())
        })? {
            let entry = match entry {
                Ok(entry) => entry,
                Err(_) => {
                    complete = false;
                    continue;
                }
            };
            let name = entry.file_name();
            if !name.to_string_lossy().starts_with("Content.") {
                continue;
            }
            if entry
                .file_type()
                .is_ok_and(|kind| kind.is_dir() && !kind.is_symlink())
            {
                roots.push(entry.path());
            }
        }
        roots.sort_unstable();
        let mut stack: Vec<PathBuf> = roots.into_iter().rev().collect();
        'scan: while let Some(folder) = stack.pop() {
            let mut children = Vec::new();
            let entries = match fs::read_dir(&folder) {
                Ok(entries) => entries,
                Err(_) => {
                    complete = false;
                    if warnings.len() < 8 {
                        warnings.push(format!("Каталог недоступен: {}", folder.display()));
                    }
                    continue;
                }
            };
            for entry in entries {
                match entry {
                    Ok(entry) => children.push(entry),
                    Err(_) => complete = false,
                }
            }
            children.sort_unstable_by_key(|entry| entry.file_name());
            for entry in children {
                visited += 1;
                if visited > MAX_VISITED || items.len() >= MAX_ITEMS {
                    complete = false;
                    warnings.push("Индекс UI-исходников достиг лимита; показаны только первые найденные файлы.".into());
                    break 'scan;
                }
                let entry_path = entry.path();
                let kind = match entry.file_type() {
                    Ok(kind) if !kind.is_symlink() => kind,
                    Ok(_) => continue,
                    Err(_) => {
                        complete = false;
                        continue;
                    }
                };
                if kind.is_dir() {
                    let name = entry.file_name();
                    if matches!(
                        name.to_str(),
                        Some("obj" | "bin" | ".git" | "node_modules" | "target")
                    ) {
                        continue;
                    }
                    stack.push(entry_path);
                    continue;
                }
                if !kind.is_file() {
                    continue;
                }
                files_scanned += 1;
                let Ok(relative) = entry_path.strip_prefix(root) else {
                    continue;
                };
                let Some(relative) = relative.to_str() else {
                    complete = false;
                    continue;
                };
                let path = relative.replace('\\', "/");
                if let Some(kind) = kind_for(&path) {
                    items.push(UiSourceEntry {
                        path,
                        kind,
                        paired_with: None,
                    });
                }
            }
        }
        items.sort_unstable_by(|a, b| a.path.cmp(&b.path));
        let indexed: HashSet<String> = items.iter().map(|entry| entry.path.clone()).collect();
        for entry in &mut items {
            entry.paired_with =
                sibling(&entry.path, entry.kind).filter(|sibling| indexed.contains(sibling));
        }
        Ok(Self {
            items,
            indexed,
            files_scanned,
            complete,
            warnings,
        })
    }

    pub fn page(&self, query: &str, offset: usize, limit: usize) -> UiSourcePage {
        let query = query.trim().to_lowercase();
        let mut total = 0usize;
        let count = limit.clamp(1, MAX_PAGE);
        let mut items = Vec::with_capacity(count);
        for entry in &self.items {
            if !query.is_empty() && !entry.path.to_lowercase().contains(&query) {
                continue;
            }
            if total >= offset && items.len() < count {
                items.push(entry.clone());
            }
            total += 1;
        }
        UiSourcePage {
            total,
            items,
            files_scanned: self.files_scanned,
            complete: self.complete,
            warnings: self.warnings.clone(),
        }
    }

    pub fn read(&self, root: &Path, path: &str) -> Result<ResourceDocument, StudioError> {
        if !self.indexed.contains(path) {
            return Err(error(
                "UI_SOURCE_NOT_INDEXED",
                "UI-исходник не найден в индексе проекта.",
                "Выберите файл из каталога UI и обновите индекс при внешнем изменении.",
            ));
        }
        let absolute = root.join(path);
        let metadata = fs::symlink_metadata(&absolute).map_err(|cause| {
            error(
                "UI_SOURCE_UNAVAILABLE",
                "Не удалось открыть UI-исходник.",
                "Проверьте, что файл ещё существует.",
            )
            .with_details(cause.to_string())
        })?;
        if !metadata.file_type().is_file() || metadata.len() > MAX_PREVIEW_BYTES {
            return Err(error(
                "UI_SOURCE_SIZE_INVALID",
                "UI-исходник не является обычным файлом или превышает 2 МиБ.",
                "Для больших файлов используйте внешний редактор.",
            ));
        }
        let canonical = fs::canonicalize(&absolute).map_err(|cause| {
            error(
                "UI_SOURCE_UNAVAILABLE",
                "Не удалось проверить путь UI-исходника.",
                "Обновите индекс и проверьте права на файл.",
            )
            .with_details(cause.to_string())
        })?;
        if !canonical.starts_with(root) {
            return Err(error(
                "UI_SOURCE_OUTSIDE_PROJECT",
                "Файл UI оказался вне текущего проекта.",
                "Нельзя открывать исходники через внешние символические ссылки.",
            ));
        }
        let mut bytes = Vec::new();
        File::open(&canonical)
            .and_then(|file| file.take(MAX_PREVIEW_BYTES + 1).read_to_end(&mut bytes))
            .map_err(|cause| {
                error(
                    "UI_SOURCE_READ_FAILED",
                    "Не удалось прочитать UI-исходник.",
                    "Проверьте доступность файла и диска.",
                )
                .with_details(cause.to_string())
            })?;
        if bytes.len() as u64 > MAX_PREVIEW_BYTES {
            return Err(error(
                "UI_SOURCE_SIZE_INVALID",
                "UI-исходник вырос при чтении и превысил лимит 2 МиБ.",
                "Откройте файл во внешнем редакторе.",
            ));
        }
        let content = String::from_utf8(bytes).map_err(|cause| {
            error(
                "UI_SOURCE_ENCODING_INVALID",
                "UI-исходник не является UTF-8.",
                "Проверьте кодировку файла.",
            )
            .with_details(cause.to_string())
        })?;
        Ok(ResourceDocument {
            path: path.to_owned(),
            bytes: content.len(),
            revision: revision(content.as_bytes()),
            content,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    struct Fixture {
        root: PathBuf,
    }
    impl Fixture {
        fn new() -> Self {
            let id = NEXT.fetch_add(1, Ordering::Relaxed);
            let root = std::env::temp_dir()
                .join(format!("ss14-studio-ui-index-{}-{id}", std::process::id()));
            fs::create_dir_all(root.join("Content.Client/UserInterface")).unwrap();
            Self {
                root: fs::canonicalize(root).unwrap(),
            }
        }
        fn write(&self, path: &str, bytes: &[u8]) {
            let full = self.root.join(path);
            fs::create_dir_all(full.parent().unwrap()).unwrap();
            fs::write(full, bytes).unwrap();
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn indexes_markup_code_behind_and_ui_csharp_with_pairing_and_pagination() {
        let fx = Fixture::new();
        fx.write("Content.Client/UserInterface/Inventory.xaml", b"<Window />");
        fx.write(
            "Content.Client/UserInterface/Inventory.xaml.cs",
            b"class Inventory {}",
        );
        fx.write("Content.Client/UserInterface/Menu.cs", b"class Menu {}");
        fx.write("Content.Client/Systems/Movement.cs", b"class Movement {}");
        fx.write("Content.Shared/Shared.axaml", b"<UserControl />");
        let catalog = UiSourceCatalog::scan(&fx.root).unwrap();
        let page = catalog.page("", 0, 100);
        assert_eq!(page.total, 4);
        let markup = page
            .items
            .iter()
            .find(|item| item.path.ends_with("Inventory.xaml"))
            .unwrap();
        assert_eq!(markup.kind, "xaml");
        assert_eq!(
            markup.paired_with.as_deref(),
            Some("Content.Client/UserInterface/Inventory.xaml.cs")
        );
        let partner = page
            .items
            .iter()
            .find(|item| item.path.ends_with("Inventory.xaml.cs"))
            .unwrap();
        assert_eq!(partner.kind, "code_behind");
        assert_eq!(
            partner.paired_with.as_deref(),
            Some("Content.Client/UserInterface/Inventory.xaml")
        );
        assert_eq!(catalog.page("inventory", 0, 1).total, 2);
        assert_eq!(catalog.page("inventory", 1, 1).items.len(), 1);
        assert!(catalog.page("inventory", 2, 1).items.is_empty());
        assert_eq!(
            catalog.read(&fx.root, &markup.path).unwrap().content,
            "<Window />"
        );
    }

    #[test]
    fn requires_exact_indexed_path_and_valid_utf8_and_size_limit() {
        let fx = Fixture::new();
        let known = "Content.Client/UserInterface/Main.xaml";
        fx.write(known, b"<Panel />");
        fx.write("Content.Client/secret.json", b"secret");
        let catalog = UiSourceCatalog::scan(&fx.root).unwrap();
        assert_eq!(
            catalog.read(&fx.root, "../secret.json").unwrap_err().code,
            "UI_SOURCE_NOT_INDEXED"
        );
        assert_eq!(
            catalog
                .read(&fx.root, "Content.Client/secret.json")
                .unwrap_err()
                .code,
            "UI_SOURCE_NOT_INDEXED"
        );
        fx.write(known, b"\xff");
        assert_eq!(
            catalog.read(&fx.root, known).unwrap_err().code,
            "UI_SOURCE_ENCODING_INVALID"
        );
        fx.write(known, &vec![b'x'; MAX_PREVIEW_BYTES as usize + 1]);
        assert_eq!(
            catalog.read(&fx.root, known).unwrap_err().code,
            "UI_SOURCE_SIZE_INVALID"
        );
    }

    #[cfg(unix)]
    #[test]
    fn refuses_source_symlink_replaced_after_scan() {
        use std::os::unix::fs::symlink;
        let fx = Fixture::new();
        let path = "Content.Client/UserInterface/Unsafe.xaml";
        fx.write(path, b"<Window/>");
        let catalog = UiSourceCatalog::scan(&fx.root).unwrap();
        fs::remove_file(fx.root.join(path)).unwrap();
        symlink("/etc/hosts", fx.root.join(path)).unwrap();
        assert_eq!(
            catalog.read(&fx.root, path).unwrap_err().code,
            "UI_SOURCE_SIZE_INVALID"
        );
    }

    #[cfg(unix)]
    #[test]
    fn does_not_follow_ui_directory_symlinks() {
        use std::os::unix::fs::symlink;
        let fx = Fixture::new();
        fx.write("Outside.xaml", b"private");
        symlink(&fx.root, fx.root.join("Content.Client/UserInterface/Loop")).unwrap();
        let external = fx.root.join("Outside.xaml");
        symlink(
            &external,
            fx.root.join("Content.Client/UserInterface/External.xaml"),
        )
        .unwrap();
        let page = UiSourceCatalog::scan(&fx.root).unwrap().page("", 0, 50);
        assert!(page.items.is_empty());
    }
}

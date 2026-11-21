//! Conservative generation and creation of a *new* SS14 YAML prototype file.
//! Source-level editing of an existing YAML block belongs to a separate CST
//! workflow. This module never appends to or overwrites existing files.
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Component, Path};

use serde::{Deserialize, Serialize};

use crate::error::StudioError;
use crate::resource_edit::validate_yaml;

const MAX_FIELD_CHARS: usize = 2048;

#[derive(Debug, Clone, Deserialize)]
pub struct PrototypeDraft {
    pub kind: String,
    pub id: String,
    pub parent: String,
    pub name: String,
    pub description: String,
    pub abstract_prototype: bool,
    pub sprite: String,
    pub sprite_state: String,
    pub include_item: bool,
    pub include_physics: bool,
    pub include_appearance: bool,
    pub file: String,
}

#[derive(Debug, Serialize)]
pub struct PrototypePreview {
    pub file: String,
    pub kind: String,
    pub id: String,
    pub yaml: String,
    pub warnings: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct CreatedPrototype {
    pub file: String,
    pub kind: String,
    pub id: String,
    pub yaml: String,
    pub warning: Option<String>,
}

fn invalid(code: &'static str, message: &str, hint: &str) -> StudioError {
    StudioError::new(code, message, hint)
}

fn legal_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'-' | b'.'))
}

fn yaml_string(value: &str) -> Result<String, StudioError> {
    serde_json::to_string(value).map_err(|error| {
        invalid(
            "PROTOTYPE_SERIALIZATION_FAILED",
            "Не удалось безопасно подготовить строку YAML.",
            "Проверьте текстовые поля прототипа.",
        )
        .with_details(error.to_string())
    })
}

pub fn preview(draft: &PrototypeDraft) -> Result<PrototypePreview, StudioError> {
    if !legal_identifier(&draft.kind) || !legal_identifier(&draft.id) {
        return Err(invalid(
             "PROTOTYPE_ID_INVALID",
             "Тип и ID прототипа должны содержать только буквы ASCII, цифры, «_», «-» и «.».",
             "Укажите непустые значения длиной до 128 символов. Для специальных ID используйте ручной YAML-редактор.",
         ));
    }
    if !draft.parent.is_empty() && !legal_identifier(&draft.parent) {
        return Err(invalid(
            "PROTOTYPE_PARENT_INVALID",
            "Идентификатор родителя содержит неподдерживаемые символы.",
            "Укажите один обычный ID. Сложные или динамические ссылки редактируются вручную.",
        ));
    }
    for text in [
        &draft.name,
        &draft.description,
        &draft.sprite,
        &draft.sprite_state,
    ] {
        if text.chars().count() > MAX_FIELD_CHARS
            || text
                .chars()
                .any(|c| c == '\0' || (c.is_control() && c != '\n' && c != '\r' && c != '\t'))
        {
            return Err(invalid(
                "PROTOTYPE_FIELD_INVALID",
                "Слишком длинное текстовое поле или недопустимый управляющий символ.",
                "Уменьшите текст до 2048 символов на поле и удалите управляющие символы.",
            ));
        }
    }
    if draft.kind != "entity"
        && (!draft.sprite.is_empty()
            || !draft.sprite_state.is_empty()
            || draft.include_item
            || draft.include_physics
            || draft.include_appearance)
    {
        return Err(invalid(
            "PROTOTYPE_COMPONENTS_INVALID",
            "Готовые компоненты этого мастера доступны только для типа entity.",
            "Для других типов используйте только общие поля или редактируйте YAML вручную.",
        ));
    }
    if !draft.sprite_state.is_empty() && draft.sprite.is_empty() {
        return Err(invalid(
            "PROTOTYPE_SPRITE_INVALID",
            "Для состояния спрайта требуется путь к RSI.",
            "Укажите RSI либо уберите состояние спрайта.",
        ));
    }
    validate_target(&draft.file)?;

    let mut lines = vec![
        format!("- type: {}", yaml_string(&draft.kind)?),
        format!("  id: {}", yaml_string(&draft.id)?),
    ];
    if !draft.parent.is_empty() {
        lines.push(format!("  parent: {}", yaml_string(&draft.parent)?));
    }
    if draft.abstract_prototype {
        lines.push("  abstract: true".into());
    }
    if !draft.name.is_empty() {
        lines.push(format!("  name: {}", yaml_string(&draft.name)?));
    }
    if !draft.description.is_empty() {
        lines.push(format!(
            "  description: {}",
            yaml_string(&draft.description)?
        ));
    }
    let has_components = !draft.sprite.is_empty()
        || draft.include_item
        || draft.include_physics
        || draft.include_appearance;
    if has_components {
        lines.push("  components:".into());
    }
    if !draft.sprite.is_empty() {
        lines.push("  - type: Sprite".into());
        lines.push(format!("    sprite: {}", yaml_string(&draft.sprite)?));
        if !draft.sprite_state.is_empty() {
            lines.push(format!("    state: {}", yaml_string(&draft.sprite_state)?));
        }
    }
    if draft.include_item {
        lines.push("  - type: Item".into());
    }
    if draft.include_physics {
        lines.push("  - type: Physics".into());
    }
    if draft.include_appearance {
        lines.push("  - type: Appearance".into());
    }
    let yaml = lines.join("\n") + "\n";
    validate_yaml(&yaml)?;
    let mut warnings = Vec::new();
    if draft.parent.is_empty() {
        warnings.push("Родитель не задан: наследование компонентов не используется.".into());
    }
    if !draft.sprite.is_empty() {
        warnings.push("RSI и состояние спрайта ещё не проверяются на существование.".into());
    }
    if draft.include_item || draft.include_physics || draft.include_appearance {
        warnings.push("Наличие и требования компонентов зависят от конкретного форка SS14; C#-валидация будет добавлена отдельно.".into());
    }
    Ok(PrototypePreview {
        file: draft.file.clone(),
        kind: draft.kind.clone(),
        id: draft.id.clone(),
        yaml,
        warnings,
    })
}

fn validate_target(path: &str) -> Result<(), StudioError> {
    let invalid_path = || {
        invalid(
         "PROTOTYPE_PATH_INVALID",
         "Новый файл должен иметь путь Resources/Prototypes/.../*.yml или .yaml.",
         "Укажите относительный путь внутри каталога прототипов без «..», обратных слешей и системных символов.",
     )
    };
    if path.len() > 500
        || path.contains('\\')
        || path
            .chars()
            .any(|c| c.is_control() || matches!(c, ':' | '<' | '>' | '|' | '?' | '*' | '"'))
    {
        return Err(invalid_path());
    }
    let parts: Vec<_> = Path::new(path).components().collect();
    if parts.len() < 3
        || parts
            .iter()
            .any(|part| !matches!(part, Component::Normal(_)))
        || parts[0].as_os_str() != "Resources"
        || parts[1].as_os_str() != "Prototypes"
        || !path.to_lowercase().ends_with(".yml") && !path.to_lowercase().ends_with(".yaml")
    {
        return Err(invalid_path());
    }
    Ok(())
}

pub fn create(root: &Path, draft: &PrototypeDraft) -> Result<CreatedPrototype, StudioError> {
    let generated = preview(draft)?;
    let proto_root = root.join("Resources/Prototypes");
    let canonical_scope = fs::canonicalize(&proto_root).map_err(|error| {
        invalid(
            "PROTOTYPE_SCOPE_INVALID",
            "Каталог прототипов недоступен.",
            "Проверьте структуру Resources/Prototypes.",
        )
        .with_details(error.to_string())
    })?;
    if !canonical_scope.starts_with(root) {
        return Err(invalid(
            "PROTOTYPE_SCOPE_INVALID",
            "Каталог прототипов расположен за пределами проекта.",
            "Уберите символические ссылки за пределы проекта.",
        ));
    }

    let target = root.join(&generated.file);
    let parent = target.parent().ok_or_else(|| {
        invalid(
            "PROTOTYPE_PATH_INVALID",
            "Не удалось определить папку нового YAML.",
            "Проверьте относительный путь.",
        )
    })?;
    let studio_folder = proto_root.join("_PrototypeStudio");
    if parent == studio_folder && !parent.exists() {
        fs::create_dir(parent).map_err(|error| {
            invalid(
                "PROTOTYPE_FOLDER_FAILED",
                "Не удалось создать папку _PrototypeStudio.",
                "Проверьте доступ на запись в Resources/Prototypes.",
            )
            .with_details(error.to_string())
        })?;
    }
    // Inspect every scope component, not only the canonical result. No writes
    // through symlinks, even when they happen to point inside the project.
    let relative = parent.strip_prefix(root).map_err(|_| {
        invalid(
            "PROTOTYPE_PATH_INVALID",
            "Путь вышел за пределы проекта.",
            "Используйте каталог Resources/Prototypes.",
        )
    })?;
    let mut cursor = root.to_path_buf();
    for segment in relative.components() {
        cursor.push(segment);
        let metadata = fs::symlink_metadata(&cursor).map_err(|error| {
            invalid(
                "PROTOTYPE_FOLDER_MISSING",
                "Папка назначения не существует или недоступна.",
                "Выберите существующую папку или _PrototypeStudio (создаётся автоматически).",
            )
            .with_details(error.to_string())
        })?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(invalid(
                "PROTOTYPE_SYMLINK_BLOCKED",
                "Папка назначения не должна быть символической ссылкой.",
                "Выберите обычный каталог внутри Resources/Prototypes.",
            ));
        }
    }
    let resolved_parent = fs::canonicalize(parent).map_err(|error| {
        invalid(
            "PROTOTYPE_FOLDER_MISSING",
            "Не удалось открыть папку назначения.",
            "Проверьте наличие каталога.",
        )
        .with_details(error.to_string())
    })?;
    if !resolved_parent.starts_with(&canonical_scope) {
        return Err(invalid(
            "PROTOTYPE_OUTSIDE_PROJECT",
            "Папка назначения расположена вне каталога прототипов.",
            "Используйте только Resources/Prototypes.",
        ));
    }

    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o644);
    }
    let mut target_file = options.open(&target).map_err(|error| {
        if error.kind() == std::io::ErrorKind::AlreadyExists {
            invalid(
                "PROTOTYPE_FILE_EXISTS",
                "Файл уже существует и не будет перезаписан.",
                "Измените имя нового файла или выберите другой каталог.",
            )
        } else {
            invalid(
                "PROTOTYPE_CREATE_FAILED",
                "Не удалось создать YAML-файл.",
                "Проверьте права доступа и свободное место.",
            )
            .with_details(error.to_string())
        }
    })?;

    let mut cleanup = RemoveFailedFile(Some(target.clone()));
    target_file
        .write_all(generated.yaml.as_bytes())
        .map_err(|error| {
            invalid(
                "PROTOTYPE_WRITE_FAILED",
                "Не удалось полностью записать новый прототип.",
                "Проверьте доступность диска; незавершённый файл будет удалён.",
            )
            .with_details(error.to_string())
        })?;
    target_file.sync_all().map_err(|error| {
        invalid(
            "PROTOTYPE_SYNC_FAILED",
            "Не удалось подтвердить запись нового YAML.",
            "Проверьте состояние диска; незавершённый файл будет удалён.",
        )
        .with_details(error.to_string())
    })?;
    drop(target_file);
    cleanup.0.take();
    let warning = sync_directory(parent)
        .err()
        .map(|error| format!("Файл создан, но синхронизация папки не подтверждена: {error}"));
    Ok(CreatedPrototype {
        file: generated.file,
        kind: generated.kind,
        id: generated.id,
        yaml: generated.yaml,
        warning,
    })
}

struct RemoveFailedFile(Option<std::path::PathBuf>);
impl Drop for RemoveFailedFile {
    fn drop(&mut self) {
        if let Some(path) = self.0.take() {
            let _ = fs::remove_file(path);
        }
    }
}

#[cfg(unix)]
fn sync_directory(path: &Path) -> std::io::Result<()> {
    std::fs::File::open(path)?.sync_all()
}
#[cfg(not(unix))]
fn sync_directory(_path: &Path) -> std::io::Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);

    struct Fixture(std::path::PathBuf);
    impl Fixture {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!(
                "ss14-prototype-create-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(dir.join("Resources/Prototypes")).unwrap();
            Self(fs::canonicalize(dir).unwrap())
        }
        fn draft(&self, id: &str) -> PrototypeDraft {
            PrototypeDraft {
                kind: "entity".into(),
                id: id.into(),
                parent: "BaseItem".into(),
                name: "Test".into(),
                description: String::new(),
                abstract_prototype: false,
                sprite: String::new(),
                sprite_state: String::new(),
                include_item: false,
                include_physics: false,
                include_appearance: false,
                file: format!("Resources/Prototypes/_PrototypeStudio/{id}.yml"),
            }
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn creates_new_file_without_implicit_overwrite() {
        let fixture = Fixture::new();
        let draft = fixture.draft("NewItem");
        let first = create(&fixture.0, &draft).unwrap();
        assert_eq!(first.file, draft.file);
        assert_eq!(
            fs::read_to_string(fixture.0.join(&draft.file)).unwrap(),
            first.yaml
        );
        assert_eq!(
            create(&fixture.0, &draft).unwrap_err().code,
            "PROTOTYPE_FILE_EXISTS"
        );
    }

    #[test]
    fn escaping_avoids_yaml_injection_and_preserves_multiline_text() {
        let fixture = Fixture::new();
        let mut draft = fixture.draft("Sample");
        draft.name = "hello: \"world\" # comment".into();
        draft.description = "line 1\nline 2: value".into();
        let yaml = preview(&draft).unwrap().yaml;
        let documents = yaml_rust2::YamlLoader::load_from_str(&yaml).unwrap();
        assert_eq!(documents[0][0]["name"].as_str(), Some(draft.name.as_str()));
        assert_eq!(
            documents[0][0]["description"].as_str(),
            Some(draft.description.as_str())
        );
    }

    #[test]
    fn rejects_path_traversal_and_arbitrary_directories() {
        let fixture = Fixture::new();
        for bad in [
            "../private.yml",
            "Resources/Prototypes/../a.yml",
            "Resources/Locale/other.yml",
            "/etc/passwd.yml",
            "Resources/Prototypes/evil\\\\name.yml",
            "Resources/Prototypes/evil?.yml",
        ] {
            let mut draft = fixture.draft("Sample");
            draft.file = bad.into();
            assert_eq!(preview(&draft).unwrap_err().code, "PROTOTYPE_PATH_INVALID");
        }
    }

    #[test]
    fn rejects_invalid_ids_and_dangerous_component_options() {
        let fixture = Fixture::new();
        let mut draft = fixture.draft("Invalid ID");
        assert_eq!(preview(&draft).unwrap_err().code, "PROTOTYPE_ID_INVALID");
        draft.id = "Valid".into();
        draft.kind = "reagent".into();
        draft.include_item = true;
        assert_eq!(
            preview(&draft).unwrap_err().code,
            "PROTOTYPE_COMPONENTS_INVALID"
        );
    }

    #[test]
    fn generates_entity_component_stubs_in_expected_yaml_order() {
        let fixture = Fixture::new();
        let mut draft = fixture.draft("MyItem");
        draft.sprite = "Objects/Tools/myitem.rsi".into();
        draft.sprite_state = "icon".into();
        draft.include_item = true;
        draft.include_appearance = true;
        let yaml = preview(&draft).unwrap().yaml;
        assert!(yaml.contains("  components:\n  - type: Sprite\n    sprite:"));
        assert!(yaml.contains("  - type: Item\n"));
        assert!(yaml.contains("  - type: Appearance\n"));
        let parsed = yaml_rust2::YamlLoader::load_from_str(&yaml).unwrap();
        let components = &parsed[0][0]["components"];
        assert_eq!(components[0]["type"].as_str(), Some("Sprite"));
        assert_eq!(components[1]["type"].as_str(), Some("Item"));
        assert_eq!(components[2]["type"].as_str(), Some("Appearance"));
    }

    #[cfg(unix)]
    #[test]
    fn refuses_symlinked_destination() {
        use std::os::unix::fs::symlink;
        let fixture = Fixture::new();
        let outside = std::env::temp_dir().join(format!("ss14-outside-{}", std::process::id()));
        fs::create_dir_all(&outside).unwrap();
        symlink(&outside, fixture.0.join("Resources/Prototypes/Linked")).unwrap();
        let mut draft = fixture.draft("Sample");
        draft.file = "Resources/Prototypes/Linked/sample.yml".into();
        assert_eq!(
            create(&fixture.0, &draft).unwrap_err().code,
            "PROTOTYPE_SYMLINK_BLOCKED"
        );
        let _ = fs::remove_dir(&outside);
    }
}

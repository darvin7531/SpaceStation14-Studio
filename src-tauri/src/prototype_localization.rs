//! Exact entity prototype localization data from the active YAML draft.
//!
//! Locator identity is checked against the selected YAML item; no inherited
//! values, ambiguous partial declarations or guessed prototype are used.
use serde::Serialize;
use yaml_rust2::Yaml;

use crate::error::StudioError;
use crate::prototype_fields::{self, FieldLocator};

#[derive(Debug, Serialize)]
pub struct EntityLocalizationSource {
    pub localization_id: String,
    pub name: String,
    pub description: String,
    pub suffix: String,
}

fn scalar(row: &Yaml, key: &str) -> Result<String, StudioError> {
    let value = &row[key];
    match value {
        Yaml::BadValue | Yaml::Null => Ok(String::new()),
        Yaml::String(text) => Ok(text.trim().into()),
        _ => Err(StudioError::new(
            "ENTITY_LOCALE_COMPLEX_FIELD",
            "Поле локализации не является простым текстом.",
            "Откройте соответствующий YAML в Monaco: автоматическая генерация поддерживает только строковые значения.",
        )),
    }
}

pub fn inspect(
    locator: &FieldLocator,
    source: &str,
) -> Result<EntityLocalizationSource, StudioError> {
    if locator.kind != "entity" {
        return Err(StudioError::new(
            "ENTITY_LOCALE_ONLY",
            "Автоматическая локализация доступна только для entity-прототипов.",
            "Выберите обычный entity-прототип в каталоге.",
        ));
    }
    let documents = prototype_fields::parse_source(source)?;
    let (row, _) = prototype_fields::item(&documents, locator)?;
    let explicit_id = scalar(row, "localizationId")?;
    let localization_id = if explicit_id.is_empty() {
        format!("ent-{}", locator.id)
    } else {
        explicit_id
    };
    if localization_id.len() > 128
        || !localization_id
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphabetic)
        || !localization_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
    {
        return Err(StudioError::new(
            "ENTITY_LOCALE_ID_INVALID",
            "ID локализации несовместим с Fluent.",
            "Fluent ID должен начинаться с латинской буквы и содержать до 128 символов: A-Z, 0-9, '_' или '-'.",
        ));
    }
    Ok(EntityLocalizationSource {
        localization_id,
        name: scalar(row, "name")?,
        description: scalar(row, "description")?,
        suffix: scalar(row, "suffix")?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn locator() -> FieldLocator {
        FieldLocator {
            file: "Resources/Prototypes/items.yml".into(),
            kind: "entity".into(),
            id: "TestEntity".into(),
            document_index: 1,
            item_index: 2,
            mode: "normal".into(),
        }
    }

    #[test]
    fn inspect_selected_declaration_not_first_item() {
        let yaml = "- type: entity\n  id: Other\n  name: wrong\n- type: entity\n  id: TestEntity\n  name: Hello\n  description: World\n  suffix: precious\n";
        let result = inspect(&locator(), yaml).unwrap();
        assert_eq!(result.localization_id, "ent-TestEntity");
        assert_eq!(result.name, "Hello");
        assert_eq!(result.description, "World");
        assert_eq!(result.suffix, "precious");
    }

    #[test]
    fn explicit_localization_id_is_preserved() {
        let yaml = "- type: entity\n  id: Other\n- type: entity\n  id: TestEntity\n  localizationId: ent-other-name\n";
        assert_eq!(
            inspect(&locator(), yaml).unwrap().localization_id,
            "ent-other-name"
        );
    }

    #[test]
    fn malformed_or_changed_identity_never_generates_from_another_item() {
        let yaml = "- type: entity\n  id: Other\n- type: entity\n  id: Changed\n";
        assert!(inspect(&locator(), yaml).is_err());
        assert!(inspect(
            &locator(),
            "- type: entity\n  id: TestEntity\n  name: new\n"
        )
        .is_err());
    }

    #[test]
    fn non_plain_values_and_invalid_fluent_id_fail_closed() {
        let complex = "- type: entity\n  id: Other\n- type: entity\n  id: TestEntity\n  name: [cannot, interpolate]\n";
        assert!(inspect(&locator(), complex).is_err());
        let invalid = "- type: entity\n  id: Other\n- type: entity\n  id: TestEntity\n  localizationId: '../escape'\n";
        assert!(inspect(&locator(), invalid).is_err());
    }
}

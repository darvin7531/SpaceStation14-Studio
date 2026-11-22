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

#[derive(Debug, Clone, Serialize)]
pub struct EntityLocalePresence {
    pub name: bool,
    pub description: bool,
    pub suffix: bool,
}
#[derive(Debug, Clone, Serialize)]
pub struct EntityLocaleTarget {
    pub locale: String,
    pub path: String,
    pub file_exists: bool,
    pub exists: EntityLocalePresence,
}
#[derive(Debug, Serialize)]
pub struct EntityLocaleDiagnostic {
    pub field: &'static str,
    pub source_text: String,
    pub missing_locales: Vec<String>,
    pub targets: Vec<EntityLocaleTarget>,
}
#[derive(Debug, Serialize)]
pub struct EntityLocalizationAnalysis {
    pub localization_id: String,
    pub diagnostics: Vec<EntityLocaleDiagnostic>,
    pub targets: Vec<EntityLocaleTarget>,
    pub complete: bool,
    pub warnings: Vec<String>,
}

pub fn build_analysis(
    entity: EntityLocalizationSource,
    targets: Vec<EntityLocaleTarget>,
    complete: bool,
    warnings: Vec<String>,
) -> EntityLocalizationAnalysis {
    let mut diagnostics = Vec::new();
    if complete {
        for (field, source_text) in [
            ("name", &entity.name),
            ("description", &entity.description),
            ("suffix", &entity.suffix),
        ] {
            if source_text.is_empty() {
                continue;
            }
            let missing_locales: Vec<String> = targets
                .iter()
                .filter(|target| match field {
                    "name" => !target.exists.name,
                    "description" => !target.exists.description,
                    _ => !target.exists.suffix,
                })
                .map(|target| target.locale.clone())
                .collect();
            if !missing_locales.is_empty() {
                diagnostics.push(EntityLocaleDiagnostic {
                    field,
                    source_text: source_text.clone(),
                    missing_locales,
                    targets: targets.clone(),
                });
            }
        }
    }
    EntityLocalizationAnalysis {
        localization_id: entity.localization_id,
        diagnostics,
        targets,
        complete,
        warnings,
    }
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
    fn missing_entity_fields_report_only_configured_game_locales() {
        let entity = EntityLocalizationSource {
            localization_id: "ent-Demo".into(),
            name: "Entity".into(),
            description: "Description".into(),
            suffix: String::new(),
        };
        let targets = vec![
            EntityLocaleTarget {
                locale: "ru-RU".into(),
                path: "Resources/Locale/ru-RU/demo.ftl".into(),
                file_exists: true,
                exists: EntityLocalePresence {
                    name: true,
                    description: false,
                    suffix: false,
                },
            },
            EntityLocaleTarget {
                locale: "en-US".into(),
                path: "Resources/Locale/en-US/demo.ftl".into(),
                file_exists: false,
                exists: EntityLocalePresence {
                    name: false,
                    description: false,
                    suffix: false,
                },
            },
        ];
        let report = build_analysis(entity, targets, true, Vec::new());
        assert!(report.complete);
        assert_eq!(report.diagnostics.len(), 2);
        assert_eq!(report.diagnostics[0].field, "name");
        assert_eq!(report.diagnostics[0].missing_locales, ["en-US"]);
        assert_eq!(report.diagnostics[1].field, "description");
        assert_eq!(report.diagnostics[1].missing_locales, ["ru-RU", "en-US"]);
        assert!(report.targets[0].file_exists);
        assert!(!report.targets[1].file_exists);
    }

    #[test]
    fn incomplete_locale_index_never_reports_false_missing_translations() {
        let entity = EntityLocalizationSource {
            localization_id: "ent-Demo".into(),
            name: "Value".into(),
            description: String::new(),
            suffix: String::new(),
        };
        let report = build_analysis(entity, Vec::new(), false, vec!["unreadable FTL".into()]);
        assert!(!report.complete);
        assert!(report.diagnostics.is_empty());
        assert_eq!(report.warnings.len(), 1);
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

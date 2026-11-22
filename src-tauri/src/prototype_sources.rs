//! On-demand declaration provenance for R05 inheritance inspection.
//! This is *not* the engine's merged YAML and never edits resources.
use std::collections::{HashMap, HashSet};

use serde::Serialize;
use yaml_rust2::{Yaml, YamlLoader};

use crate::error::StudioError;
use crate::prototypes::{PrototypeCatalog, PrototypeDeclaration};

const MAX_IDENTITIES: usize = 80;
const MAX_DECLARATIONS: usize = 120;
const MAX_TOTAL_BYTES: usize = 24 * 1024 * 1024;
const MAX_KEYS: usize = 64;
const MAX_COMPONENTS: usize = 96;

#[derive(Debug, Serialize)]
pub struct PrototypeSourceContribution {
    pub kind: String,
    pub id: String,
    pub depth: usize,
    pub mode: &'static str,
    pub file: String,
    pub line: usize,
    pub partial_order: Option<usize>,
    /// Explicit top-level YAML keys; NOT final inherited values.
    pub fields: Vec<String>,
    /// Explicit component type names; NOT merged component instances.
    pub components: Vec<String>,
    pub notice: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct PrototypeSourceReport {
    pub kind: String,
    pub id: String,
    pub items: Vec<PrototypeSourceContribution>,
    pub truncated: bool,
    pub ancestry_complete: bool,
    pub warnings: Vec<String>,
}

fn snapshot_row<'a>(docs: &'a [Yaml], entry: &PrototypeDeclaration) -> Option<&'a Yaml> {
    if entry.variant_index.is_some() {
        return None;
    }
    let row = docs
        .get(entry.document_index.checked_sub(1)?)?
        .as_vec()?
        .get(entry.item_index.checked_sub(1)?)?;
    if row["type"].as_str() != Some(entry.kind.as_str())
        || row["id"].as_str() != Some(entry.id.as_str())
    {
        return None;
    }
    row.as_hash()?;
    Some(row)
}

fn summarize(row: &Yaml) -> (Vec<String>, Vec<String>, bool) {
    let Some(map) = row.as_hash() else {
        return (Vec::new(), Vec::new(), false);
    };
    let keys: Vec<String> = map
        .keys()
        .filter_map(Yaml::as_str)
        .filter(|key| *key != "type" && *key != "id" && *key != "components")
        .take(MAX_KEYS + 1)
        .map(str::to_owned)
        .collect();
    let components: Vec<String> = row["components"].as_vec().map_or_else(Vec::new, |items| {
        items
            .iter()
            .take(MAX_COMPONENTS + 1)
            .map(|item| {
                item["type"]
                    .as_str()
                    .map_or_else(|| "(нестатический type)".to_owned(), str::to_owned)
            })
            .collect()
    });
    let capped = keys.len() > MAX_KEYS || components.len() > MAX_COMPONENTS;
    (
        keys.into_iter().take(MAX_KEYS).collect(),
        components.into_iter().take(MAX_COMPONENTS).collect(),
        capped,
    )
}

/// Traverse exactly the already bounded source ancestry. Each distinct
/// physical YAML file is fetched and parsed once, with a cumulative input cap.
/// Unknown tags and dynamic identities produce provenance with a notice, never
/// an invented data-field value or partial merge.
pub fn inspect(
    catalog: &PrototypeCatalog,
    kind: &str,
    id: &str,
    mut read: impl FnMut(&str) -> Result<String, StudioError>,
) -> Result<PrototypeSourceReport, StudioError> {
    let relations = catalog.relations(kind, id).ok_or_else(|| {
        StudioError::new(
            "PROTOTYPE_NOT_INDEXED",
            "Прототип не найден в каталоге открытого проекта.",
            "Обновите индекс проекта и повторите поиск по типу и ID.",
        )
    })?;
    let mut identities = vec![(kind.to_owned(), id.to_owned(), 0usize)];
    let mut seen = HashSet::new();
    seen.insert((kind.to_owned(), id.to_owned()));
    let mut truncated = relations.ancestry_truncated;
    for ancestor in &relations.ancestors {
        let key = (ancestor.kind.clone(), ancestor.id.clone());
        if seen.insert(key.clone()) {
            if identities.len() >= MAX_IDENTITIES {
                truncated = true;
                break;
            }
            identities.push((key.0, key.1, ancestor.depth));
        }
    }

    let mut file_cache: HashMap<String, Result<Vec<Yaml>, String>> = HashMap::new();
    let mut total_bytes = 0usize;
    let mut items = Vec::new();
    let mut warnings = Vec::new();
    'identities: for (source_kind, source_id, depth) in identities {
        let mut declarations = catalog.source_declarations(&source_kind, &source_id);
        declarations.sort_unstable_by(|a, b| {
            (
                a.mode != "normal",
                a.partial_order.unwrap_or(usize::MAX),
                &a.file,
                a.line,
                a.document_index,
                a.item_index,
            )
                .cmp(&(
                    b.mode != "normal",
                    b.partial_order.unwrap_or(usize::MAX),
                    &b.file,
                    b.line,
                    b.document_index,
                    b.item_index,
                ))
        });
        for entry in declarations {
            if items.len() >= MAX_DECLARATIONS {
                truncated = true;
                break 'identities;
            }
            if !file_cache.contains_key(&entry.file) {
                let result = read(&entry.file)
                    .map_err(|failure| {
                        format!("Файл недоступен: {} [{}]", failure.message, failure.code)
                    })
                    .and_then(|source| {
                        if source.len() > MAX_TOTAL_BYTES.saturating_sub(total_bytes) {
                            return Err("Превышен общий лимит чтения исходников (24 МиБ).".into());
                        }
                        total_bytes += source.len();
                        YamlLoader::load_from_str(&source).map_err(|error| {
                            format!("YAML содержит неподдерживаемую для обзора структуру: {error}")
                        })
                    });
                if result
                    .as_ref()
                    .err()
                    .is_some_and(|issue| issue.starts_with("Превышен общий"))
                {
                    warnings.push("Обзор остановлен после лимита чтения 24 МиБ.".into());
                    truncated = true;
                    break 'identities;
                }
                file_cache.insert(entry.file.clone(), result);
            }
            let mut fields = Vec::new();
            let mut components = Vec::new();
            let mut notice = None;
            match file_cache.get(&entry.file) {
                Some(Ok(docs)) => {
                    if let Some(row) = snapshot_row(docs, &entry) {
                        let (keys, types, capped) = summarize(row);
                        fields = keys;
                        components = types;
                        if capped {
                            notice = Some("Показаны первые 64 поля и 96 компонентов.".into());
                        }
                    } else {
                        notice = Some("Нестатический ID, CreateVariants, YAML-тег или изменённая позиция: источник не удалось безопасно связать со словарём.".into());
                    }
                }
                Some(Err(error)) => notice = Some(error.clone()),
                None => {}
            }
            items.push(PrototypeSourceContribution {
                kind: entry.kind,
                id: entry.id,
                depth,
                mode: entry.mode,
                file: entry.file,
                line: entry.line,
                partial_order: entry.partial_order,
                fields,
                components,
                notice,
            });
        }
    }
    Ok(PrototypeSourceReport {
        kind: kind.to_owned(),
        id: id.to_owned(),
        ancestry_complete: relations.ancestry_complete
            && !truncated
            && items.iter().all(|item| item.notice.is_none()),
        truncated,
        items,
        warnings,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn summarize_never_confuses_nested_component_fields_with_top_level_keys() {
        let docs = YamlLoader::load_from_str(
            "- type: entity\n  id: Sample\n  name: Sample\n  components:\n  - type: Sprite\n    state: foo\n  - type: Physics\n    bodyType: Dynamic\n"
        ).unwrap();
        let row = &docs[0].as_vec().unwrap()[0];
        let (keys, components, truncated) = summarize(row);
        assert_eq!(keys, ["name"]);
        assert_eq!(components, ["Sprite", "Physics"]);
        assert!(!truncated);
    }

    #[test]
    fn source_row_rejects_stale_identity_and_generated_variants() {
        let docs = YamlLoader::load_from_str("- type: entity\n  id: Real\n").unwrap();
        let mut declaration = PrototypeDeclaration {
            kind: "entity".into(),
            id: "Other".into(),
            parents: Vec::new(),
            abstract_prototype: false,
            file: "Resources/Prototypes/test.yml".into(),
            line: 1,
            document_index: 1,
            item_index: 1,
            variant_index: None,
            mode: "normal",
            partial_order: None,
            parent_tag: None,
            source_count: 1,
        };
        assert!(snapshot_row(&docs, &declaration).is_none());
        declaration.id = "Real".into();
        assert!(snapshot_row(&docs, &declaration).is_some());
        declaration.variant_index = Some(0);
        assert!(snapshot_row(&docs, &declaration).is_none());
    }

    #[test]
    fn summarize_caps_complex_sources_without_large_ipc_payloads() {
        let mut text = String::from("- type: entity\n  id: Item\n  components:\n");
        for i in 0..150 {
            text.push_str(&format!("  - type: Part{i}\n"));
        }
        let docs = YamlLoader::load_from_str(&text).unwrap();
        let (_, components, truncated) = summarize(&docs[0].as_vec().unwrap()[0]);
        assert_eq!(components.len(), MAX_COMPONENTS);
        assert!(truncated);
    }
}

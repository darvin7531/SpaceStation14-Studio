//! Narrow, source-preserving add/remove operations for SS14 entity components.
//!
//! Supported: one normal entity in a single block-style YAML document.
//! This module returns changed draft text only; disk writes remain behind the
//! existing SHA-256-checked save command. Ambiguity is an error, not a guess.
use serde::{Deserialize, Serialize};
use yaml_rust2::Yaml;

use crate::error::StudioError;
use crate::prototype_fields::{item, item_rows, parse_source, FieldLocator, FieldPatch};
use crate::resource_edit::{validate_yaml, MAX_TEXT_BYTES};

#[derive(Debug, Clone, Serialize)]
pub struct ComponentEntry {
    /// Zero-based, within this declaration's explicit components list.
    pub index: usize,
    pub type_name: String,
    pub field_count: usize,
}

#[derive(Debug, Serialize)]
pub struct ComponentInspection {
    pub components: Vec<ComponentEntry>,
    pub notice: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "operation", rename_all = "snake_case")]
pub enum ComponentOperation {
    Add { type_name: String },
    Remove { index: usize, expected_type: String },
}

fn issue(code: &'static str, message: &str) -> StudioError {
    StudioError::new(
        code,
        message,
        "Откройте YAML в Monaco и измените этот случай вручную. Черновик не затронут.",
    )
}

fn eol(text: &str) -> Result<&'static str, StudioError> {
    let without_crlf = text.replace("\r\n", "");
    if without_crlf.contains('\r') || (text.contains("\r\n") && without_crlf.contains('\n')) {
        return Err(issue(
            "COMPONENT_MIXED_EOL",
            "В YAML смешаны окончания строк, точечное редактирование отключено.",
        ));
    }
    Ok(if text.contains("\r\n") { "\r\n" } else { "\n" })
}

fn component_type(raw: &str) -> Result<(), StudioError> {
    if raw.is_empty()
        || raw.len() > 128
        || !raw
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
    {
        return Err(issue(
            "COMPONENT_TYPE_INVALID",
            "Имя компонента должно содержать 1–128 букв ASCII, цифр, «_», «-» или «.».",
        ));
    }
    Ok(())
}

fn components(row: &Yaml) -> Result<&[Yaml], StudioError> {
    match &row["components"] {
        Yaml::BadValue => Ok(&[]),
        Yaml::Array(items) => Ok(items.as_slice()),
        _ => Err(issue(
            "COMPONENT_COMPLEX_VALUE",
            "Поле components не является обычным YAML-списком.",
        )),
    }
}

// Entire file is parsed and every declaration identity is verified.
// Layout checks are deliberately stricter than the YAML grammar.
fn declaration<'a>(
    docs: &'a [Yaml],
    locator: &FieldLocator,
) -> Result<(&'a Yaml, &'a [Yaml]), StudioError> {
    if locator.kind != "entity" {
        return Err(issue(
            "COMPONENT_UNSUPPORTED_KIND",
            "Редактор компонентов доступен только для прототипов entity.",
        ));
    }
    let (row, siblings) = item(docs, locator)?;
    let list = components(row)?;
    for (i, value) in list.iter().enumerate() {
        let Some(name) = value["type"].as_str() else {
            return Err(issue(
                "COMPONENT_DYNAMIC_TYPE",
                &format!(
                    "Компонент №{} не имеет простого статического поля type.",
                    i + 1
                ),
            ));
        };
        component_type(name)?;
        if value.as_hash().is_none() {
            return Err(issue(
                "COMPONENT_COMPLEX_VALUE",
                "Компонент не является обычным YAML-словарём.",
            ));
        }
    }
    Ok((row, siblings))
}

struct Layout {
    lines: Vec<String>,
    start: usize,
    end: usize,
    header: Option<usize>,
    section_end: usize,
    starts: Vec<usize>,
    eol: &'static str,
}

fn layout(
    source: &str,
    locator: &FieldLocator,
    expected_items: usize,
    count: usize,
) -> Result<Layout, StudioError> {
    let (lines, start, end) = item_rows(source, expected_items, locator.item_index)?;
    let mut headers = Vec::new();
    for (i, line) in lines.iter().enumerate().take(end).skip(start + 1) {
        if let Some(rest) = line.strip_prefix("  components:") {
            if rest.is_empty() || rest.trim().is_empty() {
                headers.push(i);
            } else {
                return Err(issue(
                    "COMPONENT_UNSUPPORTED_LAYOUT",
                    "Поле components содержит значение в той же строке или комментарий.",
                ));
            }
        }
    }
    if headers.len() > 1 {
        return Err(issue(
            "COMPONENT_DUPLICATE_FIELD",
            "Поле components повторяется в объявлении.",
        ));
    }
    let header = headers.first().copied();
    if (header.is_some()) != (count > 0) {
        return Err(issue(
            "COMPONENT_UNSUPPORTED_LAYOUT",
            "Список компонентов имеет неоднозначное расположение или пустое значение.",
        ));
    }
    let mut section_end = end;
    let mut starts = Vec::new();
    if let Some(h) = header {
        for (i, line) in lines.iter().enumerate().take(end).skip(h + 1) {
            // Next top-level mapping key starts with exactly two spaces,
            // not a nested component property or root component item.
            if let Some(rest) = line.strip_prefix("  ") {
                if !rest.is_empty() && !rest.starts_with([' ', '\t', '-', '#', '\r', '\n']) {
                    section_end = i;
                    break;
                }
            }
            if line.starts_with("  - type:") {
                starts.push(i);
            }
            // Other root-level sequence forms are not safe to rewrite.
            if line.starts_with("  - ") && !line.starts_with("  - type:") {
                return Err(issue(
                    "COMPONENT_UNSUPPORTED_LAYOUT",
                    "Список содержит нестандартный элемент компонента.",
                ));
            }
        }
    }
    if starts.len() != count {
        return Err(issue(
            "COMPONENT_UNSUPPORTED_LAYOUT",
            "Положение компонентов в исходном тексте не совпадает с YAML-деревом.",
        ));
    }
    Ok(Layout {
        lines,
        start,
        end,
        header,
        section_end,
        starts,
        eol: eol(source)?,
    })
}

fn preserve_except_components(before: &Yaml, after: &Yaml) -> Result<(), StudioError> {
    let mut old = before
        .as_hash()
        .ok_or_else(|| {
            issue(
                "COMPONENT_VERIFY_FAILED",
                "Объявление перестало быть YAML-словарём.",
            )
        })?
        .clone();
    let mut new = after
        .as_hash()
        .ok_or_else(|| {
            issue(
                "COMPONENT_VERIFY_FAILED",
                "Результат перестал быть YAML-словарём.",
            )
        })?
        .clone();
    old.remove(&Yaml::String("components".into()));
    new.remove(&Yaml::String("components".into()));
    if old != new {
        return Err(issue(
            "COMPONENT_VERIFY_FAILED",
            "Изменение компонентов неожиданно затронуло другие поля прототипа.",
        ));
    }
    Ok(())
}

fn checked(source: &str, locator: &FieldLocator) -> Result<(Vec<Yaml>, Layout), StudioError> {
    let docs = parse_source(source)?;
    let (row, siblings) = declaration(&docs, locator)?;
    let count = components(row)?.len();
    let found = layout(source, locator, siblings.len(), count)?;
    Ok((docs, found))
}

pub fn inspect(source: &str, locator: &FieldLocator) -> Result<ComponentInspection, StudioError> {
    let (docs, _layout) = checked(source, locator)?;
    let (row, _) = declaration(&docs, locator)?;
    let entries = components(row)?
        .iter()
        .enumerate()
        .map(|(index, item)| ComponentEntry {
            index,
            type_name: item["type"].as_str().unwrap_or_default().into(),
            field_count: item.as_hash().map_or(0, |map| map.len().saturating_sub(1)),
        })
        .collect();
    Ok(ComponentInspection {
         components: entries,
         notice: "Это явно объявленные компоненты, без наследования от parent. Добавление и удаление изменяют черновик; сохраните его отдельно.".into(),
     })
}

pub fn patch(
    source: &str,
    locator: &FieldLocator,
    operation: &ComponentOperation,
) -> Result<FieldPatch, StudioError> {
    let (docs, positions) = checked(source, locator)?;
    let (row, siblings) = declaration(&docs, locator)?;
    let original = components(row)?;
    let mut result = String::with_capacity(source.len() + 170);
    let mut expected_len = original.len();
    let mut removed = None;
    let mut added = None;

    match operation {
        ComponentOperation::Add { type_name } => {
            component_type(type_name)?;
            if original
                .iter()
                .any(|item| item["type"].as_str() == Some(type_name))
            {
                return Err(issue(
                    "COMPONENT_ALREADY_EXISTS",
                    "В объявлении уже есть компонент с этим type. Дублирование запрещено.",
                ));
            }
            let formatted = serde_json::to_string(type_name).map_err(|error| {
                issue(
                    "COMPONENT_TYPE_INVALID",
                    "Не удалось закодировать имя компонента.",
                )
                .with_details(error.to_string())
            })?;
            let mut content = String::new();
            if positions.header.is_none() {
                content.push_str("  components:");
                content.push_str(positions.eol);
            }
            content.push_str("  - type: ");
            content.push_str(&formatted);
            content.push_str(positions.eol);

            let at = if positions.header.is_some() {
                positions.section_end
            } else {
                let id_positions: Vec<usize> = (positions.start + 1..positions.end)
                    .filter(|&i| positions.lines[i].starts_with("  id:"))
                    .collect();
                if id_positions.len() != 1 {
                    return Err(issue(
                        "COMPONENT_UNSUPPORTED_LAYOUT",
                        "Не удалось однозначно определить строку id для нового списка.",
                    ));
                }
                id_positions[0] + 1
            };
            for (i, line) in positions.lines.iter().enumerate() {
                if i == at {
                    if i > 0 && !positions.lines[i - 1].ends_with('\n') {
                        result.push_str(positions.eol);
                    }
                    result.push_str(&content);
                }
                result.push_str(line);
            }
            if at == positions.lines.len() {
                if !source.ends_with('\n') {
                    result.push_str(positions.eol);
                }
                result.push_str(&content);
            }
            expected_len += 1;
            added = Some(type_name.as_str());
        }
        ComponentOperation::Remove {
            index,
            expected_type,
        } => {
            let Some(existing) = original.get(*index) else {
                return Err(issue(
                    "COMPONENT_NOT_FOUND",
                    "Компонент с таким порядковым номером больше не существует.",
                ));
            };
            if existing["type"].as_str() != Some(expected_type.as_str()) {
                return Err(issue(
                    "COMPONENT_STALE_SELECTION",
                    "Порядок или тип компонента изменился. Сначала обновите список.",
                ));
            }
            let begin = positions.starts[*index];
            let end = positions
                .starts
                .get(index + 1)
                .copied()
                .unwrap_or(positions.section_end);
            let range = if original.len() == 1 {
                positions.header.unwrap_or(begin)..positions.section_end
            } else {
                begin..end
            };
            // Do not silently discard authored comments on deletion. In such
            // blocks use Monaco, where the user can decide what to retain.
            if positions.lines[range.clone()]
                .iter()
                .any(|line| line.contains('#'))
            {
                return Err(issue(
                     "COMPONENT_COMMENTED_BLOCK",
                     "Удаляемый блок содержит комментарии. Автоудаление отключено, чтобы не потерять их.",
                 ));
            }
            for (i, line) in positions.lines.iter().enumerate() {
                if !range.contains(&i) {
                    result.push_str(line);
                }
            }
            expected_len -= 1;
            removed = Some(*index);
        }
    }

    if result.len() as u64 > MAX_TEXT_BYTES {
        return Err(issue(
            "COMPONENT_TOO_LARGE",
            "Получившийся YAML превышает лимит 4 МиБ.",
        ));
    }
    validate_yaml(&result)?;
    let new_docs = parse_source(&result)?;
    let (new_row, new_siblings) = declaration(&new_docs, locator)?;
    if new_siblings.len() != siblings.len()
        || siblings
            .iter()
            .zip(new_siblings)
            .enumerate()
            .any(|(i, (old, new))| i + 1 != locator.item_index && old != new)
    {
        return Err(issue(
            "COMPONENT_VERIFY_FAILED",
            "После изменения поменялись соседние объявления или их количество.",
        ));
    }
    preserve_except_components(row, new_row)?;
    let final_components = components(new_row)?;
    if final_components.len() != expected_len {
        return Err(issue(
            "COMPONENT_VERIFY_FAILED",
            "Количество компонентов не соответствует операции.",
        ));
    }
    if let Some(name) = added {
        if final_components[..original.len()] != *original
            || final_components
                .last()
                .and_then(|item| item["type"].as_str())
                != Some(name)
            || final_components
                .last()
                .and_then(Yaml::as_hash)
                .map_or(0, |map| map.len())
                != 1
        {
            return Err(issue(
                "COMPONENT_VERIFY_FAILED",
                "После добавления компоненты изменились неожиданно.",
            ));
        }
    }
    if let Some(index) = removed {
        let expected: Vec<&Yaml> = original
            .iter()
            .enumerate()
            .filter_map(|(i, entry)| (i != index).then_some(entry))
            .collect();
        if expected.len() != final_components.len()
            || expected.iter().zip(final_components).any(|(a, b)| *a != b)
        {
            return Err(issue(
                "COMPONENT_VERIFY_FAILED",
                "Удаление изменило другие компоненты.",
            ));
        }
    }
    Ok(FieldPatch {
        content: result,
        changed: true,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn loc(index: usize, id: &str) -> FieldLocator {
        FieldLocator {
            file: "Resources/Prototypes/sample.yml".into(),
            kind: "entity".into(),
            id: id.into(),
            document_index: 1,
            item_index: index,
            mode: "normal".into(),
        }
    }

    const SOURCE: &str = "# header\n- type: entity\n  id: First\n  components:\n  - type: Sprite\n    sprite: Objects/Stuff/example.rsi\n    layers:\n    - state: icon\n  - type: Physics\n    bodyType: Dynamic\n  name: Keep\n- type: entity\n  id: Second\n  name: Neighbor\n";

    #[test]
    fn inspect_explicit_components_only() {
        let found = inspect(SOURCE, &loc(1, "First")).unwrap();
        assert_eq!(found.components.len(), 2);
        assert_eq!(found.components[0].type_name, "Sprite");
        assert_eq!(found.components[0].field_count, 2);
        assert_eq!(found.components[1].type_name, "Physics");
    }

    #[test]
    fn adds_to_existing_list_without_touching_other_yaml() {
        let output = patch(
            SOURCE,
            &loc(1, "First"),
            &ComponentOperation::Add {
                type_name: "Appearance".into(),
            },
        )
        .unwrap();
        assert!(output.content.contains(
            "  - type: Physics\n    bodyType: Dynamic\n  - type: \"Appearance\"\n  name: Keep\n"
        ));
        assert!(output
            .content
            .starts_with("# header\n- type: entity\n  id: First\n"));
        assert!(output
            .content
            .ends_with("- type: entity\n  id: Second\n  name: Neighbor\n"));
        assert_eq!(
            inspect(&output.content, &loc(1, "First"))
                .unwrap()
                .components
                .len(),
            3
        );
    }

    #[test]
    fn creates_new_components_section_and_preserves_crlf() {
        let source = "- type: entity\r\n  id: First\r\n  name: Existing\r\n";
        let output = patch(
            source,
            &loc(1, "First"),
            &ComponentOperation::Add {
                type_name: "Item".into(),
            },
        )
        .unwrap();
        assert_eq!(output.content, "- type: entity\r\n  id: First\r\n  components:\r\n  - type: \"Item\"\r\n  name: Existing\r\n");
    }

    #[test]
    fn supports_file_without_trailing_newline() {
        let source = "- type: entity\n  id: First";
        let result = patch(
            source,
            &loc(1, "First"),
            &ComponentOperation::Add {
                type_name: "Item".into(),
            },
        )
        .unwrap();
        assert_eq!(
            result.content,
            "- type: entity\n  id: First\n  components:\n  - type: \"Item\"\n"
        );
    }

    #[test]
    fn remove_middle_component_preserves_other_fields_and_siblings() {
        let source = "# header\n- type: entity\n  id: First\n  components:\n  - type: Sprite\n    sprite: a.rsi\n  - type: Physics\n    bodyType: Dynamic\n  - type: Appearance\n  name: Keep\n- type: entity\n  id: Second\n  name: Neighbor\n";
        let result = patch(
            source,
            &loc(1, "First"),
            &ComponentOperation::Remove {
                index: 1,
                expected_type: "Physics".into(),
            },
        )
        .unwrap();
        assert!(result
            .content
            .contains("  - type: Sprite\n    sprite: a.rsi\n  - type: Appearance\n  name: Keep\n"));
        assert!(!result.content.contains("bodyType"));
        assert!(result
            .content
            .ends_with("- type: entity\n  id: Second\n  name: Neighbor\n"));
    }

    #[test]
    fn remove_only_component_removes_its_header_too() {
        let source = "- type: entity\n  id: First\n  components:\n  - type: Sprite\n    sprite: a.rsi\n  name: Keep\n";
        let result = patch(
            source,
            &loc(1, "First"),
            &ComponentOperation::Remove {
                index: 0,
                expected_type: "Sprite".into(),
            },
        )
        .unwrap();
        assert_eq!(
            result.content,
            "- type: entity\n  id: First\n  name: Keep\n"
        );
    }

    #[test]
    fn refuse_comment_loss_and_stale_selection() {
        let source = "- type: entity\n  id: First\n  components:\n  - type: Sprite # important\n    state: icon\n";
        let err = patch(
            source,
            &loc(1, "First"),
            &ComponentOperation::Remove {
                index: 0,
                expected_type: "Sprite".into(),
            },
        )
        .unwrap_err();
        assert_eq!(err.code, "COMPONENT_COMMENTED_BLOCK");
        let err = patch(
            SOURCE,
            &loc(1, "First"),
            &ComponentOperation::Remove {
                index: 0,
                expected_type: "Physics".into(),
            },
        )
        .unwrap_err();
        assert_eq!(err.code, "COMPONENT_STALE_SELECTION");
    }

    #[test]
    fn reject_duplicate_invalid_component_and_non_entity() {
        let err = patch(
            SOURCE,
            &loc(1, "First"),
            &ComponentOperation::Add {
                type_name: "Sprite".into(),
            },
        )
        .unwrap_err();
        assert_eq!(err.code, "COMPONENT_ALREADY_EXISTS");
        let err = patch(
            SOURCE,
            &loc(1, "First"),
            &ComponentOperation::Add {
                type_name: "Sprite\n- type: entity".into(),
            },
        )
        .unwrap_err();
        assert_eq!(err.code, "COMPONENT_TYPE_INVALID");
        let mut other = loc(1, "First");
        other.kind = "reagent".into();
        assert_eq!(
            inspect(SOURCE, &other).unwrap_err().code,
            "COMPONENT_UNSUPPORTED_KIND"
        );
    }

    #[test]
    fn reject_partial_and_complex_layouts() {
        let source = "- type: !PartialOnly entity\n  id: First\n  components:\n  - type: Sprite\n";
        assert!(inspect(source, &loc(1, "First")).is_err());
        let source = "- type: entity\n  id: First\n  components: []\n";
        assert_eq!(
            inspect(source, &loc(1, "First")).unwrap_err().code,
            "COMPONENT_UNSUPPORTED_LAYOUT"
        );
        let source = "- type: entity\n  id: First\n  components:\n    - type: Sprite\n";
        assert_eq!(
            inspect(source, &loc(1, "First")).unwrap_err().code,
            "COMPONENT_UNSUPPORTED_LAYOUT"
        );
    }
}

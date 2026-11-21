//! Conservative source-preserving edits of simple top-level prototype scalars.
//!
//! Never serializes a YAML document back to text. Only untagged, single-
//! document block sequences using "- type:" declarations are supported.
//! Source text remains a draft; the existing SHA-256 save command commits it.
use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use yaml_rust2::{Yaml, YamlLoader};

use crate::error::StudioError;
use crate::resource_edit::{validate_yaml, MAX_TEXT_BYTES};

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct FieldLocator {
    pub file: String,
    pub kind: String,
    pub id: String,
    pub document_index: usize,
    pub item_index: usize,
    pub mode: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct PrototypeFields {
    pub name: String,
    pub description: String,
    pub parent: String,
    pub abstract_prototype: bool,
}

#[derive(Debug, Serialize)]
pub struct FieldInspection {
    pub fields: PrototypeFields,
    pub notice: String,
}

#[derive(Debug, Serialize)]
pub struct FieldPatch {
    pub content: String,
    pub changed: bool,
}

fn unsupported(code: &'static str, message: &str) -> StudioError {
    StudioError::new(
        code,
        message,
        "Измените этот прототип вручную в Monaco. Форма не меняет исходный YAML.",
    )
}

fn parse_source(source: &str) -> Result<Vec<Yaml>, StudioError> {
    if source.len() as u64 > MAX_TEXT_BYTES {
        return Err(unsupported(
            "FIELDS_TOO_LARGE",
            "YAML превышает лимит редактирования 4 МиБ.",
        ));
    }
    if source.contains("!Partial") {
        return Err(unsupported(
            "FIELDS_PARTIAL_UNSUPPORTED",
            "Форма пока не поддерживает YAML с Partial-тегами.",
        ));
    }
    validate_yaml(source)?;
    YamlLoader::load_from_str(source).map_err(|error| {
        unsupported(
            "FIELDS_UNSUPPORTED_YAML",
            "Структуру YAML нельзя безопасно разобрать для формы.",
        )
        .with_details(error.to_string())
    })
}

fn item<'a>(
    docs: &'a [Yaml],
    locator: &FieldLocator,
) -> Result<(&'a Yaml, &'a [Yaml]), StudioError> {
    if locator.mode != "normal" || locator.document_index != 1 || locator.item_index == 0 {
        return Err(unsupported(
            "FIELDS_UNSUPPORTED_DECLARATION",
            "Форма доступна только для обычного объявления в первом YAML-документе.",
        ));
    }
    let items = match docs {
        [Yaml::Array(items)] => items.as_slice(),
        _ => {
            return Err(unsupported(
                "FIELDS_UNSUPPORTED_STRUCTURE",
                "Форма поддерживает только один YAML-документ с корневым списком.",
            ))
        }
    };
    let current = items.get(locator.item_index - 1).ok_or_else(|| {
        unsupported(
            "FIELDS_IDENTITY_CHANGED",
            "Положение объявления больше не совпадает с индексом.",
        )
    })?;
    if current.as_hash().is_none()
        || current["type"].as_str() != Some(locator.kind.as_str())
        || current["id"].as_str() != Some(locator.id.as_str())
    {
        return Err(unsupported(
            "FIELDS_IDENTITY_CHANGED",
            "Тип, ID или положение прототипа изменились после построения индекса.",
        ));
    }
    if items
        .iter()
        .filter(|row| {
            row["type"].as_str() == Some(locator.kind.as_str())
                && row["id"].as_str() == Some(locator.id.as_str())
        })
        .count()
        != 1
    {
        return Err(unsupported(
            "FIELDS_AMBIGUOUS_ID",
            "В этом YAML есть несколько объявлений с одинаковыми type и id.",
        ));
    }
    Ok((current, items))
}

fn get_string(row: &Yaml, key: &str) -> Result<String, StudioError> {
    match &row[key] {
        Yaml::BadValue | Yaml::Null => Ok(String::new()),
        Yaml::String(value) => Ok(value.clone()),
        _ => Err(unsupported(
            "FIELDS_COMPLEX_VALUE",
            &format!(
                "Поле «{key}» не является простой строкой. Списки и теги редактируются вручную."
            ),
        )),
    }
}

fn read_values(row: &Yaml) -> Result<PrototypeFields, StudioError> {
    let abstract_prototype = match &row["abstract"] {
        Yaml::BadValue | Yaml::Null => false,
        Yaml::Boolean(value) => *value,
        _ => {
            return Err(unsupported(
                "FIELDS_COMPLEX_VALUE",
                "Поле abstract не является обычным булевым значением.",
            ))
        }
    };
    Ok(PrototypeFields {
        name: get_string(row, "name")?,
        description: get_string(row, "description")?,
        parent: get_string(row, "parent")?,
        abstract_prototype,
    })
}

fn item_rows(
    source: &str,
    expected_count: usize,
    item_index: usize,
) -> Result<(Vec<String>, usize, usize), StudioError> {
    let lines: Vec<String> = source.split_inclusive('\n').map(str::to_owned).collect();
    let heads: Vec<usize> = lines
        .iter()
        .enumerate()
        .filter_map(|(n, line)| line.starts_with("- ").then_some(n))
        .collect();
    if heads.len() != expected_count || item_index > heads.len() {
        return Err(unsupported(
             "FIELDS_UNSUPPORTED_LAYOUT",
             "Строки корневого списка не совпадают с YAML-деревом; форма поддерживает обычную блочную разметку.",
         ));
    }
    let start = heads[item_index - 1];
    let end = heads.get(item_index).copied().unwrap_or(lines.len());
    if !lines[start].starts_with("- type:") {
        return Err(unsupported(
            "FIELDS_UNSUPPORTED_LAYOUT",
            "Элемент должен начинаться строкой «- type:».",
        ));
    }
    Ok((lines, start, end))
}

fn field_line<'a>(line: &'a str, key: &str) -> Option<&'a str> {
    let suffix = line
        .strip_prefix("  ")?
        .strip_prefix(key)?
        .strip_prefix(':')?;
    if suffix.starts_with(' ')
        || suffix.starts_with('\t')
        || suffix.is_empty()
        || suffix.starts_with('\r')
        || suffix.starts_with('\n')
    {
        Some(suffix)
    } else {
        None
    }
}

// Return trailing comment unchanged. A # inside a quoted string is not a
// comment. Comments must be separated from the scalar by whitespace.
fn trailing_comment(value: &str) -> Option<&str> {
    let mut single = false;
    let mut double = false;
    let mut escaped = false;
    let mut prev = ' ';
    for (i, ch) in value.char_indices() {
        if double {
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                double = false;
            }
        } else if single {
            if ch == '\'' {
                single = false;
            }
        } else if ch == '"' {
            double = true;
        } else if ch == '\'' {
            single = true;
        } else if ch == '#' && prev.is_whitespace() {
            let begin = value[..i].trim_end_matches([' ', '\t']).len();
            return Some(&value[begin..]);
        }
        prev = ch;
    }
    None
}

fn linebreak(line: &str) -> &'static str {
    if line.ends_with("\r\n") {
        "\r\n"
    } else if line.ends_with('\n') {
        "\n"
    } else {
        ""
    }
}

fn ensure_simple(field: &str, raw: &str) -> Result<Option<String>, StudioError> {
    let trimmed = raw
        .trim_start_matches([' ', '\t'])
        .trim_end_matches(['\r', '\n']);
    let without_comment = match trailing_comment(trimmed) {
        Some(comment) => &trimmed[..trimmed.len() - comment.len()],
        None => trimmed,
    }
    .trim();
    if without_comment.is_empty()
        || without_comment.starts_with(['|', '>', '!', '&', '*', '[', '{'])
        || without_comment.starts_with("---")
    {
        return Err(unsupported(
            "FIELDS_COMPLEX_VALUE",
            &format!("Поле «{field}» использует сложное YAML-значение или тег."),
        ));
    }
    Ok(trailing_comment(trimmed).map(str::to_owned))
}

fn encode(value: &str) -> Result<String, StudioError> {
    serde_json::to_string(value).map_err(|error| {
        unsupported(
            "FIELDS_SERIALIZATION_FAILED",
            "Не удалось кодировать YAML-строку.",
        )
        .with_details(error.to_string())
    })
}

const KEYS: [&str; 4] = ["parent", "name", "description", "abstract"];

pub fn inspect(source: &str, locator: &FieldLocator) -> Result<FieldInspection, StudioError> {
    let docs = parse_source(source)?;
    let (current, items) = item(&docs, locator)?;
    let (lines, start, end) = item_rows(source, items.len(), locator.item_index)?;
    for key in KEYS {
        let matches: Vec<&str> = lines[start + 1..end]
            .iter()
            .filter_map(|line| field_line(line, key))
            .collect();
        if matches.len() > 1 {
            return Err(unsupported(
                "FIELDS_DUPLICATE_KEY",
                &format!("Поле «{key}» повторяется в объявлении."),
            ));
        }
        if let Some(value) = matches.first() {
            ensure_simple(key, value)?;
        }
    }
    Ok(FieldInspection {
         fields: read_values(current)?,
         notice: "Форма меняет только простые поля данного объявления. Изменения сначала попадают в черновик; для записи нужен Ctrl+S.".into(),
     })
}

pub fn patch(
    source: &str,
    locator: &FieldLocator,
    requested: &PrototypeFields,
) -> Result<FieldPatch, StudioError> {
    if [&requested.name, &requested.description, &requested.parent]
        .iter()
        .any(|v| {
            v.len() > 4096
                || v.chars()
                    .any(|c| c == '\0' || (c.is_control() && c != '\n' && c != '\r' && c != '\t'))
        })
    {
        return Err(unsupported(
            "FIELDS_INPUT_INVALID",
            "Значение поля слишком длинное или содержит управляющие символы.",
        ));
    }
    if !requested.parent.is_empty()
        && (requested.parent.len() > 128
            || !requested
                .parent
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'-' | b'.')))
    {
        return Err(unsupported(
            "FIELDS_PARENT_INVALID",
            "Для parent поддерживается один обычный ID из букв ASCII, цифр, «_», «-» и «.».",
        ));
    }
    let inspection = inspect(source, locator)?;
    if inspection.fields == *requested {
        return Ok(FieldPatch {
            content: source.to_owned(),
            changed: false,
        });
    }
    let docs = parse_source(source)?;
    let (_, items) = item(&docs, locator)?;
    let (lines, start, end) = item_rows(source, items.len(), locator.item_index)?;
    let original = &inspection.fields;
    let requested_texts: [&str; 3] = [&requested.parent, &requested.name, &requested.description];
    let old_texts: [&str; 3] = [&original.parent, &original.name, &original.description];
    let mut modifications = HashMap::<usize, String>::new();
    let mut additions = Vec::<String>::new();
    let default_eol = if source.contains("\r\n") {
        if source.replace("\r\n", "").contains('\n') || source.replace("\r\n", "").contains('\r') {
            return Err(unsupported(
                "FIELDS_MIXED_EOL",
                "Файл содержит смешанные окончания строк.",
            ));
        }
        "\r\n"
    } else {
        "\n"
    };
    for (index, key) in KEYS.iter().enumerate() {
        let changed = if index == 3 {
            requested.abstract_prototype != original.abstract_prototype
        } else {
            requested_texts[index] != old_texts[index]
        };
        if !changed {
            continue;
        }
        let position = (start + 1..end).find(|&n| field_line(&lines[n], key).is_some());
        let desired = if index == 3 {
            requested.abstract_prototype.then(|| "true".to_owned())
        } else {
            let text = requested_texts[index];
            (!text.is_empty()).then(|| encode(text)).transpose()?
        };
        match (position, desired) {
            (Some(n), Some(value)) => {
                let suffix = field_line(&lines[n], key).expect("previous scan found key");
                let comment = ensure_simple(key, suffix)?.unwrap_or_default();
                let eol = linebreak(&lines[n]);
                modifications.insert(n, format!("  {key}: {value}{comment}{eol}"));
            }
            (Some(n), None) => {
                let suffix = field_line(&lines[n], key).expect("previous scan found key");
                let comment = ensure_simple(key, suffix)?;
                let eol = linebreak(&lines[n]);
                modifications.insert(
                    n,
                    comment
                        .map(|tail| format!("  {}{eol}", tail.trim_start()))
                        .unwrap_or_default(),
                );
            }
            (None, Some(value)) => additions.push(format!("  {key}: {value}{default_eol}")),
            (None, None) => {}
        }
    }
    // New keys are inserted after the target's top-level id, not at the tail
    // where nested components or document markers may change meaning.
    let id_line = (start + 1..end)
        .filter(|&n| field_line(&lines[n], "id").is_some())
        .collect::<Vec<_>>();
    if id_line.len() != 1 {
        return Err(unsupported(
            "FIELDS_UNSUPPORTED_LAYOUT",
            "Не удалось однозначно найти строку «id» для вставки полей.",
        ));
    }
    let insertion = id_line[0] + 1;
    let mut revised =
        String::with_capacity(source.len() + additions.iter().map(String::len).sum::<usize>() + 64);
    for (n, line) in lines.iter().enumerate() {
        if n == insertion {
            revised.push_str(&additions.join(""));
        }
        if let Some(change) = modifications.get(&n) {
            revised.push_str(change);
        } else {
            revised.push_str(line);
        }
    }
    if insertion == lines.len() && !additions.is_empty() {
        if !source.ends_with('\n') {
            revised.push_str(default_eol);
        }
        revised.push_str(&additions.join(""));
    }
    if revised.len() as u64 > MAX_TEXT_BYTES {
        return Err(unsupported(
            "FIELDS_TOO_LARGE",
            "Результат превышает лимит 4 МиБ.",
        ));
    }
    validate_yaml(&revised)?;
    let after = parse_source(&revised)?;
    let (updated, updated_items) = item(&after, locator)?;
    if updated_items.len() != items.len()
        || updated_items
            .iter()
            .enumerate()
            .any(|(n, entry)| n + 1 != locator.item_index && entry != &items[n])
        || read_values(updated)? != *requested
    {
        return Err(unsupported(
            "FIELDS_VERIFY_FAILED",
            "После изменения YAML-дерево изменилось неожиданным образом. Черновик не тронут.",
        ));
    }
    let mut old_unaffected = items[locator.item_index - 1]
        .as_hash()
        .expect("item verified")
        .clone();
    let mut new_unaffected = updated.as_hash().expect("updated item verified").clone();
    for key in KEYS {
        old_unaffected.remove(&Yaml::String(key.into()));
        new_unaffected.remove(&Yaml::String(key.into()));
    }
    if old_unaffected != new_unaffected {
        return Err(unsupported(
            "FIELDS_VERIFY_FAILED",
            "Изменение затронуло другие поля прототипа. Черновик не тронут.",
        ));
    }
    Ok(FieldPatch {
        content: revised,
        changed: true,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn locator(item_index: usize, id: &str) -> FieldLocator {
        FieldLocator {
            file: "Resources/Prototypes/fixture.yml".into(),
            kind: "entity".into(),
            id: id.into(),
            document_index: 1,
            item_index,
            mode: "normal".into(),
        }
    }

    #[test]
    fn patches_only_second_item_and_preserves_comments_and_components() {
        let source = "# heading\n- type: entity\n  id: First\n  name: First name\n- type: entity\n  id: Second\n  name: 'old # value' # useful comment\n  components:\n  - type: Sprite\n    state: icon\n";
        let values = PrototypeFields {
            name: "Updated # value".into(),
            description: "Two lines\nand more".into(),
            parent: "BaseItem".into(),
            abstract_prototype: true,
        };
        let output = patch(source, &locator(2, "Second"), &values).unwrap();
        assert!(output.changed);
        assert!(output
            .content
            .starts_with("# heading\n- type: entity\n  id: First\n  name: First name\n"));
        assert!(output
            .content
            .contains("name: \"Updated # value\" # useful comment\n"));
        assert!(output
            .content
            .contains("description: \"Two lines\\nand more\"\n"));
        assert!(output
            .content
            .contains("  - type: Sprite\n    state: icon\n"));
        assert_eq!(
            inspect(&output.content, &locator(2, "Second"))
                .unwrap()
                .fields,
            values
        );
    }

    #[test]
    fn changes_one_value_without_touching_neighbor_declarations() {
        let source =
            "- type: entity\n  id: A\n  name: Before\n- type: entity\n  id: B\n  name: Unchanged\n";
        let mut fields = inspect(source, &locator(1, "A")).unwrap().fields;
        fields.name = "After".into();
        let result = patch(source, &locator(1, "A"), &fields).unwrap();
        assert!(result.content.contains("id: B\n  name: Unchanged\n"));
        assert!(result.content.contains("id: A\n  name: \"After\"\n"));
        assert_eq!(
            inspect(&result.content, &locator(1, "A"))
                .unwrap()
                .fields
                .name,
            "After"
        );
    }

    #[test]
    fn handles_crlf_and_removal_preserving_inline_comment() {
        let source =
            "- type: entity\r\n  id: X\r\n  parent: Old # keep this\r\n  abstract: true\r\n";
        let requested = PrototypeFields {
            name: String::new(),
            description: String::new(),
            parent: String::new(),
            abstract_prototype: false,
        };
        let patched = patch(source, &locator(1, "X"), &requested).unwrap();
        assert!(patched.content.contains("  # keep this\r\n"));
        assert!(!patched.content.contains("  parent:"));
        assert!(!patched.content.contains("  abstract:"));
        assert!(!patched.content.replace("\r\n", "").contains('\n'));
    }

    #[test]
    fn blocks_partial_and_multi_document_sources() {
        let partial = "- type: !PartialOnly entity\n  id: X\n";
        assert_eq!(
            inspect(partial, &locator(1, "X")).unwrap_err().code,
            "FIELDS_PARTIAL_UNSUPPORTED"
        );
        let multi = "- type: entity\n  id: X\n---\n- type: entity\n  id: Y\n";
        assert_eq!(
            inspect(multi, &locator(1, "X")).unwrap_err().code,
            "FIELDS_UNSUPPORTED_STRUCTURE"
        );
    }

    #[test]
    fn refuses_complex_parent_and_multiline_scalar() {
        let array = "- type: entity\n  id: X\n  parent: [Base, Other]\n";
        assert_eq!(
            inspect(array, &locator(1, "X")).unwrap_err().code,
            "FIELDS_COMPLEX_VALUE"
        );
        let block = "- type: entity\n  id: X\n  description: |\n    one\n    two\n";
        assert_eq!(
            inspect(block, &locator(1, "X")).unwrap_err().code,
            "FIELDS_COMPLEX_VALUE"
        );
    }

    #[test]
    fn rejects_stale_index_and_duplicate_id() {
        let source = "- type: entity\n  id: X\n- type: entity\n  id: X\n";
        assert_eq!(
            inspect(source, &locator(1, "X")).unwrap_err().code,
            "FIELDS_AMBIGUOUS_ID"
        );
        let source = "- type: entity\n  id: X\n";
        assert_eq!(
            inspect(source, &locator(1, "Another")).unwrap_err().code,
            "FIELDS_IDENTITY_CHANGED"
        );
        assert_eq!(
            inspect(source, &locator(2, "X")).unwrap_err().code,
            "FIELDS_IDENTITY_CHANGED"
        );
    }

    #[test]
    fn adds_fields_after_final_id_line_without_final_newline() {
        let source = "- type: entity\n  id: X";
        let fields = PrototypeFields {
            name: "New".into(),
            description: String::new(),
            parent: String::new(),
            abstract_prototype: true,
        };
        let result = patch(source, &locator(1, "X"), &fields).unwrap();
        assert_eq!(
            result.content,
            "- type: entity\n  id: X\n  name: \"New\"\n  abstract: true\n"
        );
    }

    #[test]
    fn changing_unrelated_fields_never_drops_inline_comments() {
        let source = "- type: entity\n  id: X\n  name: 'Hello'  # keep\n  components:\n  - type: Sprite\n    state: icon\n";
        let mut fields = inspect(source, &locator(1, "X")).unwrap().fields;
        fields.name = "World".into();
        let result = patch(source, &locator(1, "X"), &fields).unwrap();
        assert!(result.content.contains("  name: \"World\"  # keep\n"));
        assert!(result
            .content
            .contains("  - type: Sprite\n    state: icon\n"));
    }

    #[test]
    fn no_op_does_not_reformat_source() {
        let source = "- type: entity\n  id: X\n  name: 'Unchanged'\n";
        let fields = inspect(source, &locator(1, "X")).unwrap().fields;
        let result = patch(source, &locator(1, "X"), &fields).unwrap();
        assert!(!result.changed);
        assert_eq!(result.content, source);
    }
}

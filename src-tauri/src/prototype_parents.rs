//! Safe editing of explicit prototype parent IDs, including multi-parent YAML.
//!
//! This changes only a selected normal declaration in the in-memory draft.
//! It never serializes the whole file and it verifies the parsed YAML tree
//! before the caller may apply a patch to the editor.
use std::collections::HashSet;

use serde::Serialize;
use yaml_rust2::Yaml;

use crate::error::StudioError;
use crate::prototype_fields::{item, item_rows, parse_source, FieldLocator, FieldPatch};
use crate::resource_edit::{validate_yaml, MAX_TEXT_BYTES};

const MAX_PARENTS: usize = 64;

#[derive(Debug, Serialize)]
pub struct ParentInspection {
    pub parents: Vec<String>,
    pub notice: String,
}

fn issue(code: &'static str, message: &str) -> StudioError {
    StudioError::new(
        code,
        message,
        "Измените нестандартное объявление вручную в Monaco. Исходный YAML не изменён.",
    )
}

fn validate_ids(ids: &[String]) -> Result<(), StudioError> {
    if ids.len() > MAX_PARENTS {
        return Err(issue(
            "PARENT_COUNT_LIMIT",
            "Указано более 64 родительских прототипов.",
        ));
    }
    let mut seen = HashSet::new();
    for id in ids {
        if id.is_empty()
            || id.len() > 128
            || !id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
        {
            return Err(issue(
                "PARENT_ID_INVALID",
                "Каждый родитель должен быть ID из 1–128 ASCII-букв, цифр, '_' , '-' или '.'.",
            ));
        }
        if !seen.insert(id) {
            return Err(issue(
                "PARENT_ID_DUPLICATE",
                "Родительские ID не должны повторяться.",
            ));
        }
    }
    Ok(())
}

fn parents(row: &Yaml) -> Result<Vec<String>, StudioError> {
    let result = match &row["parent"] {
        Yaml::BadValue | Yaml::Null => Vec::new(),
        Yaml::String(parent) => vec![parent.clone()],
        Yaml::Array(items) => {
            let mut result = Vec::with_capacity(items.len());
            for item in items {
                let Yaml::String(parent) = item else {
                    return Err(issue(
                        "PARENT_COMPLEX_VALUE",
                        "Список родителей должен состоять из простых строковых ID.",
                    ));
                };
                result.push(parent.clone());
            }
            result
        }
        _ => {
            return Err(issue(
                "PARENT_COMPLEX_VALUE",
                "Поле parent должно быть строкой или YAML-списком строк.",
            ))
        }
    };
    validate_ids(&result)?;
    Ok(result)
}

fn head_value(line: &str) -> Option<&str> {
    let rest = line.strip_prefix("  parent:")?;
    if rest.starts_with([' ', '\t', '\r', '\n']) || rest.is_empty() {
        Some(rest)
    } else {
        None
    }
}

fn is_sequence_row(line: &str) -> bool {
    line.starts_with("  - ") || line.starts_with("    - ")
}

struct ParentSnapshot {
    docs: Vec<Yaml>,
    lines: Vec<String>,
    start: usize,
    end: usize,
    parents: Vec<String>,
}

/// The parsed AST is authoritative for values. The line layout is only used
/// to find an exact, contiguous source slice that may be replaced safely.
fn source_span(
    lines: &[String],
    start: usize,
    end: usize,
    old: &[String],
) -> Result<Option<(usize, usize, String)>, StudioError> {
    let matches: Vec<usize> = (start + 1..end)
        .filter(|&n| head_value(&lines[n]).is_some())
        .collect();
    if matches.len() > 1 {
        return Err(issue(
            "PARENT_DUPLICATE_KEY",
            "В объявлении повторяется поле parent.",
        ));
    }
    let Some(line_index) = matches.first().copied() else {
        if !old.is_empty() {
            return Err(issue(
                "PARENT_LAYOUT_UNSUPPORTED",
                "Поле parent есть в YAML-дереве, но не найдено в исходных строках.",
            ));
        }
        return Ok(None);
    };
    let raw = head_value(&lines[line_index]).expect("indexed parent line");
    let value = raw
        .trim_start_matches([' ', '\t'])
        .trim_end_matches(['\r', '\n']);
    let inline_comment = value
        .find(" #")
        .map(|index| value[index..].to_owned())
        .or_else(|| value.starts_with('#').then(|| format!(" {value}")));
    let without_comment = value
        .split_once(" #")
        .map(|(before, _)| before.trim_end())
        .unwrap_or(value);
    let mut after = line_index + 1;
    if without_comment.is_empty() || without_comment.starts_with('#') {
        // Indentless YAML block sequences are common in SS14:
        //   parent:
        //   - BaseA
        //   - BaseB
        // Preserve nothing inside the deleted block unless its shape is
        // unambiguous. Comments or nested elements require manual editing.
        while after < end && is_sequence_row(&lines[after]) {
            if lines[after].contains('#') {
                return Err(issue(
                    "PARENT_COMMENTS_UNSUPPORTED",
                    "Внутри списка родителей есть комментарий; безопасно перенести его автоматически нельзя.",
                ));
            }
            after += 1;
        }
        if after - line_index - 1 != old.len() {
            return Err(issue(
                "PARENT_LAYOUT_UNSUPPORTED",
                "Разметка списка родителей не совпадает с YAML-деревом.",
            ));
        }
    } else if without_comment.starts_with(['!', '&', '*', '|', '>', '{']) {
        return Err(issue(
            "PARENT_COMPLEX_VALUE",
            "Теги, YAML-якоря и нестандартное значение parent требуют ручной правки.",
        ));
    } else if !old.is_empty() && old.len() > 1 && !without_comment.starts_with('[') {
        return Err(issue(
            "PARENT_LAYOUT_UNSUPPORTED",
            "Ожидался встроенный или блочный YAML-список parent.",
        ));
    }
    Ok(Some((
        line_index,
        after,
        inline_comment.unwrap_or_default(),
    )))
}

fn snapshot(
    source: &str,
    locator: &FieldLocator,
) -> Result<ParentSnapshot, StudioError> {
    let docs = parse_source(source)?;
    let (row, items) = item(&docs, locator)?;
    let values = parents(row)?;
    let (lines, start, end) = item_rows(source, items.len(), locator.item_index)?;
    source_span(&lines, start, end, &values)?;
    Ok(ParentSnapshot {
        docs,
        lines,
        start,
        end,
        parents: values,
    })
}

pub fn inspect(source: &str, locator: &FieldLocator) -> Result<ParentInspection, StudioError> {
    let parsed = snapshot(source, locator)?;
    Ok(ParentInspection {
        parents: parsed.parents,
        notice: "Поддерживаются обычные объявления, одиночный parent и списки parent. Изменения попадут в черновик YAML; сохраните их Ctrl+S.".into(),
    })
}

pub fn patch(
    source: &str,
    locator: &FieldLocator,
    requested: &[String],
) -> Result<FieldPatch, StudioError> {
    validate_ids(requested)?;
    let ParentSnapshot {
        docs,
        lines,
        start,
        end,
        parents: original,
    } = snapshot(source, locator)?;
    if requested == original {
        return Ok(FieldPatch {
            content: source.to_owned(),
            changed: false,
        });
    }
    let eol = if source.contains("\r\n") {
        if source.replace("\r\n", "").contains(['\r', '\n']) {
            return Err(issue(
                "PARENT_MIXED_EOL",
                "У YAML смешанные окончания строк, точечная замена отключена.",
            ));
        }
        "\r\n"
    } else {
        "\n"
    };
    let old_span = source_span(&lines, start, end, &original)?;
    let value = match requested {
        [] => String::new(),
        [only] => serde_json::to_string(only).map_err(|_| {
            issue(
                "PARENT_ENCODE_FAILED",
                "Не удалось закодировать ID родителя.",
            )
        })?,
        more => {
            let values = more
                .iter()
                .map(serde_json::to_string)
                .collect::<Result<Vec<_>, _>>()
                .map_err(|_| {
                    issue(
                        "PARENT_ENCODE_FAILED",
                        "Не удалось закодировать список родителей.",
                    )
                })?;
            format!("[{}]", values.join(", "))
        }
    };
    let (begin, finish, comment) = if let Some((begin, finish, comment)) = old_span {
        (begin, finish, comment)
    } else {
        let ids: Vec<usize> = (start + 1..end)
            .filter(|&n| lines[n].starts_with("  id:"))
            .collect();
        if ids.len() != 1 {
            return Err(issue(
                "PARENT_INSERTION_UNSUPPORTED",
                "Не удалось найти единственное исходное поле id для вставки parent.",
            ));
        }
        (ids[0] + 1, ids[0] + 1, String::new())
    };
    let mut next = String::with_capacity(source.len() + 256);
    for (index, line) in lines.iter().enumerate() {
        if index == begin {
            if !value.is_empty() {
                // When the preceding id is the last line without a newline,
                // terminate it before inserting a new top-level field.
                if begin == finish && !next.ends_with('\n') && !next.is_empty() {
                    next.push_str(eol);
                }
                next.push_str(&format!("  parent: {value}{comment}{eol}"));
            } else if !comment.is_empty() {
                next.push_str(&format!("  {}{eol}", comment.trim_start()));
            }
        }
        if index < begin || index >= finish {
            next.push_str(line);
        }
    }
    if begin == lines.len() && !value.is_empty() {
        if !next.ends_with('\n') && !next.is_empty() {
            next.push_str(eol);
        }
        next.push_str(&format!("  parent: {value}{eol}"));
    }
    if next.len() as u64 > MAX_TEXT_BYTES {
        return Err(issue(
            "PARENT_TOO_LARGE",
            "Получившийся YAML превышает 4 МиБ.",
        ));
    }
    validate_yaml(&next)?;
    let reparsed = parse_source(&next)?;
    let (updated, new_items) = item(&reparsed, locator)?;
    let (previous, old_items) = item(&docs, locator)?;
    if old_items.len() != new_items.len()
        || old_items
            .iter()
            .zip(new_items)
            .enumerate()
            .any(|(n, (before, after))| n + 1 != locator.item_index && before != after)
        || parents(updated)? != requested
    {
        return Err(issue(
            "PARENT_VERIFY_FAILED",
            "Проверка результата обнаружила изменение соседних прототипов или списка родителей.",
        ));
    }
    let mut old_other = previous.as_hash().expect("item verified").clone();
    let mut new_other = updated.as_hash().expect("item verified").clone();
    old_other.remove(&Yaml::String("parent".into()));
    new_other.remove(&Yaml::String("parent".into()));
    if old_other != new_other {
        return Err(issue(
            "PARENT_VERIFY_FAILED",
            "Изменение затронуло другие поля прототипа.",
        ));
    }
    Ok(FieldPatch {
        content: next,
        changed: true,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn locator(item_index: usize, id: &str) -> FieldLocator {
        FieldLocator {
            file: "Resources/Prototypes/test.yml".into(),
            kind: "entity".into(),
            id: id.into(),
            document_index: 1,
            item_index,
            mode: "normal".into(),
        }
    }

    fn ids(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| (*s).to_owned()).collect()
    }

    #[test]
    fn single_to_multiple_preserves_adjacent_prototypes_and_components() {
        let source = "- type: entity\n  id: First\n  parent: Old # keep\n  components:\n  - type: Sprite\n    state: icon\n- type: entity\n  id: Second\n  parent: Base\n";
        let updated = patch(source, &locator(1, "First"), &ids(&["A", "B"])).unwrap();
        assert!(updated.changed);
        assert!(updated
            .content
            .contains("  parent: [\"A\", \"B\"] # keep\n"));
        assert!(updated
            .content
            .contains("  components:\n  - type: Sprite\n    state: icon\n"));
        assert!(updated
            .content
            .ends_with("- type: entity\n  id: Second\n  parent: Base\n"));
        assert_eq!(
            inspect(&updated.content, &locator(1, "First"))
                .unwrap()
                .parents,
            ids(&["A", "B"])
        );
    }

    #[test]
    fn block_array_to_single_replaces_only_parent_rows() {
        let source =
            "- type: entity\n  id: A\n  parent:\n  - Parent1\n  - Parent2\n  name: 'Hello'\n";
        let changed = patch(source, &locator(1, "A"), &ids(&["Parent3"])).unwrap();
        assert_eq!(
            changed.content,
            "- type: entity\n  id: A\n  parent: \"Parent3\"\n  name: 'Hello'\n"
        );
    }

    #[test]
    fn inline_array_to_empty_removes_only_parent() {
        let source =
            "- type: entity\n  id: A\n  parent: [Parent1, Parent2]\n  description: A description\n";
        let changed = patch(source, &locator(1, "A"), &[]).unwrap();
        assert_eq!(
            changed.content,
            "- type: entity\n  id: A\n  description: A description\n"
        );
    }

    #[test]
    fn add_parent_after_final_id_without_newline() {
        let source = "- type: entity\n  id: A";
        let changed = patch(source, &locator(1, "A"), &ids(&["One", "Two"])).unwrap();
        assert_eq!(
            changed.content,
            "- type: entity\n  id: A\n  parent: [\"One\", \"Two\"]\n"
        );
    }

    #[test]
    fn retains_crlf_and_existing_comments() {
        let source = "- type: entity\r\n  id: A\r\n  parent: Parent1 # keep\r\n";
        let result = patch(source, &locator(1, "A"), &ids(&["Parent2"])).unwrap();
        assert_eq!(
            result.content,
            "- type: entity\r\n  id: A\r\n  parent: \"Parent2\" # keep\r\n"
        );
    }

    #[test]
    fn no_op_preserves_block_layout_verbatim() {
        let source = "- type: entity\n  id: A\n  parent:\n  - One\n  - Two\n";
        let result = patch(source, &locator(1, "A"), &ids(&["One", "Two"])).unwrap();
        assert!(!result.changed);
        assert_eq!(result.content, source);
    }

    #[test]
    fn rejects_stale_locator_duplicates_and_unrepresentable_ids() {
        let source = "- type: entity\n  id: A\n  parent: Old\n";
        assert!(inspect(source, &locator(1, "B")).is_err());
        assert_eq!(
            patch(source, &locator(1, "A"), &ids(&["X", "X"]))
                .unwrap_err()
                .code,
            "PARENT_ID_DUPLICATE"
        );
        assert_eq!(
            patch(source, &locator(1, "A"), &ids(&["../evil"]))
                .unwrap_err()
                .code,
            "PARENT_ID_INVALID"
        );
        assert!(inspect(
            "- type: entity\n  id: A\n  parent: [A, [B]]\n",
            &locator(1, "A")
        )
        .is_err());
    }

    #[test]
    fn refuses_comments_in_block_sequence_and_mixed_eol() {
        let comment = "- type: entity\n  id: A\n  parent:\n  - A # annotated\n  - B\n";
        assert_eq!(
            inspect(comment, &locator(1, "A")).unwrap_err().code,
            "PARENT_COMMENTS_UNSUPPORTED"
        );
        let mixed = "- type: entity\r\n  id: A\n  parent: Old\r\n";
        assert_eq!(
            patch(mixed, &locator(1, "A"), &ids(&["New"]))
                .unwrap_err()
                .code,
            "PARENT_MIXED_EOL"
        );
    }
}

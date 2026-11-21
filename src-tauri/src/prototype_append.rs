//! Lossless, conservative append of one generated prototype declaration.
 //!
 //! This is NOT a general YAML AST/CST writer. We only extend a single
 //! top-level YAML sequence in an already indexed existing prototype file.
 //! Parsing before and after ensures the new node has become exactly one new
 //! sequence item. The source is not reserialized.
 use serde::Serialize;
 use yaml_rust2::{Yaml, YamlLoader};
 
 use crate::error::StudioError;
 use crate::prototype_create::PrototypePreview;
 use crate::resource_edit::{revision, validate_yaml, MAX_TEXT_BYTES};
 
 #[derive(Debug, Serialize)]
 pub struct AppendPreview {
     pub file: String,
     pub kind: String,
     pub id: String,
     /// Only the generated declaration, not the whole pre-existing file.
     pub yaml: String,
     /// Exact revision the user reviewed, mandatory for commit.
     pub expected_revision: String,
     pub warnings: Vec<String>,
 }
 
 pub fn prepare_append(original: &str, snippet: &str) -> Result<String, StudioError> {
     if original.len() as u64 > MAX_TEXT_BYTES || snippet.len() as u64 > MAX_TEXT_BYTES {
         return Err(StudioError::new(
             "APPEND_RESOURCE_TOO_LARGE",
             "Исходный YAML или новое объявление превышают лимит редактирования.",
             "Используйте файл меньше 4 МиБ или внешний редактор.",
         ));
     }
     if original.trim().is_empty() {
         return Err(StudioError::new(
             "APPEND_EMPTY_FILE",
             "В целевом файле нет существующей YAML-последовательности.",
             "Для пустого файла создайте YAML вручную либо выберите другой файл.",
         ));
     }
     if original.contains("!Partial") {
         return Err(StudioError::new(
             "APPEND_PARTIAL_UNSUPPORTED",
             "Этот YAML содержит Partial-теги, автоматическое добавление в него отключено.",
             "Пока используйте ручное редактирование Partial Prototypes.",
         ));
     }
 
     validate_yaml(original)?;
     let original_docs = YamlLoader::load_from_str(original).map_err(|err| StudioError::new(
         "APPEND_UNSUPPORTED_YAML",
         "Структуру целевого YAML невозможно безопасно разобрать для добавления.",
         "Выберите обычный YAML со списком прототипов или воспользуйтесь текстовым редактором.",
     ).with_details(err.to_string()))?;
     let original_items = match original_docs.as_slice() {
         [Yaml::Array(items)] if !items.is_empty() => items,
         _ => return Err(StudioError::new(
             "APPEND_UNSUPPORTED_STRUCTURE",
             "Добавление поддерживает только один YAML-документ с корневым списком прототипов.",
             "Пока не поддерживаются несколько документов, пустые списки и корневые словари.",
         )),
     };
 
     if !snippet.starts_with("- type: ") || !snippet.ends_with('\n') {
         return Err(StudioError::new(
             "APPEND_SNIPPET_INVALID",
             "Новый блок имеет неподдерживаемый формат.",
             "Повторите генерацию объявления в мастере.",
         ));
     }
     let snippet_docs = YamlLoader::load_from_str(snippet).map_err(|err| StudioError::new(
         "APPEND_SNIPPET_INVALID",
         "Не удалось разобрать новый блок прототипа.",
         "Исправьте поля в мастере создания.",
     ).with_details(err.to_string()))?;
     let new_item = match snippet_docs.as_slice() {
         [Yaml::Array(items)] if items.len() == 1 => &items[0],
         _ => return Err(StudioError::new(
             "APPEND_SNIPPET_INVALID",
             "Ожидалось ровно одно объявление прототипа.",
             "Повторите генерацию объявления.",
         )),
     };
     if new_item["type"].as_str().is_none() || new_item["id"].as_str().is_none() {
         return Err(StudioError::new(
             "APPEND_SNIPPET_INVALID",
             "Новый блок не содержит обычных полей type и id.",
             "Проверьте введённые тип и идентификатор.",
         ));
     }
 
     if original_items.iter().any(|entry| {
         entry["type"] == new_item["type"] && entry["id"] == new_item["id"]
     }) {
         return Err(StudioError::new(
             "PROTOTYPE_ID_EXISTS",
             "В выбранном файле уже объявлен прототип с таким типом и ID.",
             "Измените идентификатор или откройте существующий прототип.",
         ));
     }

     let has_crlf = original.contains("\r\n");
     if original.replace("\r\n", "").contains('\r')
         || has_crlf && original.replace("\r\n", "").contains('\n')
     {
         return Err(StudioError::new(
             "APPEND_MIXED_NEWLINES",
             "YAML содержит смешанные или нестандартные окончания строк.",
             "Используйте текстовый редактор, чтобы привести строки к одному формату.",
         ));
     }
     let linebreak = if has_crlf { "\r\n" } else { "\n" };
     let mut combined = original.to_owned();
     if !combined.ends_with('\n') {
         combined.push_str(linebreak);
     }
     if has_crlf {
         combined.push_str(&snippet.replace('\n', linebreak));
     } else {
         combined.push_str(snippet);
     }
     if combined.len() as u64 > MAX_TEXT_BYTES {
         return Err(StudioError::new(
             "APPEND_RESOURCE_TOO_LARGE",
             "После добавления YAML превысил ограничение записи 4 МиБ.",
             "Создайте отдельный файл прототипа.",
         ));
     }
 
     validate_yaml(&combined)?;
     let combined_docs = YamlLoader::load_from_str(&combined).map_err(|err| StudioError::new(
         "APPEND_INVALID_RESULT",
         "После добавления структура YAML стала неоднозначной. Ничего не записано.",
         "Создайте отдельный файл или исправьте YAML вручную.",
     ).with_details(err.to_string()))?;
     match combined_docs.as_slice() {
         [Yaml::Array(items)] if items.len() == original_items.len() + 1
             && &items[..original_items.len()] == original_items
             && &items[original_items.len()] == new_item => Ok(combined),
         _ => Err(StudioError::new(
             "APPEND_INVALID_RESULT",
             "Новый блок не удалось однозначно добавить как последний элемент списка.",
             "Никаких изменений не записано. Используйте ручной редактор или новый файл.",
         )),
     }
 }
 
 pub fn preview_append(original: &str, generated: PrototypePreview) -> Result<AppendPreview, StudioError> {
     let _ = prepare_append(original, &generated.yaml)?;
     let mut warnings = generated.warnings;
     warnings.push(
         "Будет добавлен только новый элемент корневого списка. Комментарии, порядок и существующие блоки не перезаписываются.".into(),
     );
     Ok(AppendPreview {
         file: generated.file,
         kind: generated.kind,
         id: generated.id,
         yaml: generated.yaml,
         expected_revision: revision(original.as_bytes()),
         warnings,
     })
 }
 
 #[cfg(test)]
 mod tests {
     use super::*;
 
     const EXISTING: &str = "# Prototype comments\n- type: entity\n  id: Old\n  components:\n  - type: Transform\n";
     const NEW: &str = "- type: \"entity\"\n  id: \"Fresh\"\n  parent: \"Old\"\n";
 
     #[test]
     fn appends_without_changing_original_bytes_or_comment() {
         let result = prepare_append(EXISTING, NEW).unwrap();
         assert!(result.starts_with(EXISTING));
         let docs = YamlLoader::load_from_str(&result).unwrap();
         assert_eq!(docs[0].as_vec().unwrap().len(), 2);
         assert_eq!(docs[0][1]["id"].as_str(), Some("Fresh"));
     }
 
     #[test]
     fn preserves_crlf_and_no_final_newline() {
         let existing = EXISTING.replace('\n', "\r\n");
         let added = prepare_append(&existing, NEW).unwrap();
         assert!(added.starts_with(&existing));
         assert!(!added.replace("\r\n", "").contains('\n'));
         let without_final_newline = EXISTING.trim_end_matches('\n');
         let result = prepare_append(without_final_newline, NEW).unwrap();
         assert!(result.starts_with(&format!("{without_final_newline}\n")));
     }
 
     #[test]
     fn explicit_document_end_never_silently_creates_second_document() {
         let original = format!("{EXISTING}...\n");
         let result = prepare_append(&original, NEW);
         assert!(result.is_err());
     }
 
     #[test]
     fn refuses_multiple_documents_and_mapping_roots() {
         for original in [
             "type: entity\nid: X\n",
             "---\n- type: entity\n  id: A\n---\n- type: entity\n  id: B\n",
             "# nothing here\n",
             "[]\n",
         ] {
             assert_eq!(
                 prepare_append(original, NEW).unwrap_err().code,
                 "APPEND_UNSUPPORTED_STRUCTURE"
             );
         }
     }
 
     #[test]
     fn rejects_duplicate_declaration_even_with_stale_catalog() {
         let source = "- type: entity\n  id: Fresh\n";
         assert_eq!(
             prepare_append(source, NEW).unwrap_err().code,
             "PROTOTYPE_ID_EXISTS"
         );
     }

     #[test]
     fn rejects_mixed_line_endings() {
         let text = "# c\r\n- type: entity\n  id: A\r\n";
         assert_eq!(prepare_append(text, NEW).unwrap_err().code, "APPEND_MIXED_NEWLINES");
     }
 
     #[test]
     fn rejects_partial_tags_and_bad_snippets() {
         let partial = "- type: !PartialOnly entity\n  id: Old\n";
         assert_eq!(prepare_append(partial, NEW).unwrap_err().code, "APPEND_PARTIAL_UNSUPPORTED");
         assert_eq!(prepare_append(EXISTING, "invalid: 1\n").unwrap_err().code, "APPEND_SNIPPET_INVALID");
     }
 
     #[test]
     fn never_changes_existing_items_when_tail_has_comments() {
         let text = format!("{EXISTING}\n# trailing comment\n");
         let result = prepare_append(&text, NEW).unwrap();
         assert!(result.starts_with(&text));
         let docs = YamlLoader::load_from_str(&result).unwrap();
         assert_eq!(docs[0][0]["id"].as_str(), Some("Old"));
         assert_eq!(docs[0][1]["id"].as_str(), Some("Fresh"));
     }
 }

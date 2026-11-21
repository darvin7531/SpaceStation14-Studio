//! Read-only SS14 prototype declaration catalog.
//!
//! This is a *source catalog*, NOT RobustToolbox's resolved prototype graph.
//! Every declaration is preserved, including configured partials and tagged
//! partials, with separate provenance and no guessed merge semantics.
use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::{Component, Path};

use serde::Serialize;
use yaml_rust2::parser::{Event, MarkedEventReceiver, Parser, Tag};
use yaml_rust2::scanner::Marker;
use yaml_rust2::{Yaml, YamlLoader};

use crate::project::ResourceEntry;
use crate::prototype_graph::{PrototypeGraph, PrototypeRelations};

const MAX_YAML_BYTES: u64 = 4 * 1024 * 1024;
const MAX_PAGE: usize = 200;

#[derive(Debug, Clone, Serialize)]
pub struct PrototypeDeclaration {
    pub kind: String,
    pub id: String,
    pub parents: Vec<String>,
    pub abstract_prototype: bool,
    pub file: String,
    pub line: usize,
    pub document_index: usize,
    pub item_index: usize,
    /// "normal" | "configured_partial" | "tagged_partial" | "partial_only".
    /// This is provenance, not a resolution or merge guarantee.
    pub mode: &'static str,
    pub partial_order: Option<usize>,
    pub parent_tag: Option<String>,
    pub source_count: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct PrototypeDiagnostic {
    pub code: &'static str,
    pub file: String,
    pub line: usize,
    pub message: String,
}

#[derive(Debug, Serialize)]
pub struct PrototypePage {
    pub total: usize,
    pub items: Vec<PrototypeDeclaration>,
    pub diagnostic_count: usize,
}

#[derive(Debug, Serialize)]
pub struct DiagnosticPage {
    pub total: usize,
    pub items: Vec<PrototypeDiagnostic>,
}

#[derive(Debug)]
struct PartialScope {
    relative: String,
    is_file: bool,
    order: usize,
}

#[derive(Debug, Default)]
pub struct PrototypeCatalog {
    declarations: Vec<PrototypeDeclaration>,
    diagnostics: Vec<PrototypeDiagnostic>,
    search_keys: Vec<String>,
    by_identity: HashMap<(String, String), Vec<usize>>,
    graph: PrototypeGraph,
}

impl PrototypeCatalog {
    /// Loads on first prototype query (from a blocking task), not on workspace open.
    pub fn build(root: &Path, resources: &[ResourceEntry]) -> Self {
        let mut catalog = Self::default();
        let scopes = configured_partials(root, &mut catalog.diagnostics);

        for resource in resources {
            if resource.kind != "yaml" {
                continue;
            }

            let candidate = root.join(&resource.path);
            let path = resource.path.as_str();
            let mode = scopes
                .iter()
                .find(|scope| {
                    if scope.is_file {
                        path == scope.relative
                    } else {
                        path.strip_prefix(scope.relative.as_str())
                            .is_some_and(|remainder| remainder.starts_with('/'))
                    }
                })
                .map(|scope| scope.order);

            // File index ignored symlinks, but protect against external changes since scanning.
            let resolved = match fs::canonicalize(&candidate) {
                Ok(resolved) if resolved.starts_with(root) => resolved,
                Ok(_) => {
                    catalog.issue(
                        "SOURCE_OUTSIDE_PROJECT",
                        path,
                        0,
                        "YAML-файл оказался за пределами выбранного проекта.",
                    );
                    continue;
                }
                Err(error) => {
                    catalog.issue(
                        "SOURCE_NOT_READABLE",
                        path,
                        0,
                        format!("YAML-файл недоступен: {error}"),
                    );
                    continue;
                }
            };

            let bytes = match read_bounded(&resolved) {
                Ok(bytes) => bytes,
                Err(message) => {
                    catalog.issue("SOURCE_NOT_READABLE", path, 0, message);
                    continue;
                }
            };
            let content = match String::from_utf8(bytes) {
                Ok(content) => content,
                Err(error) => {
                    catalog.issue(
                        "SOURCE_ENCODING",
                        path,
                        0,
                        format!("Невозможно разобрать YAML как UTF-8: {error}"),
                    );
                    continue;
                }
            };

            let mut collector = DeclarationCollector::new(path, mode);
            let result = Parser::new_from_str(&content).load(&mut collector, true);
            match result {
                Ok(()) => {
                    catalog.declarations.extend(collector.declarations);
                    catalog.diagnostics.extend(collector.diagnostics);
                }
                Err(error) => {
                    // An invalid YAML file must not contribute a *partial* parse result.
                    catalog.issue("YAML_PARSE_ERROR", path, 0, format!("Ошибка YAML: {error}"));
                }
            }
        }

        catalog.declarations.sort_unstable_by(|a, b| {
            (
                &a.kind,
                &a.id,
                &a.file,
                a.line,
                a.document_index,
                a.item_index,
            )
                .cmp(&(
                    &b.kind,
                    &b.id,
                    &b.file,
                    b.line,
                    b.document_index,
                    b.item_index,
                ))
        });
        for (index, item) in catalog.declarations.iter().enumerate() {
            catalog
                .by_identity
                .entry((item.kind.clone(), item.id.clone()))
                .or_default()
                .push(index);
            catalog
                .search_keys
                .push(format!("{} {} {}", item.kind, item.id, item.file).to_lowercase());
        }
        for item in &mut catalog.declarations {
            item.source_count = catalog
                .by_identity
                .get(&(item.kind.clone(), item.id.clone()))
                .map_or(1, Vec::len);
        }

        for ((kind, id), matches) in &catalog.by_identity {
            let normal_count = matches
                .iter()
                .filter(|&&index| catalog.declarations[index].mode == "normal")
                .count();
            if normal_count > 1 {
                let original = &catalog.declarations[matches[0]];
                catalog.diagnostics.push(PrototypeDiagnostic {
                    code: "MULTIPLE_BASE_DECLARATIONS",
                    file: original.file.clone(),
                    line: original.line,
                    message: format!(
                        "У {kind}:{id} найдено {normal_count} обычных объявлений. Проверьте дубликаты и настройки partial-каталогов."
                    ),
                });
            }
        }
        catalog.graph = PrototypeGraph::build(
            &catalog.declarations,
            &catalog.by_identity,
            &catalog.diagnostics,
        );
        catalog
            .diagnostics
            .extend_from_slice(catalog.graph.diagnostics());
        catalog
            .diagnostics
            .sort_unstable_by(|a, b| (&a.file, a.line).cmp(&(&b.file, b.line)));
        catalog
    }

    pub fn search(
        &self,
        query: &str,
        kind: Option<&str>,
        offset: usize,
        limit: usize,
    ) -> PrototypePage {
        let query = query.trim().to_lowercase();
        let kind = kind.map(str::trim).filter(|value| !value.is_empty());
        let mut total = 0;
        let mut items = Vec::new();
        let page_limit = limit.clamp(1, MAX_PAGE);
        for (index, declaration) in self.declarations.iter().enumerate() {
            if kind.is_some_and(|value| !declaration.kind.eq_ignore_ascii_case(value))
                || (!query.is_empty() && !self.search_keys[index].contains(&query))
            {
                continue;
            }
            if total >= offset && items.len() < page_limit {
                items.push(declaration.clone());
            }
            total += 1;
        }
        PrototypePage {
            total,
            items,
            diagnostic_count: self.diagnostics.len(),
        }
    }

    pub fn relations(&self, kind: &str, id: &str) -> Option<PrototypeRelations> {
        self.graph
            .relations(kind, id, &self.declarations, &self.by_identity)
    }

    pub fn diagnostics(&self, offset: usize, limit: usize) -> DiagnosticPage {
        let max = limit.clamp(1, MAX_PAGE);
        DiagnosticPage {
            total: self.diagnostics.len(),
            items: self
                .diagnostics
                .iter()
                .skip(offset)
                .take(max)
                .cloned()
                .collect(),
        }
    }

    fn issue(&mut self, code: &'static str, file: &str, line: usize, message: impl Into<String>) {
        self.diagnostics.push(PrototypeDiagnostic {
            code,
            file: file.to_owned(),
            line,
            message: message.into(),
        });
    }
}

fn read_bounded(path: &Path) -> Result<Vec<u8>, String> {
    let file = fs::File::open(path).map_err(|error| error.to_string())?;
    let size = file.metadata().map_err(|error| error.to_string())?.len();
    if size > MAX_YAML_BYTES {
        return Err(format!(
            "Файл превышает лимит индексатора: {size} байт (максимум {MAX_YAML_BYTES})."
        ));
    }
    let mut bytes = Vec::new();
    file.take(MAX_YAML_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() as u64 > MAX_YAML_BYTES {
        return Err("YAML-файл увеличился во время чтения и превысил лимит.".into());
    }
    Ok(bytes)
}

fn configured_partials(root: &Path, issues: &mut Vec<PrototypeDiagnostic>) -> Vec<PartialScope> {
    let config_rel = "Resources/PartialPrototypes/partialPrototypes.yml";
    let config = root.join(config_rel);
    if !config.exists() {
        return Vec::new();
    }
    let canonical = match fs::canonicalize(&config) {
        Ok(path) if path.starts_with(root) => path,
        Ok(_) => {
            issues.push(PrototypeDiagnostic {
                code: "PARTIAL_CONFIG_OUTSIDE_PROJECT",
                file: config_rel.into(),
                line: 0,
                message: "Конфигурация partial-каталогов ссылается за пределы проекта.".into(),
            });
            return Vec::new();
        }
        Err(error) => {
            issues.push(PrototypeDiagnostic {
                code: "PARTIAL_CONFIG_UNREADABLE",
                file: config_rel.into(),
                line: 0,
                message: error.to_string(),
            });
            return Vec::new();
        }
    };
    let content = match read_bounded(&canonical)
        .and_then(|bytes| String::from_utf8(bytes).map_err(|error| error.to_string()))
    {
        Ok(content) => content,
        Err(message) => {
            issues.push(PrototypeDiagnostic {
                code: "PARTIAL_CONFIG_UNREADABLE",
                file: config_rel.into(),
                line: 0,
                message,
            });
            return Vec::new();
        }
    };
    let parsed = match YamlLoader::load_from_str(&content) {
        Ok(parsed) => parsed,
        Err(error) => {
            issues.push(PrototypeDiagnostic {
                code: "PARTIAL_CONFIG_INVALID",
                file: config_rel.into(),
                line: 0,
                message: error.to_string(),
            });
            return Vec::new();
        }
    };
    let mut scopes = Vec::new();
    for document in parsed {
        let Some(paths) = document.as_vec() else {
            issues.push(PrototypeDiagnostic {
                code: "PARTIAL_CONFIG_INVALID",
                file: config_rel.into(),
                line: 0,
                message: "Ожидается YAML-список путей к partial-каталогам или файлам.".into(),
            });
            continue;
        };
        for item in paths {
            let order = scopes.len();
            let Yaml::String(raw) = item else {
                issues.push(PrototypeDiagnostic {
                    code: "PARTIAL_CONFIG_PATH_INVALID",
                    file: config_rel.into(),
                    line: 0,
                    message: "Путь partial-ресурса должен быть строкой.".into(),
                });
                continue;
            };
            let trimmed = raw.trim().replace('\\', "/");
            let rel = trimmed.trim_start_matches('/');
            let path = if rel.starts_with("Resources/") {
                rel.to_string()
            } else {
                format!("Resources/{rel}")
            };

            let absolute = Path::new(&path);
            if !path.starts_with("Resources/Prototypes/")
                || absolute
                    .components()
                    .any(|component| !matches!(component, Component::Normal(_)))
            {
                issues.push(PrototypeDiagnostic {
                    code: "PARTIAL_CONFIG_PATH_INVALID",
                    file: config_rel.into(),
                    line: 0,
                    message: format!("Недопустимый путь partial-ресурса: {raw}"),
                });
                continue;
            }
            let full = root.join(&path);
            if !full.exists() {
                issues.push(PrototypeDiagnostic {
                    code: "PARTIAL_CONFIG_MISSING",
                    file: config_rel.into(),
                    line: 0,
                    message: format!("Указанный partial-путь не существует: {path}"),
                });
            }
            scopes.push(PartialScope {
                is_file: full.is_file() || path.ends_with(".yml") || path.ends_with(".yaml"),
                relative: path.trim_end_matches('/').into(),
                order,
            });
        }
    }
    scopes
}

#[derive(Debug)]
struct Draft {
    kind: Option<String>,
    id: Option<String>,
    parents: Vec<String>,
    abstract_prototype: bool,
    type_tag: Option<String>,
    id_tag: Option<String>,
    mapping_tag: Option<String>,
    parent_tag: Option<String>,
    expected_key: bool,
    pending_key: Option<String>,
    line: usize,
    document_index: usize,
    item_index: usize,
}

enum Frame {
    RootSequence,
    Prototype(Box<Draft>),
    ParentSequence,
    OtherSequence,
    OtherMapping,
}

struct DeclarationCollector {
    file: String,
    configured_order: Option<usize>,
    document_index: usize,
    item_index: usize,
    frames: Vec<Frame>,
    declarations: Vec<PrototypeDeclaration>,
    diagnostics: Vec<PrototypeDiagnostic>,
}

impl DeclarationCollector {
    fn new(file: &str, configured_order: Option<usize>) -> Self {
        Self {
            file: file.into(),
            configured_order,
            document_index: 0,
            item_index: 0,
            frames: Vec::new(),
            declarations: Vec::new(),
            diagnostics: Vec::new(),
        }
    }

    fn note(&mut self, code: &'static str, line: usize, message: impl Into<String>) {
        self.diagnostics.push(PrototypeDiagnostic {
            code,
            line,
            file: self.file.clone(),
            message: message.into(),
        });
    }

    fn finalize(&mut self, draft: Draft) {
        if draft.id_tag.is_some() {
            // A tagged ID may represent multiple generated prototypes or a non-scalar value.
            self.note(
                "PROTOTYPE_DYNAMIC_ID",
                draft.line,
                "ID создаётся YAML-тегом динамически. Индексировать как один обычный прототип нельзя.",
            );
            return;
        }
        let (Some(kind), Some(id)) = (draft.kind, draft.id) else {
            self.note(
                "PROTOTYPE_IDENTITY_MISSING",
                draft.line,
                "Пропущено объявление без строковых полей type и id.",
            );
            return;
        };
        if kind.trim().is_empty() || id.trim().is_empty() {
            self.note(
                "PROTOTYPE_IDENTITY_MISSING",
                draft.line,
                "Пропущено объявление с пустыми type или id.",
            );
            return;
        }
        let mode = if draft.type_tag.as_deref() == Some("PartialOnly") {
            "partial_only"
        } else if draft
            .mapping_tag
            .as_ref()
            .is_some_and(|tag| tag.starts_with("Partial:"))
            || draft
                .type_tag
                .as_ref()
                .is_some_and(|tag| tag.starts_with("Partial:"))
        {
            "tagged_partial"
        } else if self.configured_order.is_some() {
            "configured_partial"
        } else {
            "normal"
        };
        self.declarations.push(PrototypeDeclaration {
            kind,
            id,
            parents: draft.parents,
            abstract_prototype: draft.abstract_prototype,
            file: self.file.clone(),
            line: draft.line,
            document_index: draft.document_index,
            item_index: draft.item_index,
            mode,
            partial_order: self.configured_order,
            parent_tag: draft.parent_tag,
            source_count: 1,
        });
    }
}

fn tag_name(tag: &Tag) -> String {
    format!("{}{}", tag.handle, tag.suffix)
        .trim_start_matches('!')
        .into()
}

impl MarkedEventReceiver for DeclarationCollector {
    fn on_event(&mut self, event: Event, mark: Marker) {
        match event {
            Event::DocumentStart => {
                self.document_index += 1;
                self.item_index = 0;
                self.frames.clear();
            }
            Event::DocumentEnd => self.frames.clear(),
            Event::SequenceStart(_, tag) => {
                if self.frames.is_empty() {
                    self.frames.push(Frame::RootSequence);
                } else if let Some(Frame::Prototype(draft)) = self.frames.last_mut() {
                    let key = draft.pending_key.take();
                    draft.expected_key = true;
                    if key.as_deref() == Some("parent") {
                        draft.parent_tag = tag.as_ref().map(tag_name);
                        self.frames.push(Frame::ParentSequence);
                    } else {
                        self.frames.push(Frame::OtherSequence);
                    }
                } else {
                    self.frames.push(Frame::OtherSequence);
                }
            }
            Event::SequenceEnd => {
                self.frames.pop();
            }
            Event::MappingStart(_, tag) => {
                if matches!(self.frames.last(), Some(Frame::RootSequence)) {
                    self.item_index += 1;
                    self.frames.push(Frame::Prototype(Box::new(Draft {
                        kind: None,
                        id: None,
                        parents: Vec::new(),
                        abstract_prototype: false,
                        type_tag: None,
                        id_tag: None,
                        mapping_tag: tag.as_ref().map(tag_name),
                        parent_tag: None,
                        expected_key: true,
                        pending_key: None,
                        line: mark.line(),
                        document_index: self.document_index,
                        item_index: self.item_index,
                    })));
                } else {
                    if let Some(Frame::Prototype(draft)) = self.frames.last_mut() {
                        draft.pending_key = None;
                        draft.expected_key = true;
                    }
                    self.frames.push(Frame::OtherMapping);
                }
            }
            Event::MappingEnd => {
                if let Some(Frame::Prototype(draft)) = self.frames.pop() {
                    self.finalize(*draft);
                }
            }
            Event::Scalar(value, _, _, tag) => {
                if let Some(Frame::Prototype(draft)) = self.frames.last_mut() {
                    if draft.expected_key {
                        draft.pending_key = Some(value);
                        draft.expected_key = false;
                    } else {
                        let key = draft.pending_key.take();
                        draft.expected_key = true;
                        match key.as_deref() {
                            Some("type") => {
                                draft.kind = Some(value);
                                draft.type_tag = tag.as_ref().map(tag_name);
                            }
                            Some("id") => {
                                draft.id = Some(value);
                                draft.id_tag = tag.as_ref().map(tag_name);
                            }
                            Some("parent") => {
                                draft.parents.push(value);
                                draft.parent_tag = tag.as_ref().map(tag_name);
                            }
                            Some("abstract") => {
                                draft.abstract_prototype = value.eq_ignore_ascii_case("true");
                            }
                            _ => {}
                        }
                    }
                } else if matches!(self.frames.last(), Some(Frame::ParentSequence)) {
                    if let Some(Frame::Prototype(draft)) = self
                        .frames
                        .iter_mut()
                        .rev()
                        .find(|frame| matches!(frame, Frame::Prototype(_)))
                    {
                        draft.parents.push(value);
                    }
                }
            }
            Event::Alias(_) | Event::StreamStart | Event::StreamEnd | Event::Nothing => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(
        text: &str,
        order: Option<usize>,
    ) -> (Vec<PrototypeDeclaration>, Vec<PrototypeDiagnostic>) {
        let mut collector = DeclarationCollector::new("Resources/Prototypes/test.yml", order);
        Parser::new_from_str(text)
            .load(&mut collector, true)
            .unwrap();
        (collector.declarations, collector.diagnostics)
    }

    #[test]
    fn extracts_real_prototypes_and_source_lines() {
        let (items, issues) = parse(
            "# heading\n- type: entity\n  id: SampleOne\n  abstract: true\n  parent: Base\n  components:\n  - type: Transform\n- type: entity\n  parent: [Base, Other]\n  id: SampleTwo\n", None,
        );
        assert!(issues.is_empty());
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].id, "SampleOne");
        assert_eq!(items[0].parents, ["Base"]);
        assert!(items[0].abstract_prototype);
        assert_eq!(items[1].parents, ["Base", "Other"]);
        assert!(items[1].line > items[0].line);
        assert_eq!(items[1].item_index, 2);
    }

    #[test]
    fn accepts_ss14_yaml_custom_tags_without_modifying_content() {
        let text = "- type: !PartialOnly entity\n  id: Test\n  components:\n  - !Remove type: DeleteMe\n  - type: Sprite\n    state: !Clear ignored\n";
        let (items, issues) = parse(text, None);
        assert!(issues.is_empty());
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].mode, "partial_only");
    }

    #[test]
    fn configured_and_explicit_partial_declarations_remain_separate() {
        let (items, _) = parse(
            "- type: entity\n  id: Test\n- !Partial:0\n  type: entity\n  id: Other\n",
            Some(0),
        );
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].mode, "configured_partial");
        assert_eq!(items[1].mode, "tagged_partial");
    }

    #[test]
    fn nested_components_are_not_mistaken_for_prototypes() {
        let (items, issues) = parse(
            "- type: entity\n  id: Example\n  components:\n  - type: Sprite\n    layers:\n    - state: icon\n      visible: true\n", None,
        );
        assert_eq!(items.len(), 1);
        assert!(issues.is_empty());
    }

    #[test]
    fn excludes_dynamic_variant_identifiers_and_explains_why() {
        let (items, issues) = parse(
            "- type: !PartialOnly listing\n  id: !type:CreateVariants\n  values: [A, B]\n",
            None,
        );
        assert!(items.is_empty());
        assert_eq!(issues[0].code, "PROTOTYPE_DYNAMIC_ID");
    }

    #[test]
    fn supports_multiple_yaml_documents() {
        let (items, issues) = parse(
            "- type: entity\n  id: First\n---\n- type: entity\n  id: Second\n",
            None,
        );
        assert!(issues.is_empty());
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].document_index, 1);
        assert_eq!(items[1].document_index, 2);
    }

    #[test]
    fn records_source_diagnostics_for_invalid_entries() {
        let (items, issues) = parse("- type: entity\n  name: NoId\n", None);
        assert!(items.is_empty());
        assert_eq!(issues[0].code, "PROTOTYPE_IDENTITY_MISSING");
    }

    #[test]
    fn partial_config_paths_are_ordered_without_code_execution() {
        let root = std::env::temp_dir().join(format!("ss14-partials-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("Resources/PartialPrototypes")).unwrap();
        fs::create_dir_all(root.join("Resources/Prototypes/_Fork/Partials")).unwrap();
        fs::write(
            root.join("Resources/PartialPrototypes/partialPrototypes.yml"),
            "- /Prototypes/_Fork/Partials\n- /Prototypes/_Fork/Partials/example.yml\n",
        )
        .unwrap();
        let mut issues = Vec::new();
        let scopes = configured_partials(&root, &mut issues);
        assert_eq!(scopes.len(), 2);
        assert_eq!(scopes[0].order, 0);
        assert!(!scopes[0].is_file);
        assert!(scopes[1].is_file);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn catalog_keeps_base_and_partial_separate_and_reports_bad_yaml() {
        let root =
            std::env::temp_dir().join(format!("ss14-prototype-integration-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let prototypes = root.join("Resources/Prototypes");
        let partials = prototypes.join("_Local/Partials");
        fs::create_dir_all(&partials).unwrap();
        fs::create_dir_all(root.join("Resources/PartialPrototypes")).unwrap();

        fs::write(
            prototypes.join("base.yml"),
            "- type: entity\n  id: Example\n  parent: BaseEntity\n",
        )
        .unwrap();
        fs::write(
            partials.join("changes.yml"),
            "- type: entity\n  id: Example\n  name: Modified\n",
        )
        .unwrap();
        fs::write(
            prototypes.join("broken.yml"),
            "- type: entity\n  id: [unfinished\n",
        )
        .unwrap();
        fs::write(
            root.join("Resources/PartialPrototypes/partialPrototypes.yml"),
            "- /Prototypes/_Local/Partials\n",
        )
        .unwrap();

        let workspace = crate::project::ProjectIndex::open(root.to_str().unwrap()).unwrap();
        let catalog = workspace.prototypes();
        let page = catalog.search("Example", Some("entity"), 0, 100);

        assert_eq!(page.total, 2);
        assert!(page.items.iter().all(|entry| entry.source_count == 2));
        assert_eq!(
            page.items
                .iter()
                .filter(|entry| entry.mode == "normal")
                .count(),
            1
        );
        assert_eq!(
            page.items
                .iter()
                .filter(|entry| entry.mode == "configured_partial")
                .count(),
            1
        );
        assert!(catalog
            .diagnostics(0, 50)
            .items
            .iter()
            .any(|item| item.code == "YAML_PARSE_ERROR" && item.file.ends_with("broken.yml")));
        assert!(!catalog
            .diagnostics(0, 50)
            .items
            .iter()
            .any(|item| item.code == "MULTIPLE_BASE_DECLARATIONS"));

        let _ = fs::remove_dir_all(root);
    }
}

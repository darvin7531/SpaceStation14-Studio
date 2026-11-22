//! Bounded, lazy C# syntax index for SS14 metadata.
//!
//! Unlike the Electron regex scanner, Tree-sitter attaches attributes to the
//! actual class/member syntax node, not a nearby line. This is intentionally a
//! structural index, not Roslyn semantic type resolution: inheritance,
//! preprocessor symbols, generated sources and cross-assembly partial classes
//! remain unverified until an explicit semantic pass is added.
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::Read;
use std::path::Path;

use serde::Serialize;
use tree_sitter::{Node, Parser};

use crate::error::StudioError;

const MAX_SOURCE_FILES: usize = 20_000;
const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_SCAN_BYTES: u64 = 128 * 1024 * 1024;
const MAX_WARNINGS: usize = 40;
const MAX_PAGE: usize = 150;

#[derive(Clone, Debug, Serialize)]
pub struct CSharpField {
    pub name: String,
    pub member: String,
    pub field_type: String,
    pub line: usize,
    pub required: bool,
    pub explicit_name: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct CSharpDefinition {
    pub kind: &'static str,
    pub name: String,
    pub class_name: String,
    pub qualified_name: String,
    pub file: String,
    pub line: usize,
    pub partial: bool,
    pub base_types: String,
    pub fields: Vec<CSharpField>,
    pub parse_uncertain: bool,
}

#[derive(Debug)]
pub struct CSharpCatalog {
    definitions: Vec<CSharpDefinition>,
    parts: Vec<CSharpPart>,
    warnings: Vec<String>,
    complete: bool,
    files_scanned: usize,
    files_parsed: usize,
    bytes_scanned: u64,
}

#[derive(Debug, Serialize)]
pub struct CSharpPage {
    pub total: usize,
    pub files_scanned: usize,
    pub files_parsed: usize,
    pub bytes_scanned: u64,
    pub complete: bool,
    pub warnings: Vec<String>,
    pub items: Vec<CSharpDefinition>,
}

/// A C# partial declaration carrying its own DataField members. Collected
/// independently of RegisterComponent, which is often present on only one
/// partial declaration. Every field retains its source via the containing part.
#[derive(Debug, Clone, Serialize)]
pub struct CSharpPart {
    pub qualified_name: String,
    pub file: String,
    pub line: usize,
    pub fields: Vec<CSharpField>,
    pub parse_uncertain: bool,
}

/// Direct-base field candidate resolved only by exact lexical namespace + type.
/// Not a Roslyn result: assemblies, using-aliases and preprocessor symbols
/// remain unknown. The UI must not use these for automatic YAML edits.
#[derive(Debug, Clone, Serialize)]
pub struct CSharpInheritedCandidate {
    pub base_type: String,
    pub qualified_name: String,
    pub file: String,
    pub line: usize,
    pub fields: Vec<CSharpField>,
    pub parse_uncertain: bool,
}

/// A conservative lookup for a YAML component type. "unique" only means
/// one complete direct declaration was found, not a Roslyn-resolved schema.
#[derive(Debug, Serialize)]
pub struct ComponentSchema {
    pub type_name: String,
    /// unique | ambiguous | partial | uncertain | not_indexed
    pub status: &'static str,
    pub declarations: Vec<CSharpDefinition>,
    /// Related partial C# fragments under an identical namespace + type.
    /// Informational only: no assembly/preprocessor semantics are inferred.
    pub parts: Vec<CSharpPart>,
    pub inherited_candidates: Vec<CSharpInheritedCandidate>,
}

#[derive(Debug, Serialize)]
pub struct ComponentSchemaBatch {
    pub index_complete: bool,
    pub files_scanned: usize,
    pub warnings: Vec<String>,
    pub components: Vec<ComponentSchema>,
}

#[derive(Debug)]
struct Attribute {
    name: String,
    literal: Option<String>,
    arguments: String,
}

fn node_text<'a>(node: Node<'_>, source: &'a [u8]) -> &'a str {
    node.utf8_text(source).unwrap_or("")
}

fn named_children(node: Node<'_>) -> Vec<Node<'_>> {
    let mut cursor = node.walk();
    node.named_children(&mut cursor).collect()
}

fn first_child<'a>(node: Node<'a>, kind: &str) -> Option<Node<'a>> {
    named_children(node)
        .into_iter()
        .find(|child| child.kind() == kind)
}

fn first_string(node: Node<'_>, source: &[u8]) -> Option<String> {
    let mut pending = vec![node];
    while let Some(candidate) = pending.pop() {
        if matches!(
            candidate.kind(),
            "string_literal" | "verbatim_string_literal" | "raw_string_literal"
        ) {
            let raw = node_text(candidate, source);
            if let Some(inner) = raw
                .strip_prefix('"')
                .and_then(|value| value.strip_suffix('"'))
            {
                // Do not pretend to evaluate C# escapes or interpolated values.
                if !inner.contains('\\') && !inner.contains('{') {
                    return Some(inner.into());
                }
            }
        }
        for child in named_children(candidate).into_iter().rev() {
            pending.push(child);
        }
    }
    None
}

fn attributes(node: Node<'_>, source: &[u8]) -> Vec<Attribute> {
    let mut result = Vec::new();
    for list in named_children(node) {
        if list.kind() != "attribute_list" {
            continue;
        }
        for attr in named_children(list) {
            if attr.kind() != "attribute" {
                continue;
            }
            let attribute_name = attr
                .child_by_field_name("name")
                .or_else(|| attr.named_child(0))
                .map(|part| node_text(part, source))
                .unwrap_or("");
            let name = attribute_name
                .rsplit('.')
                .next()
                .unwrap_or(attribute_name)
                .trim_end_matches("Attribute");
            if name.is_empty() {
                continue;
            }
            result.push(Attribute {
                name: name.into(),
                literal: first_string(attr, source),
                arguments: node_text(attr, source).into(),
            });
        }
    }
    result
}

fn member_name(member: &str) -> String {
    let cleaned = member.trim_start_matches('@').trim_start_matches('_');
    let mut chars = cleaned.chars();
    match chars.next() {
        Some(first) => first.to_lowercase().collect::<String>() + chars.as_str(),
        None => member.into(),
    }
}

fn data_fields(node: Node<'_>, source: &[u8]) -> Vec<CSharpField> {
    let Some(attribute) = attributes(node, source)
        .into_iter()
        .find(|attr| attr.name == "DataField")
    else {
        return Vec::new();
    };

    let required = attribute
        .arguments
        .split(',')
        .map(|arg| arg.to_ascii_lowercase())
        .any(|arg| {
            let normalized = arg.trim_start();
            (normalized.starts_with("required:") || normalized.starts_with("required ="))
                && normalized.contains("true")
        });
    let explicit_name = attribute.literal.is_some();

    let (field_type, declarations) = if node.kind() == "property_declaration" {
        let kind = node
            .child_by_field_name("type")
            .map(|part| node_text(part, source).to_string())
            .unwrap_or_default();
        let name = node
            .child_by_field_name("name")
            .map(|part| node_text(part, source).to_string());
        (
            kind,
            name.into_iter()
                .map(|name| (name, node.start_position().row + 1))
                .collect(),
        )
    } else if node.kind() == "field_declaration" {
        let Some(declaration) = first_child(node, "variable_declaration") else {
            return Vec::new();
        };
        let kind = declaration
            .child_by_field_name("type")
            .or_else(|| declaration.named_child(0))
            .map(|part| node_text(part, source).to_string())
            .unwrap_or_default();
        let names = named_children(declaration)
            .into_iter()
            .filter(|child| child.kind() == "variable_declarator")
            .filter_map(|child| {
                child
                    .child_by_field_name("name")
                    .or_else(|| child.named_child(0))
                    .map(|name| {
                        (
                            node_text(name, source).to_string(),
                            child.start_position().row + 1,
                        )
                    })
            })
            .collect();
        (kind, names)
    } else {
        return Vec::new();
    };

    let declarations: Vec<(String, usize)> = declarations;
    // A single DataField attribute on multiple variables is ambiguous for
    // YAML. Do not manufacture several equally named schema entries.
    if declarations.len() != 1 || field_type.trim().is_empty() {
        return Vec::new();
    }
    declarations
        .into_iter()
        .map(|(member, line)| CSharpField {
            name: attribute
                .literal
                .clone()
                .unwrap_or_else(|| member_name(&member)),
            member,
            field_type: field_type.trim().into(),
            line,
            required,
            explicit_name,
        })
        .collect()
}

fn component_name(class_name: &str) -> String {
    let name = ["Client", "Server", "Shared"]
        .into_iter()
        .find_map(|prefix| class_name.strip_prefix(prefix))
        .unwrap_or(class_name);
    name.strip_suffix("Component").unwrap_or(name).into()
}

fn prototype_name(class_name: &str) -> String {
    if class_name == "EntityPrototype" {
        return "entity".into();
    }
    member_name(class_name.strip_suffix("Prototype").unwrap_or(class_name))
}

fn qualified_name(node: Node<'_>, source: &[u8], file_scoped: Option<&str>) -> String {
    let mut parts = Vec::new();
    let mut parent = Some(node);
    let mut has_file_scoped_ancestor = false;
    while let Some(current) = parent {
        if current.kind() == "file_scoped_namespace_declaration" {
            has_file_scoped_ancestor = true;
        }
        if matches!(
            current.kind(),
            "class_declaration"
                | "record_declaration"
                | "struct_declaration"
                | "namespace_declaration"
                | "file_scoped_namespace_declaration"
        ) {
            if let Some(name) = current.child_by_field_name("name") {
                parts.push(node_text(name, source).to_string());
            }
        }
        parent = current.parent();
    }
    // Tree-sitter represents `namespace A.B;` as a sibling of the class
    // declaration rather than its ancestor. Keep its scope for every
    // top-level declaration without duplicating it when nested by grammar.
    if !has_file_scoped_ancestor {
        if let Some(namespace) = file_scoped {
            parts.push(namespace.to_string());
        }
    }
    parts.reverse();
    parts.join(".")
}

fn parse_class(
    node: Node<'_>,
    file: &str,
    source: &[u8],
    file_scoped: Option<&str>,
) -> (Vec<CSharpDefinition>, Option<CSharpPart>) {
    if !matches!(node.kind(), "class_declaration" | "record_declaration") {
        return (Vec::new(), None);
    }
    let Some(name_node) = node.child_by_field_name("name") else {
        return (Vec::new(), None);
    };
    let class_name = node_text(name_node, source).to_string();
    let attrs = attributes(node, source);

    let component = attrs.iter().any(|attr| attr.name == "RegisterComponent");
    let prototype = attrs
        .iter()
        .find(|attr| attr.name == "Prototype" || attr.name == "PrototypeRecord");
    let body = node.child_by_field_name("body");
    let mut fields = Vec::new();
    if let Some(body) = body {
        for member in named_children(body) {
            if matches!(member.kind(), "field_declaration" | "property_declaration") {
                fields.extend(data_fields(member, source));
            }
        }
    }
    let declaration = &source[node.start_byte()..name_node.start_byte()];
    let partial = String::from_utf8_lossy(declaration)
        .split(|c: char| !c.is_ascii_alphanumeric())
        .any(|word| word == "partial");
    let base_types = first_child(node, "base_list")
        .map(|part| {
            node_text(part, source)
                .trim_start_matches(':')
                .trim()
                .to_string()
        })
        .unwrap_or_default();
    let line = node.start_position().row + 1;
    let qualified_name = qualified_name(node, source, file_scoped);
    let fragment = if !fields.is_empty() || (partial && (component || prototype.is_some())) {
        Some(CSharpPart {
            qualified_name: qualified_name.clone(),
            file: file.into(),
            line,
            fields: fields.clone(),
            parse_uncertain: node.has_error(),
        })
    } else {
        None
    };
    if !component && prototype.is_none() {
        return (Vec::new(), fragment);
    }
    let mut result = Vec::new();
    if component {
        let override_name = attrs
            .iter()
            .find(|attr| attr.name == "ComponentProtoName")
            .and_then(|attr| attr.literal.clone());
        result.push(CSharpDefinition {
            kind: "component",
            name: override_name.unwrap_or_else(|| component_name(&class_name)),
            class_name: class_name.clone(),
            qualified_name: qualified_name.clone(),
            file: file.into(),
            line,
            partial,
            base_types: base_types.clone(),
            fields: fields.clone(),
            parse_uncertain: node.has_error(),
        });
    }
    if let Some(proto) = prototype {
        result.push(CSharpDefinition {
            kind: "prototype",
            name: proto
                .literal
                .clone()
                .unwrap_or_else(|| prototype_name(&class_name)),
            class_name,
            qualified_name,
            file: file.into(),
            line,
            partial,
            base_types,
            fields,
            parse_uncertain: node.has_error(),
        });
    }
    (result, fragment)
}

fn parse_source(
    parser: &mut Parser,
    file: &str,
    source: &str,
) -> (Vec<CSharpDefinition>, Vec<CSharpPart>, bool) {
    let Some(tree) = parser.parse(source, None) else {
        return (Vec::new(), Vec::new(), true);
    };
    let mut definitions = Vec::new();
    let mut fragments = Vec::new();
    let root = tree.root_node();
    let file_scoped = named_children(root)
        .into_iter()
        .find(|child| child.kind() == "file_scoped_namespace_declaration")
        .and_then(|child| child.child_by_field_name("name"))
        .map(|name| node_text(name, source.as_bytes()));
    let mut pending = vec![root];
    while let Some(node) = pending.pop() {
        let (found, fragment) = parse_class(node, file, source.as_bytes(), file_scoped);
        definitions.extend(found);
        if let Some(fragment) = fragment {
            fragments.push(fragment);
        }
        for child in named_children(node).into_iter().rev() {
            pending.push(child);
        }
    }
    (definitions, fragments, root.has_error())
}

fn warning(warnings: &mut Vec<String>, issue: String) {
    if warnings.len() < MAX_WARNINGS {
        warnings.push(issue);
    }
}

fn is_skipped_dir(name: &str) -> bool {
    matches!(
        name,
        ".git"
            | ".idea"
            | ".vs"
            | ".vscode"
            | "Resources"
            | "node_modules"
            | "target"
            | "bin"
            | "obj"
            | "dist"
            | "build"
            | "release"
            | "artifacts"
            | "packages"
            | ".cache"
            | "vendor"
    )
}

/// A base can be resolved without imports only if it is qualified or in the
/// same lexical namespace. Generics, aliases and unusual type syntax are
/// intentionally omitted: speculative matches must not become YAML hints.
fn lexical_base(derived: &str, candidate: &str) -> Option<String> {
    let base = candidate.trim();
    if base.is_empty()
        || !base
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '.')
        || base.split('.').any(str::is_empty)
    {
        return None;
    }
    if base.contains('.') {
        return Some(base.to_owned());
    }
    let (scope, _) = derived.rsplit_once('.')?;
    Some(format!("{scope}.{base}"))
}

impl CSharpCatalog {
    pub fn scan(root: &Path) -> Result<Self, StudioError> {
        let mut parser = Parser::new();
        parser
            .set_language(&tree_sitter_c_sharp::LANGUAGE.into())
            .map_err(|err| {
                StudioError::new(
                    "CSHARP_PARSER_UNAVAILABLE",
                    "Не удалось загрузить синтаксический анализатор C#.",
                    "Проверьте установленную сборку Studio.",
                )
                .with_details(err.to_string())
            })?;

        let mut catalog = Self {
            definitions: Vec::new(),
            parts: Vec::new(),
            warnings: Vec::new(),
            complete: true,
            files_scanned: 0,
            files_parsed: 0,
            bytes_scanned: 0,
        };
        let mut pending = vec![root.to_path_buf()];
        while let Some(directory) = pending.pop() {
            let entries = match fs::read_dir(&directory) {
                Ok(entries) => entries,
                Err(error) => {
                    catalog.complete = false;
                    warning(
                        &mut catalog.warnings,
                        format!(
                            "Не удалось прочитать каталог {}: {error}",
                            directory.display()
                        ),
                    );
                    continue;
                }
            };
            for entry in entries {
                let entry = match entry {
                    Ok(entry) => entry,
                    Err(error) => {
                        catalog.complete = false;
                        warning(
                            &mut catalog.warnings,
                            format!("Ошибка обхода C#-исходников: {error}"),
                        );
                        continue;
                    }
                };
                let path = entry.path();
                let kind = match entry.file_type() {
                    Ok(kind) => kind,
                    Err(error) => {
                        catalog.complete = false;
                        warning(
                            &mut catalog.warnings,
                            format!("Недоступен тип {}: {error}", path.display()),
                        );
                        continue;
                    }
                };
                if kind.is_symlink() {
                    continue;
                }
                if kind.is_dir() {
                    if !is_skipped_dir(&entry.file_name().to_string_lossy()) {
                        pending.push(path);
                    }
                    continue;
                }
                if !kind.is_file()
                    || !path
                        .extension()
                        .is_some_and(|ext| ext.eq_ignore_ascii_case("cs"))
                {
                    continue;
                }
                if catalog.files_scanned >= MAX_SOURCE_FILES {
                    catalog.complete = false;
                    warning(
                        &mut catalog.warnings,
                        format!("Лимит {MAX_SOURCE_FILES} C#-файлов достигнут. Индекс неполный."),
                    );
                    return Ok(catalog);
                }
                let relative = path
                    .strip_prefix(root)
                    .unwrap_or(&path)
                    .to_string_lossy()
                    .replace('\\', "/");
                let metadata = match entry.metadata() {
                    Ok(meta) => meta,
                    Err(error) => {
                        catalog.complete = false;
                        warning(
                            &mut catalog.warnings,
                            format!("Недоступен {relative}: {error}"),
                        );
                        continue;
                    }
                };
                if metadata.len() > MAX_FILE_BYTES {
                    catalog.complete = false;
                    warning(
                        &mut catalog.warnings,
                        format!("{relative} больше лимита 2 МиБ: пропущен."),
                    );
                    continue;
                }
                if catalog.bytes_scanned.saturating_add(metadata.len()) > MAX_SCAN_BYTES {
                    catalog.complete = false;
                    warning(
                        &mut catalog.warnings,
                        "Лимит чтения C#-исходников 128 МиБ достигнут: индекс неполный.".into(),
                    );
                    return Ok(catalog);
                }
                let mut bytes = Vec::with_capacity(metadata.len() as usize);
                let opened = File::open(&path)
                    .and_then(|file| file.take(MAX_FILE_BYTES + 1).read_to_end(&mut bytes));
                if let Err(error) = opened {
                    catalog.complete = false;
                    warning(
                        &mut catalog.warnings,
                        format!("Не удалось прочитать {relative}: {error}"),
                    );
                    continue;
                }
                if bytes.len() as u64 > MAX_FILE_BYTES {
                    catalog.complete = false;
                    warning(
                        &mut catalog.warnings,
                        format!("{relative} изменился при чтении и превысил 2 МиБ."),
                    );
                    continue;
                }
                catalog.bytes_scanned += bytes.len() as u64;
                catalog.files_scanned += 1;
                match std::str::from_utf8(&bytes) {
                    Ok(source) => {
                        // Most C# files do not declare SS14 serialization
                        // metadata. A cheap substring prefilter avoids building
                        // a syntax tree for unrelated source code.
                        if !source.contains("RegisterComponent")
                            && !source.contains("Prototype")
                            && !source.contains("DataField")
                        {
                            continue;
                        }
                        catalog.files_parsed += 1;
                        let (definitions, fragments, uncertain) =
                            parse_source(&mut parser, &relative, source);
                        catalog.parts.extend(fragments);
                        if uncertain {
                            catalog.complete = false;
                            warning(&mut catalog.warnings,
                                format!("В {relative} есть ошибки разбора C#: часть метаданных может быть неполной."));
                        }
                        catalog.definitions.extend(definitions);
                    }
                    Err(_) => {
                        catalog.complete = false;
                        warning(
                            &mut catalog.warnings,
                            format!("{relative} не является UTF-8: пропущен."),
                        );
                    }
                }
            }
        }
        catalog
            .definitions
            .sort_unstable_by(|a, b| a.name.cmp(&b.name).then_with(|| a.file.cmp(&b.file)));
        Ok(catalog)
    }

    /// Only paths that contributed C# declarations are viewable from the catalog.
    /// This prevents the source viewer from being an arbitrary filesystem reader.
    pub fn has_source(&self, path: &str) -> bool {
        self.definitions.iter().any(|entry| entry.file == path)
            || self.parts.iter().any(|part| part.file == path)
    }

    /// Resolve exact YAML component names only. Never guess a class by
    /// fuzzy match or merge duplicated / partial declarations silently.
    pub fn component_schemas(&self, names: &[String]) -> ComponentSchemaBatch {
        let mut by_name: HashMap<&str, Vec<&CSharpDefinition>> = HashMap::new();
        for entry in &self.definitions {
            if entry.kind == "component" {
                by_name.entry(entry.name.as_str()).or_default().push(entry);
            }
        }
        let mut fragments_by_type: HashMap<&str, Vec<&CSharpPart>> = HashMap::new();
        for part in &self.parts {
            fragments_by_type
                .entry(part.qualified_name.as_str())
                .or_default()
                .push(part);
        }
        let components = names
            .iter()
            .map(|type_name| {
                let declarations: Vec<CSharpDefinition> = by_name
                    .get(type_name.as_str())
                    .into_iter()
                    .flatten()
                    .map(|entry| (*entry).clone())
                    .collect();
                let status = match declarations.as_slice() {
                    [] => "not_indexed",
                    [definition] if definition.parse_uncertain => "uncertain",
                    [definition] if definition.partial => "partial",
                    [_] => "unique",
                    _ => "ambiguous",
                };
                let parts = if status == "partial" {
                    let mut parts: Vec<CSharpPart> = fragments_by_type
                        .get(declarations[0].qualified_name.as_str())
                        .into_iter()
                        .flatten()
                        .map(|part| (*part).clone())
                        .collect();
                    parts.sort_unstable_by(|a, b| {
                        a.file.cmp(&b.file).then_with(|| a.line.cmp(&b.line))
                    });
                    parts
                } else {
                    Vec::new()
                };
                let inherited_candidates = if status == "unique" {
                    declarations
                        .iter()
                        .flat_map(|definition| {
                            definition
                                .base_types
                                .split(',')
                                .take(8)
                                .filter_map(|base_name| {
                                    let base_full =
                                        lexical_base(&definition.qualified_name, base_name)?;
                                    let parts = fragments_by_type.get(base_full.as_str())?;
                                    // Duplicate source declarations may come from different
                                    // assemblies. Show every candidate and never auto-merge.
                                    Some(
                                        parts
                                            .iter()
                                            .take(16)
                                            .filter(|part| !part.fields.is_empty())
                                            .map(|part| CSharpInheritedCandidate {
                                                base_type: base_name.trim().to_owned(),
                                                qualified_name: base_full.clone(),
                                                file: part.file.clone(),
                                                line: part.line,
                                                fields: part.fields.clone(),
                                                parse_uncertain: part.parse_uncertain,
                                            })
                                            .collect::<Vec<_>>(),
                                    )
                                })
                                .flatten()
                        })
                        .take(64)
                        .collect()
                } else {
                    Vec::new()
                };
                ComponentSchema {
                    type_name: type_name.clone(),
                    status,
                    declarations,
                    parts,
                    inherited_candidates,
                }
            })
            .collect();
        ComponentSchemaBatch {
            index_complete: self.complete,
            files_scanned: self.files_scanned,
            warnings: self.warnings.clone(),
            components,
        }
    }

    pub fn page(&self, query: &str, kind: Option<&str>, offset: usize, limit: usize) -> CSharpPage {
        let query = query.trim().to_lowercase();
        let mut total = 0usize;
        let mut items = Vec::new();
        for definition in &self.definitions {
            if kind.is_some_and(|kind| kind != "all" && definition.kind != kind) {
                continue;
            }
            if !query.is_empty()
                && !definition.name.to_lowercase().contains(&query)
                && !definition.class_name.to_lowercase().contains(&query)
                && !definition.file.to_lowercase().contains(&query)
                && !definition
                    .fields
                    .iter()
                    .any(|field| field.name.to_lowercase().contains(&query))
            {
                continue;
            }
            if total >= offset && items.len() < limit.clamp(1, MAX_PAGE) {
                items.push(definition.clone());
            }
            total += 1;
        }
        CSharpPage {
            total,
            files_scanned: self.files_scanned,
            files_parsed: self.files_parsed,
            bytes_scanned: self.bytes_scanned,
            complete: self.complete,
            warnings: self.warnings.clone(),
            items,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(input: &str) -> Vec<CSharpDefinition> {
        let mut parser = Parser::new();
        parser
            .set_language(&tree_sitter_c_sharp::LANGUAGE.into())
            .unwrap();
        let (defs, _, failed) = parse_source(&mut parser, "Content.Shared/Test.cs", input);
        assert!(!failed, "Syntax error in test fixture");
        defs
    }

    #[test]
    fn direct_base_fields_are_read_only_candidates_with_source_location() {
        let mut parser = Parser::new();
        parser
            .set_language(&tree_sitter_c_sharp::LANGUAGE.into())
            .unwrap();
        let text = r#"
            namespace Content.Shared.Equipment;
            public class SharedItemBase {
                [DataField("base_speed")] public float BaseSpeed = 1f;
            }
            [RegisterComponent]
            public class ItemComponent : SharedItemBase {
                [DataField("own")] public bool Own;
            }
        "#;
        let (definitions, parts, invalid) = parse_source(
            &mut parser,
            "Content.Shared/Equipment/ItemComponent.cs",
            text,
        );
        assert!(!invalid);
        assert!(parts
            .iter()
            .any(|part| part.qualified_name.ends_with("SharedItemBase")));
        let index = CSharpCatalog {
            definitions,
            parts,
            warnings: Vec::new(),
            complete: true,
            files_scanned: 1,
            files_parsed: 1,
            bytes_scanned: text.len() as u64,
        };
        let schema = index.component_schemas(&["Item".into()]);
        let item = &schema.components[0];
        assert_eq!(item.status, "unique");
        assert_eq!(item.declarations[0].fields[0].name, "own");
        assert_eq!(item.inherited_candidates.len(), 1);
        assert_eq!(item.inherited_candidates[0].fields[0].name, "base_speed");
        assert_eq!(item.inherited_candidates[0].base_type, "SharedItemBase");
        assert!(item.inherited_candidates[0]
            .file
            .ends_with("ItemComponent.cs"));
    }

    #[test]
    fn base_candidate_resolver_rejects_inference_across_namespaces_and_generics() {
        assert_eq!(
            lexical_base("Content.Shared.ItemComponent", "SharedItemBase").as_deref(),
            Some("Content.Shared.SharedItemBase")
        );
        assert_eq!(
            lexical_base("Content.Shared.ItemComponent", "Content.Other.Base").as_deref(),
            Some("Content.Other.Base")
        );
        assert_eq!(
            lexical_base("Content.Shared.ItemComponent", "Base<T>"),
            None
        );
        assert_eq!(
            lexical_base("Content.Shared.ItemComponent", "global::Base"),
            None
        );
        assert_eq!(
            lexical_base("Content.Shared.ItemComponent", "../Base"),
            None
        );
    }

    #[test]
    fn partial_fragments_match_full_namespace_not_just_class_name() {
        let mut parser = Parser::new();
        parser
            .set_language(&tree_sitter_c_sharp::LANGUAGE.into())
            .unwrap();
        let registered = r#"
            namespace Content.Shared.One {
                [RegisterComponent]
                public partial class ExampleComponent {
                    [DataField] public int Initial = 1;
                }
            }
        "#;
        let same_namespace = r#"
            namespace Content.Shared.One;
            public partial class ExampleComponent {
                [DataField("extra")] public bool Extra;
            }
        "#;
        let other_namespace = r#"
            namespace Content.Shared.Other {
                public partial class ExampleComponent {
                    [DataField("unrelated")] public string Wrong;
                }
            }
        "#;
        let (definitions, mut parts, invalid) =
            parse_source(&mut parser, "Content.Shared/One.cs", registered);
        assert!(!invalid);
        let (_, second, invalid) =
            parse_source(&mut parser, "Content.Shared/Two.cs", same_namespace);
        assert!(!invalid);
        assert_eq!(second.len(), 1);
        assert_eq!(
            second[0].qualified_name,
            "Content.Shared.One.ExampleComponent"
        );
        let (_, unrelated, invalid) =
            parse_source(&mut parser, "Content.Shared/Other.cs", other_namespace);
        assert!(!invalid);
        parts.extend(second);
        parts.extend(unrelated);
        let catalog = CSharpCatalog {
            definitions,
            parts,
            warnings: Vec::new(),
            complete: true,
            files_scanned: 3,
            files_parsed: 3,
            bytes_scanned: 0,
        };
        let result = catalog.component_schemas(&["Example".into()]);
        let component = &result.components[0];
        assert_eq!(component.status, "partial");
        assert_eq!(
            component.declarations[0].qualified_name,
            "Content.Shared.One.ExampleComponent"
        );
        assert_eq!(component.parts.len(), 2);
        assert_eq!(
            component
                .parts
                .iter()
                .flat_map(|part| part.fields.iter())
                .map(|field| field.name.as_str())
                .collect::<Vec<_>>(),
            vec!["initial", "extra"]
        );
        assert_eq!(component.parts[1].file, "Content.Shared/Two.cs");
    }

    #[test]
    fn non_partial_definition_does_not_merge_similar_partial_type() {
        let mut parser = Parser::new();
        parser
            .set_language(&tree_sitter_c_sharp::LANGUAGE.into())
            .unwrap();
        let (definitions, _, failed) = parse_source(
            &mut parser,
            "A.cs",
            "[RegisterComponent] public class BodyComponent { [DataField] public int Count; }",
        );
        assert!(!failed);
        let (_, parts, failed) = parse_source(
            &mut parser,
            "B.cs",
            "public partial class BodyComponent { [DataField] public bool Active; }",
        );
        assert!(!failed);
        let catalog = CSharpCatalog {
            definitions,
            parts,
            warnings: Vec::new(),
            complete: true,
            files_scanned: 2,
            files_parsed: 2,
            bytes_scanned: 0,
        };
        let result = catalog.component_schemas(&["Body".into()]);
        assert_eq!(result.components[0].status, "unique");
        assert!(result.components[0].parts.is_empty());
    }

    #[test]
    fn component_schema_requires_exact_unique_non_partial_definition() {
        let source = r#"
        [RegisterComponent]
        public class ItemComponent {
            [DataField("display")]
            public string Display = "";
            [DataField]
            public bool Visible = true;
        }
        [RegisterComponent]
        public partial class PartialComponent {}
        [RegisterComponent]
        public class DoubleComponent {}
        [RegisterComponent]
        public class DoubleComponent {}
        [RegisterComponent]
        [ComponentProtoName("custom")]
        public class RenamedComponent {}
        "#;
        let index = CSharpCatalog {
            definitions: parse(source),
            parts: Vec::new(),
            warnings: Vec::new(),
            complete: true,
            files_scanned: 1,
            files_parsed: 1,
            bytes_scanned: source.len() as u64,
        };
        let names: Vec<String> = ["Item", "Partial", "Double", "custom", "Missing"]
            .into_iter()
            .map(str::to_string)
            .collect();
        let result = index.component_schemas(&names);
        assert!(result.index_complete);
        assert_eq!(result.components[0].status, "unique");
        assert_eq!(result.components[0].declarations[0].fields.len(), 2);
        assert_eq!(
            result.components[0].declarations[0].fields[0].name,
            "display"
        );
        assert_eq!(result.components[1].status, "partial");
        assert_eq!(result.components[2].status, "ambiguous");
        assert_eq!(result.components[2].declarations.len(), 2);
        assert_eq!(result.components[3].status, "unique");
        assert_eq!(result.components[4].status, "not_indexed");
    }

    #[test]
    fn component_schema_skips_non_component_class_of_same_name() {
        let source = r#"
        [Prototype("Item")]
        public class ItemPrototype {}
        [RegisterComponent]
        public class ItemComponent { [DataField] public float Speed; }
        "#;
        let index = CSharpCatalog {
            definitions: parse(source),
            parts: Vec::new(),
            warnings: Vec::new(),
            complete: true,
            files_scanned: 1,
            files_parsed: 1,
            bytes_scanned: source.len() as u64,
        };
        let result = index.component_schemas(&["Item".into()]);
        assert_eq!(result.components[0].status, "unique");
        assert_eq!(
            result.components[0].declarations[0].class_name,
            "ItemComponent"
        );
    }

    #[test]
    fn finds_attributes_inside_their_actual_class_not_nearby_classes() {
        let source = r#"
        [RegisterComponent]
        [ComponentProtoName("Renamed")]
        public sealed partial class SharedExampleComponent : Component {
            /// Test
            [DataField("maxValue", required: true)]
            public int Maximum = 5;

            [DataField]
            public Dictionary<string, int> CurrentValues { get; set; }
        }
        class Unrelated { [DataField] public int FalseField; }
        "#;
        let defs = parse(source);
        assert_eq!(defs.len(), 1);
        let component = &defs[0];
        assert_eq!(component.kind, "component");
        assert_eq!(component.name, "Renamed");
        assert_eq!(component.class_name, "SharedExampleComponent");
        assert!(component.partial);
        assert_eq!(component.fields.len(), 2);
        assert_eq!(component.fields[0].name, "maxValue");
        assert!(component.fields[0].required);
        assert_eq!(component.fields[1].name, "currentValues");
        assert!(!component.fields[1].explicit_name);
    }

    #[test]
    fn finds_prototype_and_record_declarations_with_identity() {
        let defs = parse(
            r#"
        [Prototype("custom-item")]
        public sealed class CustomItemPrototype : IPrototype { [DataField] public string ID = ""; }
        [Prototype]
        public partial class EntityPrototype : IPrototype { }
        "#,
        );
        assert_eq!(defs.len(), 2);
        assert_eq!(defs[0].kind, "prototype");
        assert_eq!(defs[0].name, "custom-item");
        assert_eq!(defs[0].fields[0].name, "iD");
        assert_eq!(defs[1].name, "entity");
    }

    #[test]
    fn ignores_attributes_inside_comments_and_string_literals() {
        let defs = parse(
            r#"
        // [RegisterComponent] class FakeComponent {}
        /* [RegisterComponent] class AnotherFakeComponent {} */
        public class Unrelated {
            public string Text = "[RegisterComponent] class BadComponent {}";
        }
        [RegisterComponent]
        public class RealComponent { }
        "#,
        );
        assert_eq!(defs.len(), 1);
        assert_eq!(defs[0].name, "Real");
    }

    #[test]
    fn no_fixed_line_window_and_no_cross_class_datafield_leakage() {
        let long_gap = "\n".repeat(300);
        let source = format!(
            "[RegisterComponent]\npublic class HugeComponent {{\n{long_gap}[DataField]\npublic float Payload;\n}}\n[RegisterComponent]\npublic class OtherComponent {{ }}",
        );
        let defs = parse(&source);
        assert_eq!(defs.len(), 2);
        assert_eq!(defs[0].fields.len(), 1);
        assert_eq!(defs[1].fields.len(), 0);
    }

    #[test]
    fn scan_respects_root_scopes_and_skips_symlink() {
        let root = std::env::temp_dir().join(format!(
            "ss14-csharp-test-{}-{}",
            std::process::id(),
            std::thread::current().name().unwrap_or("anonymous")
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("Content.Shared")).unwrap();
        fs::create_dir_all(root.join("Resources")).unwrap();
        fs::write(
            root.join("Content.Shared/Example.cs"),
            "[RegisterComponent]\npublic class ExampleComponent {}\n",
        )
        .unwrap();
        fs::write(
            root.join("Resources/Skip.cs"),
            "[RegisterComponent]\npublic class SkipComponent {}\n",
        )
        .unwrap();
        fs::write(
            root.join("Content.Shared/Unrelated.cs"),
            "public class Unrelated {}\n",
        )
        .unwrap();
        let index = CSharpCatalog::scan(&root).unwrap();
        assert!(index.complete);
        assert_eq!(index.files_scanned, 2);
        assert_eq!(index.files_parsed, 1);
        let page = index.page("", None, 0, 10);
        assert_eq!(page.total, 1);
        assert_eq!(page.items[0].name, "Example");
        fs::remove_dir_all(root).unwrap();
    }
}

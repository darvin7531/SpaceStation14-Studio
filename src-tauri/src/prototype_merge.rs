//! Read-only, conservative partial overlay preview. This is deliberately
//! separate from RobustToolbox's resolved inherited/DataField semantics.
//! Tag-aware event parsing prevents YamlLoader from silently dropping !Clear,
//! !Remove, !Index and !CombineIndex on source operations.
use std::collections::HashMap;

use serde::Serialize;
use yaml_rust2::parser::{MarkedEventReceiver, Parser, Tag};
use yaml_rust2::scanner::Marker;
use yaml_rust2::Event;

use crate::error::StudioError;
use crate::prototypes::{PrototypeCatalog, PrototypeDeclaration};

const MAX_PREVIEW_FIELDS: usize = 96;
const MAX_PREVIEW_COMPONENTS: usize = 128;
const MAX_PREVIEW_BYTES: usize = 16 * 1024 * 1024;
const MAX_PREVIEW_NODES: usize = 60_000;
const MAX_PREVIEW_DEPTH: usize = 96;

#[derive(Debug, Clone, PartialEq, Eq)]
enum Value {
    Scalar(String),
    Seq(Vec<Node>),
    Map(Vec<(String, Node)>),
    Alias,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Node {
    tag: Option<String>,
    value: Value,
}

impl Node {
    fn scalar(&self) -> Option<&str> {
        match &self.value {
            Value::Scalar(s) => Some(s),
            _ => None,
        }
    }

    fn field(&self, name: &str) -> Option<&Node> {
        match &self.value {
            Value::Map(entries) => entries
                .iter()
                .find(|(key, _)| key == name)
                .map(|(_, value)| value),
            _ => None,
        }
    }

    fn brief(&self) -> String {
        match &self.value {
            Value::Scalar(value) => value.chars().take(120).collect(),
            Value::Seq(items) => format!("список ({} элементов)", items.len()),
            Value::Map(items) => format!("словарь ({} ключей)", items.len()),
            Value::Alias => "YAML alias".into(),
        }
    }
}

enum Frame {
    Seq {
        tag: Option<String>,
        items: Vec<Node>,
    },
    Map {
        tag: Option<String>,
        pairs: Vec<(String, Node)>,
        key: Option<String>,
    },
}

#[derive(Default)]
struct TreeBuilder {
    docs: Vec<Node>,
    stack: Vec<Frame>,
    error: Option<String>,
    nodes: usize,
}

impl TreeBuilder {
    fn tag(tag: Option<Tag>) -> Option<String> {
        tag.map(|value| {
            format!("{}{}", value.handle, value.suffix)
                .trim_start_matches('!')
                .to_owned()
        })
    }

    fn push(&mut self, node: Node) {
        self.nodes += 1;
        if self.nodes > MAX_PREVIEW_NODES {
            self.error
                .get_or_insert_with(|| "Превышен лимит 60 000 YAML-узлов.".into());
            return;
        }
        match self.stack.last_mut() {
            Some(Frame::Seq { items, .. }) => items.push(node),
            Some(Frame::Map { tag, pairs, key }) => {
                if let Some(name) = key.take() {
                    if pairs.iter().any(|(existing, _)| existing == &name) {
                        self.error
                            .get_or_insert_with(|| format!("Повтор ключа YAML: {name}"));
                    }
                    pairs.push((name, node));
                } else if let Some(name) = node.scalar() {
                    // The legal RobustToolbox spelling "- !Remove type: Foo"
                    // emits the tag on the mapping's first *key* in yaml-rust2,
                    // not on MappingStart. Treat only this exact spelling as
                    // the component map's !Remove operation. All other tagged
                    // keys fail closed rather than being interpreted as data.
                    if let Some(op) = &node.tag {
                        if pairs.is_empty()
                            && tag.is_none()
                            && ((op == "Remove" && name == "type")
                                || op.starts_with("CombineIndex:")
                                || op.starts_with("Index:"))
                        {
                            *tag = Some(op.clone());
                        } else {
                            self.error.get_or_insert_with(|| {
                                format!("Тег !{op} на YAML-ключе не поддерживается.")
                            });
                        }
                    }
                    *key = Some(name.to_owned());
                } else {
                    self.error
                        .get_or_insert_with(|| "Динамический ключ YAML.".into());
                }
            }
            None => self.docs.push(node),
        }
    }
}

impl MarkedEventReceiver for TreeBuilder {
    fn on_event(&mut self, event: Event, _: Marker) {
        // Prevent recursive merge/clean from hitting unbounded user-controlled
        // nesting. Finish parsing the stream, then reject the whole snapshot.
        if matches!(
            &event,
            Event::SequenceStart(_, _) | Event::MappingStart(_, _)
        ) && self.stack.len() >= MAX_PREVIEW_DEPTH
        {
            self.error
                .get_or_insert_with(|| "YAML глубже 96 уровней не вычисляется.".into());
        }
        match event {
            Event::DocumentStart => {}
            Event::DocumentEnd => {
                if !self.stack.is_empty() {
                    self.error
                        .get_or_insert_with(|| "Незакрытый YAML-документ.".into());
                }
            }
            Event::SequenceStart(_, tag) => self.stack.push(Frame::Seq {
                tag: Self::tag(tag),
                items: Vec::new(),
            }),
            Event::MappingStart(_, tag) => self.stack.push(Frame::Map {
                tag: Self::tag(tag),
                pairs: Vec::new(),
                key: None,
            }),
            Event::SequenceEnd => match self.stack.pop() {
                Some(Frame::Seq { tag, items }) => self.push(Node {
                    tag,
                    value: Value::Seq(items),
                }),
                _ => {
                    self.error
                        .get_or_insert_with(|| "Некорректное закрытие YAML-списка.".into());
                }
            },
            Event::MappingEnd => match self.stack.pop() {
                Some(Frame::Map {
                    tag,
                    pairs,
                    key: None,
                }) => self.push(Node {
                    tag,
                    value: Value::Map(pairs),
                }),
                _ => {
                    self.error
                        .get_or_insert_with(|| "Некорректное закрытие YAML-словаря.".into());
                }
            },
            Event::Scalar(text, _, _, tag) => self.push(Node {
                tag: Self::tag(tag),
                value: Value::Scalar(text),
            }),
            Event::Alias(_) => self.push(Node {
                tag: None,
                value: Value::Alias,
            }),
            Event::StreamStart | Event::StreamEnd | Event::Nothing => {}
        }
    }
}

fn parse(source: &str) -> Result<Vec<Node>, String> {
    let mut collector = TreeBuilder::default();
    Parser::new_from_str(source)
        .load(&mut collector, true)
        .map_err(|err| err.to_string())?;
    if let Some(err) = collector.error {
        return Err(err);
    }
    Ok(collector.docs)
}

fn row<'a>(docs: &'a [Node], declaration: &PrototypeDeclaration) -> Option<&'a Node> {
    if declaration.variant_index.is_some() {
        return None;
    }
    let root = docs.get(declaration.document_index.checked_sub(1)?)?;
    let Value::Seq(items) = &root.value else {
        return None;
    };
    let item = items.get(declaration.item_index.checked_sub(1)?)?;
    (item.field("type")?.scalar() == Some(declaration.kind.as_str())
        && item.field("id")?.scalar() == Some(declaration.id.as_str()))
    .then_some(item)
}

#[derive(Debug, Serialize)]
pub struct MergeField {
    pub key: String,
    pub preview: String,
    pub source_file: String,
}

#[derive(Debug, Serialize)]
pub struct MergeComponent {
    pub type_name: String,
    pub keys: Vec<String>,
    pub source_file: String,
}

#[derive(Debug, Serialize)]
pub struct PrototypePartialPreview {
    pub kind: String,
    pub id: String,
    pub exact: bool,
    pub parents: Vec<String>,
    pub fields: Vec<MergeField>,
    pub components: Vec<MergeComponent>,
    pub applied_partials: usize,
    pub warnings: Vec<String>,
    #[serde(skip)]
    composed: Option<Node>,
    #[serde(skip)]
    sources: HashMap<String, String>,
}

fn index_from(tag: &str, prefix: &str, len: usize, insertion: bool) -> Result<usize, String> {
    let value: i64 = tag
        .strip_prefix(prefix)
        .ok_or_else(|| format!("Неизвестный тег: !{tag}"))?
        .parse()
        .map_err(|_| format!("Некорректный индекс в !{tag}"))?;
    let index = if value < 0 { len as i64 + value } else { value };
    let max = if insertion {
        len
    } else {
        len.saturating_sub(1)
    } as i64;
    if index < 0 || index > max || (!insertion && len == 0) {
        return Err(format!("Индекс !{tag} находится вне списка длины {len}."));
    }
    Ok(index as usize)
}

fn clean(mut node: Node) -> Result<Node, String> {
    let tag = node.tag.take();
    if let Some(tag) = tag {
        if tag != "Clear" {
            return Err(format!("Неподдерживаемый тег !{tag} в значении."));
        }
    }
    match &mut node.value {
        Value::Alias => Err("YAML alias не поддерживается в вычисляемом merge.".into()),
        Value::Map(fields) => {
            for (_, value) in fields {
                *value = clean(value.clone())?;
            }
            Ok(node)
        }
        Value::Seq(items) => {
            for value in items {
                *value = clean(value.clone())?;
            }
            Ok(node)
        }
        Value::Scalar(_) => Ok(node),
    }
}

fn merge(dst: &mut Node, src: &Node, components: bool) -> Result<(), String> {
    if src.tag.as_deref() == Some("Clear") {
        *dst = clean(src.clone())?;
        return Ok(());
    }
    if let Some(tag) = &src.tag {
        return Err(format!(
            "Неподдерживаемый тег !{tag} при объединении значений."
        ));
    }
    if components {
        return merge_components(dst, src);
    }
    // Scalar/sequence combination must keep the prior scalar as the first
    // element; handle before mutably borrowing the destination shape.
    if let (Value::Scalar(_), Value::Seq(additions)) = (&dst.value, &src.value) {
        let original = dst.clone();
        let mut combined = vec![original];
        merge_sequence(&mut combined, additions)?;
        *dst = Node {
            tag: None,
            value: Value::Seq(combined),
        };
        return Ok(());
    }
    match (&mut dst.value, &src.value) {
        (Value::Map(old), Value::Map(new)) => {
            for (key, value) in new {
                if value.tag.as_deref() == Some("Remove") {
                    if let Some(position) = old.iter().position(|(existing, _)| existing == key) {
                        let condition = matches!(&value.value, Value::Scalar(text) if text.is_empty())
                            || old[position].1.value == value.value;
                        if condition {
                            old.remove(position);
                        }
                    }
                    continue;
                }
                if let Some((_, existing)) = old.iter_mut().find(|(candidate, _)| candidate == key)
                {
                    merge(existing, value, key == "components")?;
                } else {
                    let mut inserted = if matches!(&value.value, Value::Seq(_)) {
                        Node {
                            tag: None,
                            value: Value::Seq(Vec::new()),
                        }
                    } else {
                        // A new field starts from its own value. In particular
                        // do not prefix a new list with an empty scalar.
                        old.push((key.clone(), clean(value.clone())?));
                        continue;
                    };
                    merge(&mut inserted, value, key == "components")?;
                    old.push((key.clone(), inserted));
                }
            }
        }
        (Value::Seq(old), Value::Seq(new)) => merge_sequence(old, new)?,
        (Value::Seq(old), Value::Scalar(_)) => old.push(clean(src.clone())?),
        (_, _) => *dst = clean(src.clone())?,
    }
    Ok(())
}

fn merge_sequence(old: &mut Vec<Node>, additions: &[Node]) -> Result<(), String> {
    for item in additions {
        match item.tag.as_deref() {
            Some("Remove") => {
                let mut target = item.clone();
                target.tag = None;
                old.retain(|entry| entry != &target);
            }
            Some(tag) if tag.starts_with("Index:") => {
                let where_at = index_from(tag, "Index:", old.len(), true)?;
                let mut item = item.clone();
                item.tag = None;
                old.insert(where_at, clean(item)?);
            }
            Some(tag) if tag.starts_with("CombineIndex:") => {
                let where_at = index_from(tag, "CombineIndex:", old.len(), false)?;
                let mut item = item.clone();
                item.tag = None;
                merge(&mut old[where_at], &item, false)?;
            }
            None => old.push(clean(item.clone())?),
            Some(tag) => return Err(format!("Неподдерживаемый тег элемента списка !{tag}.")),
        }
    }
    Ok(())
}

fn merge_components(dst: &mut Node, src: &Node) -> Result<(), String> {
    if src.tag.as_deref() == Some("Clear") {
        *dst = clean(src.clone())?;
        return Ok(());
    }
    let Value::Seq(new) = &src.value else {
        return Err("Entity.components должен быть списком.".into());
    };
    let Value::Seq(old) = &mut dst.value else {
        if matches!(&dst.value, Value::Scalar(text) if text.is_empty()) {
            *dst = Node {
                tag: None,
                value: Value::Seq(Vec::new()),
            };
            return merge_components(dst, src);
        }
        return Err("Ранее объявленные components не являются списком.".into());
    };
    for component in new {
        let type_name = component
            .field("type")
            .and_then(Node::scalar)
            .ok_or_else(|| "У компонента нет статического type.".to_owned())?;
        if component.tag.as_deref() == Some("Remove") {
            old.retain(|entry| entry.field("type").and_then(Node::scalar) != Some(type_name));
            continue;
        }
        if component.tag.is_some() {
            return Err("Тег на компоненте не поддерживается, кроме !Remove.".into());
        }
        if let Some(current) = old
            .iter_mut()
            .find(|entry| entry.field("type").and_then(Node::scalar) == Some(type_name))
        {
            merge(current, component, false)?;
        } else {
            old.push(clean(component.clone())?);
        }
    }
    Ok(())
}

fn parent_list(node: Option<&Node>) -> Result<Vec<String>, String> {
    match node {
        None => Ok(Vec::new()),
        Some(Node {
            value: Value::Scalar(text),
            ..
        }) => {
            if text.is_empty() {
                Ok(Vec::new())
            } else {
                Ok(vec![text.clone()])
            }
        }
        Some(Node {
            value: Value::Seq(items),
            ..
        }) => items
            .iter()
            .map(|item| {
                item.scalar()
                    .map(str::to_owned)
                    .ok_or_else(|| "parent содержит динамический элемент.".to_owned())
            })
            .collect(),
        _ => Err("parent имеет нестатическое значение.".into()),
    }
}

fn preview_fields(
    node: &Node,
    sources: &HashMap<String, String>,
) -> (Vec<MergeField>, Vec<MergeComponent>) {
    let Value::Map(fields) = &node.value else {
        return (Vec::new(), Vec::new());
    };
    let mut result = Vec::new();
    let mut components = Vec::new();
    for (key, value) in fields {
        if matches!(key.as_str(), "type" | "id" | "parent" | "components") {
            continue;
        }
        if result.len() >= MAX_PREVIEW_FIELDS {
            break;
        }
        result.push(MergeField {
            key: key.clone(),
            preview: value.brief(),
            source_file: sources.get(key).cloned().unwrap_or_default(),
        });
    }
    if let Some(Node {
        value: Value::Seq(items),
        ..
    }) = node.field("components")
    {
        for item in items.iter().take(MAX_PREVIEW_COMPONENTS) {
            let Some(name) = item.field("type").and_then(Node::scalar) else {
                continue;
            };
            let keys = if let Value::Map(fields) = &item.value {
                fields
                    .iter()
                    .filter(|(key, _)| key != "type")
                    .map(|(key, _)| key.clone())
                    .collect()
            } else {
                Vec::new()
            };
            components.push(MergeComponent {
                type_name: name.to_owned(),
                keys,
                source_file: sources
                    .get(&format!("components/{name}"))
                    .cloned()
                    .unwrap_or_default(),
            });
        }
    }
    (result, components)
}

/// Applies only the base prototype and its ordered partial modifications.
/// Parent inheritance is explicitly NOT resolved here; the source graph is
/// exposed by the existing R05 relationships query.
pub fn preview(
    catalog: &PrototypeCatalog,
    kind: &str,
    id: &str,
    mut read: impl FnMut(&str) -> Result<String, StudioError>,
) -> Result<PrototypePartialPreview, StudioError> {
    let declarations = catalog.source_declarations(kind, id);
    if declarations.is_empty() {
        return Err(StudioError::new(
            "PROTOTYPE_NOT_INDEXED",
            "Прототип не найден в каталоге.",
            "Проверьте тип и ID.",
        ));
    }
    let mut warnings = Vec::new();
    let normal: Vec<_> = declarations
        .iter()
        .filter(|entry| entry.mode == "normal")
        .collect();
    let mut exact = normal.len() == 1;
    if !exact {
        warnings.push("Для предпросмотра требуется ровно одно базовое (normal) объявление.".into());
    }
    let mut partials: Vec<_> = declarations
        .iter()
        .filter(|entry| entry.mode != "normal")
        .collect();
    partials.sort_unstable_by_key(|entry| {
        (
            entry.partial_order.unwrap_or(usize::MAX),
            &entry.file,
            entry.line,
        )
    });
    if partials.iter().any(|entry| entry.partial_order.is_none()) {
        exact = false;
        warnings.push(
            "Есть partial без определённого порядка; порядок применения нельзя подтвердить.".into(),
        );
    }
    if partials
        .windows(2)
        .any(|pair| pair[0].partial_order == pair[1].partial_order)
    {
        exact = false;
        warnings.push(
            "Несколько partial с одним порядковым индексом: их взаимный порядок не подтверждён."
                .into(),
        );
    }
    let mut inputs = Vec::new();
    if let Some(base) = normal.first() {
        inputs.push(*base);
    }
    inputs.extend(partials);
    let mut files = HashMap::<String, Result<Vec<Node>, String>>::new();
    let mut bytes = 0usize;
    let mut composed: Option<Node> = None;
    let mut sources = HashMap::new();
    let mut applied_partials = 0usize;
    for entry in inputs {
        if !files.contains_key(&entry.file) {
            let parsed = read(&entry.file)
                .map_err(|error| {
                    format!(
                        "Невозможно прочитать исходник: {} [{}]",
                        error.message, error.code
                    )
                })
                .and_then(|source| {
                    if source.len() > MAX_PREVIEW_BYTES.saturating_sub(bytes) {
                        return Err("Превышен лимит исходников 16 МиБ.".into());
                    }
                    bytes += source.len();
                    parse(&source)
                });
            files.insert(entry.file.clone(), parsed);
        }
        let Some(Ok(docs)) = files.get(&entry.file) else {
            exact = false;
            let why = files
                .get(&entry.file)
                .and_then(|result| result.as_ref().err())
                .map_or("Неизвестная ошибка", String::as_str);
            warnings.push(format!("{}: {why}", entry.file));
            continue;
        };
        let Some(source) = row(docs, entry) else {
            exact = false;
            warnings.push(format!(
                "{}:{}: нельзя связать объявление с исходным YAML.",
                entry.file, entry.line
            ));
            continue;
        };
        if composed.is_none() {
            if entry.mode != "normal" {
                exact = false;
                warnings.push(
                    "Нет базового прототипа; partial не применяется к пустому объекту.".into(),
                );
                continue;
            }
            let clean_base = match clean(source.clone()) {
                Ok(value) => value,
                Err(reason) => {
                    exact = false;
                    warnings.push(format!("{}:{}: {reason}", entry.file, entry.line));
                    continue;
                }
            };
            composed = Some(clean_base);
            if let Value::Map(fields) = &source.value {
                for (key, value) in fields {
                    sources.insert(key.clone(), entry.file.clone());
                    if key == "components" {
                        if let Value::Seq(list) = &value.value {
                            for component in list {
                                if let Some(name) = component.field("type").and_then(Node::scalar) {
                                    sources
                                        .insert(format!("components/{name}"), entry.file.clone());
                                }
                            }
                        }
                    }
                }
            }
            continue;
        }
        let Some(composed_ref) = composed.as_mut() else {
            continue;
        };
        // A failed operation must not leak a partly applied partial into the result.
        let mut candidate = composed_ref.clone();
        // The tagged type/id nodes identify a partial declaration; they must
        // not be interpreted as modifications to the prototype's data.
        let mut overlay = source.clone();
        if let Value::Map(pairs) = &mut overlay.value {
            pairs.retain(|(key, _)| key != "type" && key != "id");
        }
        match merge(&mut candidate, &overlay, false) {
            Ok(()) => {
                // Provenance changes only when the resulting value changes.
                // A conditional !Remove that does not match must not claim
                // it modified an inherited field.
                if let Value::Map(fields) = &source.value {
                    for (key, _) in fields {
                        if matches!(key.as_str(), "type" | "id") {
                            continue;
                        }
                        let before = composed_ref.field(key);
                        let after = candidate.field(key);
                        if before != after {
                            if after.is_some() {
                                sources.insert(key.clone(), entry.file.clone());
                            } else {
                                sources.remove(key);
                            }
                        }
                    }
                }
                let component_entries = |node: &Node| -> HashMap<String, Node> {
                    match node.field("components").map(|field| &field.value) {
                        Some(Value::Seq(list)) => list
                            .iter()
                            .filter_map(|item| {
                                item.field("type")
                                    .and_then(Node::scalar)
                                    .map(|name| (name.to_owned(), item.clone()))
                            })
                            .collect(),
                        _ => HashMap::new(),
                    }
                };
                let prior = component_entries(composed_ref);
                let current = component_entries(&candidate);
                for (name, value) in &current {
                    if prior.get(name) != Some(value) {
                        sources.insert(format!("components/{name}"), entry.file.clone());
                    }
                }
                for name in prior.keys() {
                    if !current.contains_key(name) {
                        sources.remove(&format!("components/{name}"));
                    }
                }
                // Partial type/id are identity markers, not mutable prototype fields.
                if let Value::Map(fields) = &mut candidate.value {
                    for key in ["type", "id"] {
                        if let Some((_, val)) = fields.iter_mut().find(|(name, _)| name == key) {
                            if let Some(original) = composed_ref.field(key) {
                                *val = original.clone();
                            }
                        }
                    }
                }
                *composed_ref = candidate;
                applied_partials += 1;
            }
            Err(reason) => {
                exact = false;
                warnings.push(format!("{}:{}: {reason}", entry.file, entry.line));
            }
        }
    }
    let parents = match composed
        .as_ref()
        .map(|node| parent_list(node.field("parent")))
    {
        Some(Ok(parents)) => parents,
        Some(Err(err)) => {
            exact = false;
            warnings.push(err);
            Vec::new()
        }
        None => Vec::new(),
    };
    if composed.is_none() {
        exact = false;
    }
    let (fields, components) = composed
        .as_ref()
        .map(|node| preview_fields(node, &sources))
        .unwrap_or_default();
    if fields.len() >= MAX_PREVIEW_FIELDS || components.len() >= MAX_PREVIEW_COMPONENTS {
        exact = false;
        warnings.push("Предпросмотр ограничен 96 полями и 128 компонентами.".into());
    }
    Ok(PrototypePartialPreview {
        kind: kind.to_owned(),
        id: id.to_owned(),
        exact,
        parents,
        fields,
        components,
        applied_partials,
        warnings,
        composed,
        sources,
    })
}

const MAX_INHERIT_IDENTITIES: usize = 64;
const MAX_INHERIT_DEPTH: usize = 32;
const MAX_INHERIT_BYTES: usize = 24 * 1024 * 1024;
const MAX_INHERIT_WARNINGS: usize = 48;

/// Structural source projection only. Unlike engine deserialization, this does
/// not know C# DataField custom serializers, AlwaysPushInheritance or defaults.
#[derive(Debug, Serialize)]
pub struct PrototypeInheritancePreview {
    pub kind: String,
    pub id: String,
    /// All referenced static sources were available and had a unique base.
    /// Does NOT mean that the values equal RobustToolbox's runtime objects.
    pub structural_complete: bool,
    /// Deliberately false until this is checked against engine definitions.
    pub runtime_exact: bool,
    pub direct_parents: Vec<String>,
    /// Ordered, distinct source prototypes involved in this projection.
    pub lineage: Vec<String>,
    pub fields: Vec<MergeField>,
    pub components: Vec<MergeComponent>,
    pub total_partials: usize,
    pub warnings: Vec<String>,
}

#[derive(Clone)]
struct InheritedSnapshot {
    node: Node,
    sources: HashMap<String, String>,
    parents: Vec<String>,
    lineage: Vec<String>,
    complete: bool,
    /// Own applied partial counts, deduplicated by ancestor ID across diamonds.
    partials_by_identity: HashMap<String, usize>,
}

struct InheritanceSolver<'a, F> {
    catalog: &'a PrototypeCatalog,
    kind: &'a str,
    reader: F,
    file_cache: HashMap<String, String>,
    bytes: usize,
    stack: Vec<String>,
    calculated: HashMap<String, InheritedSnapshot>,
    warnings: Vec<String>,
}

impl<F: FnMut(&str) -> Result<String, StudioError>> InheritanceSolver<'_, F> {
    fn warn(&mut self, message: String) {
        if self.warnings.len() < MAX_INHERIT_WARNINGS {
            self.warnings.push(message);
        }
    }

    fn read_file(&mut self, file: &str) -> Result<String, StudioError> {
        if let Some(cached) = self.file_cache.get(file) {
            return Ok(cached.clone());
        }
        let source = (self.reader)(file)?;
        if source.len() > MAX_INHERIT_BYTES.saturating_sub(self.bytes) {
            return Err(StudioError::new(
                "PROTOTYPE_INHERITANCE_LIMIT",
                "Превышен общий лимит исходных YAML для наследования (24 МиБ).",
                "Просмотрите связи прототипа по отдельности.",
            ));
        }
        self.bytes += source.len();
        self.file_cache.insert(file.to_owned(), source.clone());
        Ok(source)
    }

    fn resolve(&mut self, id: &str) -> Result<InheritedSnapshot, String> {
        if let Some(snapshot) = self.calculated.get(id) {
            return Ok(snapshot.clone());
        }
        if self.stack.iter().any(|ancestor| ancestor == id) {
            return Err(format!("Цикл parent: {} → {id}", self.stack.join(" → ")));
        }
        if self.stack.len() >= MAX_INHERIT_DEPTH {
            return Err(format!(
                "Глубина parent для {id} превысила {MAX_INHERIT_DEPTH}."
            ));
        }
        if self.calculated.len() + self.stack.len() >= MAX_INHERIT_IDENTITIES {
            return Err(format!(
                "Достигнут лимит {MAX_INHERIT_IDENTITIES} прототипов."
            ));
        }
        self.stack.push(id.to_owned());
        // A separate closure ensures we always pop the current identity after
        // a parse, source read or parent resolution failure.
        let attempt = (|| {
            let catalog = self.catalog;
            let kind = self.kind;
            let partial = preview(catalog, kind, id, |path| self.read_file(path))
                .map_err(|error| format!("{id}: {} [{}]", error.message, error.code))?;
            let own = partial
                .composed
                .as_ref()
                .ok_or_else(|| format!("{id}: базовое объявление отсутствует или недоступно"))?;
            let mut complete = partial.exact;
            for warning in &partial.warnings {
                self.warn(format!("{id}: {warning}"));
            }
            let parents = partial.parents.clone();
            if parents.len() > 1 {
                complete = false;
                self.warn(format!(
                    "{id}: {} родителя; порядок и DataField-семантика конфликтующих полей движка не подтверждены.",
                    parents.len()
                ));
            }
            let mut seen_parents = std::collections::HashSet::new();
            let mut projected = Node {
                tag: None,
                value: Value::Map(Vec::new()),
            };
            let mut sources = HashMap::new();
            let mut lineage = Vec::new();
            let mut partials_by_identity = HashMap::new();
            partials_by_identity.insert(id.to_owned(), partial.applied_partials);
            for parent_id in &parents {
                if parent_id.trim().is_empty() || !seen_parents.insert(parent_id.clone()) {
                    complete = false;
                    self.warn(format!(
                        "{id}: пустой или повторяющийся parent «{parent_id}»."
                    ));
                    continue;
                }
                match self.resolve(parent_id) {
                    Ok(parent) => {
                        if !parent.complete {
                            complete = false;
                        }
                        partials_by_identity.extend(parent.partials_by_identity);
                        for ancestor in parent.lineage {
                            if !lineage.contains(&ancestor) {
                                lineage.push(ancestor);
                            }
                        }
                        // Preserve the previous projection when a parent
                        // contains an unsupported nested YAML operation.
                        let mut candidate = projected.clone();
                        let mut candidate_sources = sources.clone();
                        match overlay_inherited(
                            &mut candidate,
                            &parent.node,
                            &mut candidate_sources,
                            &parent.sources,
                        ) {
                            Ok(()) => {
                                projected = candidate;
                                sources = candidate_sources;
                            }
                            Err(error) => {
                                complete = false;
                                self.warn(format!("{id} ← {parent_id}: {error}"));
                            }
                        }
                    }
                    Err(error) => {
                        complete = false;
                        self.warn(format!("{id}: {error}"));
                    }
                }
            }
            // Apply a child's already-partial-merged source *after* the parents.
            // No metadata such as parent, id, type or abstract is inherited.
            let mut candidate = projected.clone();
            let mut candidate_sources = sources.clone();
            match overlay_inherited(
                &mut candidate,
                own,
                &mut candidate_sources,
                &partial.sources,
            ) {
                Ok(()) => {
                    projected = candidate;
                    sources = candidate_sources;
                }
                Err(error) => {
                    complete = false;
                    self.warn(format!("{id}: {error}"));
                }
            }
            lineage.push(id.to_owned());
            Ok(InheritedSnapshot {
                node: projected,
                sources,
                parents,
                lineage,
                complete,
                partials_by_identity,
            })
        })();
        self.stack.pop();
        if let Ok(value) = &attempt {
            self.calculated.insert(id.to_owned(), value.clone());
        }
        attempt
    }
}

/// Inheritance is deliberately different from partial append semantics:
/// normal child sequences replace parent sequences. Components retain their
/// type-indexed overlay (AlwaysPushInheritance in engine), while custom
/// DataField serializers are not represented by this structural projection.
fn overlay_inherited(
    dest: &mut Node,
    incoming: &Node,
    provenance: &mut HashMap<String, String>,
    incoming_sources: &HashMap<String, String>,
) -> Result<(), String> {
    let (Value::Map(target), Value::Map(fields)) = (&mut dest.value, &incoming.value) else {
        return Err("Для наследования требуются два YAML-словаря.".into());
    };
    for (key, value) in fields {
        if matches!(key.as_str(), "id" | "type" | "abstract" | "parent") {
            continue;
        }
        let origin = incoming_sources.get(key).cloned().unwrap_or_default();
        let before = target.iter().position(|(name, _)| name == key);
        if key == "components" {
            let Value::Seq(additions) = &value.value else {
                return Err("components не является списком.".into());
            };
            let position = if let Some(index) = before {
                index
            } else {
                target.push((
                    key.clone(),
                    Node {
                        tag: None,
                        value: Value::Seq(Vec::new()),
                    },
                ));
                target.len() - 1
            };
            let Value::Seq(current) = &mut target[position].1.value else {
                return Err("Унаследованные components не являются списком.".into());
            };
            for component in additions {
                let name = component
                    .field("type")
                    .and_then(Node::scalar)
                    .ok_or_else(|| "У компонента отсутствует статический type.".to_owned())?;
                let slot = current
                    .iter()
                    .position(|item| item.field("type").and_then(Node::scalar) == Some(name));
                let key_name = format!("components/{name}");
                let component_source = incoming_sources
                    .get(&key_name)
                    .cloned()
                    .unwrap_or_else(|| origin.clone());
                if let Some(index) = slot {
                    let before_component = current[index].clone();
                    overlay_inherited_mapping(&mut current[index], component)?;
                    if current[index] != before_component {
                        provenance.insert(key_name, component_source);
                    }
                } else {
                    current.push(component.clone());
                    provenance.insert(key_name, component_source);
                }
            }
        } else if let Some(index) = before {
            let old = target[index].1.clone();
            overlay_inherited_mapping(&mut target[index].1, value)?;
            if target[index].1 != old {
                provenance.insert(key.clone(), origin);
            }
        } else {
            target.push((key.clone(), value.clone()));
            provenance.insert(key.clone(), origin);
        }
    }
    Ok(())
}

/// Mapping entries can be inherited field by field; ordinary lists are replaced
/// by the child rather than appended as with partial-prototype modifications.
fn overlay_inherited_mapping(dest: &mut Node, incoming: &Node) -> Result<(), String> {
    if dest.tag.is_some() || incoming.tag.is_some() {
        return Err("Неизвестный YAML-тег в данных наследования.".into());
    }
    if let (Value::Map(target), Value::Map(fields)) = (&mut dest.value, &incoming.value) {
        for (key, value) in fields {
            if let Some((_, existing)) = target.iter_mut().find(|(name, _)| name == key) {
                overlay_inherited_mapping(existing, value)?;
            } else {
                target.push((key.clone(), value.clone()));
            }
        }
    } else {
        *dest = incoming.clone();
    }
    Ok(())
}

/// Resolve a bounded source-derived inheritance projection with partials
/// applied independently to each ancestor first. This is not an engine-runtime
/// resolver: field-specific C# inheritance, custom serializers and variants
/// may give different actual results.
pub fn preview_inheritance(
    catalog: &PrototypeCatalog,
    kind: &str,
    id: &str,
    read: impl FnMut(&str) -> Result<String, StudioError>,
) -> Result<PrototypeInheritancePreview, StudioError> {
    if !catalog.has_identity(kind, id) {
        return Err(StudioError::new(
            "PROTOTYPE_NOT_INDEXED",
            "Прототип не найден в каталоге проекта.",
            "Обновите каталог или проверьте ID и тип.",
        ));
    }
    let mut solver = InheritanceSolver {
        catalog,
        kind,
        reader: read,
        file_cache: HashMap::new(),
        bytes: 0,
        stack: Vec::new(),
        calculated: HashMap::new(),
        warnings: Vec::new(),
    };
    let result = solver.resolve(id).map_err(|reason| {
        StudioError::new(
            "PROTOTYPE_INHERITANCE_UNAVAILABLE",
            "Не удалось вычислить базовую структуру прототипа.",
            "Проверьте исходные объявления, теги и пути проекта.",
        )
        .with_details(reason)
    })?;
    let (fields, components) = preview_fields(&result.node, &result.sources);
    let index_complete = catalog
        .relations(kind, id)
        .is_some_and(|relations| relations.index_complete);
    let mut structural_complete = result.complete && index_complete;
    if !index_complete {
        solver.warn("Каталог прототипов неполон: часть YAML, ID или partial-конфигураций не удалось индексировать.".into());
    }
    if fields.len() >= MAX_PREVIEW_FIELDS || components.len() >= MAX_PREVIEW_COMPONENTS {
        structural_complete = false;
        solver.warn("Вывод ограничен 96 полями и 128 компонентами.".into());
    }
    Ok(PrototypeInheritancePreview {
        kind: kind.to_owned(),
        id: id.to_owned(),
        structural_complete,
        runtime_exact: false,
        direct_parents: result.parents,
        lineage: result.lineage,
        fields,
        components,
        total_partials: result.partials_by_identity.values().sum(),
        warnings: solver.warnings,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node(src: &str) -> Node {
        parse(src).unwrap().remove(0)
    }

    #[test]
    fn inherited_lists_replace_parent_lists_but_nested_maps_keep_unspecified_keys() {
        let mut parent = node("tags: [a, b]\nflags: {enabled: true, hidden: true}\n");
        let child = node("tags: [c]\nflags: {enabled: false}\n");
        let mut provenance = HashMap::new();
        let child_sources = HashMap::from([
            ("tags".to_owned(), "child.yml".to_owned()),
            ("flags".to_owned(), "child.yml".to_owned()),
        ]);
        overlay_inherited(&mut parent, &child, &mut provenance, &child_sources).unwrap();
        let Value::Seq(tags) = &parent.field("tags").unwrap().value else {
            panic!("missing tags")
        };
        assert_eq!(tags.len(), 1);
        assert_eq!(tags[0].scalar(), Some("c"));
        let flags = parent.field("flags").unwrap();
        assert_eq!(flags.field("enabled").unwrap().scalar(), Some("false"));
        assert_eq!(flags.field("hidden").unwrap().scalar(), Some("true"));
        assert_eq!(provenance["flags"], "child.yml");
    }

    #[test]
    fn inherited_components_merge_by_type_without_erasing_unspecified_fields() {
        let mut parent = node("components:\n- type: Sprite\n  state: old\n  shader: unshaded\n");
        let child = node("components:\n- type: Sprite\n  state: new\n- type: Physics\n  mass: 2\n");
        let mut provenance = HashMap::new();
        let sources = HashMap::from([
            ("components".to_owned(), "child.yml".to_owned()),
            ("components/Sprite".to_owned(), "child.yml".to_owned()),
            ("components/Physics".to_owned(), "child.yml".to_owned()),
        ]);
        overlay_inherited(&mut parent, &child, &mut provenance, &sources).unwrap();
        let Value::Seq(components) = &parent.field("components").unwrap().value else {
            panic!("missing components")
        };
        assert_eq!(components.len(), 2);
        assert_eq!(components[0].field("state").unwrap().scalar(), Some("new"));
        assert_eq!(
            components[0].field("shader").unwrap().scalar(),
            Some("unshaded")
        );
        assert_eq!(provenance["components/Sprite"], "child.yml");
        assert_eq!(provenance["components/Physics"], "child.yml");
    }

    #[test]
    fn retains_all_critical_yaml_tags() {
        let source = node(
            "- parent: !Clear [New]\n  components:\n  - !Remove type: Sprite\n  - type: Physics\n",
        );
        let Value::Seq(items) = source.value else {
            panic!("seq")
        };
        assert_eq!(
            items[0].field("parent").unwrap().tag.as_deref(),
            Some("Clear")
        );
        let Value::Seq(components) = &items[0].field("components").unwrap().value else {
            panic!("components")
        };
        assert_eq!(components[0].tag.as_deref(), Some("Remove"));
    }

    #[test]
    fn merges_mapping_sequences_and_clear_values() {
        let mut base = node("parent: [A]\nsettings: {one: yes, two: old}\nitems: [a,b]\n");
        let partial =
            node("parent: !Clear [B]\nsettings: {two: new, one: !Remove}\nitems: [c, !Remove b]\n");
        merge(&mut base, &partial, false).unwrap();
        assert_eq!(parent_list(base.field("parent")).unwrap(), ["B"]);
        let map = base.field("settings").unwrap();
        assert!(map.field("one").is_none());
        assert_eq!(map.field("two").unwrap().scalar(), Some("new"));
        let Value::Seq(items) = &base.field("items").unwrap().value else {
            panic!("items")
        };
        assert_eq!(
            items
                .iter()
                .map(|v| v.scalar().unwrap())
                .collect::<Vec<_>>(),
            ["a", "c"]
        );
    }

    #[test]
    fn parent_scalar_vs_sequence_obeys_distinct_rules() {
        let mut scalar = node("parent: A");
        merge(&mut scalar, &node("parent: B"), false).unwrap();
        assert_eq!(parent_list(scalar.field("parent")).unwrap(), ["B"]);
        merge(&mut scalar, &node("parent: [C]"), false).unwrap();
        assert_eq!(parent_list(scalar.field("parent")).unwrap(), ["B", "C"]);
        merge(&mut scalar, &node("parent: !Clear D"), false).unwrap();
        assert_eq!(parent_list(scalar.field("parent")).unwrap(), ["D"]);
    }

    #[test]
    fn merges_named_components_removals_and_nested_fields() {
        let mut base = node("components:\n- type: Sprite\n  state: base\n  visible: true\n- type: Physics\n  mass: 1\n");
        let patch = node("components:\n- !Remove type: Sprite\n- type: Physics\n  mass: 2\n  other: yes\n- type: Transform\n");
        merge(&mut base, &patch, false).unwrap();
        let Value::Seq(items) = &base.field("components").unwrap().value else {
            panic!("components")
        };
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].field("type").unwrap().scalar(), Some("Physics"));
        assert_eq!(items[0].field("mass").unwrap().scalar(), Some("2"));
        assert_eq!(items[1].field("type").unwrap().scalar(), Some("Transform"));
    }

    #[test]
    fn combine_index_tag_on_first_mapping_key_is_preserved() {
        let mut initial = node("effects:\n- data: { int: 1, tag: old }\n");
        let patch = node("effects:\n- !CombineIndex:0 data: { int: 2 }\n");
        merge(&mut initial, &patch, false).unwrap();
        let Value::Seq(effects) = &initial.field("effects").unwrap().value else {
            panic!("effects sequence was lost");
        };
        assert_eq!(effects.len(), 1);
        let data = effects[0].field("data").unwrap();
        assert_eq!(data.field("int").unwrap().scalar(), Some("2"));
        assert_eq!(data.field("tag").unwrap().scalar(), Some("old"));
    }

    #[test]
    fn reject_unknown_tag_on_mapping_key_instead_of_guessing() {
        assert!(parse("- !Fancy type: Sprite\n").is_err());
    }

    #[test]
    fn indexed_sequence_operations_have_explicit_bounds() {
        let mut base = node("items: [a, b, c]");
        merge(
            &mut base,
            &node("items: [!Index:0 start, !Index:-1 nearend]"),
            false,
        )
        .unwrap();
        let Value::Seq(items) = &base.field("items").unwrap().value else {
            panic!("items")
        };
        assert_eq!(
            items
                .iter()
                .map(|v| v.scalar().unwrap())
                .collect::<Vec<_>>(),
            ["start", "a", "b", "nearend", "c"]
        );
        assert!(merge(&mut base, &node("items: [!Index:999 invalid]"), false).is_err());
    }

    #[test]
    fn new_sequence_field_has_no_phantom_empty_item() {
        let mut root = node("id: Base");
        merge(&mut root, &node("items: [one, two]"), false).unwrap();
        let Value::Seq(list) = &root.field("items").unwrap().value else {
            panic!("not a list")
        };
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].scalar(), Some("one"));
    }

    #[test]
    fn unsafe_aliases_or_unknown_tags_fail_closed() {
        assert!(merge(&mut node("name: ok"), &node("name: !Fancy changed"), false).is_err());
        assert!(merge(&mut node("items: []"), &node("items: [&a foo, *a]"), false).is_err());
    }
}

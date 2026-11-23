//! Read-only SS14 prototype declaration catalog.
//!
//! This is a *source catalog*, NOT RobustToolbox's resolved prototype graph.
//! Every declaration is preserved, including configured partials and tagged
//! partials, with separate provenance and no guessed merge semantics.
use std::collections::{BTreeSet, HashMap, HashSet};
use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use serde::Serialize;
use yaml_rust2::parser::{Event, MarkedEventReceiver, Parser, Tag};
use yaml_rust2::scanner::Marker;
use yaml_rust2::{Yaml, YamlLoader};

use crate::error::StudioError;
use crate::project::ResourceEntry;
use crate::prototype_graph::{PrototypeGraph, PrototypeRelations};

const MAX_YAML_BYTES: u64 = 4 * 1024 * 1024;
const MAX_PARTIAL_CONFIG_FILES: usize = 128;
const MAX_PARTIAL_CONFIG_ENTRIES: usize = 4096;
const MAX_PARTIAL_CONFIG_BYTES: usize = 16 * 1024 * 1024;
const MAX_PAGE: usize = 200;
const MAX_SPRITE_DIAGNOSTICS: usize = 500;

#[derive(Debug, Clone, Serialize)]
pub struct PrototypeDeclaration {
    pub kind: String,
    pub id: String,
    /// Lowercased declared scalar name, shared by generated variants.
    #[serde(skip)]
    pub(crate) search_name: Option<Arc<str>>,
    pub parents: Vec<String>,
    pub abstract_prototype: bool,
    pub file: String,
    pub line: usize,
    pub document_index: usize,
    pub item_index: usize,
    /// Index of a generated prototype variant; None for a literal YAML declaration.
    pub variant_index: Option<usize>,
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

const MAX_LIVE_OUTLINE: usize = 256;
const MAX_OUTLINE_ISSUES: usize = 64;

/// A view of a single *draft*, never a resolved RobustToolbox prototype.
/// Positions are the collector's YAML document/item markers, not text guesses.
#[derive(Debug, Serialize)]
pub struct SourceOutline {
    pub declarations: Vec<SourceOutlineEntry>,
    pub diagnostics: Vec<PrototypeDiagnostic>,
    pub truncated: bool,
}

#[derive(Debug, Serialize)]
pub struct SourceOutlineEntry {
    pub declaration: PrototypeDeclaration,
    pub sprite: Option<SourceSpriteLink>,
    /// Only layers explicitly declared on this source prototype.
    pub sprite_layers: Vec<SourceSpriteLayer>,
    pub sprite_layers_total: usize,
}

#[derive(Debug, Serialize)]
pub struct SourceSpriteLink {
    pub path: String,
    pub state: Option<String>,
    pub indexed: bool,
}

#[derive(Debug, Serialize)]
pub struct SourceSpriteLayer {
    pub index: usize,
    pub path: Option<String>,
    pub state: Option<String>,
    pub indexed: bool,
    pub visible: Option<bool>,
    pub shader: Option<String>,
    /// True when Sprite.sprite supplies the path omitted by this layer.
    pub default_path: bool,
}

const MAX_LIVE_SPRITE_LAYERS: usize = 32;

/// Reuse the exact catalogue parser on unsaved text. Partial/tagged and
/// CreateVariants declarations remain visible, but are never implicitly
/// promoted into editable ordinary prototype declarations.
pub fn inspect_source_outline(
    root: &Path,
    file: &str,
    source: &str,
    is_rsi_indexed: impl Fn(&str) -> bool,
) -> Result<SourceOutline, StudioError> {
    if source.len() as u64 > MAX_YAML_BYTES {
        return Err(StudioError::new(
            "OUTLINE_TOO_LARGE",
            "YAML превышает лимит предпросмотра 4 МиБ.",
            "Уменьшите файл или откройте другой YAML-прототип.",
        ));
    }
    let mut issues = Vec::new();
    let scopes = configured_partials(root, &mut issues);
    let order = partial_order_for(file, &scopes);
    let mut collector = DeclarationCollector::new(file, order);
    if let Err(error) = Parser::new_from_str(source).load(&mut collector, true) {
        // A failed parse must not present half-read declarations as valid.
        return Ok(SourceOutline {
            declarations: Vec::new(),
            diagnostics: vec![PrototypeDiagnostic {
                code: "OUTLINE_YAML_PARSE_ERROR",
                file: file.into(),
                line: 0,
                message: format!("Черновик YAML пока невозможно разобрать: {error}"),
            }],
            truncated: false,
        });
    }
    issues.extend(collector.diagnostics);
    let truncated =
        collector.declarations.len() > MAX_LIVE_OUTLINE || issues.len() > MAX_OUTLINE_ISSUES;
    let parsed = YamlLoader::load_from_str(source).ok();
    let declarations = collector
        .declarations
        .into_iter()
        .take(MAX_LIVE_OUTLINE)
        .map(|declaration| {
            let source_item = if declaration.kind == "entity" && declaration.variant_index.is_none()
            {
                parsed
                    .as_ref()
                    .and_then(|docs| docs.get(declaration.document_index.saturating_sub(1)))
                    .and_then(Yaml::as_vec)
                    .and_then(|items| items.get(declaration.item_index.saturating_sub(1)))
            } else {
                None
            };
            let sprite = source_item
                .and_then(extract_sprite_source)
                .map(|(path, state)| SourceSpriteLink {
                    indexed: is_rsi_indexed(&path),
                    path,
                    state,
                });
            let (sprite_layers, sprite_layers_total) = source_item
                .map(|item| extract_sprite_layers(item, sprite.as_ref(), &is_rsi_indexed))
                .unwrap_or_default();
            SourceOutlineEntry {
                declaration,
                sprite,
                sprite_layers,
                sprite_layers_total,
            }
        })
        .collect();
    issues.truncate(MAX_OUTLINE_ISSUES);
    Ok(SourceOutline {
        declarations,
        diagnostics: issues,
        truncated,
    })
}

/// Accept only source-constant texture paths, never canonicalize arbitrary
/// YAML paths. Explicit Textures prefixes and optional .rsi suffixes are
/// common across SS14 forks.
pub(crate) fn normalize_sprite_path(raw: &str) -> Option<String> {
    let relative = raw
        .strip_prefix("Resources/Textures/")
        .or_else(|| raw.strip_prefix("/Textures/"))
        .or_else(|| raw.strip_prefix("Textures/"))
        .unwrap_or(raw);
    if relative.is_empty()
        || relative.len() > 512
        || relative.contains('\\')
        || relative.contains(':')
        || relative.chars().any(char::is_control)
    {
        return None;
    }
    let relative_path = Path::new(relative);
    if !relative_path
        .components()
        .all(|part| matches!(part, Component::Normal(_)))
    {
        return None;
    }
    let normalized = if relative_path.extension().is_none() {
        format!("{relative}.rsi")
    } else if relative_path
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("rsi"))
    {
        relative.to_owned()
    } else {
        return None;
    };
    Some(format!("Resources/Textures/{normalized}"))
}

fn sprite_component(item: &Yaml) -> Option<&Yaml> {
    item["components"]
        .as_vec()?
        .iter()
        .find(|component| component["type"].as_str() == Some("Sprite"))
}

/// Only direct Sprite.sprite + state; never read inherited component state.
fn extract_sprite_source(item: &Yaml) -> Option<(String, Option<String>)> {
    let sprite = sprite_component(item)?;
    let path = normalize_sprite_path(sprite["sprite"].as_str()?)?;
    let state = sprite["state"].as_str().map(str::to_owned);
    Some((path, state))
}

/// Layers are read-only provenance. Missing Sprite.sprite is not an error if a
/// layer provides its own path. Dynamic fields/tags require manual inspection.
fn extract_sprite_layers(
    item: &Yaml,
    default: Option<&SourceSpriteLink>,
    is_rsi_indexed: &impl Fn(&str) -> bool,
) -> (Vec<SourceSpriteLayer>, usize) {
    let Some(component) = sprite_component(item) else {
        return (Vec::new(), 0);
    };
    let Some(layers) = component["layers"].as_vec() else {
        return (Vec::new(), 0);
    };
    let total = layers.len();
    let layers = layers
        .iter()
        .take(MAX_LIVE_SPRITE_LAYERS)
        .enumerate()
        .map(|(index, layer)| {
            let explicit = layer["sprite"].as_str();
            let path = match explicit {
                Some(path) => normalize_sprite_path(path),
                None => default.map(|link| link.path.clone()),
            };
            let indexed = path.as_deref().is_some_and(is_rsi_indexed);
            SourceSpriteLayer {
                index,
                path,
                indexed,
                state: layer["state"].as_str().map(str::to_owned),
                visible: layer["visible"]
                    .as_bool()
                    .or_else(|| matches!(layer["visible"], Yaml::BadValue).then_some(true)),
                shader: layer["shader"].as_str().map(str::to_owned),
                default_path: explicit.is_none() && default.is_some(),
            }
        })
        .collect();
    (layers, total)
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
    by_id: HashMap<String, Vec<usize>>,
    graph: PrototypeGraph,
}

fn unique_kinds(declarations: &[PrototypeDeclaration]) -> Vec<String> {
    let kinds: BTreeSet<String> = declarations
        .iter()
        .map(|declaration| declaration.kind.clone())
        .collect();
    kinds.into_iter().collect()
}

impl PrototypeCatalog {
    /// Electron create-prototype wizard: all kinds in the native index,
    /// not just the first page of prototype search results.
    pub fn kinds(&self) -> Vec<String> {
        unique_kinds(&self.declarations)
    }

    /// Original YAML declarations for a particular kind/ID. No merge or
    /// inherited property resolution is implied by their order.
    pub fn source_declarations(&self, kind: &str, id: &str) -> Vec<PrototypeDeclaration> {
        self.by_identity
            .get(&(kind.to_owned(), id.to_owned()))
            .map(|indices| {
                indices
                    .iter()
                    .map(|&index| self.declarations[index].clone())
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Electron Inspector compatibility: resolve a reference by ID, first
    /// preferring the same prototype kind, then entity, then another indexed
    /// kind. A partial-only declaration cannot be a safe navigation target.
    pub fn linked_prototype(
        &self,
        preferred_kind: &str,
        id: &str,
    ) -> Option<&PrototypeDeclaration> {
        let pick = |indices: &Vec<usize>| {
            indices
                .iter()
                .copied()
                .find(|&i| self.declarations[i].mode == "normal")
                .map(|i| &self.declarations[i])
        };
        self.by_identity
            .get(&(preferred_kind.to_owned(), id.to_owned()))
            .and_then(pick)
            .or_else(|| {
                self.by_identity
                    .get(&("entity".to_owned(), id.to_owned()))
                    .and_then(pick)
            })
            .or_else(|| self.by_id.get(id).and_then(pick))
    }

    pub fn has_identity(&self, kind: &str, id: &str) -> bool {
        self.by_identity
            .contains_key(&(kind.to_owned(), id.to_owned()))
    }

    pub fn has_partial_declarations(&self, file: &str) -> bool {
        self.declarations
            .iter()
            .any(|entry| entry.file == file && entry.mode != "normal")
    }

    /// Loads on first prototype query (from a blocking task), not on workspace open.
    pub fn build(root: &Path, resources: &[ResourceEntry]) -> Self {
        let mut catalog = Self::default();
        let scopes = configured_partials(root, &mut catalog.diagnostics);
        let textures_present = root.join("Resources/Textures").is_dir();
        let rsi_paths: HashSet<&str> = resources.iter().filter(|entry| entry.kind == "rsi")
            .map(|entry| entry.path.as_str()).collect();
        let resolved_rsi_paths: HashSet<PathBuf> = rsi_paths.iter()
            .filter_map(|path| fs::canonicalize(root.join(path)).ok())
            .filter(|path| path.starts_with(root)).collect();
        let mut sprite_count = 0;
        let mut sprite_truncated = false;
        if !textures_present {
            catalog.issue("SPRITE_INDEX_INCOMPLETE", "Resources/Textures", 0,
                "Каталог текстур отсутствует: проверка Sprite.sprite неполна.");
        }

        for resource in resources {
            if resource.kind != "yaml" {
                continue;
            }

            let candidate = root.join(&resource.path);
            let path = resource.path.as_str();
            let mode = partial_order_for(path, &scopes);

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
                    if textures_present {
                        if let Ok(docs) = YamlLoader::load_from_str(&content) {
                            for declaration in &collector.declarations {
                                if declaration.kind != "entity" || declaration.variant_index.is_some() {
                                    continue;
                                }
                                let item = docs.get(declaration.document_index.saturating_sub(1))
                                    .and_then(Yaml::as_vec)
                                    .and_then(|items| items.get(declaration.item_index.saturating_sub(1)));
                                if let Some((sprite, _)) = item.and_then(extract_sprite_source) {
                                    if !rsi_paths.contains(sprite.as_str()) {
                                        // The resource index deliberately skips symlinks; absence there is not proof.
                                        let mut current = root.to_path_buf();
                                        let skipped_link = Path::new(&sprite).components().any(|part| {
                                            current.push(part.as_os_str());
                                            fs::symlink_metadata(&current).is_ok_and(|metadata| metadata.file_type().is_symlink())
                                        });
                                        if skipped_link {
                                            if sprite_count < MAX_SPRITE_DIAGNOSTICS {
                                                catalog.issue("SPRITE_INDEX_INCOMPLETE", path, declaration.line,
                                                    format!("Sprite.sprite не проверен: путь содержит символическую ссылку: {sprite}."));
                                                sprite_count += 1;
                                            } else if !sprite_truncated {
                                                catalog.issue("SPRITE_DIAGNOSTICS_TRUNCATED", path, declaration.line,
                                                    "Показаны первые 500 сообщений Sprite RSI; проверка усечена.");
                                                sprite_truncated = true;
                                            }
                                            continue;
                                        }
                                        // Resolve alternate casing using the project's filesystem, not Unicode folding.
                                        if fs::canonicalize(root.join(&sprite)).ok()
                                            .is_some_and(|path| resolved_rsi_paths.contains(&path))
                                        {
                                            continue;
                                        }
                                        if sprite_count < MAX_SPRITE_DIAGNOSTICS {
                                            catalog.issue("SPRITE_RSI_MISSING", path, declaration.line,
                                                format!("Sprite.sprite: RSI отсутствует в текущем индексе: {sprite} ({}).", declaration.id));
                                            sprite_count += 1;
                                        } else if !sprite_truncated {
                                            catalog.issue("SPRITE_DIAGNOSTICS_TRUNCATED", path, declaration.line,
                                                "Показаны первые 500 сообщений Sprite RSI; проверка усечена.");
                                            sprite_truncated = true;
                                        }
                                    }
                                }
                            }
                        } else {
                            catalog.issue("SPRITE_SCAN_INCOMPLETE", path, 0,
                                "Не удалось проверить Sprite.sprite в этом YAML-файле.");
                        }
                    }
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
                a.variant_index,
            )
                .cmp(&(
                    &b.kind,
                    &b.id,
                    &b.file,
                    b.line,
                    b.document_index,
                    b.item_index,
                    b.variant_index,
                ))
        });
        for (index, item) in catalog.declarations.iter().enumerate() {
            catalog
                .by_identity
                .entry((item.kind.clone(), item.id.clone()))
                .or_default()
                .push(index);
            catalog
                .by_id
                .entry(item.id.clone())
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
                || (!query.is_empty()
                    && !self.search_keys[index].contains(&query)
                    && !declaration
                        .search_name
                        .as_deref()
                        .is_some_and(|name| name.contains(&query)))
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
    let directory = root.join("Resources/PartialPrototypes");
    let metadata = match fs::symlink_metadata(&directory) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Vec::new(),
        Err(error) => {
            issues.push(PrototypeDiagnostic {
                code: "PARTIAL_CONFIG_UNREADABLE",
                file: "Resources/PartialPrototypes".into(),
                line: 0,
                message: error.to_string(),
            });
            return Vec::new();
        }
    };
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        issues.push(PrototypeDiagnostic {
            code: "PARTIAL_CONFIG_SYMLINK",
            file: "Resources/PartialPrototypes".into(),
            line: 0,
            message:
                "Каталог PartialPrototypes должен быть обычной папкой, не символической ссылкой."
                    .into(),
        });
        return Vec::new();
    }

    // The engine enumerates every config file in this directory in canonical
    // path order. Nested directories are included, and only the first YAML
    // document in each file is used by EntryPoint.TryReadFilesPaths.
    let mut pending = vec![directory];
    let mut config_files: Vec<(String, PathBuf)> = Vec::new();
    let mut visited = 0usize;
    let mut limited = false;
    while let Some(folder) = pending.pop() {
        let entries = match fs::read_dir(&folder) {
            Ok(entries) => entries,
            Err(error) => {
                issues.push(PrototypeDiagnostic {
                    code: "PARTIAL_CONFIG_UNREADABLE",
                    file: folder
                        .strip_prefix(root)
                        .unwrap_or(&folder)
                        .to_string_lossy()
                        .replace('\\', "/"),
                    line: 0,
                    message: error.to_string(),
                });
                continue;
            }
        };
        let mut entries = entries
            .filter_map(|entry| match entry {
                Ok(entry) => Some(entry),
                Err(error) => {
                    issues.push(PrototypeDiagnostic {
                        code: "PARTIAL_CONFIG_UNREADABLE",
                        file: "Resources/PartialPrototypes".into(),
                        line: 0,
                        message: error.to_string(),
                    });
                    None
                }
            })
            .collect::<Vec<_>>();
        entries.sort_by_key(|entry| entry.file_name());

        for entry in entries {
            visited += 1;
            if visited > MAX_PARTIAL_CONFIG_ENTRIES {
                limited = true;
                break;
            }
            let path = entry.path();
            let relative = path
                .strip_prefix(root)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/");
            let kind = match entry.file_type() {
                Ok(kind) => kind,
                Err(error) => {
                    issues.push(PrototypeDiagnostic {
                        code: "PARTIAL_CONFIG_UNREADABLE",
                        file: relative,
                        line: 0,
                        message: error.to_string(),
                    });
                    continue;
                }
            };
            if kind.is_symlink() {
                issues.push(PrototypeDiagnostic {
                    code: "PARTIAL_CONFIG_SYMLINK",
                    file: relative,
                    line: 0,
                    message: "Символические ссылки в PartialPrototypes не индексируются.".into(),
                });
            } else if kind.is_dir() {
                pending.push(path);
            } else if kind.is_file()
                && path
                    .extension()
                    .and_then(|extension| extension.to_str())
                    .is_some_and(|extension| {
                        extension.eq_ignore_ascii_case("yml")
                            || extension.eq_ignore_ascii_case("yaml")
                    })
            {
                config_files.push((relative, path));
            }
        }
        if limited {
            break;
        }
    }
    if limited {
        issues.push(PrototypeDiagnostic {
            code: "PARTIAL_CONFIG_LIMIT",
            file: "Resources/PartialPrototypes".into(),
            line: 0,
            message: format!(
                "Обход конфигураций partial-прототипов остановлен после {MAX_PARTIAL_CONFIG_ENTRIES} элементов."
            ),
        });
    }

    config_files.sort_by(|left, right| left.0.cmp(&right.0));
    if config_files.len() > MAX_PARTIAL_CONFIG_FILES {
        config_files.truncate(MAX_PARTIAL_CONFIG_FILES);
        issues.push(PrototypeDiagnostic {
            code: "PARTIAL_CONFIG_LIMIT",
            file: "Resources/PartialPrototypes".into(),
            line: 0,
            message: format!(
                "Найдено больше {MAX_PARTIAL_CONFIG_FILES} конфигурационных YAML-файлов; обработана только отсортированная часть."
            ),
        });
    }

    let mut scopes = Vec::new();
    let mut total_bytes = 0usize;
    for (config_rel, config) in config_files {
        let canonical = match fs::canonicalize(&config) {
            Ok(path) if path.starts_with(root) => path,
            Ok(_) => {
                issues.push(PrototypeDiagnostic {
                    code: "PARTIAL_CONFIG_OUTSIDE_PROJECT",
                    file: config_rel,
                    line: 0,
                    message: "Конфигурация partial-каталогов оказалась за пределами проекта."
                        .into(),
                });
                continue;
            }
            Err(error) => {
                issues.push(PrototypeDiagnostic {
                    code: "PARTIAL_CONFIG_UNREADABLE",
                    file: config_rel,
                    line: 0,
                    message: error.to_string(),
                });
                continue;
            }
        };
        let content_bytes = match read_bounded(&canonical) {
            Ok(bytes) => bytes,
            Err(message) => {
                issues.push(PrototypeDiagnostic {
                    code: "PARTIAL_CONFIG_UNREADABLE",
                    file: config_rel,
                    line: 0,
                    message,
                });
                continue;
            }
        };
        if content_bytes.len() > MAX_PARTIAL_CONFIG_BYTES.saturating_sub(total_bytes) {
            issues.push(PrototypeDiagnostic {
                code: "PARTIAL_CONFIG_LIMIT",
                file: config_rel,
                line: 0,
                message: format!(
                    "Суммарный размер конфигураций PartialPrototypes превышает лимит {MAX_PARTIAL_CONFIG_BYTES} байт."
                ),
            });
            break;
        }
        total_bytes += content_bytes.len();
        let content = match String::from_utf8(content_bytes) {
            Ok(content) => content,
            Err(error) => {
                issues.push(PrototypeDiagnostic {
                    code: "PARTIAL_CONFIG_INVALID",
                    file: config_rel,
                    line: 0,
                    message: format!("Конфигурация должна быть UTF-8: {error}"),
                });
                continue;
            }
        };
        let parsed = match YamlLoader::load_from_str(&content) {
            Ok(parsed) => parsed,
            Err(error) => {
                issues.push(PrototypeDiagnostic {
                    code: "PARTIAL_CONFIG_INVALID",
                    file: config_rel,
                    line: 0,
                    message: error.to_string(),
                });
                continue;
            }
        };
        let Some(document) = parsed.first() else {
            continue;
        };
        let Some(paths) = document.as_vec() else {
            issues.push(PrototypeDiagnostic {
                code: "PARTIAL_CONFIG_INVALID",
                file: config_rel,
                line: 0,
                message:
                    "Первый YAML-документ должен быть списком путей к partial-файлам или каталогам."
                        .into(),
            });
            continue;
        };
        for item in paths {
            let Yaml::String(raw) = item else {
                issues.push(PrototypeDiagnostic {
                    code: "PARTIAL_CONFIG_PATH_INVALID",
                    file: config_rel.clone(),
                    line: 0,
                    message: "Путь partial-ресурса должен быть строкой.".into(),
                });
                continue;
            };
            let trimmed = raw.trim().replace('\\', "/");
            let relative = trimmed.trim_start_matches('/');
            let path = if relative.starts_with("Resources/") {
                relative.to_owned()
            } else {
                format!("Resources/{relative}")
            };
            let normalized = Path::new(&path);
            let inside_prototypes =
                path == "Resources/Prototypes" || path.starts_with("Resources/Prototypes/");
            if !inside_prototypes
                || normalized
                    .components()
                    .any(|component| !matches!(component, Component::Normal(_)))
            {
                issues.push(PrototypeDiagnostic {
                    code: "PARTIAL_CONFIG_PATH_INVALID",
                    file: config_rel.clone(),
                    line: 0,
                    message: format!("Недопустимый путь partial-ресурса: {raw}"),
                });
                continue;
            }

            let full = root.join(&path);
            match fs::symlink_metadata(&full) {
                Ok(metadata) if metadata.file_type().is_symlink() => {
                    issues.push(PrototypeDiagnostic {
                        code: "PARTIAL_CONFIG_SYMLINK",
                        file: config_rel.clone(),
                        line: 0,
                        message: format!("Partial-путь указывает на символическую ссылку: {path}"),
                    });
                    continue;
                }
                Ok(_) => match fs::canonicalize(&full) {
                    Ok(canonical) if canonical.starts_with(root) => {}
                    Ok(_) => {
                        issues.push(PrototypeDiagnostic {
                            code: "PARTIAL_CONFIG_OUTSIDE_PROJECT",
                            file: config_rel.clone(),
                            line: 0,
                            message: format!("Partial-путь выходит за пределы проекта: {path}"),
                        });
                        continue;
                    }
                    Err(error) => {
                        issues.push(PrototypeDiagnostic {
                            code: "PARTIAL_CONFIG_UNREADABLE",
                            file: config_rel.clone(),
                            line: 0,
                            message: format!("Не удалось проверить partial-путь {path}: {error}"),
                        });
                        continue;
                    }
                },
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    issues.push(PrototypeDiagnostic {
                        code: "PARTIAL_CONFIG_MISSING",
                        file: config_rel.clone(),
                        line: 0,
                        message: format!("Указанный partial-путь не существует: {path}"),
                    });
                }
                Err(error) => {
                    issues.push(PrototypeDiagnostic {
                        code: "PARTIAL_CONFIG_UNREADABLE",
                        file: config_rel.clone(),
                        line: 0,
                        message: format!("Не удалось проверить partial-путь {path}: {error}"),
                    });
                    continue;
                }
            }

            // RobustToolbox classifies a partial path as a file whenever it
            // has an extension; otherwise it is treated as a directory.
            scopes.push(PartialScope {
                is_file: normalized.extension().is_some(),
                relative: path.trim_end_matches('/').into(),
                order: scopes.len(),
            });
        }
    }
    scopes
}

fn partial_order_for(path: &str, scopes: &[PartialScope]) -> Option<usize> {
    // RobustToolbox checks registered files before directories, regardless
    // of the order in which those scopes were registered.
    scopes
        .iter()
        .find(|scope| scope.is_file && path == scope.relative)
        .or_else(|| {
            scopes.iter().find(|scope| {
                !scope.is_file
                    && path
                        .strip_prefix(scope.relative.as_str())
                        .is_some_and(|remainder| remainder.starts_with('/'))
            })
        })
        .map(|scope| scope.order)
}

#[derive(Debug)]
struct Draft {
    kind: Option<String>,
    id: Option<String>,
    name: Option<String>,
    parents: Vec<String>,
    abstract_prototype: bool,
    type_tag: Option<String>,
    id_tag: Option<String>,
    id_is_mapping: bool,
    id_alias: bool,
    variant_ids: Vec<String>,
    variant_alias: bool,
    variant_values_invalid: bool,
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
    VariantMapping {
        expected_key: bool,
        pending_key: Option<String>,
    },
    VariantValuesSequence,
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
        let (mode, explicit_order) = match draft.type_tag.as_deref() {
            Some(tag) if tag == "PartialOnly" || tag.starts_with("PartialOnly:") => {
                match partial_tag_index(tag, "PartialOnly", false) {
                    Ok(index) => ("partial_only", index),
                    Err(message) => {
                        self.note("PARTIAL_TAG_INVALID", draft.line, message);
                        return;
                    }
                }
            }
            Some(tag) if tag == "Partial" || tag.starts_with("Partial:") => {
                match partial_tag_index(tag, "Partial", true) {
                    Ok(index) => ("tagged_partial", index),
                    Err(message) => {
                        self.note("PARTIAL_TAG_INVALID", draft.line, message);
                        return;
                    }
                }
            }
            _ if self.configured_order.is_some() => ("configured_partial", None),
            _ => ("normal", None),
        };
        let partial_order = explicit_order.or(self.configured_order);

        let Some(kind) = draft.kind else {
            self.note(
                "PROTOTYPE_IDENTITY_MISSING",
                draft.line,
                "Пропущено объявление без строкового поля type.",
            );
            return;
        };
        if kind.trim().is_empty() {
            self.note(
                "PROTOTYPE_IDENTITY_MISSING",
                draft.line,
                "Пропущено объявление с пустым type.",
            );
            return;
        }

        let identifiers: Vec<(String, Option<usize>)> = if draft.id_is_mapping
            && draft.id_tag.as_deref() == Some("type:CreateVariants")
        {
            if draft.variant_alias || draft.variant_values_invalid || draft.variant_ids.is_empty() {
                self.note(
                        "PROTOTYPE_VARIANTS_INVALID",
                        draft.line,
                        "CreateVariants должен содержать обычный список строковых values без YAML aliases.",
                    );
                return;
            }
            draft
                .variant_ids
                .into_iter()
                .enumerate()
                .map(|(index, id)| (id, Some(index)))
                .collect()
        } else {
            if draft.id_alias {
                self.note(
                        "PROTOTYPE_ALIAS_ID_UNSUPPORTED",
                        draft.line,
                        "ID задан YAML alias. Каталог пока не разрешает aliases и не будет угадывать итоговый ID.",
                    );
                return;
            }
            if draft.id_is_mapping || draft.id_tag.is_some() {
                self.note(
                        "PROTOTYPE_DYNAMIC_ID",
                        draft.line,
                        "ID задан YAML-тегом или mapping, который каталог не может безопасно разрешить.",
                    );
                return;
            }
            let Some(id) = draft.id else {
                self.note(
                    "PROTOTYPE_IDENTITY_MISSING",
                    draft.line,
                    "Пропущено объявление без строковых полей type и id.",
                );
                return;
            };
            vec![(id, None)]
        };

        let search_name: Option<Arc<str>> = draft.name.map(|name| Arc::from(name.to_lowercase()));
        for (id, variant_index) in identifiers {
            if id.trim().is_empty() {
                self.note(
                    "PROTOTYPE_VARIANTS_INVALID",
                    draft.line,
                    "ID прототипа или одного из CreateVariants пуст.",
                );
                continue;
            }
            self.declarations.push(PrototypeDeclaration {
                kind: kind.clone(),
                id,
                search_name: search_name.clone(),
                parents: draft.parents.clone(),
                abstract_prototype: draft.abstract_prototype,
                file: self.file.clone(),
                line: draft.line,
                document_index: draft.document_index,
                item_index: draft.item_index,
                variant_index,
                mode,
                partial_order,
                parent_tag: draft.parent_tag.clone(),
                source_count: 1,
            });
        }
    }
}

fn tag_name(tag: &Tag) -> String {
    format!("{}{}", tag.handle, tag.suffix)
        .trim_start_matches('!')
        .into()
}

fn partial_tag_index(tag: &str, name: &str, require_index: bool) -> Result<Option<usize>, String> {
    if tag == name {
        return if require_index {
            Err(format!(
                "Тег !{name} должен содержать числовой индекс, например !{name}:0."
            ))
        } else {
            Ok(None)
        };
    }
    let Some(raw) = tag.strip_prefix(&format!("{name}:")) else {
        return Ok(None);
    };
    if raw.is_empty() {
        return Err(format!("После тега !{name}: не указан индекс."));
    }
    raw.parse::<usize>()
        .map(Some)
        .map_err(|_| format!("Тег !{name} содержит некорректный индекс: {raw}."))
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
            Event::SequenceStart(_, _) => {
                if self.frames.is_empty() {
                    self.frames.push(Frame::RootSequence);
                    return;
                }
                let mut invalid_variant_child = false;
                let next = match self.frames.last_mut() {
                    Some(Frame::Prototype(draft)) => {
                        let key = draft.pending_key.take();
                        draft.expected_key = true;
                        if key.as_deref() == Some("name") {
                            draft.name = None;
                        }
                        if key.as_deref() == Some("parent") {
                            Frame::ParentSequence
                        } else {
                            Frame::OtherSequence
                        }
                    }
                    Some(Frame::VariantValuesSequence) => {
                        invalid_variant_child = true;
                        Frame::OtherSequence
                    }
                    Some(Frame::VariantMapping {
                        expected_key,
                        pending_key,
                    }) => {
                        let key = pending_key.take();
                        *expected_key = true;
                        if key.as_deref() == Some("values") {
                            Frame::VariantValuesSequence
                        } else {
                            Frame::OtherSequence
                        }
                    }
                    _ => Frame::OtherSequence,
                };
                if invalid_variant_child {
                    if let Some(Frame::Prototype(draft)) = self
                        .frames
                        .iter_mut()
                        .rev()
                        .find(|frame| matches!(frame, Frame::Prototype(_)))
                    {
                        draft.variant_values_invalid = true;
                    }
                }
                self.frames.push(next);
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
                        name: None,
                        parents: Vec::new(),
                        abstract_prototype: false,
                        type_tag: None,
                        id_tag: None,
                        id_is_mapping: false,
                        id_alias: false,
                        variant_ids: Vec::new(),
                        variant_alias: false,
                        variant_values_invalid: false,
                        parent_tag: None,
                        expected_key: true,
                        pending_key: None,
                        line: mark.line(),
                        document_index: self.document_index,
                        item_index: self.item_index,
                    })));
                } else {
                    let mut create_variants = false;
                    if matches!(self.frames.last(), Some(Frame::VariantValuesSequence)) {
                        if let Some(Frame::Prototype(draft)) = self
                            .frames
                            .iter_mut()
                            .rev()
                            .find(|frame| matches!(frame, Frame::Prototype(_)))
                        {
                            draft.variant_values_invalid = true;
                        }
                    } else if let Some(Frame::Prototype(draft)) = self.frames.last_mut() {
                        let key = draft.pending_key.take();
                        draft.expected_key = true;
                        if key.as_deref() == Some("name") {
                            draft.name = None;
                        }
                        if key.as_deref() == Some("id") {
                            draft.id_is_mapping = true;
                            draft.id_tag = tag.as_ref().map(tag_name);
                            create_variants =
                                draft.id_tag.as_deref() == Some("type:CreateVariants");
                        }
                    } else if let Some(Frame::VariantMapping {
                        expected_key,
                        pending_key,
                    }) = self.frames.last_mut()
                    {
                        pending_key.take();
                        *expected_key = true;
                    }
                    if create_variants {
                        self.frames.push(Frame::VariantMapping {
                            expected_key: true,
                            pending_key: None,
                        });
                    } else {
                        self.frames.push(Frame::OtherMapping);
                    }
                }
            }
            Event::MappingEnd => {
                if let Some(Frame::Prototype(draft)) = self.frames.pop() {
                    self.finalize(*draft);
                }
            }
            Event::Scalar(value, _, _, tag) => {
                if matches!(self.frames.last(), Some(Frame::VariantValuesSequence)) {
                    if let Some(Frame::Prototype(draft)) = self
                        .frames
                        .iter_mut()
                        .rev()
                        .find(|frame| matches!(frame, Frame::Prototype(_)))
                    {
                        draft.variant_ids.push(value);
                    }
                } else if let Some(Frame::VariantMapping {
                    expected_key,
                    pending_key,
                }) = self.frames.last_mut()
                {
                    if *expected_key {
                        *pending_key = Some(value);
                        *expected_key = false;
                    } else {
                        pending_key.take();
                        *expected_key = true;
                    }
                } else if let Some(Frame::Prototype(draft)) = self.frames.last_mut() {
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
                            Some("name") => {
                                draft.name = tag.is_none().then_some(value);
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
                        if tag.is_some() {
                            draft.parent_tag = tag.as_ref().map(tag_name);
                        }
                    }
                }
            }
            Event::Alias(_) => {
                if matches!(self.frames.last(), Some(Frame::VariantValuesSequence)) {
                    if let Some(Frame::Prototype(draft)) = self
                        .frames
                        .iter_mut()
                        .rev()
                        .find(|frame| matches!(frame, Frame::Prototype(_)))
                    {
                        draft.variant_alias = true;
                        draft.variant_values_invalid = true;
                    }
                } else {
                    let mut parent_alias = false;
                    if let Some(Frame::Prototype(draft)) = self.frames.last_mut() {
                        if !draft.expected_key && draft.pending_key.as_deref() == Some("name") {
                            draft.name = None;
                            draft.pending_key = None;
                            draft.expected_key = true;
                        } else if !draft.expected_key && draft.pending_key.as_deref() == Some("id")
                        {
                            draft.id_alias = true;
                        } else if !draft.expected_key
                            && draft.pending_key.as_deref() == Some("parent")
                        {
                            parent_alias = true;
                        }
                    } else if matches!(self.frames.last(), Some(Frame::ParentSequence)) {
                        parent_alias = true;
                    }
                    if parent_alias {
                        self.note(
                            "PARENT_ALIAS_UNRESOLVED",
                            mark.line(),
                            "Ссылка parent задана YAML alias; исходный граф не разрешает anchors и aliases.",
                        );
                    }
                }
                /* Parent-sequence aliases are reported by the branch above. */
            }
            Event::StreamStart | Event::StreamEnd | Event::Nothing => {}
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
    fn live_outline_preserves_document_coordinates_and_reads_direct_sprite() {
        let source = "- type: entity\n  id: Item\n  components:\n  - type: Sprite\n    sprite: Objects/Tools/wrench.rsi\n    state: icon\n- type: entity\n  id: Other\n  parent: Item\n";
        let result = inspect_source_outline(
            Path::new("/tmp"),
            "Resources/Prototypes/test.yml",
            source,
            |path| path == "Resources/Textures/Objects/Tools/wrench.rsi",
        )
        .unwrap();
        assert_eq!(result.declarations.len(), 2);
        let first = &result.declarations[0];
        assert_eq!(first.declaration.id, "Item");
        assert_eq!(first.declaration.item_index, 1);
        assert_eq!(first.declaration.document_index, 1);
        assert_eq!(
            first.sprite.as_ref().unwrap().state.as_deref(),
            Some("icon")
        );
        assert!(first.sprite.as_ref().unwrap().indexed);
        assert_eq!(result.declarations[1].declaration.parents, ["Item"]);
    }

    #[test]
    fn live_outline_retains_partial_mode_and_fails_closed_on_yaml_errors() {
        let result = inspect_source_outline(
            Path::new("/tmp"),
            "Resources/Prototypes/test.yml",
            "- type: !PartialOnly entity\n  id: Variant\n",
            |_| false,
        )
        .unwrap();
        assert_eq!(result.declarations[0].declaration.mode, "partial_only");
        let invalid = inspect_source_outline(
            Path::new("/tmp"),
            "Resources/Prototypes/test.yml",
            "- type: entity\n  id: [broken\n",
            |_| false,
        )
        .unwrap();
        assert!(invalid.declarations.is_empty());
        assert_eq!(invalid.diagnostics[0].code, "OUTLINE_YAML_PARSE_ERROR");
    }

    #[test]
    fn live_outline_lists_sprite_layers_with_default_and_explicit_paths() {
        let source = "- type: entity\n  id: Layered\n  components:\n  - type: Sprite\n    sprite: Textures/Clothing/shirt\n    state: worn\n    layers:\n    - state: base\n    - state: overlay\n      sprite: /Textures/Effects/shine.rsi\n      visible: false\n      shader: unshaded\n    - state: missing\n      sprite: ../unsafe.rsi\n";
        let report = inspect_source_outline(
            Path::new("/tmp"),
            "Resources/Prototypes/test.yml",
            source,
            |path| path == "Resources/Textures/Clothing/shirt.rsi",
        )
        .unwrap();
        let entry = &report.declarations[0];
        assert_eq!(entry.sprite_layers_total, 3);
        assert_eq!(
            entry.sprite.as_ref().unwrap().path,
            "Resources/Textures/Clothing/shirt.rsi"
        );
        assert_eq!(
            entry.sprite_layers[0].path.as_deref(),
            Some("Resources/Textures/Clothing/shirt.rsi")
        );
        assert!(entry.sprite_layers[0].default_path);
        assert!(entry.sprite_layers[0].indexed);
        assert_eq!(
            entry.sprite_layers[1].path.as_deref(),
            Some("Resources/Textures/Effects/shine.rsi")
        );
        assert_eq!(entry.sprite_layers[1].visible, Some(false));
        assert_eq!(entry.sprite_layers[1].shader.as_deref(), Some("unshaded"));
        assert!(!entry.sprite_layers[1].indexed);
        assert!(entry.sprite_layers[2].path.is_none());
    }

    #[test]
    fn live_outline_supports_layer_only_sprite_and_caps_large_layer_list() {
        let mut source =
            "- type: entity\n  id: LayerOnly\n  components:\n  - type: Sprite\n    layers:\n"
                .to_owned();
        for _ in 0..40 {
            source.push_str("    - state: icon\n      sprite: Objects/Tool.rsi\n");
        }
        let result = inspect_source_outline(
            Path::new("/tmp"),
            "Resources/Prototypes/test.yml",
            &source,
            |_| true,
        )
        .unwrap();
        let entry = &result.declarations[0];
        assert!(entry.sprite.is_none());
        assert_eq!(entry.sprite_layers_total, 40);
        assert_eq!(entry.sprite_layers.len(), MAX_LIVE_SPRITE_LAYERS);
        assert!(entry.sprite_layers[0].indexed);
        assert!(!entry.sprite_layers[0].default_path);
    }

    #[test]
    fn live_outline_rejects_sprite_path_traversal_and_oversize_text() {
        for path in [
            "../Other.rsi",
            "/abs.rsi",
            "Resources/Textures/../Out.rsi",
            "a.png",
        ] {
            let item = format!(
                "- type: entity\n  id: Item\n  components:\n  - type: Sprite\n    sprite: {path}\n"
            );
            let result = inspect_source_outline(
                Path::new("/tmp"),
                "Resources/Prototypes/test.yml",
                &item,
                |_| true,
            )
            .unwrap();
            assert!(
                result.declarations[0].sprite.is_none(),
                "unexpected link for {path}"
            );
        }
        assert_eq!(
            inspect_source_outline(
                Path::new("/tmp"),
                "Resources/Prototypes/test.yml",
                &" ".repeat(MAX_YAML_BYTES as usize + 1),
                |_| false
            )
            .unwrap_err()
            .code,
            "OUTLINE_TOO_LARGE"
        );
    }

    #[test]
    fn wizard_kinds_include_all_project_specific_types_without_duplicates() {
        let (entries, issues) = parse(
            "- type: entity\n  id: One\n- type: reagent\n  id: Acid\n- type: entity\n  id: Two\n- type: customPrototype\n  id: Extra\n",
            None,
        );
        assert!(issues.is_empty());
        assert_eq!(
            unique_kinds(&entries),
            ["customPrototype", "entity", "reagent"]
        );
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
            "- type: entity\n  id: Test\n- type: !Partial:0 entity\n  id: Other\n",
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
    fn partial_config_files_follow_lexical_order_and_only_first_document() {
        let root = std::env::temp_dir().join(format!("ss14-partials-order-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("Resources/PartialPrototypes")).unwrap();
        fs::create_dir_all(root.join("Resources/Prototypes/_First")).unwrap();
        fs::create_dir_all(root.join("Resources/Prototypes/_Second")).unwrap();
        fs::write(
            root.join("Resources/PartialPrototypes/z-last.yml"),
            "- /Prototypes/_Second\n",
        )
        .unwrap();
        fs::write(
            root.join("Resources/PartialPrototypes/a-first.yml"),
            "- /Prototypes/_First\n---\n- /Prototypes/_IgnoredSecondDocument\n",
        )
        .unwrap();

        let mut issues = Vec::new();
        let scopes = configured_partials(&root, &mut issues);
        assert_eq!(scopes.len(), 2);
        assert_eq!(scopes[0].relative, "Resources/Prototypes/_First");
        assert_eq!(scopes[0].order, 0);
        assert_eq!(scopes[1].relative, "Resources/Prototypes/_Second");
        assert_eq!(scopes[1].order, 1);
        assert!(!issues
            .iter()
            .any(|issue| issue.code == "PARTIAL_CONFIG_INVALID"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn explicitly_registered_files_take_precedence_over_directories() {
        let root =
            std::env::temp_dir().join(format!("ss14-partials-precedence-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("Resources/PartialPrototypes")).unwrap();
        fs::create_dir_all(root.join("Resources/Prototypes/_Fork/Partials")).unwrap();
        fs::write(
            root.join("Resources/PartialPrototypes/a-directories.yml"),
            "- /Prototypes/_Fork/Partials\n",
        )
        .unwrap();
        fs::write(
            root.join("Resources/PartialPrototypes/b-file.yml"),
            "- /Prototypes/_Fork/Partials/example.yml\n",
        )
        .unwrap();

        let mut issues = Vec::new();
        let scopes = configured_partials(&root, &mut issues);
        assert_eq!(
            partial_order_for("Resources/Prototypes/_Fork/Partials/example.yml", &scopes),
            Some(1)
        );
        assert_eq!(
            partial_order_for("Resources/Prototypes/_Fork/Partials/another.yml", &scopes),
            Some(0)
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn partial_tags_preserve_explicit_order_and_reject_invalid_indices() {
        let (items, _issues) = parse(
            "- type: !Partial:3 entity\n  id: Tagged\n- type: !PartialOnly:7 entity\n  id: Only\n- !Partial:99\n  type: entity\n  id: MappingTagIgnored\n",
            None,
        );
        assert_eq!(items.len(), 3);
        let tagged = items.iter().find(|item| item.id == "Tagged").unwrap();
        assert_eq!(tagged.mode, "tagged_partial");
        assert_eq!(tagged.partial_order, Some(3));
        let only = items.iter().find(|item| item.id == "Only").unwrap();
        assert_eq!(only.mode, "partial_only");
        assert_eq!(only.partial_order, Some(7));
        let mapping_tagged = items
            .iter()
            .find(|item| item.id == "MappingTagIgnored")
            .unwrap();
        assert_eq!(mapping_tagged.mode, "normal");
        assert_eq!(mapping_tagged.partial_order, None);

        let (invalid, diagnostics) = parse(
            "- type: !Partial entity\n  id: MissingIndex\n- type: !Partial:abc entity\n  id: InvalidIndex\n- type: !PartialOnly:nope entity\n  id: InvalidOnly\n",
            None,
        );
        assert!(invalid.is_empty());
        assert_eq!(
            diagnostics
                .iter()
                .filter(|issue| issue.code == "PARTIAL_TAG_INVALID")
                .count(),
            3
        );
    }

    #[test]
    fn create_variants_indexes_generated_ids_without_scanning_nested_component_data() {
        let (items, issues) = parse(
            "- type: entity\n  id: !type:CreateVariants\n    values: [Human, Moth, Vulp]\n  components:\n  - type: Sprite\n    state: !type:CreateVariants\n      values: [human, moth, vulp]\n",
            None,
        );
        assert!(issues.is_empty(), "{issues:?}");
        assert_eq!(items.len(), 3);
        assert_eq!(
            items
                .iter()
                .map(|item| item.id.as_str())
                .collect::<Vec<_>>(),
            ["Human", "Moth", "Vulp"]
        );
        assert_eq!(
            items
                .iter()
                .map(|item| item.variant_index)
                .collect::<Vec<_>>(),
            [Some(0), Some(1), Some(2)]
        );
    }

    #[test]
    fn unresolved_aliases_and_invalid_variant_lists_make_catalog_incomplete() {
        let (items, issues) = parse(
            "- type: entity\n  id: &ExternalId External\n- type: entity\n  id: !type:CreateVariants\n    values: [One, *ExternalId]\n- type: entity\n  id: *ExternalId\n",
            None,
        );
        assert_eq!(
            items
                .iter()
                .map(|item| item.id.as_str())
                .collect::<Vec<_>>(),
            ["External"]
        );
        assert!(issues
            .iter()
            .any(|issue| issue.code == "PROTOTYPE_VARIANTS_INVALID"));
        assert!(issues
            .iter()
            .any(|issue| issue.code == "PROTOTYPE_ALIAS_ID_UNSUPPORTED"));
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
        let catalog = workspace.prototypes().unwrap();
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

    #[test]
    fn catalog_searches_declared_names_without_nested_or_inherited_matches() {
        let root =
            std::env::temp_dir().join(format!("ss14-prototype-name-search-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let directory = root.join("Resources/Prototypes");
        fs::create_dir_all(&directory).unwrap();
        fs::write(
            directory.join("names.yml"),
            "- type: entity\n  id: Parent\n  name: Bright Wrench\n- type: entity\n  id: Child\n  parent: Parent\n  components:\n  - type: Sprite\n    name: NestedOnly\n- type: entity\n  id: !type:CreateVariants\n    values: [VariantA, VariantB]\n  name: Bright Wrench\n- type: other\n  id: Other\n  name: Bright Wrench\n",
        )
        .unwrap();
        let workspace = crate::project::ProjectIndex::open(root.to_str().unwrap()).unwrap();
        let catalog = workspace.prototypes().unwrap();
        let page = catalog.search("  BRIGHT wrench  ", Some("ENTITY"), 1, 1);
        assert_eq!(page.total, 3);
        assert_eq!(page.items.len(), 1);
        assert_eq!(page.items[0].id, "VariantA");
        assert_eq!(catalog.search("bright", None, 0, 500).total, 4);
        assert_eq!(catalog.search("nestedonly", None, 0, 10).total, 0);
        assert!(catalog
            .search("bright", Some("entity"), usize::MAX, 10)
            .items
            .is_empty());
        let variants: Vec<_> = catalog
            .declarations
            .iter()
            .filter(|item| item.id.starts_with("Variant"))
            .collect();
        assert!(Arc::ptr_eq(
            variants[0].search_name.as_ref().unwrap(),
            variants[1].search_name.as_ref().unwrap()
        ));
        let _ = fs::remove_dir_all(root);
    }
}

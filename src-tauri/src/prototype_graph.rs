//! Source-level prototype parent graph. Never substitute this for the
//! engine's fully resolved inheritance, especially with partial declarations.
use std::collections::{HashMap, HashSet};

use serde::Serialize;

use crate::prototypes::{PrototypeDeclaration, PrototypeDiagnostic};

type Identity = (String, String);
const MAX_LINKS: usize = 150;
const MAX_GRAPH_DIAGNOSTICS: usize = 200;

#[derive(Debug)]
struct ParentEdge {
    child_index: usize,
    parent_id: String,
    tagged: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct PrototypeRelationLink {
    pub kind: String,
    pub id: String,
    pub file: String,
    pub line: usize,
    /// The YAML declaration where the parent reference was written.
    pub source_mode: &'static str,
    /// "defined" | "partial_only" | "ambiguous" | "not_indexed" | "tagged"
    pub status: &'static str,
}

#[derive(Debug, Serialize)]
pub struct PrototypeRelations {
    pub kind: String,
    pub id: String,
    pub declarations: Vec<PrototypeDeclaration>,
    pub parents: Vec<PrototypeRelationLink>,
    pub children: Vec<PrototypeRelationLink>,
    pub parent_total: usize,
    pub child_total: usize,
    /// False if malformed or unreadable source files could hide definitions.
    pub index_complete: bool,
}

#[derive(Debug, Default)]
pub struct PrototypeGraph {
    edges: Vec<ParentEdge>,
    parent_edges: HashMap<Identity, Vec<usize>>,
    child_edges: HashMap<Identity, Vec<usize>>,
    diagnostics: Vec<PrototypeDiagnostic>,
    index_complete: bool,
}

fn index_is_complete(issues: &[PrototypeDiagnostic]) -> bool {
    !issues.iter().any(|issue| {
        matches!(
            issue.code,
            "SOURCE_NOT_READABLE"
                | "SOURCE_OUTSIDE_PROJECT"
                | "SOURCE_ENCODING"
                | "YAML_PARSE_ERROR"
                | "PROTOTYPE_DYNAMIC_ID"
                | "PARTIAL_CONFIG_UNREADABLE"
                | "PARTIAL_CONFIG_INVALID"
                | "PARTIAL_CONFIG_OUTSIDE_PROJECT"
                | "PARTIAL_CONFIG_PATH_INVALID"
                | "PARTIAL_CONFIG_MISSING"
        )
    })
}

fn status(
    key: &Identity,
    by_identity: &HashMap<Identity, Vec<usize>>,
    declarations: &[PrototypeDeclaration],
) -> &'static str {
    match by_identity.get(key) {
        None => "not_indexed",
        Some(found) => {
            let base_count = found
                .iter()
                .filter(|&&index| declarations[index].mode == "normal")
                .count();
            if base_count > 1 {
                "ambiguous"
            } else if base_count == 0 {
                "partial_only"
            } else {
                "defined"
            }
        }
    }
}

impl PrototypeGraph {
    pub fn build(
        declarations: &[PrototypeDeclaration],
        by_identity: &HashMap<Identity, Vec<usize>>,
        current_issues: &[PrototypeDiagnostic],
    ) -> Self {
        let mut graph = Self {
            index_complete: index_is_complete(current_issues),
            ..Self::default()
        };
        let mut definite_adjacency: HashMap<Identity, Vec<Identity>> = HashMap::new();
        let mut reported_missing = HashSet::new();

        for (index, declaration) in declarations.iter().enumerate() {
            let child = (declaration.kind.clone(), declaration.id.clone());
            for parent in &declaration.parents {
                if parent.trim().is_empty() {
                    continue;
                }
                let target = (declaration.kind.clone(), parent.clone());
                let tagged = declaration.parent_tag.is_some();
                let position = graph.edges.len();
                graph.edges.push(ParentEdge {
                    child_index: index,
                    parent_id: parent.clone(),
                    tagged,
                });
                graph
                    .parent_edges
                    .entry(child.clone())
                    .or_default()
                    .push(position);
                graph
                    .child_edges
                    .entry(target.clone())
                    .or_default()
                    .push(position);

                // "Not indexed" is not a proof that an engine prototype does not
                // exist, especially if the project has syntax errors or dynamic IDs.
                if !tagged
                    && declaration.mode == "normal"
                    && graph.index_complete
                    && status(&target, by_identity, declarations) == "not_indexed"
                    && reported_missing.insert((child.clone(), target.clone()))
                    && graph.diagnostics.len() < MAX_GRAPH_DIAGNOSTICS
                {
                    graph.diagnostics.push(PrototypeDiagnostic {
                        code: "PARENT_NOT_INDEXED",
                        file: declaration.file.clone(),
                        line: declaration.line,
                        message: format!(
                            "Для {}:{} ссылка parent={} не найдена в текущем каталоге объявлений.",
                            declaration.kind, declaration.id, parent
                        ),
                    });
                }

                // A cycle in static, untagged, normal declarations is actionable.
                // Inheritance contributed only by partials is intentionally omitted
                // because its merge behavior depends on RobustToolbox.
                if !tagged
                    && declaration.mode == "normal"
                    && status(&child, by_identity, declarations) == "defined"
                    && status(&target, by_identity, declarations) == "defined"
                {
                    let parents = definite_adjacency.entry(child.clone()).or_default();
                    if !parents.contains(&target) {
                        parents.push(target);
                    }
                }
            }
        }
        graph.detect_cycles(&definite_adjacency, declarations, by_identity);
        graph
    }

    fn detect_cycles(
        &mut self,
        adjacency: &HashMap<Identity, Vec<Identity>>,
        declarations: &[PrototypeDeclaration],
        by_identity: &HashMap<Identity, Vec<usize>>,
    ) {
        // Iterative 3-color DFS: bounded call stack even on large SS14 catalogs.
        let mut color: HashMap<Identity, u8> = HashMap::new();
        let mut emitted = HashSet::new();

        for start in adjacency.keys() {
            if color.get(start).copied().unwrap_or(0) != 0 {
                continue;
            }
            color.insert(start.clone(), 1);
            let mut stack: Vec<(Identity, usize)> = vec![(start.clone(), 0)];

            while let Some((current, position)) = stack.last_mut() {
                let neighbors = adjacency.get(current).map_or(&[][..], Vec::as_slice);
                if *position >= neighbors.len() {
                    color.insert(current.clone(), 2);
                    stack.pop();
                    continue;
                }

                let next = neighbors[*position].clone();
                *position += 1;
                match color.get(&next).copied().unwrap_or(0) {
                    0 => {
                        color.insert(next.clone(), 1);
                        stack.push((next, 0));
                    }
                    1 => {
                        let Some(offset) = stack.iter().position(|(node, _)| *node == next) else {
                            continue;
                        };
                        let nodes: Vec<Identity> =
                            stack[offset..].iter().map(|(key, _)| key.clone()).collect();
                        let mut signature = nodes.clone();
                        signature.sort();
                        signature.dedup();
                        if !emitted.insert(signature) {
                            continue;
                        }

                        if self.diagnostics.len() >= MAX_GRAPH_DIAGNOSTICS {
                            continue;
                        }
                        if let Some(first_index) =
                            by_identity.get(&next).and_then(|indices| {
                                indices.iter().copied().find(|&i| declarations[i].mode == "normal")
                            })
                        {
                            let first = &declarations[first_index];
                            let mut chain: Vec<String> =
                                nodes.iter().map(|(_, id)| id.clone()).collect();
                            chain.push(next.1.clone());
                            self.diagnostics.push(PrototypeDiagnostic {
                                code: "DECLARED_PARENT_CYCLE",
                                file: first.file.clone(),
                                line: first.line,
                                message: format!(
                                    "Цикл прямых parent-ссылок в типе {}: {}. Проверьте наследование.",
                                    next.0,
                                    chain.join(" → ")
                                ),
                            });
                        }
                    }
                    _ => {}
                }
            }
        }
    }

    pub fn diagnostics(&self) -> &[PrototypeDiagnostic] {
        &self.diagnostics
    }

    pub fn relations(
        &self,
        kind: &str,
        id: &str,
        declarations: &[PrototypeDeclaration],
        by_identity: &HashMap<Identity, Vec<usize>>,
    ) -> Option<PrototypeRelations> {
        let key = (kind.to_owned(), id.to_owned());
        let declared = by_identity.get(&key)?;
        let definitions = declared.iter().map(|&i| declarations[i].clone()).collect();

        let parents = self.parent_edges.get(&key).map_or(&[][..], Vec::as_slice);
        let children = self.child_edges.get(&key).map_or(&[][..], Vec::as_slice);

        let parent_links = parents
            .iter()
            .take(MAX_LINKS)
            .map(|&index| {
                let edge = &self.edges[index];
                let original = &declarations[edge.child_index];
                let target = (original.kind.clone(), edge.parent_id.clone());
                PrototypeRelationLink {
                    kind: original.kind.clone(),
                    id: edge.parent_id.clone(),
                    file: original.file.clone(),
                    line: original.line,
                    source_mode: original.mode,
                    status: if edge.tagged {
                        "tagged"
                    } else {
                        status(&target, by_identity, declarations)
                    },
                }
            })
            .collect();

        let child_links = children
            .iter()
            .take(MAX_LINKS)
            .map(|&index| {
                let edge = &self.edges[index];
                let original = &declarations[edge.child_index];
                PrototypeRelationLink {
                    kind: original.kind.clone(),
                    id: original.id.clone(),
                    file: original.file.clone(),
                    line: original.line,
                    source_mode: original.mode,
                    status: if edge.tagged {
                        "tagged"
                    } else {
                        status(
                            &(original.kind.clone(), original.id.clone()),
                            by_identity,
                            declarations,
                        )
                    },
                }
            })
            .collect();

        Some(PrototypeRelations {
            kind: kind.into(),
            id: id.into(),
            declarations: definitions,
            parents: parent_links,
            children: child_links,
            parent_total: parents.len(),
            child_total: children.len(),
            index_complete: self.index_complete,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn declaration(kind: &str, id: &str, parents: &[&str], mode: &'static str) -> PrototypeDeclaration {
        PrototypeDeclaration {
            kind: kind.into(),
            id: id.into(),
            parents: parents.iter().map(|value| (*value).to_owned()).collect(),
            abstract_prototype: false,
            file: format!("Resources/Prototypes/{id}.yml"),
            line: 1,
            document_index: 1,
            item_index: 1,
            mode,
            partial_order: None,
            parent_tag: None,
            source_count: 1,
        }
    }

    fn build(declarations: &[PrototypeDeclaration], issues: &[PrototypeDiagnostic])
        -> (PrototypeGraph, HashMap<Identity, Vec<usize>>)
    {
        let mut index: HashMap<Identity, Vec<usize>> = HashMap::new();
        for (position, item) in declarations.iter().enumerate() {
            index.entry((item.kind.clone(), item.id.clone()))
                .or_default().push(position);
        }
        (PrototypeGraph::build(declarations, &index, issues), index)
    }

    #[test]
    fn source_graph_finds_parents_and_children_without_merging_partials() {
        let declarations = vec![
            declaration("entity", "Base", &[], "normal"),
            declaration("entity", "Soldier", &["Base"], "normal"),
            declaration("entity", "Soldier", &["Other"], "configured_partial"),
            declaration("entity", "Other", &[], "normal"),
        ];
        let (graph, index) = build(&declarations, &[]);
        let relations = graph.relations("entity", "Soldier", &declarations, &index).unwrap();
        assert_eq!(relations.declarations.len(), 2);
        assert_eq!(relations.parent_total, 2);
        assert!(relations.parents.iter().all(|parent| parent.status == "defined"));
        let base = graph.relations("entity", "Base", &declarations, &index).unwrap();
        assert_eq!(base.child_total, 1);
        assert_eq!(base.children[0].id, "Soldier");
    }

    #[test]
    fn types_are_isolated_and_missing_reference_is_diagnostic_not_a_crash() {
        let declarations = vec![
            declaration("entity", "One", &["Missing"], "normal"),
            declaration("reagent", "Missing", &[], "normal"),
        ];
        let (graph, index) = build(&declarations, &[]);
        let relations = graph.relations("entity", "One", &declarations, &index).unwrap();
        assert_eq!(relations.parents[0].status, "not_indexed");
        assert!(graph.diagnostics.iter().any(|issue| issue.code == "PARENT_NOT_INDEXED"));
        assert!(graph.relations("entity", "Missing", &declarations, &index).is_none());
    }

    #[test]
    fn incomplete_catalog_does_not_emit_misleading_missing_parent_warning() {
        let declarations = vec![declaration("entity", "One", &["Missing"], "normal")];
        let issues = vec![PrototypeDiagnostic {
            code: "YAML_PARSE_ERROR",
            file: "broken.yml".into(),
            line: 1,
            message: "invalid YAML".into(),
        }];
        let (graph, index) = build(&declarations, &issues);
        assert!(!graph.relations("entity", "One", &declarations, &index).unwrap().index_complete);
        assert!(graph.diagnostics.is_empty());
    }

    #[test]
    fn detects_static_cycles_without_recursive_stack_overflow() {
        let declarations = vec![
            declaration("entity", "A", &["B"], "normal"),
            declaration("entity", "B", &["C"], "normal"),
            declaration("entity", "C", &["A"], "normal"),
        ];
        let (graph, _) = build(&declarations, &[]);
        assert_eq!(graph.diagnostics.iter()
            .filter(|issue| issue.code == "DECLARED_PARENT_CYCLE").count(), 1);
    }

    #[test]
    fn partial_only_cycle_is_not_reported_as_definite_engine_cycle() {
        let declarations = vec![
            declaration("entity", "A", &["B"], "normal"),
            declaration("entity", "B", &["A"], "configured_partial"),
        ];
        let (graph, _) = build(&declarations, &[]);
        assert!(!graph.diagnostics.iter().any(|issue| issue.code == "DECLARED_PARENT_CYCLE"));
    }

    #[test]
    fn tagged_parent_does_not_qualify_for_static_cycle_detection() {
        let mut a = declaration("entity", "A", &["B"], "normal");
        a.parent_tag = Some("type:Something".into());
        let declarations = vec![a, declaration("entity", "B", &["A"], "normal")];
        let (graph, index) = build(&declarations, &[]);
        assert!(graph.diagnostics.is_empty());
        let refs = graph.relations("entity", "A", &declarations, &index).unwrap();
        assert_eq!(refs.parents[0].status, "tagged");
    }

    #[test]
    fn details_are_paginated_in_memory_without_huge_ipc_payloads() {
        let mut declarations = vec![declaration("entity", "Root", &[], "normal")];
        for i in 0..200 {
            declarations.push(declaration("entity", &format!("Child{i}"), &["Root"], "normal"));
        }
        let (graph, index) = build(&declarations, &[]);
        let root = graph.relations("entity", "Root", &declarations, &index).unwrap();
        assert_eq!(root.child_total, 200);
        assert_eq!(root.children.len(), MAX_LINKS);
    }
}

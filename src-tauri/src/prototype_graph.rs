//! Source-level prototype parent graph. Never substitute this for the
//! engine's fully resolved inheritance, especially with partial declarations.
use std::collections::{HashMap, HashSet, VecDeque};

use serde::Serialize;

use crate::prototypes::{PrototypeDeclaration, PrototypeDiagnostic};

type Identity = (String, String);
const MAX_LINKS: usize = 150;
const MAX_GRAPH_DIAGNOSTICS: usize = 200;
const MAX_ANCESTRY_STEPS: usize = 200;
const MAX_ANCESTRY_DEPTH: usize = 32;

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

/// A source-level parent reference: provenance is preserved, but partial
/// declarations, YAML tags and duplicate bases are *never* guessed into
/// fully resolved engine inheritance.
#[derive(Debug, Clone, Serialize)]
pub struct PrototypeAncestor {
    pub kind: String,
    pub id: String,
    pub via: String,
    pub depth: usize,
    /// defined | partial_only | ambiguous | not_indexed | tagged
    pub status: &'static str,
    /// Declaration containing the parent reference, not the target definition.
    pub source_file: String,
    pub source_line: usize,
    pub source_mode: &'static str,
    pub definition_file: Option<String>,
    pub definition_line: Option<usize>,
    pub partial_sources: usize,
    /// Seen already on another path in the source graph (diamond/shared parent).
    pub repeated: bool,
    /// This reference closes a cycle along its own ancestry path.
    pub cycle: bool,
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
    pub ancestors: Vec<PrototypeAncestor>,
    pub ancestry_complete: bool,
    pub ancestry_truncated: bool,
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
                | "PARTIAL_CONFIG_LIMIT"
                | "PARTIAL_CONFIG_SYMLINK"
                | "PARTIAL_TAG_INVALID"
                | "PROTOTYPE_IDENTITY_MISSING"
                | "PROTOTYPE_VARIANTS_INVALID"
                | "PROTOTYPE_ALIAS_ID_UNSUPPORTED"
                | "PARENT_ALIAS_UNRESOLVED"
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
                        if let Some(first_index) = by_identity.get(&next).and_then(|indices| {
                            indices
                                .iter()
                                .copied()
                                .find(|&i| declarations[i].mode == "normal")
                        }) {
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

    /// Breadth-first exploration of the *declared* parent graph, preserving
    /// the order of multiple parent references. Partial declarations are
    /// represented as uncertain source edges but not traversed as definitive
    /// engine parents. This query uses only the existing catalog index.
    fn ancestry(
        &self,
        key: &Identity,
        declarations: &[PrototypeDeclaration],
        by_identity: &HashMap<Identity, Vec<usize>>,
    ) -> (Vec<PrototypeAncestor>, bool, bool) {
        let mut complete =
            self.index_complete && status(key, by_identity, declarations) == "defined";
        let mut truncated = false;
        let mut steps = Vec::new();
        if !by_identity.contains_key(key) {
            return (steps, false, false);
        }
        let mut seen: HashSet<Identity> = HashSet::new();
        seen.insert(key.clone());
        let mut queue = VecDeque::new();
        queue.push_back((key.clone(), 0usize, vec![key.clone()]));

        while let Some((current, depth, trail)) = queue.pop_front() {
            let matches = by_identity.get(&current);
            if matches.is_some_and(|found| found.iter().any(|&i| declarations[i].mode != "normal"))
            {
                complete = false;
            }

            let edges = self
                .parent_edges
                .get(&current)
                .map_or(&[][..], Vec::as_slice);
            if depth >= MAX_ANCESTRY_DEPTH {
                if !edges.is_empty() {
                    truncated = true;
                    complete = false;
                }
                continue;
            }

            for &position in edges {
                if steps.len() >= MAX_ANCESTRY_STEPS {
                    truncated = true;
                    complete = false;
                    return (steps, complete, truncated);
                }
                let edge = &self.edges[position];
                let source = &declarations[edge.child_index];
                let target = (source.kind.clone(), edge.parent_id.clone());
                let target_status = status(&target, by_identity, declarations);
                let target_declarations = by_identity.get(&target);
                let partial_sources = target_declarations.map_or(0, |indices| {
                    indices
                        .iter()
                        .filter(|&&i| declarations[i].mode != "normal")
                        .count()
                });
                // Ambiguous target IDs have no single trustworthy source
                // location. Let the catalog list all competing definitions.
                let definition = if target_status == "defined" {
                    target_declarations.and_then(|indices| {
                        indices
                            .iter()
                            .copied()
                            .find(|&i| declarations[i].mode == "normal")
                    })
                } else {
                    None
                }
                .map(|index| &declarations[index]);
                let tentative = edge.tagged
                    || source.mode != "normal"
                    || status(&current, by_identity, declarations) != "defined";
                let cycle = trail.contains(&target);
                let repeated = seen.contains(&target);
                if tentative || target_status != "defined" || cycle || partial_sources > 0 {
                    complete = false;
                }
                steps.push(PrototypeAncestor {
                    kind: target.0.clone(),
                    id: target.1.clone(),
                    via: current.1.clone(),
                    depth: depth + 1,
                    status: if edge.tagged { "tagged" } else { target_status },
                    source_file: source.file.clone(),
                    source_line: source.line,
                    source_mode: source.mode,
                    definition_file: definition.map(|item| item.file.clone()),
                    definition_line: definition.map(|item| item.line),
                    partial_sources,
                    repeated,
                    cycle,
                });
                if !tentative && target_status == "defined" && !repeated {
                    let mut next_trail = trail.clone();
                    next_trail.push(target.clone());
                    seen.insert(target.clone());
                    queue.push_back((target, depth + 1, next_trail));
                }
            }
        }
        (steps, complete, truncated)
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
        let (ancestors, ancestry_complete, ancestry_truncated) =
            self.ancestry(&key, declarations, by_identity);

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
            ancestors,
            ancestry_complete,
            ancestry_truncated,
            index_complete: self.index_complete,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn declaration(
        kind: &str,
        id: &str,
        parents: &[&str],
        mode: &'static str,
    ) -> PrototypeDeclaration {
        PrototypeDeclaration {
            kind: kind.into(),
            id: id.into(),
            parents: parents.iter().map(|value| (*value).to_owned()).collect(),
            abstract_prototype: false,
            file: format!("Resources/Prototypes/{id}.yml"),
            line: 1,
            document_index: 1,
            item_index: 1,
            variant_index: None,
            mode,
            partial_order: None,
            parent_tag: None,
            source_count: 1,
        }
    }

    fn build(
        declarations: &[PrototypeDeclaration],
        issues: &[PrototypeDiagnostic],
    ) -> (PrototypeGraph, HashMap<Identity, Vec<usize>>) {
        let mut index: HashMap<Identity, Vec<usize>> = HashMap::new();
        for (position, item) in declarations.iter().enumerate() {
            index
                .entry((item.kind.clone(), item.id.clone()))
                .or_default()
                .push(position);
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
        let relations = graph
            .relations("entity", "Soldier", &declarations, &index)
            .unwrap();
        assert_eq!(relations.declarations.len(), 2);
        assert_eq!(relations.parent_total, 2);
        assert!(relations
            .parents
            .iter()
            .all(|parent| parent.status == "defined"));
        let base = graph
            .relations("entity", "Base", &declarations, &index)
            .unwrap();
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
        let relations = graph
            .relations("entity", "One", &declarations, &index)
            .unwrap();
        assert_eq!(relations.parents[0].status, "not_indexed");
        assert!(graph
            .diagnostics
            .iter()
            .any(|issue| issue.code == "PARENT_NOT_INDEXED"));
        assert!(graph
            .relations("entity", "Missing", &declarations, &index)
            .is_none());
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
        assert!(
            !graph
                .relations("entity", "One", &declarations, &index)
                .unwrap()
                .index_complete
        );
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
        assert_eq!(
            graph
                .diagnostics
                .iter()
                .filter(|issue| issue.code == "DECLARED_PARENT_CYCLE")
                .count(),
            1
        );
    }

    #[test]
    fn partial_only_cycle_is_not_reported_as_definite_engine_cycle() {
        let declarations = vec![
            declaration("entity", "A", &["B"], "normal"),
            declaration("entity", "B", &["A"], "configured_partial"),
        ];
        let (graph, _) = build(&declarations, &[]);
        assert!(!graph
            .diagnostics
            .iter()
            .any(|issue| issue.code == "DECLARED_PARENT_CYCLE"));
    }

    #[test]
    fn tagged_parent_does_not_qualify_for_static_cycle_detection() {
        let mut a = declaration("entity", "A", &["B"], "normal");
        a.parent_tag = Some("type:Something".into());
        let declarations = vec![a, declaration("entity", "B", &["A"], "normal")];
        let (graph, index) = build(&declarations, &[]);
        assert!(graph.diagnostics.is_empty());
        let refs = graph
            .relations("entity", "A", &declarations, &index)
            .unwrap();
        assert_eq!(refs.parents[0].status, "tagged");
    }

    #[test]
    fn ancestry_traces_multiple_parents_and_diamond_without_false_cycle() {
        let definitions = vec![
            declaration("entity", "D", &[], "normal"),
            declaration("entity", "B", &["D"], "normal"),
            declaration("entity", "C", &["D"], "normal"),
            declaration("entity", "A", &["B", "C"], "normal"),
            declaration("reagent", "D", &["Unknown"], "normal"),
        ];
        let (graph, index) = build(&definitions, &[]);
        let result = graph
            .relations("entity", "A", &definitions, &index)
            .unwrap();
        assert_eq!(
            result
                .ancestors
                .iter()
                .map(|a| a.id.as_str())
                .collect::<Vec<_>>(),
            ["B", "C", "D", "D"]
        );
        assert_eq!(
            result.ancestors.iter().map(|a| a.depth).collect::<Vec<_>>(),
            [1, 1, 2, 2]
        );
        assert!(result.ancestors.last().unwrap().repeated);
        assert!(!result.ancestors.last().unwrap().cycle);
        assert!(result.ancestry_complete);
        assert!(!result.ancestry_truncated);
        assert_eq!(
            result.ancestors[0].source_file,
            "Resources/Prototypes/A.yml"
        );
        assert_eq!(
            result.ancestors[0].definition_file.as_deref(),
            Some("Resources/Prototypes/B.yml")
        );
    }

    #[test]
    fn ancestry_partial_sources_are_visible_but_not_definitive() {
        let definitions = vec![
            declaration("entity", "Base", &[], "normal"),
            declaration("entity", "Extra", &[], "normal"),
            declaration("entity", "A", &["Base"], "normal"),
            declaration("entity", "A", &["Extra"], "configured_partial"),
            declaration("entity", "Base", &["Extra"], "tagged_partial"),
        ];
        let (graph, index) = build(&definitions, &[]);
        let result = graph
            .relations("entity", "A", &definitions, &index)
            .unwrap();
        assert_eq!(result.ancestors.len(), 3);
        assert_eq!(result.ancestors[0].id, "Base");
        assert_eq!(result.ancestors[0].partial_sources, 1);
        assert_eq!(result.ancestors[1].source_mode, "configured_partial");
        assert_eq!(result.ancestors[2].source_mode, "tagged_partial");
        assert!(!result.ancestry_complete);
        assert!(!result.ancestry_truncated);
    }

    #[test]
    fn ancestry_stops_at_missing_ambiguous_and_tagged_edges() {
        let mut tagged = declaration("entity", "Root", &["Hidden"], "normal");
        tagged.parent_tag = Some("type:Something".into());
        let definitions = vec![
            tagged,
            declaration(
                "entity",
                "Root",
                &["Ambig", "Missing"],
                "configured_partial",
            ),
            declaration("entity", "Hidden", &["NotReached"], "normal"),
            declaration("entity", "Ambig", &["NotReached"], "normal"),
            declaration("entity", "Ambig", &[], "normal"),
        ];
        let (graph, index) = build(&definitions, &[]);
        let result = graph
            .relations("entity", "Root", &definitions, &index)
            .unwrap();
        assert_eq!(result.ancestors.len(), 3);
        assert_eq!(result.ancestors[0].status, "tagged");
        assert_eq!(result.ancestors[1].status, "ambiguous");
        assert_eq!(result.ancestors[2].status, "not_indexed");
        assert!(!result.ancestry_complete);
    }

    #[test]
    fn ambiguous_root_lists_its_edges_without_resolving_grandparents() {
        let definitions = vec![
            declaration("entity", "Root", &["First"], "normal"),
            declaration("entity", "Root", &["Second"], "normal"),
            declaration("entity", "First", &["Grandparent"], "normal"),
            declaration("entity", "Second", &["Grandparent"], "normal"),
            declaration("entity", "Grandparent", &[], "normal"),
        ];
        let (graph, index) = build(&definitions, &[]);
        let result = graph
            .relations("entity", "Root", &definitions, &index)
            .unwrap();
        assert_eq!(result.ancestors.len(), 2);
        assert!(result.ancestors.iter().all(|step| step.depth == 1));
        assert!(!result.ancestry_complete);
        assert!(!result.ancestry_truncated);
    }

    #[test]
    fn ancestry_cycles_and_deep_chains_are_bounded() {
        let cyclic = vec![
            declaration("entity", "A", &["B"], "normal"),
            declaration("entity", "B", &["A"], "normal"),
        ];
        let (graph, index) = build(&cyclic, &[]);
        let result = graph.relations("entity", "A", &cyclic, &index).unwrap();
        assert_eq!(result.ancestors.len(), 2);
        assert!(result.ancestors[1].cycle);
        assert!(!result.ancestry_complete);

        // Distinct valid identities on a long chain, no recursion or unbounded IPC.
        let mut chain = Vec::new();
        for i in 0..500 {
            let mut node = declaration("entity", &format!("N{i}"), &[], "normal");
            if i < 499 {
                node.parents.push(format!("N{}", i + 1));
            }
            chain.push(node);
        }
        let (graph, index) = build(&chain, &[]);
        let result = graph.relations("entity", "N0", &chain, &index).unwrap();
        assert_eq!(result.ancestors.len(), MAX_ANCESTRY_DEPTH);
        assert!(result.ancestry_truncated);
        assert!(!result.ancestry_complete);
    }

    #[test]
    fn ancestry_reports_incomplete_catalog_without_claiming_resolution() {
        let definitions = vec![
            declaration("entity", "A", &["B"], "normal"),
            declaration("entity", "B", &[], "normal"),
        ];
        let issues = vec![PrototypeDiagnostic {
            code: "SOURCE_NOT_READABLE",
            file: "unavailable.yml".into(),
            line: 0,
            message: "not readable".into(),
        }];
        let (graph, index) = build(&definitions, &issues);
        let result = graph
            .relations("entity", "A", &definitions, &index)
            .unwrap();
        assert_eq!(result.ancestors.len(), 1);
        assert!(!result.ancestry_complete);
    }

    #[test]
    fn details_are_paginated_in_memory_without_huge_ipc_payloads() {
        let mut declarations = vec![declaration("entity", "Root", &[], "normal")];
        for i in 0..200 {
            declarations.push(declaration(
                "entity",
                &format!("Child{i}"),
                &["Root"],
                "normal",
            ));
        }
        let (graph, index) = build(&declarations, &[]);
        let root = graph
            .relations("entity", "Root", &declarations, &index)
            .unwrap();
        assert_eq!(root.child_total, 200);
        assert_eq!(root.children.len(), MAX_LINKS);
    }
}

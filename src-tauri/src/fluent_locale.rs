//! Read-only, bounded Fluent symbol index within one locale.
//!
//! This does not attempt to emulate SS14 runtime fallback or resource layering.
//! The official Fluent AST determines identities and references; source lines
//! are used only to locate the owning top-level declaration in the editor.
use std::collections::HashMap;

use fluent_syntax::{ast, parser};
use serde::Serialize;

const MAX_ISSUES: usize = 100;
pub const MAX_LOCALE_FILES: usize = 4_096;
pub const MAX_LOCALE_BYTES: usize = 64 * 1024 * 1024;

#[derive(Debug, Clone)]
pub struct Definition {
    id: String,
    file: String,
    line: usize,
    attributes: Vec<String>,
    has_value: bool,
}

#[derive(Debug, Clone)]
struct Reference {
    target: String,
    attribute: Option<String>,
    owner: String,
    line: usize,
}

#[derive(Debug, Clone)]
pub struct FileSymbols {
    pub file: String,
    definitions: Vec<Definition>,
    references: Vec<Reference>,
    pub has_syntax_errors: bool,
}

#[derive(Debug)]
pub struct LocaleSnapshot {
    pub locale: String,
    pub files: Vec<FileSymbols>,
    pub warnings: Vec<String>,
    pub complete: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct LocaleIssue {
    pub code: &'static str,
    pub line: usize,
    pub symbol: String,
    pub message: String,
    pub related_file: Option<String>,
    pub related_line: Option<usize>,
}

#[derive(Debug, Serialize)]
pub struct FluentInspection {
    pub syntax: crate::fluent_diagnostics::FluentAnalysis,
    pub locale: LocaleAnalysis,
}

#[derive(Debug, Serialize)]
pub struct LocaleAnalysis {
    pub locale: String,
    pub file_count: usize,
    pub declaration_count: usize,
    pub reference_count: usize,
    pub complete: bool,
    pub warnings: Vec<String>,
    pub issue_count: usize,
    pub truncated: bool,
    pub issues: Vec<LocaleIssue>,
}

pub fn locale_of(path: &str) -> Option<&str> {
    let after = path.strip_prefix("Resources/Locale/")?;
    let (locale, rest) = after.split_once('/')?;
    if locale.is_empty() || rest.is_empty() || !rest.to_ascii_lowercase().ends_with(".ftl") {
        return None;
    }
    Some(locale)
}

pub fn belongs_to_locale(path: &str, locale: &str) -> bool {
    locale_of(path) == Some(locale)
}

fn declaration_lines(source: &str) -> HashMap<&str, Vec<usize>> {
    let mut result: HashMap<&str, Vec<usize>> = HashMap::new();
    for (index, raw) in source.lines().enumerate() {
        // Fluent top-level messages/terms start in column one. Indented
        // attributes or pattern contents must not become declarations.
        if raw.starts_with(char::is_whitespace) || raw.starts_with('#') {
            continue;
        }
        if let Some((head, _)) = raw.split_once('=') {
            let id = head.trim_end();
            if !id.is_empty() {
                result.entry(id).or_default().push(index + 1);
            }
        }
    }
    result
}

fn take_line<'a>(
    id: &str,
    positions: &HashMap<&'a str, Vec<usize>>,
    seen: &mut HashMap<String, usize>,
) -> usize {
    let index = seen.entry(id.to_string()).or_default();
    let line = positions
        .get(id)
        .and_then(|locations| locations.get(*index))
        .copied()
        .unwrap_or(1);
    *index += 1;
    line
}

fn walk_pattern(pattern: &ast::Pattern<&str>, owner: &str, line: usize, refs: &mut Vec<Reference>) {
    for item in &pattern.elements {
        if let ast::PatternElement::Placeable { expression } = item {
            walk_expression(expression, owner, line, refs);
        }
    }
}

fn walk_expression(
    expression: &ast::Expression<&str>,
    owner: &str,
    line: usize,
    refs: &mut Vec<Reference>,
) {
    match expression {
        ast::Expression::Inline(inline) => walk_inline(inline, owner, line, refs),
        ast::Expression::Select { selector, variants } => {
            walk_inline(selector, owner, line, refs);
            for variant in variants {
                walk_pattern(&variant.value, owner, line, refs);
            }
        }
    }
}

fn walk_inline(inline: &ast::InlineExpression<&str>, owner: &str, line: usize, refs: &mut Vec<Reference>) {
    match inline {
        ast::InlineExpression::MessageReference { id, attribute } => {
            refs.push(Reference {
                target: id.name.to_string(),
                attribute: attribute.as_ref().map(|attribute| attribute.name.to_string()),
                owner: owner.into(),
                line,
            });
        }
        ast::InlineExpression::TermReference { id, attribute, arguments } => {
            refs.push(Reference {
                target: format!("-{}", id.name),
                attribute: attribute.as_ref().map(|attribute| attribute.name.to_string()),
                owner: owner.into(),
                line,
            });
            if let Some(arguments) = arguments {
                for value in &arguments.positional {
                    walk_inline(value, owner, line, refs);
                }
            }
        }
        ast::InlineExpression::FunctionReference { arguments, .. } => {
            for value in &arguments.positional {
                walk_inline(value, owner, line, refs);
            }
        }
        ast::InlineExpression::Placeable { expression } => {
            walk_expression(expression, owner, line, refs);
        }
        ast::InlineExpression::StringLiteral { .. }
        | ast::InlineExpression::NumberLiteral { .. }
        | ast::InlineExpression::VariableReference { .. } => {}
    }
}

pub fn scan_file(file: &str, source: &str) -> FileSymbols {
    let (ast, has_syntax_errors) = match parser::parse(source) {
        Ok(ast) => (ast, false),
        Err((ast, _)) => (ast, true),
    };
    let positions = declaration_lines(source);
    let mut seen = HashMap::new();
    let mut definitions = Vec::new();
    let mut references = Vec::new();

    for entry in ast.body {
        match entry {
            ast::Entry::Message(message) => {
                let id = message.id.name;
                let line = take_line(id, &positions, &mut seen);
                definitions.push(Definition {
                    id: id.into(),
                    file: file.into(),
                    line,
                    attributes: message.attributes.iter()
                        .map(|attribute| attribute.id.name.to_string()).collect(),
                    has_value: message.value.is_some(),
                });
                if let Some(value) = &message.value {
                    walk_pattern(value, id, line, &mut references);
                }
                for attribute in &message.attributes {
                    walk_pattern(&attribute.value, id, line, &mut references);
                }
            }
            ast::Entry::Term(term) => {
                let id = format!("-{}", term.id.name);
                let line = take_line(&id, &positions, &mut seen);
                definitions.push(Definition {
                    id: id.clone(),
                    file: file.into(),
                    line,
                    attributes: term.attributes.iter()
                        .map(|attribute| attribute.id.name.to_string()).collect(),
                    has_value: true,
                });
                walk_pattern(&term.value, &id, line, &mut references);
                for attribute in &term.attributes {
                    walk_pattern(&attribute.value, &id, line, &mut references);
                }
            }
            _ => {}
        }
    }

    FileSymbols {
        file: file.into(),
        definitions,
        references,
        has_syntax_errors,
    }
}

impl LocaleSnapshot {
    pub fn new(locale: &str, files: Vec<FileSymbols>, warnings: Vec<String>, complete: bool) -> Self {
        Self {
            locale: locale.into(),
            files,
            warnings,
            complete,
        }
    }

    /// Overrides the cached disk version of the active file with the current
    /// unsaved editor text. Results never modify the resource index or disk.
    pub fn inspect(&self, active_path: &str, active_source: &str) -> LocaleAnalysis {
        let active = scan_file(active_path, active_source);
        let mut complete = self.complete && !active.has_syntax_errors;
        let mut warnings = self.warnings.clone();
        let mut symbols: HashMap<&str, Vec<&Definition>> = HashMap::new();

        for file in &self.files {
            if file.file == active_path {
                continue;
            }
            if file.has_syntax_errors {
                complete = false;
            }
            for symbol in &file.definitions {
                symbols.entry(&symbol.id).or_default().push(symbol);
            }
        }
        for symbol in &active.definitions {
            symbols.entry(&symbol.id).or_default().push(symbol);
        }

        if !complete {
            warnings.push(
                "Проверка ссылок неполная: некоторые FTL недоступны или содержат синтаксические ошибки. Отсутствующие ссылки могут быть пропущены.".into(),
            );
        }

        let mut issues = Vec::new();
        let mut issue_count = 0;
        let mut push_issue = |issue: LocaleIssue| {
            issue_count += 1;
            if issues.len() < MAX_ISSUES {
                issues.push(issue);
            }
        };

        for symbol in &active.definitions {
            if let Some(duplicates) = symbols.get(symbol.id.as_str()) {
                if duplicates.len() > 1 {
                    let original = duplicates.iter().find(|candidate|
                        candidate.file != symbol.file || candidate.line != symbol.line
                    );
                    push_issue(LocaleIssue {
                        code: "FTL_DUPLICATE_KEY",
                        line: symbol.line,
                        symbol: symbol.id.clone(),
                        message: format!(
                            "Ключ «{}» объявлен {} раз в локали {}.",
                            symbol.id,
                            duplicates.len(),
                            self.locale,
                        ),
                        related_file: original.map(|entry| entry.file.clone()),
                        related_line: original.map(|entry| entry.line),
                    });
                }
            }
        }

        if complete {
            for reference in &active.references {
                match symbols.get(reference.target.as_str()) {
                    None => push_issue(LocaleIssue {
                        code: "FTL_REFERENCE_MISSING",
                        line: reference.line,
                        symbol: reference.target.clone(),
                        message: format!(
                            "Объявление «{}» ссылается на отсутствующий ключ «{}».",
                            reference.owner, reference.target,
                        ),
                        related_file: None,
                        related_line: None,
                    }),
                    Some(definitions) if definitions.len() == 1 => {
                        let target = definitions[0];
                        if let Some(attribute) = &reference.attribute {
                            if !target.attributes.contains(attribute) {
                                push_issue(LocaleIssue {
                                    code: "FTL_ATTRIBUTE_MISSING",
                                    line: reference.line,
                                    symbol: format!("{}.{}", reference.target, attribute),
                                    message: format!(
                                        "У ключа «{}» нет атрибута «.{}».",
                                        reference.target, attribute,
                                    ),
                                    related_file: Some(target.file.clone()),
                                    related_line: Some(target.line),
                                });
                            }
                        } else if !target.has_value {
                            push_issue(LocaleIssue {
                                code: "FTL_VALUE_MISSING",
                                line: reference.line,
                                symbol: reference.target.clone(),
                                message: format!(
                                    "У ключа «{}» нет основного значения; ссылка должна указывать на атрибут.",
                                    reference.target,
                                ),
                                related_file: Some(target.file.clone()),
                                related_line: Some(target.line),
                            });
                        }
                    }
                    Some(_) => {
                        // Ambiguity is already reported on the owning key if
                        // defined in this file. Do not guess which duplicate
                        // the runtime resolves when reference is elsewhere.
                    }
                }
            }
        }

        LocaleAnalysis {
            locale: self.locale.clone(),
            file_count: self.files.len(),
            declaration_count: symbols.values().map(Vec::len).sum(),
            reference_count: active.references.len(),
            complete,
            warnings,
            issue_count,
            truncated: issue_count > MAX_ISSUES,
            issues,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(files: &[(&str, &str)]) -> LocaleSnapshot {
        let scanned = files.iter().map(|(path, source)| scan_file(path, source)).collect();
        LocaleSnapshot::new("en-US", scanned, Vec::new(), true)
    }

    const FIRST: &str = "Resources/Locale/en-US/first.ftl";
    const SECOND: &str = "Resources/Locale/en-US/second.ftl";

    #[test]
    fn recognizes_locale_without_leaking_across_language_boundaries() {
        assert_eq!(locale_of(FIRST), Some("en-US"));
        assert_eq!(locale_of("Resources/Locale/ru-RU/a.ftl"), Some("ru-RU"));
        assert_eq!(locale_of("Resources/Locale/en-US"), None);
        assert!(!belongs_to_locale("Resources/Locale/en-US-extra/one.ftl", "en-US"));
    }

    #[test]
    fn resolves_message_term_attribute_and_selector_references() {
        let definitions = "thing = Item\n    .name = Name\n-brand = Brand\n";
        let active = "item = { thing.name } — { -brand }\nquantity = { $count ->\n    [one] { thing }\n   *[other] { thing.name }\n}\n";
        let index = fixture(&[(FIRST, definitions), (SECOND, active)]);
        let analysis = index.inspect(SECOND, active);
        assert!(analysis.complete);
        assert_eq!(analysis.reference_count, 4);
        assert!(analysis.issues.is_empty());
    }

    #[test]
    fn overlays_dirty_draft_without_using_stale_disk_definitions() {
        let index = fixture(&[(FIRST, "old = Value\n"), (SECOND, "use = { old }\n")]);
        let result = index.inspect(FIRST, "new = { missing }\n");
        assert_eq!(result.issue_count, 1);
        assert_eq!(result.issues[0].code, "FTL_REFERENCE_MISSING");
        let result = index.inspect(SECOND, "use = { old }\n");
        assert!(result.issues.is_empty(), "Disk versions should remain cached until a save invalidates the index");
    }

    #[test]
    fn detects_duplicate_keys_across_files_and_within_one_file() {
        let index = fixture(&[(FIRST, "same = One\n"), (SECOND, "same = Two\nsame = Three\n")]);
        let report = index.inspect(SECOND, "same = Two\nsame = Three\n");
        assert_eq!(report.issue_count, 2);
        assert_eq!(report.issues[0].code, "FTL_DUPLICATE_KEY");
        assert_eq!(report.issues[0].line, 1);
        assert_eq!(report.issues[0].related_file.as_deref(), Some(FIRST));
        assert_eq!(report.issues[1].line, 2);
    }

    #[test]
    fn catches_missing_references_and_missing_attributes_but_not_variables() {
        let index = fixture(&[(FIRST, "target = Value\nattrs =\n    .name = Name\n"), (SECOND, "")]);
        let active = "new = { absent } { target.bad } { attrs } { $runtimeVar }\n";
        let report = index.inspect(SECOND, active);
        assert_eq!(report.issue_count, 3);
        assert_eq!(report.issues[0].code, "FTL_REFERENCE_MISSING");
        assert_eq!(report.issues[1].code, "FTL_ATTRIBUTE_MISSING");
        assert_eq!(report.issues[2].code, "FTL_VALUE_MISSING");
    }

    #[test]
    fn incomplete_scans_never_claim_a_reference_is_missing() {
        let index = LocaleSnapshot::new("en-US", vec![scan_file(FIRST, "foo = ok\n")],
            vec!["Unreadable file".into()], false);
        let report = index.inspect(FIRST, "foo = { external }\n");
        assert!(!report.complete);
        assert_eq!(report.issue_count, 0);
        assert!(!report.warnings.is_empty());
    }

    #[test]
    fn ignores_fake_references_in_comments_and_plain_text() {
        let source = "# { absent }\nfoo = literal { not a literal! }\n";
        let file = scan_file(FIRST, source);
        assert!(file.has_syntax_errors);
        let index = fixture(&[(SECOND, "exists = ok\n")]);
        let report = index.inspect(FIRST, "# { absent }\nfoo = literal absent\n");
        assert_eq!(report.issue_count, 0);
    }
}

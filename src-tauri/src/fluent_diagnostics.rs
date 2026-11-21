//! Read-only Fluent syntax diagnostics for the live editor buffer.
//!
//! The parser recovers after malformed entries; the source is never rewritten.
//! Byte offsets returned by fluent-syntax are converted to 1-based Unicode
//! character columns for Monaco (which will convert to UTF-16 if necessary).
use fluent_syntax::{ast, parser};
use serde::Serialize;

use crate::error::StudioError;
use crate::resource_edit::MAX_TEXT_BYTES;

const MAX_DIAGNOSTICS: usize = 100;

#[derive(Debug, Clone, Serialize)]
pub struct FluentDiagnostic {
    pub code: &'static str,
    pub message: String,
    pub details: String,
    pub line: usize,
    pub column: usize,
    pub end_line: usize,
    pub end_column: usize,
}

#[derive(Debug, Serialize)]
pub struct FluentAnalysis {
    pub entry_count: usize,
    pub diagnostic_count: usize,
    pub truncated: bool,
    pub diagnostics: Vec<FluentDiagnostic>,
}

fn line_starts(source: &str) -> Vec<usize> {
    std::iter::once(0)
        .chain(
            source
                .as_bytes()
                .iter()
                .enumerate()
                .filter_map(|(index, byte)| (*byte == b'\n').then_some(index + 1)),
        )
        .collect()
}

/// Character columns are user-facing: byte-based offsets would point
/// into the middle of Cyrillic/emoji text.
fn location(source: &str, starts: &[usize], byte: usize) -> (usize, usize) {
    let mut offset = byte.min(source.len());
    while !source.is_char_boundary(offset) {
        offset -= 1;
    }
    let line = starts.partition_point(|&start| start <= offset).max(1);
    let column = source[starts[line - 1]..offset].chars().count() + 1;
    (line, column)
}

fn message(kind: &parser::ErrorKind) -> &'static str {
    use parser::ErrorKind;
    match kind {
        ErrorKind::ExpectedToken(_) | ErrorKind::ExpectedCharRange { .. } => {
            "Неожиданный символ или отсутствует обязательный разделитель Fluent."
        }
        ErrorKind::ExpectedMessageField { .. } | ErrorKind::ExpectedTermField { .. } => {
            "В сообщении или термине отсутствует обязательное поле."
        }
        ErrorKind::MissingValue => "Ожидалось значение сообщения или выражения.",
        ErrorKind::UnterminatedStringLiteral => "Строка не закрыта кавычкой.",
        ErrorKind::UnbalancedClosingBrace => "Лишняя закрывающая фигурная скобка.",
        ErrorKind::MissingDefaultVariant => "В выражении выбора отсутствует вариант по умолчанию (*).",
        ErrorKind::MultipleDefaultVariants => "У выражения выбора несколько вариантов по умолчанию (*).",
        ErrorKind::UnknownEscapeSequence(_) | ErrorKind::InvalidUnicodeEscapeSequence(_) => {
            "Недопустимая escape-последовательность."
        }
        ErrorKind::DuplicatedNamedArgument(_) => "Аргумент функции указан несколько раз.",
        ErrorKind::PositionalArgumentFollowsNamed => {
            "Позиционный аргумент не может следовать за именованным."
        }
        _ => "Синтаксическая ошибка Fluent.",
    }
}

pub fn analyze(source: &str) -> Result<FluentAnalysis, StudioError> {
    if source.len() as u64 > MAX_TEXT_BYTES {
        return Err(StudioError::new(
            "FTL_DIAGNOSTICS_TOO_LARGE",
            "Файл слишком большой для синтаксической проверки Fluent.",
            "Сократите файл до 4 МиБ или проверьте его внешним инструментом. Черновик не изменён.",
        ));
    }

    let (resource, errors) = match parser::parse(source) {
        Ok(resource) => (resource, Vec::new()),
        Err((resource, errors)) => (resource, errors),
    };
    let entry_count = resource
        .body
        .iter()
        .filter(|entry| matches!(entry, ast::Entry::Message(_) | ast::Entry::Term(_)))
        .count();
    let starts = line_starts(source);
    let diagnostic_count = errors.len();
    let diagnostics = errors
        .into_iter()
        .take(MAX_DIAGNOSTICS)
        .map(|error| {
            let (line, column) = location(source, &starts, error.pos.start);
            let (end_line, end_column) =
                location(source, &starts, error.pos.end.max(error.pos.start.saturating_add(1)));
            FluentDiagnostic {
                code: "FTL_SYNTAX",
                message: message(&error.kind).into(),
                details: error.to_string(),
                line,
                column,
                end_line,
                end_column,
            }
        })
        .collect();

    Ok(FluentAnalysis {
        entry_count,
        diagnostic_count,
        truncated: diagnostic_count > MAX_DIAGNOSTICS,
        diagnostics,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_real_fluent_constructs_and_keeps_unicode() {
        let source = "# Comment\nhello-world = Привет, { $user }!\n    .description = Описание\n\n-brand = Марка\nitems = { $count ->\n    [one] One\n   *[other] Many\n}\n";
        let result = analyze(source).unwrap();
        assert_eq!(result.diagnostic_count, 0);
        assert_eq!(result.entry_count, 3);
        assert!(result.diagnostics.is_empty());
    }

    #[test]
    fn recovers_from_malformed_entry_and_reports_correct_line() {
        let source = "valid = Привет\r\nbad@message = Broken\r\nnext = Works\r\n";
        let result = analyze(source).unwrap();
        assert!(result.diagnostic_count > 0);
        assert_eq!(result.diagnostics[0].line, 2);
        assert_eq!(result.diagnostics[0].code, "FTL_SYNTAX");
        assert!(result.diagnostics[0].column >= 1);
        assert_eq!(result.entry_count, 2);
    }

    #[test]
    fn uses_character_columns_instead_of_utf8_byte_offsets() {
        let source = "name = Привет\nnext = value\n";
        let starts = line_starts(source);
        let byte = source.find("вет").unwrap();
        assert_eq!(location(source, &starts, byte), (1, 11));
        assert_eq!(location(source, &starts, source.find("next").unwrap()), (2, 1));
    }

    #[test]
    fn safely_clamps_invalid_positions_and_handles_crlf() {
        let source = "first = One\r\nsecond = Two\r\n";
        let starts = line_starts(source);
        assert_eq!(location(source, &starts, usize::MAX), (3, 1));
        assert_eq!(location(source, &starts, 0), (1, 1));
    }

    #[test]
    fn rejects_oversized_buffer_without_mutation() {
        let source = "a".repeat(MAX_TEXT_BYTES as usize + 1);
        assert_eq!(analyze(&source).unwrap_err().code, "FTL_DIAGNOSTICS_TOO_LARGE");
    }
}

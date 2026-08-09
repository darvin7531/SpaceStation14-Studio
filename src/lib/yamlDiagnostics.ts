import { parseDocument } from 'yaml';

export interface YamlDiagnostic {
  level: 'error';
  line: number;
  column: number;
  message: string;
  hint: string;
}

export function parseYamlDiagnostics(text: string): YamlDiagnostic[] {
  const document = parseDocument(String(text ?? ''));
  return document.errors.map((error) => {
    const location = error.linePos?.[0];
    const message = error.message.split('\n')[0].replace(/ at line \d+, column \d+:?$/i, '');
    return {
      level: 'error',
      line: location?.line ?? 1,
      column: location?.col ?? 1,
      message,
      hint: yamlErrorHint(error.message),
    };
  });
}

function yamlErrorHint(message: string) {
  if (/end with a \]/i.test(message)) return 'Закройте последовательность символом ].';
  if (/end with a \}/i.test(message)) return 'Закройте объект символом }.';
  if (/map keys need to be followed by map values|implicit map keys/i.test(message)) return 'После имени поля поставьте двоеточие (:), затем значение.';
  if (/indent/i.test(message)) return 'Проверьте отступы: вложенные поля должны иметь одинаковый уровень отступа.';
  if (/unexpected.*token|unexpected.*character/i.test(message)) return 'Проверьте символ рядом с указанной позицией и кавычки в значениях.';
  return 'Исправьте YAML возле указанной строки и проверьте отступы, двоеточия и парные скобки.';
}

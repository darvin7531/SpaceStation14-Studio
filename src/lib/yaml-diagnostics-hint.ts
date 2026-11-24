// ponytail: generic guidance only; add parser-specific hints when their diagnostics are verified.
export function yamlSyntaxHint(valid: boolean): string | null {
  return valid ? null : 'Исправьте YAML возле указанной строки и проверьте отступы, двоеточия и парные скобки.';
}

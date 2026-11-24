import { uiText, type Language, type UIKey } from './ui-language';

export function yamlSyntaxHint(valid: boolean, message: string | null, language: Language): string | null {
  if (valid) return null;
  // ponytail: yaml-rust2's text is the only classification available; unknown messages use generic guidance.
  let key: UIKey = 'yamlDiagnostics.hintGeneric';
  if (message === "while parsing a flow sequence, expected ',' or ']'") key = 'yamlDiagnostics.hintSequence';
  else if (message === "while parsing a flow mapping, did not find expected ',' or '}'") key = 'yamlDiagnostics.hintMapping';
  else if (message === 'mapping values are not allowed in this context') key = 'yamlDiagnostics.hintValue';
  else if (message && /indentation|tabs disallowed|tab cannot be used as indentation/.test(message)) key = 'yamlDiagnostics.hintIndent';
  else if (message?.startsWith('unexpected character:')) key = 'yamlDiagnostics.hintCharacter';
  return uiText(language, key);
}

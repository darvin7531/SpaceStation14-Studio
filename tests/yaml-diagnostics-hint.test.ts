import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '../src/i18n';
import YamlDiagnosticsPanel, { YamlDiagnosticResult } from '../src/components/YamlDiagnosticsPanel';
import { yamlSyntaxHint } from '../src/lib/yaml-diagnostics-hint';

test('parser messages get conservative, localized repair guidance', () => {
  assert.equal(yamlSyntaxHint(true, null, 'en'), null);
  for (const [message, expected] of [
    ["while parsing a flow sequence, expected ',' or ']'", /comma.*\]/i],
    ["while parsing a flow mapping, did not find expected ',' or '}'", /comma.*}/i],
    ['mapping values are not allowed in this context', /colon/i],
    ['invalid indentation in flow construct', /indent/i],
    ["unexpected character: `@'", /character/i],
  ] as const) assert.match(yamlSyntaxHint(false, message, 'en') ?? '', expected);
  assert.match(yamlSyntaxHint(false, 'unknown error', 'ru') ?? '', /отступы, двоеточия и парные скобки/);
  assert.match(yamlSyntaxHint(false, 'while scanning a quoted scalar, found unexpected end of stream', 'en') ?? '', /indentation, colons/);
});

test('diagnostic result displays localized guidance, position and raw parser message', () => {
  for (const language of ['en', 'ru'] as const) {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { localStorage: { getItem: () => language } } });
    try {
      const report = { valid: false, line: 2, column: 3, message: "while parsing a flow sequence, expected ',' or ']'" };
      const html = renderToStaticMarkup(createElement(I18nProvider, { children: createElement(YamlDiagnosticResult, { report, onRevealLine: () => {} }) }));
      assert.match(html, /2:3/);
      assert.match(html, /while parsing a flow sequence/);
      assert.match(html, language === 'en' ? /How to fix/ : /Как исправить/);
      assert.match(html, language === 'en' ? /comma/ : /запят/);
      const panel = renderToStaticMarkup(createElement(I18nProvider, { children: createElement(YamlDiagnosticsPanel, {
        path: 'test.yml', source: '', enabled: false, delayMs: 0, onRevealLine: () => {},
      }) }));
      assert.match(panel, language === 'en' ? /YAML diagnostics/ : /Проверка YAML/);
      assert.match(panel, language === 'en' ? /Check now/ : /Проверить сейчас/);
    } finally { Reflect.deleteProperty(globalThis, 'window'); }
  }
});

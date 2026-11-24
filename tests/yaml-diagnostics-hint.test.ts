import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '../src/i18n';
import YamlDiagnosticsPanel, { YamlDiagnosticResult, YamlAnalysisFailure } from '../src/components/YamlDiagnosticsPanel';
import { yamlSyntaxHint } from '../src/lib/yaml-diagnostics-hint';

test('analysis failures retain localized actionable guidance without exposing unknown private data', () => {
  const error = { code: 'YAML_ANALYSIS_SIZE_LIMIT', message: 'Черновик превышает лимит 4 МиБ.', hint: 'Уменьшите файл.' };
  for (const language of ['en', 'ru'] as const) {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { localStorage: { getItem: () => language } } });
    try {
      const render = (failure: typeof error) => renderToStaticMarkup(createElement(I18nProvider, { children: createElement(YamlAnalysisFailure, { failure }) }));
      assert.match(render(error), language === 'en' ? /4 MiB.*external editor/ : /4 МиБ.*Уменьшите/);
      if (language === 'en') {
        assert.match(render({ ...error, code: 'YAML_NOT_INDEXED' }), /index.*refresh/i);
        const unknown = render({ code: 'UNKNOWN', message: 'private path', hint: 'private content' });
        assert.doesNotMatch(unknown, /private/);
        assert.match(unknown, /Could not check YAML/);
      }
    } finally { Reflect.deleteProperty(globalThis, 'window'); }
  }
});

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

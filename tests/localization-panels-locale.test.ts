import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '../src/i18n';
import PrototypeLocalizationPanel from '../src/components/PrototypeLocalizationPanel';
import FluentDiagnosticsPanel from '../src/components/FluentDiagnosticsPanel';
import { uiText } from '../src/lib/ui-language';

function render(language: 'en' | 'ru', enabled: boolean) {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { localStorage: { getItem: () => language } } });
  try {
    const diagnostics = renderToStaticMarkup(createElement(I18nProvider, { children: createElement(FluentDiagnosticsPanel, {
      path: 'Resources/Locale/en-US/a.ftl', source: 'hello = Hello', enabled, delayMs: 100,
      onRevealLine: () => {}, onRevealSource: () => {},
    }) }));
    const prototype = renderToStaticMarkup(createElement(I18nProvider, { children: createElement(PrototypeLocalizationPanel, {
      projectRoot: '/project', locator: { id: 'Example', file: 'a.yml', kind: 'entity', document_index: 0, item_index: 0, mode: 'normal' },
      source: '', busy: false, requiredLocales: ['en-US'], onCreateMissing: () => {},
      onCreateBatch: async () => { throw new Error('not called'); }, onApply: async () => true, onClose: () => {},
    }) }));
    return { diagnostics, prototype };
  } finally { Reflect.deleteProperty(globalThis, 'window'); }
}

test('panels localize accessible labels, manual controls and loading states', () => {
  const en = render('en', false); const ru = render('ru', false);
  assert.match(en.diagnostics, /aria-label="Fluent diagnostics"/);
  assert.match(en.diagnostics, /Check now/);
  assert.match(ru.diagnostics, /aria-label="Диагностика Fluent"/);
  assert.match(ru.diagnostics, /Проверить сейчас/);
  assert.match(en.prototype, /aria-label="Localization Example"/);
  assert.match(ru.prototype, /aria-label="Закрыть"/);
  assert.match(render('en', true).diagnostics, /Checking the current version/);
  assert.match(ru.prototype, /Проверка YAML/);
});

test('dynamic status messages retain paths, counts and locale identifiers', () => {
  assert.equal(uiText('en', 'entityLocale.duplicate', { path: 'a.ftl', line: 12 }), 'Fluent ID is already declared in a.ftl:12. Select that file instead of creating a duplicate.');
  assert.match(uiText('ru', 'entityLocale.partial', { count: 2 }), /2/);
  assert.equal(uiText('en', 'fluentDiagnostics.issuesTruncated', { shown: 3, total: 8 }), 'Showing the first 3 of 8 issues.');
  assert.match(uiText('ru', 'fluentDiagnostics.localeHeading', { locale: 'en-US' }), /en-US/);
});

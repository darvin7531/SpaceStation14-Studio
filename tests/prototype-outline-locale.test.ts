import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import PrototypeOutlinePanel from '../src/components/PrototypeOutlinePanel';
import { I18nProvider } from '../src/i18n';
import { uiText } from '../src/lib/ui-language';

function render(language: 'ru' | 'en') {
  Object.defineProperty(globalThis, 'window', {
    configurable: true, value: { localStorage: { getItem: () => language } },
  });
  try {
    return renderToStaticMarkup(createElement(I18nProvider, {
      children: createElement(PrototypeOutlinePanel, {
        path: 'a.yml', source: 'draft', busy: false, onJump: () => {}, onEdit: () => {},
        onOpenRsi: () => {}, onOpenFtl: () => {}, requiredLocales: ['en-US'],
        liveValidation: true, validationDelay: 0, cursorLine: null, prototypeJump: null,
        workspaceKey: 'workspace', sourceDirty: true, onNavigatePrototype: () => {}, onOpenSource: () => {},
      }),
    }));
  } finally {
    Reflect.deleteProperty(globalThis, 'window');
  }
}

test('outline controls and accessible names follow the UI language', () => {
  assert.match(render('en'), /aria-label="Open YAML inspector"/);
  assert.match(render('en'), /placeholder="Find ID or type in file"/);
  assert.match(render('en'), /aria-label="Find a prototype in the current file"/);
  assert.match(render('ru'), /aria-label="Инспектор открытого YAML"/);
  assert.match(render('ru'), /placeholder="Найти ID или тип в файле"/);
});

test('outline states and dynamic details are localized', () => {
  assert.equal(uiText('en', 'outline.count', { count: 2 }), '2 declarations · draft');
  assert.equal(uiText('ru', 'outline.count', { count: 2 }), '2 объявлений · черновик');
  assert.match(uiText('en', 'outline.limit'), /256 declarations and 64 diagnostic messages/);
  assert.equal(uiText('ru', 'outline.loading'), 'Разбор YAML…');
  assert.equal(uiText('en', 'outline.failure', { message: 'Oops', code: 'E' }), 'Check failed: Oops [E]');
  assert.equal(uiText('ru', 'outline.openFtl', { locale: 'en-US', file: 'a.ftl' }), 'Открыть en-US · a.ftl');
  assert.equal(uiText('en', 'outline.dirty'), 'The YAML has unsaved changes. Relations and inheritance come from the saved project’s Rust index; save the draft to see current results.');
});

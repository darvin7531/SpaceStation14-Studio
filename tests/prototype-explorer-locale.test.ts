import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import PrototypeExplorer from '../src/components/PrototypeExplorer';
import { I18nProvider } from '../src/i18n';
import { uiText } from '../src/lib/ui-language';

function renderExplorer(language: 'ru' | 'en') {
  Object.defineProperty(globalThis, 'window', {
    configurable: true, value: { localStorage: { getItem: () => language } },
  });
  try {
    return renderToStaticMarkup(createElement(I18nProvider, {
      children: createElement(PrototypeExplorer, {
        workspaceKey: 'workspace', query: '', kind: '',
        onQueryChange: () => {}, onKindChange: () => {}, onOpen: () => {}, onEdit: () => {},
      }),
    }));
  } finally {
    Reflect.deleteProperty(globalThis, 'window');
  }
}

test('prototype explorer renders localized controls and accessibility labels', () => {
  const en = renderExplorer('en');
  const ru = renderExplorer('ru');
  assert.match(en, /aria-label="Prototype catalog mode"/);
  assert.match(en, /aria-label="Search prototypes by type, ID or file"/);
  assert.match(en, /aria-label="Next page"/);
  assert.match(en, /No prototype declarations match your search/);
  assert.match(ru, /aria-label="Режим каталога прототипов"/);
  assert.match(ru, /aria-label="Следующая страница"/);
  assert.match(ru, /По запросу нет объявлений прототипов/);
});

test('prototype explorer translates dynamic, loading and error text', () => {
  assert.equal(uiText('en', 'prototypeExplorer.loading'), 'Indexing YAML…');
  assert.equal(uiText('ru', 'prototypeExplorer.error'), 'Не удалось загрузить прототипы.');
  assert.equal(uiText('en', 'prototypeExplorer.relationsLabel', { kind: 'entity', id: 'Example' }),
    'Show relations for prototype entity:Example');
  assert.equal(uiText('ru', 'prototypeExplorer.range', { start: 1, end: 80, total: 100 }), '1–80 из 100');
  assert.equal(uiText('en', 'prototypeExplorer.range', { start: 1, end: 80, total: 100 }), '1–80 of 100');
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import PrototypeRelationsPanel from '../src/components/PrototypeRelationsPanel';
import { I18nProvider } from '../src/i18n';
import { uiText } from '../src/lib/ui-language';

function renderPanel(language: 'ru' | 'en') {
  Object.defineProperty(globalThis, 'window', {
    configurable: true, value: { localStorage: { getItem: () => language } },
  });
  try {
    return renderToStaticMarkup(createElement(I18nProvider, {
      children: createElement(PrototypeRelationsPanel, {
        selected: { kind: 'entity', id: 'Example' }, workspaceKey: 'workspace',
        onClose: () => {}, onNavigate: () => {}, onOpen: () => {},
      }),
    }));
  } finally {
    Reflect.deleteProperty(globalThis, 'window');
  }
}

test('relation panel localizes accessible names', () => {
  assert.match(renderPanel('en'), /aria-label="Relations entity:Example"/);
  assert.match(renderPanel('en'), /aria-label="Close relationship details"/);
  assert.match(renderPanel('ru'), /aria-label="Связи entity:Example"/);
  assert.match(renderPanel('ru'), /aria-label="Закрыть сведения о связях"/);
});

test('relation states, controls and interpolated details use the selected language', () => {
  assert.equal(uiText('en', 'relations.loading'), 'Loading relations from the Rust index…');
  assert.equal(uiText('ru', 'relations.status.not_indexed'), 'Нет в индексе');
  assert.equal(uiText('en', 'relations.status.ambiguous'), 'Multiple base declarations');
  assert.equal(uiText('en', 'relations.showSources'), 'Show field and component provenance');
  assert.equal(uiText('ru', 'relations.hidePartial'), 'Скрыть PartialPrototypes');
  assert.equal(uiText('en', 'relations.open', { file: 'a.yml', line: 3 }), 'Open a.yml:3');
  assert.equal(uiText('ru', 'relations.linksMore', { shown: 2, total: 5 }),
    'Показаны первые 2 ссылок из 5. Полный индекс остаётся в Rust.');
});

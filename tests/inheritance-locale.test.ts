import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import LinkedPrototypePanel from '../src/components/LinkedPrototypePanel';
import InheritancePreviewPanel from '../src/components/InheritancePreviewPanel';
import PrototypeParentsPanel from '../src/components/PrototypeParentsPanel';
import { I18nProvider } from '../src/i18n';
import { uiText } from '../src/lib/ui-language';

function render(language: 'ru' | 'en', child: ReactNode) {
  Object.defineProperty(globalThis, 'window', {
    configurable: true, value: { localStorage: { getItem: () => language } },
  });
  try {
    return renderToStaticMarkup(createElement(I18nProvider, { children: child }));
  } finally {
    Reflect.deleteProperty(globalThis, 'window');
  }
}

const props = { kind: 'entity', id: 'Example', workspaceKey: 'workspace', onNavigate: () => {} };

test('linked and inheritance loading states and accessible labels follow the language', () => {
  const linked = createElement(LinkedPrototypePanel, props);
  const inheritance = createElement(InheritancePreviewPanel, { ...props, onOpen: () => {} });
  assert.match(render('en', linked), /aria-label="Linked prototypes".*Searching fields and components/);
  assert.match(render('ru', linked), /aria-label="Связанные прототипы".*Ищу ссылки/);
  assert.match(render('en', inheritance), /aria-label="Structural inheritance with partials".*Resolving the ancestor chain/);
  assert.match(render('ru', inheritance), /aria-label="Структурное наследование с partial".*Разбираю цепочку/);
});

test('parent editor and interpolated report strings follow the language', () => {
  const panel = createElement(PrototypeParentsPanel, {
    locator: { kind: 'entity', id: 'Example', file: 'a.yml', document_index: 0, item_index: 0, mode: 'normal' },
    source: '', busy: false, onApply: () => true, onClose: () => {},
  });
  assert.match(render('en', panel), /aria-label="Parents entity:Example"/);
  assert.match(render('ru', panel), /aria-label="Закрыть редактор родителей"/);
  assert.equal(uiText('en', 'linked.navigate', { kind: 'entity', id: 'A' }), 'Go to entity:A');
  assert.equal(uiText('ru', 'inheritance.partials', { count: 2 }), 'Partial-объявлений применено во всей цепочке: 2.');
  assert.equal(uiText('en', 'parents.applied'), 'The parent list was changed in the YAML draft. Save the file with Ctrl+S.');
});

import assert from 'node:assert/strict';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '../src/i18n';
import RsiImportPanel from '../src/components/RsiImportPanel';
import RsiRenamePanel from '../src/components/RsiRenamePanel';
import test from 'node:test';
import { uiText } from '../src/lib/ui-language';
import { planRsiBatch } from '../src/lib/rsi-batch-plan';
import { buildRsiFrameLayout, parseRsiMetadata } from '../src/lib/rsi-layout';

test('RSI preview and bulk import labels, accessibility and outcomes follow UI language', () => {
  assert.equal(uiText('en', 'rsi.preview.label'), 'RSI preview');
  assert.equal(uiText('ru', 'rsi.preview.label'), 'Просмотр RSI');
  assert.equal(uiText('en', 'rsi.player.previous'), 'Previous frame');
  assert.equal(uiText('ru', 'rsi.bulk.dropLabel'), 'Пакетный импорт PNG');
  assert.equal(uiText('en', 'rsi.bulk.partial', { count: 1, total: 3, detail: 'IO_ERROR: disk full' }),
    'Imported 1 of 3 PNGs. Remaining files were not written: IO_ERROR: disk full');
  assert.match(uiText('ru', 'rsi.bulk.success', { count: 2, path: 'sprites/test.rsi' }), /2.*sprites\/test\.rsi/);
});

test('RSI validation is localized without losing filenames or technical details', () => {
  const png = { name: 'bad.png', bytes: 100, width: 33, height: 32 };
  assert.throws(() => planRsiBatch([png], { x: 32, y: 32 }, 1, new Set(), 'en'), /bad\.png.*32×32/);
  assert.throws(() => planRsiBatch([png], { x: 32, y: 32 }, 1, new Set(), 'ru'), /не кратен.*32×32/);
  assert.match(parseRsiMetadata('{', 'en').errors[0], /Cannot parse meta\.json: .+/);
  const state = { name: 'idle', directions: 1 as const, delays: [[1]] };
  assert.deepEqual(buildRsiFrameLayout({ x: 32, y: 32 }, state, 33, 32, 'en'),
    { error: 'PNG dimensions are not a multiple of frame size 32×32 from meta.json.' });
});


test('single import and rename safety messages interpolate without changing user names', () => {
  for (const language of ['en', 'ru'] as const) {
    assert.match(uiText(language, 'rsi.rename.warning', { name: 'idle_old' }), /idle_old/);
    assert.match(uiText(language, 'rsi.import.selected', { name: 'My Sprite.png', size: 8 }), /My Sprite\.png.*8/);
    assert.notEqual(uiText(language, 'rsi.import.dropLabel'), 'rsi.import.dropLabel');
    assert.notEqual(uiText(language, 'rsi.import.errorExtension'), 'rsi.import.errorExtension');
  }
  assert.match(uiText('en', 'rsi.rename.missingIntro'), /external writers/);
  assert.match(uiText('ru', 'rsi.rename.missingIntro'), /внешние процессы/);
});


test('single import and rename panels render English labels and safety warnings', () => {
  const previous = globalThis.window;
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { localStorage: { getItem: () => 'en' } } });
  try {
    const render = (node: ReactElement) => renderToStaticMarkup(createElement(I18nProvider, null, node));
    const imported = render(createElement(RsiImportPanel, { path: 'test.rsi', revision: 'rev', projectRoot: 'root', onImported: () => {}, onAttempt: () => {} }));
    assert.match(imported, /aria-label="Drop PNG to import"/);
    assert.match(imported, /Existing images and states are not overwritten/);
    const renamed = render(createElement(RsiRenamePanel, { path: 'test.rsi', revision: 'rev', name: 'idle', expectedMissingPng: true, onRenamed: () => {} }));
    assert.match(renamed, /Stop external writers/);
    assert.match(renamed, /not rewritten automatically/);
    assert.match(renamed, /Confirm: enter/);
  } finally {
    if (previous === undefined) Reflect.deleteProperty(globalThis, 'window');
    else Object.defineProperty(globalThis, 'window', { configurable: true, value: previous });
  }
});

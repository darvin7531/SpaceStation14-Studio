import assert from 'node:assert/strict';
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

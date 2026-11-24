import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import RsiTimingPanel from '../src/components/RsiTimingPanel';

test('metadata-only timing warns about external writes and limits regrouping', () => {
  const html = renderToStaticMarkup(createElement(RsiTimingPanel, {
    projectRoot: '/project', path: 'Resources/Textures/test.rsi', revision: 'a'.repeat(64),
    state: { name: 'idle', directions: 1, delays: [[0.1, 0.2, 0.3, 0.4]] },
    expectedMissingPng: true, onUpdated: () => {},
  }));
  assert.match(html, /PNG не проверяется и не изменяется/);
  assert.match(html, /внешние записи могут конкурировать/);
  assert.match(html, /восстановите архив вручную/);
  assert.match(html, /<option value="4">4<\/option>/);
  assert.match(html, /<option value="8" disabled="">8<\/option>/);
});

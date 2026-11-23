import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import RsiRenamePanel from '../src/components/RsiRenamePanel';

test('metadata-only rename explains manual recovery and starts disabled', () => {
  const html = renderToStaticMarkup(createElement(RsiRenamePanel, {
    path: 'Resources/Textures/test.rsi', revision: 'a'.repeat(64), name: 'idle',
    expectedMissingPng: true, onRenamed: () => {},
  }));
  assert.match(html, /PNG не изменяются/);
  assert.match(html, /восстанавливается вручную/);
  assert.match(html, /Остановите внешние процессы записи/);
  assert.match(html, /старым или новым именем после проверки/);
  assert.match(html, /<button type="submit" disabled=""/);
  assert.doesNotMatch(html, /исходного PNG/);
});

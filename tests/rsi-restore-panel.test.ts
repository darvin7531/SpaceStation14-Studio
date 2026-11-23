import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import RsiRestorePanel, { RsiArchiveAction } from '../src/components/RsiRestorePanel';

test('manual rename recovery preserves later edits before removing the current entry', () => {
  const html = renderToStaticMarkup(createElement(RsiRestorePanel, {
    path: 'Resources/Textures/test.rsi', revision: 'a'.repeat(64), onRestored: () => {},
  }));
  assert.match(html, /сравните её с текущей записью под новым именем/);
  assert.match(html, /согласуйте все последующие изменения, сохранив нужные данные в восстановленной записи/);
  assert.match(html, /не удаляйте и не заменяйте текущую запись или файлы, пока изменения не сохранены и не согласованы/);
  assert.match(html, /При неоднозначности остановитесь и сделайте резервную копию/);
});

test('metadata-only archive shows its manual path instead of a restore action', () => {
  const props = {
    path: 'Resources/Textures/test.rsi', saving: false, confirmation: 'idle',
    selected: { id: 'deleted-idle-123', state: 'idle', automatic_restore: false },
    onConfirmation: () => {},
  };
  const manual = renderToStaticMarkup(createElement(RsiArchiveAction, props));
  assert.match(manual, /Только ручное восстановление/);
  assert.match(manual, /test\.rsi\/.ss14-studio-archive\/deleted-idle-123\/meta\.json\.before/);
  assert.doesNotMatch(manual, /<button|<input/);

  const automatic = renderToStaticMarkup(createElement(RsiArchiveAction, {
    ...props, selected: { ...props.selected, automatic_restore: true },
  }));
  assert.match(automatic, /<button type="submit"/);
  assert.doesNotMatch(automatic, /Только ручное восстановление/);
});

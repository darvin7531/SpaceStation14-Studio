import test from 'node:test';
import assert from 'node:assert/strict';
import { LANGUAGE_STORAGE_KEY, resolveLanguage, uiText } from '../src/lib/ui-language';

test('language validation defaults to Russian and rejects unknown storage values', () => {
  assert.equal(resolveLanguage(null), 'ru');
  assert.equal(resolveLanguage('invalid'), 'ru');
  assert.equal(resolveLanguage('en'), 'en');
  assert.equal(resolveLanguage('ru'), 'ru');
  assert.equal(LANGUAGE_STORAGE_KEY, 'ss14-studio-language');
});
test('core interface labels switch language at runtime', () => {
  assert.equal(uiText('ru', 'app.openProject'), 'Открыть проект');
  assert.equal(uiText('en', 'app.openProject'), 'Open Project');
  assert.equal(uiText('en', 'settings.language'), 'Interface language');
  assert.equal(uiText('ru', 'app.files'), 'Файлы');
});
test('interpolation substitutes numbers and text without evaluating them', () => {
  assert.equal(uiText('en', 'common.countRange', { from: 1, to: 15, total: 30 }), '1–15 of 30');
  assert.equal(uiText('ru', 'common.countRange', { from: 1, to: 2, total: 8 }), '1–2 из 8');
  assert.equal(uiText('en', 'app.closeTab', { path: '<script>' }), 'Close tab <script>');
  assert.equal(uiText('en', 'app.closeTab'), 'Close tab ');
});

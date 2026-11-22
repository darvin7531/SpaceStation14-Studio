import assert from 'node:assert/strict';
import test from 'node:test';
import { ftlInspectorDetails } from '../src/lib/ftl-inspector';

test('FTL inspector shows game locale from file path, never editor RU/EN setting', () => {
  assert.deepEqual(ftlInspectorDetails('Resources/Locale/en-US/items.ftl', 'item = Item', 1), {
    path: 'Resources/Locale/en-US/items.ftl',
    locale: 'en-US',
    entries: 1,
    characters: 11,
  });
  assert.equal(ftlInspectorDetails('Resources/Locale/ru-RU/items.ftl', 'ключ = текст', 1).locale, 'ru-RU');
});
test('old inspection counts are unavailable until matching native analysis finishes', () => {
  assert.equal(ftlInspectorDetails('Resources/Locale/en-US/a.ftl', 'a = value', null).entries, null);
  assert.equal(ftlInspectorDetails('Resources/Locale/en-US/a.ftl', 'a = value', -1).entries, null);
});

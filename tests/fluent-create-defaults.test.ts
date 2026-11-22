import assert from 'node:assert/strict';
import test from 'node:test';
import { suggestedFluentDraft, moveFluentDraftToLocale } from '../src/lib/fluent-create-defaults';

test('creates the same starter fields as Electron-style new Fluent wizard', () => {
  assert.deepEqual(suggestedFluentDraft(), {
    file: 'Resources/Locale/en-US/StudioNew.ftl',
    starter_key: 'new-message',
    starter_value: 'New message',
  });
  assert.equal(suggestedFluentDraft('Resources/Locale/ru-RU/entities/item.ftl').file, 'Resources/Locale/ru-RU/entities/StudioNew.ftl');
});
test('missing entity locale uses the exact previously inspected path and source', () => {
  const suggested = {
    file: 'Resources/Locale/ru-RU/_Foobar/items.ftl',
    starter_key: 'ent-Example',
    starter_value: 'Object',
    starter_description: 'Object description',
    starter_suffix: 'Unusual',
  };
  assert.deepEqual(suggestedFluentDraft(undefined, suggested), suggested);
});

test('Electron game locale selection changes only Fluent resource directory', () => {
  assert.equal(moveFluentDraftToLocale('Resources/Locale/en-US/entities/item.ftl', 'ru-RU'),
    'Resources/Locale/ru-RU/entities/item.ftl');
  assert.equal(moveFluentDraftToLocale('Resources/Locale/en-US/new.ftl', 'zh-Hant-TW'),
    'Resources/Locale/zh-Hant-TW/new.ftl');
  assert.equal(moveFluentDraftToLocale('Resources/Locale/en-US/new.ftl', '../unsafe'), null);
  assert.equal(moveFluentDraftToLocale('Resources/Prototypes/en-US/new.yml', 'ru-RU'), null);
});

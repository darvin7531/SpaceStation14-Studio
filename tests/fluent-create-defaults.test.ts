import assert from 'node:assert/strict';
import test from 'node:test';
import { suggestedFluentDraft } from '../src/lib/fluent-create-defaults';

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

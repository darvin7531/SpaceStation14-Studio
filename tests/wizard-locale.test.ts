import assert from 'node:assert/strict';
import test from 'node:test';
import { uiText } from '../src/lib/ui-language';

test('create-wizard labels use the selected Studio interface language', () => {
  assert.equal(uiText('en', 'wizard.fluent.title'), 'New localization');
  assert.equal(uiText('ru', 'wizard.fluent.title'), 'Новая локализация');
  assert.equal(uiText('en', 'wizard.rsi.create'), 'Create RSI');
  assert.equal(uiText('ru', 'wizard.common.project'), 'В проекте');
});

test('game locale and translated UI remain separate and interpolations are safe', () => {
  assert.match(uiText('en', 'wizard.fluent.gameLocale'), /not Studio/);
  assert.match(uiText('ru', 'wizard.fluent.gameLocale'), /не язык интерфейса/);
  assert.equal(uiText('en', 'wizard.rsi.createdPath', { path: 'Resources/Textures/Objects/item.rsi' }),
    'Will create: Resources/Textures/Objects/item.rsi');
  assert.equal(uiText('ru', 'wizard.rsi.createdExternal', { name: 'hat' }),
    'Будет создан: hat.rsi в выбранной внешней папке');
});

test('prototype wizard UI switches between Russian and English without changing game values', () => {
  assert.equal(uiText('ru', 'wizard.proto.title'), 'Создать прототип');
  assert.equal(uiText('en', 'wizard.proto.title'), 'Create prototype');
  assert.equal(uiText('en', 'wizard.proto.parent'), 'Parent (optional)');
  assert.equal(uiText('ru', 'wizard.proto.matches', { shown: 200, total: 1015 }),
    'Показано 200 из 1015 файлов — уточните путь для поиска.');
  assert.equal(uiText('en', 'wizard.proto.previewAppend'), 'Appended block (Rust)');
});

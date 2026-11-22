import assert from 'node:assert/strict';
import test from 'node:test';
import { buildEntityLocalePatch, planMissingEntityTranslations, buildMissingFluentDraft, type EntityLocaleValues } from '../src/lib/entity-localization';

const entity: EntityLocaleValues = {
  localization_id: 'ent-TestEntity',
  name: 'Test entity', description: 'A description', suffix: 'Suffix',
};

test('new entity creates a Fluent message with attributes', () => {
  const p = buildEntityLocalePatch('', entity, ['name', 'description', 'suffix']);
  assert.equal(p.content, 'ent-TestEntity = Test entity\n    .desc = A description\n    .suffix = Suffix\n');
  assert.equal(p.added.length, 3);
});

test('existing text, attrs and line endings remain unchanged', () => {
  const source = 'ent-TestEntity = Existing\r\n    .suffix = Existing suffix\r\n\r\nother = Other\r\n';
  const p = buildEntityLocalePatch(source, entity, ['name', 'description', 'suffix']);
  assert.equal(p.content, 'ent-TestEntity = Existing\r\n    .suffix = Existing suffix\r\n    .desc = A description\r\n\r\nother = Other\r\n');
  assert.deepEqual(p.added, ['description']);
  assert.deepEqual(p.alreadyPresent, ['name', 'suffix']);
});

test('does not change original if everything exists', () => {
  const source = 'ent-TestEntity = Existing\n    .desc = Already\n';
  assert.equal(buildEntityLocalePatch(source, entity, ['name', 'description']).content, source);
});

test('attributes can be scaffolded without a name', () => {
  assert.equal(buildEntityLocalePatch('', entity, ['description']).content, 'ent-TestEntity =\n    .desc = A description\n');
});

test('invalid names and Fluent special syntax are rejected', () => {
  assert.throws(() => buildEntityLocalePatch('', { ...entity, localization_id: '../escape' }, ['name']));
  assert.throws(() => buildEntityLocalePatch('', { ...entity, name: '{ $unsafe }' }, ['name']));
  assert.throws(() => buildEntityLocalePatch('', { ...entity, description: 'line\nother = bad' }, ['description']));
});

test('duplicate message ids are refused rather than silently patched', () => {
  assert.throws(() => buildEntityLocalePatch('ent-TestEntity = a\nent-TestEntity = b\n', entity, ['suffix']));
});

test('checkbox order cannot place attributes before the message', () => {
  assert.equal(
    buildEntityLocalePatch('', entity, ['suffix', 'description', 'name']).content,
    'ent-TestEntity = Test entity\n    .desc = A description\n    .suffix = Suffix\n',
  );
});

test('batch quick-fix plans only confirmed missing fields for each game locale', () => {
  const analysis: import('../src/lib/api').EntityLocalizationAnalysis = {
    localization_id: entity.localization_id,
    complete: true,
    warnings: [],
    targets: [
      { locale: 'ru-RU', path: 'Resources/Locale/ru-RU/entities.ftl', file_exists: true,
        exists: { name: true, description: false, suffix: true } },
      { locale: 'en-US', path: 'Resources/Locale/en-US/entities.ftl', file_exists: false,
        exists: { name: false, description: false, suffix: false } },
    ],
    diagnostics: [
      { field: 'name', source_text: entity.name, missing_locales: ['en-US'], targets: [] },
      { field: 'description', source_text: entity.description, missing_locales: ['ru-RU', 'en-US'], targets: [] },
    ],
  };
  assert.deepEqual(planMissingEntityTranslations(analysis, ['name', 'description', 'suffix']), [
    { locale: 'ru-RU', path: 'Resources/Locale/ru-RU/entities.ftl',
      fileExists: true, fields: ['description'] },
    { locale: 'en-US', path: 'Resources/Locale/en-US/entities.ftl',
      fileExists: false, fields: ['name', 'description'] },
  ]);
  assert.deepEqual(planMissingEntityTranslations(analysis, ['name']), [
    { locale: 'en-US', path: 'Resources/Locale/en-US/entities.ftl',
      fileExists: false, fields: ['name'] },
  ]);
  assert.deepEqual(planMissingEntityTranslations({ ...analysis, complete: false }, ['name']), []);
  assert.deepEqual(planMissingEntityTranslations(analysis, []), []);
});

test('missing main value can be added to an existing attribute-only Fluent message', () => {
  const original = 'ent-TestEntity =   \r\n    .desc = Existing description\r\n\r\n';
  const patch = buildEntityLocalePatch(original, entity, ['name', 'description', 'suffix']);
  assert.deepEqual(patch.added, ['name', 'suffix']);
  assert.deepEqual(patch.alreadyPresent, ['description']);
  assert.equal(patch.content, 'ent-TestEntity = Test entity\r\n    .desc = Existing description\r\n    .suffix = Suffix\r\n\r\n');
  assert.equal(buildEntityLocalePatch('ent-TestEntity =\n    .desc = Old\n', entity, ['name']).content,
    'ent-TestEntity = Test entity\n    .desc = Old\n');
});


test('missing FTL draft contains only selected fields, including attribute-only messages', () => {
  const draft = buildMissingFluentDraft('Resources/Locale/en-US/entities.ftl', entity, ['description']);
  assert.deepEqual(draft, { file: 'Resources/Locale/en-US/entities.ftl', starter_key: entity.localization_id,
    starter_value: '', starter_description: entity.description, starter_suffix: undefined, allow_empty_value: true });
  assert.throws(() => buildMissingFluentDraft('Resources/Locale/en-US/entities.ftl', { ...entity, description: '{ $bad }' }, ['description']));
});


test('batch draft enforces the native UTF-8 byte limit for every field', () => {
  for (const field of ['name', 'description', 'suffix'] as const) {
    assert.doesNotThrow(() => buildMissingFluentDraft('Resources/Locale/en-US/a.ftl', { ...entity, [field]: '界'.repeat(2730) }, [field]));
    assert.throws(() => buildMissingFluentDraft('Resources/Locale/en-US/a.ftl', { ...entity, [field]: '界'.repeat(2731) }, [field]));
  }
});

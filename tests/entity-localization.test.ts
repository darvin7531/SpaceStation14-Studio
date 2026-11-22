import assert from 'node:assert/strict';
import test from 'node:test';
import { buildEntityLocalePatch, type EntityLocaleValues } from '../src/lib/entity-localization';

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

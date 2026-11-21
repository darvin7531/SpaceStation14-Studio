import test from 'node:test';
import assert from 'node:assert/strict';
import type { ComponentSchema, CSharpField, PrototypeComponentEntry } from '../src/lib/api';
import { scalarKindForCSharp, suggestedFields } from '../src/lib/csharp-suggestions';

const field = (name: string, field_type: string): CSharpField => ({
  name, field_type, member: name, line: 13, required: false, explicit_name: true,
});
const entry: PrototypeComponentEntry = {
  index: 0, type_name: 'Sprite', field_count: 1,
  fields: [{ key: 'visible', kind: 'bool', value: 'true', editable: true }],
};
const schema = (status: ComponentSchema['status'], fields: CSharpField[]): ComponentSchema => ({
  status, type_name: 'Sprite',
  declarations: [{
    kind: 'component', name: 'Sprite', class_name: 'SpriteComponent',
    qualified_name: 'Content.Shared.SpriteComponent',
    file: 'Content.Shared/Sprite.cs', line: 10, partial: false,
    base_types: 'Component', parse_uncertain: false, fields,
  }],
  parts: [],
});

test('maps only directly supported nonnullable primitive C# types', () => {
  assert.equal(scalarKindForCSharp('bool'), 'bool');
  assert.equal(scalarKindForCSharp(' int '), 'int');
  assert.equal(scalarKindForCSharp('ulong'), 'int');
  assert.equal(scalarKindForCSharp('double'), 'float');
  assert.equal(scalarKindForCSharp('string'), 'string');
  assert.equal(scalarKindForCSharp('int?'), null);
  assert.equal(scalarKindForCSharp('Color'), null);
  assert.equal(scalarKindForCSharp('List<string>'), null);
});

test('never suggest fields already declared in YAML', () => {
  const rows = suggestedFields(entry, schema('unique', [
    field('visible', 'bool'), field('color', 'Color'), field('layer', 'int'),
  ]), true);
  assert.deepEqual(rows.map((row) => [row.field.name, row.kind]), [
    ['color', null], ['layer', 'int'],
  ]);
  assert.equal(rows[1].defaultValue, '0');
});

test('no editable suggestions when index is incomplete, schema ambiguous or partial', () => {
  for (const status of ['ambiguous', 'partial', 'uncertain', 'not_indexed'] as const) {
    assert.deepEqual(suggestedFields(entry, schema(status, [field('layer', 'int')]), true), []);
  }
  assert.deepEqual(suggestedFields(entry, schema('unique', [field('layer', 'int')]), false), []);
});

test('invalid YAML keys and duplicate C# fields cannot be auto-generated', () => {
  const rows = suggestedFields(entry, schema('unique', [
    field('a:b', 'int'), field('newField', 'bool'), field('newField', 'bool'), field('type', 'int'),
  ]), true);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].kind, null);
  assert.equal(rows[1].kind, 'bool');
  assert.equal(rows[1].defaultValue, 'false');
  assert.equal(rows[2].kind, null);
});

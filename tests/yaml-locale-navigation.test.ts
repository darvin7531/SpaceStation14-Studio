import assert from 'node:assert/strict';
import test from 'node:test';
import { directEntityLocaleField, yamlLocaleClickField } from '../src/editor/yaml-locale-navigation';
import type { PrototypeDeclaration } from '../src/lib/api';

const declaration: PrototypeDeclaration = {
  kind: 'entity', id: 'TestEntity', parents: [], abstract_prototype: false,
  file: 'Resources/Prototypes/test.yml', line: 1,
  document_index: 0, item_index: 0, variant_index: null,
  mode: 'normal', partial_order: null, parent_tag: null, source_count: 1,
};

const example = [
  '- type: entity',
  '  id: TestEntity',
  '  name: Actual Name',
  '  description: Direct description',
  '  suffix: blessed',
  '  components:',
  '  - type: Sprite',
  '    name: nested name',
  '- type: entity',
  '  id: OtherEntity',
  '  name: Other',
];

test('Ctrl+Click candidates include direct YAML entity localized text only', () => {
  assert.equal(yamlLocaleClickField(example[2], 5), 'name');
  assert.equal(yamlLocaleClickField(example[3], 9), 'description');
  assert.equal(yamlLocaleClickField('  suffix: # no value', 6), null);
  assert.equal(yamlLocaleClickField('  name: Actual # comment', 23), null);
  assert.equal(yamlLocaleClickField('  name: Actual', 0), null);
});

test('direct entity selector ignores component properties and adjacent declarations', () => {
  assert.equal(directEntityLocaleField(example, 3, declaration), 'name');
  assert.equal(directEntityLocaleField(example, 5, declaration), 'suffix');
  assert.equal(directEntityLocaleField(example, 8, declaration), null);
  assert.equal(directEntityLocaleField(example, 11, { ...declaration, line: 9, id: 'OtherEntity' }), 'name');
  assert.equal(directEntityLocaleField(example, 11, declaration), 'name');
  // The caller must also restrict line numbers to the next native declaration.
  assert.equal(directEntityLocaleField(example, 3, { ...declaration, kind: 'reagent' }), null);
  assert.equal(directEntityLocaleField(example, 3, { ...declaration, mode: 'partial_only' }), null);
});

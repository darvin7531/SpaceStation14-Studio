import assert from 'node:assert/strict';
import test from 'node:test';
import type { EntityLocaleDiagnostic, PrototypeDeclaration } from '../src/lib/api';
import { missingEntityLocaleUnderlines } from '../src/editor/yaml-locale-markers';

const entity: PrototypeDeclaration = {
  kind: 'entity', id: 'Item', parents: [], abstract_prototype: false,
  file: 'Resources/Prototypes/items.yml', line: 1, document_index: 0,
  item_index: 0, variant_index: null, mode: 'normal', partial_order: null,
  parent_tag: null, source_count: 1,
};
const lines = [
  '- type: entity',
  '  id: Item',
  '  name: An Item',
  '  description: Description',
  '  components:',
  '  - type: Sprite',
  '    name: Sprite layer name',
  '- type: entity',
  '  id: Another',
  '  name: Another item',
];
const diagnostic = (field: EntityLocaleDiagnostic['field'],
  missing_locales: string[]): EntityLocaleDiagnostic => ({
  field, source_text: 'text', missing_locales, targets: [],
});

test('inline Fluent errors are derived only from confirmed missing direct entity fields', () => {
  assert.deepEqual(missingEntityLocaleUnderlines(lines, entity, 8, [
    diagnostic('name', ['ru-RU', 'en-US']),
    diagnostic('description', []),
  ]), [{
    line: 3, startColumn: 3, endColumn: 7, field: 'name',
    locales: ['ru-RU', 'en-US'],
  }]);
});

test('nested components and next entity are never marked', () => {
  assert.deepEqual(missingEntityLocaleUnderlines(lines, entity, 8, [
    diagnostic('name', ['ru-RU']), diagnostic('suffix', ['en-US']),
  ]).map((item) => item.line), [3]);
  assert.deepEqual(missingEntityLocaleUnderlines(lines,
    {...entity, kind: 'reagent'}, 8, [diagnostic('name', ['ru-RU'])]), []);
  assert.deepEqual(missingEntityLocaleUnderlines(lines,
    {...entity, mode: 'partial_only'}, 8, [diagnostic('name', ['ru-RU'])]), []);
});

test('different entity selection marks only fields belonging to the selected declaration', () => {
  const next = {...entity, line: 8, id: 'Another'};
  assert.deepEqual(missingEntityLocaleUnderlines(lines, next, null,
    [diagnostic('name', ['ru-RU'])]).map((item) => item.line), [10]);
});

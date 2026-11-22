import assert from 'node:assert/strict';
import test from 'node:test';
import type { PrototypeDeclaration, SourceOutlineEntry } from '../src/lib/api';
import { outlineDeclarationKey, outlineKeyAtLine } from '../src/lib/outline-selection';

const entry = (line: number, item_index: number, variant_index: number | null = null,
  document_index = 1): SourceOutlineEntry => ({
  declaration: {
    kind: 'entity', id: 'Proto' + item_index, parents: [],
    abstract_prototype: false, file: 'Resources/Prototypes/test.yml',
    line, item_index, document_index, variant_index,
    mode: 'normal', partial_order: null, parent_tag: null, source_count: 1,
  },
  sprite: null, sprite_layers: [], sprite_layers_total: 0,
});

test('inspector follows the native YAML item with cursor without scanning source text', () => {
  const items = [entry(2, 1), entry(9, 2), entry(17, 3)];
  assert.equal(outlineKeyAtLine(items, null), '1:1:base');
  assert.equal(outlineKeyAtLine(items, 1), null);
  assert.equal(outlineKeyAtLine(items, 2), '1:1:base');
  assert.equal(outlineKeyAtLine(items, 8), '1:1:base');
  assert.equal(outlineKeyAtLine(items, 9), '1:2:base');
  assert.equal(outlineKeyAtLine(items, 20), '1:3:base');
  assert.equal(outlineKeyAtLine(items, 0), null);
  assert.equal(outlineKeyAtLine(items, Number.NaN), null);
  assert.equal(outlineKeyAtLine(items, -1), null);
  assert.equal(outlineKeyAtLine([], 12), null);
});

test('the inspector never confuses multiple YAML documents or variant IDs', () => {
  const items = [entry(1, 1), entry(15, 1, null, 2), entry(15, 1, 0, 2), entry(26, 2, null, 2)];
  assert.equal(outlineKeyAtLine(items, 1), '1:1:base');
  assert.equal(outlineKeyAtLine(items, 15), '2:1:base');
  assert.equal(outlineKeyAtLine(items, 25), '2:1:base');
  assert.equal(outlineKeyAtLine(items, 26), '2:2:base');
  assert.equal(outlineDeclarationKey(items[2].declaration), '2:1:0');
  const reordered = [items[2], items[0], items[1], items[3]];
  assert.equal(outlineKeyAtLine(reordered, 16), '2:1:base');
});

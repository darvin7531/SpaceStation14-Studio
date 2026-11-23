import assert from 'node:assert/strict';
import test from 'node:test';
import type { PrototypeDeclaration, SourceOutlineEntry } from '../src/lib/api';
import { canApplyPrototypeFields, outlineDeclarationKey, outlineKeyAtLine, resolvePrototypeTab, inheritedSpriteForEntry } from '../src/lib/outline-selection';

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

test('legacy tabs resolve only unique, complete matches and keep exact variant identity', () => {
  const base = entry(15, 1);
  const variant = entry(15, 1, 0);
  const { variant_index: _variant, ...legacy } = base.declaration;
  assert.equal(resolvePrototypeTab([base], legacy, false), base.declaration);
  assert.equal(resolvePrototypeTab([variant], legacy, false), variant.declaration);
  assert.equal(resolvePrototypeTab([base, variant], legacy, false), null);
  assert.equal(resolvePrototypeTab([base], legacy, true), null);
  assert.equal(resolvePrototypeTab([base, variant], { ...legacy, variant_index: 0 }, false), variant.declaration);
  assert.equal(outlineDeclarationKey(resolvePrototypeTab([base, variant], { ...legacy, variant_index: 0 }, false)!), '1:1:0');
});

test('pending form patches are rejected after switching or reopening a tab', () => {
  const target = entry(2, 1).declaration;
  assert.equal(canApplyPrototypeFields(target, target, target, target.file), true);
  assert.equal(canApplyPrototypeFields(target, null, target, target.file), false);
  assert.equal(canApplyPrototypeFields(target, { ...target }, target, target.file), false);
  assert.equal(canApplyPrototypeFields(target, target, { ...target, id: 'other' }, target.file), false);
  assert.equal(canApplyPrototypeFields(target, target, target, 'other.yml'), false);
});

test('inherited sprite requires a complete report for the exact selected base and a known sprite source', () => {
  const selected = entry(2, 1);
  const projection = { sprite: null, layers: [], layers_total: 0, source: selected.declaration };
  const report = { kind: 'entity', id: selected.declaration.id, structural_complete: true,
    base: selected.declaration, sprite: projection } as Parameters<typeof inheritedSpriteForEntry>[1];
  assert.equal(inheritedSpriteForEntry(selected, report), projection);
  assert.equal(inheritedSpriteForEntry(selected, null), null);
  assert.equal(inheritedSpriteForEntry(selected, { ...report, structural_complete: false }), null);
  assert.equal(inheritedSpriteForEntry(selected, { ...report, base: null }), null);
  assert.equal(inheritedSpriteForEntry(selected, { ...report, base: { ...selected.declaration, file: 'other.yml' } }), null);
  assert.equal(inheritedSpriteForEntry(selected, { ...report, base: { ...selected.declaration, item_index: 2 } }), null);
  assert.equal(inheritedSpriteForEntry(selected, { ...report, sprite: { ...projection, source: null } }), null);
});

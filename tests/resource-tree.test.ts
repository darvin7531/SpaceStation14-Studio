import assert from 'node:assert/strict';
import test from 'node:test';
import { RESOURCE_TREE_PAGE_SIZE, treePageOffset, treePrototypes, treePrototypeKey } from '../src/lib/resource-tree';
import type { SourceOutline, PrototypeDeclaration } from '../src/lib/api';

test('lazy tree pages are capped before querying the native resource browser', () => {
  assert.equal(RESOURCE_TREE_PAGE_SIZE, 100);
  assert.equal(treePageOffset(0), 0);
  assert.equal(treePageOffset(3), 300);
  assert.equal(treePageOffset(-1), 0);
  assert.equal(treePageOffset(Infinity), 0);
  assert.equal(treePageOffset(1_000_000), 0);
});
test('YAML source nodes retain variant identity and skip unknown line offsets', () => {
  const source: PrototypeDeclaration = {
    kind: 'entity', id: 'Door', parents: [], abstract_prototype: false,
    file: 'Resources/Prototypes/door.yml', line: 3, document_index: 1,
    item_index: 4, variant_index: null, mode: 'normal', partial_order: null,
    parent_tag: null, source_count: 1,
  };
  const asEntry = (declaration: PrototypeDeclaration) => ({
    declaration, sprite: null, sprite_layers: [], sprite_layers_total: 0,
  });
  const outline: SourceOutline = {
    declarations: [asEntry(source), asEntry({...source, line: 7, variant_index: 1}),
      asEntry({...source, line: 0})],
    diagnostics: [], truncated: true,
  };
  assert.deepEqual(treePrototypes(outline).map((item) => item.line), [3, 7]);
  assert.deepEqual(treePrototypes(outline).map(treePrototypeKey), ['1:4:base', '1:4:1']);
});

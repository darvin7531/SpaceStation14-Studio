import assert from 'node:assert/strict';
import test from 'node:test';
import { identifierAtColumn } from '../src/lib/editor-navigation';

test('ctrl click captures complete prototype IDs with underscores and hyphens', () => {
  assert.equal(identifierAtColumn('parent: [BaseEntity, Some-Prototype]', 11), 'BaseEntity');
  assert.equal(identifierAtColumn('parent: [BaseEntity, Some-Prototype]', 28), 'Some-Prototype');
  assert.equal(identifierAtColumn('id: NPC_25', 8), 'NPC_25');
  assert.equal(identifierAtColumn('id: a', 5), null);
});
test('ignores punctuation, invalid cursor and path-like escapes', () => {
  assert.equal(identifierAtColumn('parent: ', 2), 'parent');
  assert.equal(identifierAtColumn(':', 1), null);
  assert.equal(identifierAtColumn('any', -1), null);
  assert.equal(identifierAtColumn('foo/bar', 4), 'foo');
  assert.equal(identifierAtColumn('', 1), null);
});

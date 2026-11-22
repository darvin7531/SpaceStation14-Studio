import assert from 'node:assert/strict';
import test from 'node:test';
import { yamlCompletionContext } from '../src/editor/yaml-completion';

test('suggests prototype parents for scalar and inline sequence', () => {
  assert.deepEqual(yamlCompletionContext(['- type: entity', '  parent: Bas'], 2, 14), {
    kind: 'prototype-parent', query: 'Bas', startColumn: 11,
  });
  assert.deepEqual(yamlCompletionContext(['- type: entity', '  parent: [Base, Chi'], 2, 21), {
    kind: 'prototype-parent', query: 'Chi', startColumn: 18,
  });
});
test('suggests ordered parent lists but not arbitrary YAML list items', () => {
  const input = ['- type: entity', '  parent:', '  - Foo', '  components:', '  - type: Sprite'];
  assert.equal(yamlCompletionContext(input, 3, 8)?.kind, 'prototype-parent');
  assert.equal(yamlCompletionContext(['- type: entity', '  other:', '  - Foo'], 3, 8), null);
});
test('component classes are suggested only inside an explicit components sequence', () => {
  assert.deepEqual(yamlCompletionContext(['- type: entity', '  components:', '  - type: Spr'], 3, 14), {
    kind: 'component-type', query: 'Spr', startColumn: 11,
  });
  assert.equal(yamlCompletionContext(['- type: ent'], 1, 12), null);
  assert.equal(yamlCompletionContext(['- type: entity', '  foo:', '  - type: Other'], 3, 16), null);
});
test('refuses comments and out-of-range editor positions', () => {
  assert.equal(yamlCompletionContext(['parent: Foo # comment'], 1, 22), null);
  assert.equal(yamlCompletionContext(['parent: Foo'], 1, 999), null);
});

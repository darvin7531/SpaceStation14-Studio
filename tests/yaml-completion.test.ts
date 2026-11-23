import assert from 'node:assert/strict';
import test from 'node:test';
import { indexedRsiPath, yamlCompletionContext, yamlComponentHoverTarget, yamlSpriteLinkTarget, yamlEditorContextLines, yamlEditorCompletionContext, yamlEditorComponentHoverTarget } from '../src/editor/yaml-completion';

test('editor completions and hover retain context beyond 64 lines without crossing prototypes', () => {
  const lines = ['- type: entity', '  components:', '  - type: Old', '- type: entity', '  components:',
    '  - type: Sprite', ...Array.from({ length: 70 }, (_, i) => `    field${i}: value`), '    sca'];
  let version = 1;
  const model = { getLineContent: (line: number) => lines[line - 1], getVersionId: () => version };
  const context = yamlEditorContextLines(model, lines.length);
  assert.equal(context[0], '- type: entity');
  assert.equal(context.includes('  - type: Old'), false);
  assert.equal(yamlCompletionContext(context, context.length, 8)?.kind, 'component-field');
  lines.push('  - type: Icon');
  version += 1;
  const hoverLines = yamlEditorContextLines(model, lines.length);
  assert.equal(yamlComponentHoverTarget(hoverLines, hoverLines.length, 13)?.name, 'Icon');
});

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

test('component hover points to the real C# component token and ignores root prototype type', () => {
  const lines = ['- type: entity', '  components:', '  - type: Sprite', '    state: icon'];
  assert.deepEqual(yamlComponentHoverTarget(lines, 3, 13), {
    name: 'Sprite', startColumn: 11, endColumn: 17,
  });
  assert.equal(yamlComponentHoverTarget(lines, 3, 5), null);
  assert.equal(yamlComponentHoverTarget(lines, 1, 9), null);
  assert.equal(yamlComponentHoverTarget(['- type: entity', '  other:', '  - type: Sprite'], 3, 13), null);
});


test('component entry and DataField contexts preserve existing fields', () => {
  assert.deepEqual(yamlCompletionContext(['- type: entity', '  components:', '  - Spr'], 3, 8), {
    kind: 'component-entry-start', query: 'Spr', startColumn: 5,
  });
  assert.deepEqual(yamlCompletionContext([
    '- type: entity', '  components:', '  - type: Sprite', '    state: icon', '    sca',
  ], 5, 8), {
    kind: 'component-field', query: 'sca', startColumn: 5,
    componentType: 'Sprite', existingFields: ['state'],
  });
  assert.equal(yamlCompletionContext([
    '- type: entity', '  components:', '  - type: Sprite', '  unrelated:', '    foo',
  ], 5, 8), null);
});

test('RSI paths require supported component context', () => {
  const lines = ['- type: entity', '  components:', '  - type: Sprite', '    sprite: "Objects/We'];
  assert.deepEqual(yamlCompletionContext(lines, 4, lines[3].length + 1), {
    kind: 'rsi-path', query: 'Objects/We', startColumn: 14, componentType: 'Sprite',
  });
  const other = ['- type: entity', '  components:', '  - type: Other', '    sprite: Foo'];
  assert.equal(yamlCompletionContext(other, 4, other[3].length + 1), null);
});

test('Ctrl-click RSI path validation rejects external and traversal targets', () => {
  const lines = ['- type: entity', '  components:', '  - type: Sprite', '    sprite: "Objects/Test/example.rsi"'];
  assert.equal(yamlSpriteLinkTarget(lines, 4, 23), 'Resources/Textures/Objects/Test/example.rsi');
  assert.equal(yamlSpriteLinkTarget(lines, 4, 5), null);
  assert.equal(indexedRsiPath('Objects/../Secret.rsi'), null);
  assert.equal(indexedRsiPath('https://host/a.rsi'), null);
  assert.equal(indexedRsiPath('Objects\\invalid.rsi'), null);
  assert.equal(indexedRsiPath('Resources/Textures/Objects/Test.rsi'), 'Resources/Textures/Objects/Test.rsi');
});


test('editor requests skip irrelevant lines and invalidate cached context on edits', () => {
  const lines = ['- type: entity', '  components:', '  - type: Sprite',
    ...Array.from({ length: 100 }, (_, i) => `    field${i}: value`), '    sca'];
  let version = 1;
  let reads = 0;
  const model = { getVersionId: () => version, getLineContent: (line: number) => { reads++; return lines[line - 1]; } };
  assert.equal(yamlEditorComponentHoverTarget(model, lines.length - 1, 8), null);
  assert.equal(reads, 1);
  reads = 0;
  assert.equal(yamlEditorCompletionContext(model, lines.length - 1, lines[lines.length - 2].length + 1), null);
  assert.equal(reads, 1);
  assert.equal(yamlEditorCompletionContext(model, lines.length, 8)?.componentType, 'Sprite');
  reads = 0;
  assert.equal(yamlEditorCompletionContext(model, lines.length, 8)?.componentType, 'Sprite');
  assert.equal(reads, 1);
  lines[2] = '  - type: Icon';
  version++;
  assert.equal(yamlEditorCompletionContext(model, lines.length, 8)?.componentType, 'Icon');
  lines[1] = '  unrelated:';
  version++;
  assert.equal(yamlEditorCompletionContext(model, lines.length, 8), null);
});

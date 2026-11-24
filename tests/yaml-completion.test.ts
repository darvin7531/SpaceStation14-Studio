import assert from 'node:assert/strict';
import test from 'node:test';
import { yamlRsiCandidates, yamlRsiInsertText, indexedRsiPath, yamlCompletionContext, yamlComponentHoverTarget, yamlSpriteLinkTarget, yamlEditorContextLines, yamlEditorCompletionContext, yamlEditorComponentHoverTarget, yamlComponentInsertText, yamlCompletionEndColumn, yamlFieldInsertText, yamlCurrentCompletion } from '../src/editor/yaml-completion';

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

test('component fields include siblings after the cursor but not nested or other component fields', () => {
  const lines = ['- type: entity', '  components:', '  - type: Sprite', '    before: x',
    '    sca', '    nested:', '      scale: x', '    state: icon', '  - type: Icon', '    scale: x'];
  const model = { getLineContent: (n: number) => lines[n - 1], getLineCount: () => lines.length, getVersionId: () => 1 };
  assert.deepEqual(yamlEditorCompletionContext(model, 5, 8)?.existingFields, ['before', 'nested', 'state']);
  assert.deepEqual(yamlCompletionContext(lines, 5, 8)?.existingFields, ['before', 'nested', 'state']);
});

test('nested mappings do not offer component fields while sibling fields still do', () => {
  const lines = ['- type: entity', '  components:', '  - type: Sprite', '    layers:',
    '      scale', '    sca'];
  const model = { getLineContent: (n: number) => lines[n - 1], getLineCount: () => lines.length, getVersionId: () => 1 };
  assert.equal(yamlCompletionContext(lines, 5, 12), null);
  assert.equal(yamlEditorCompletionContext(model, 5, 12), null);
  assert.equal(yamlEditorCompletionContext(model, 6, 8)?.kind, 'component-field');
});

test('RSI completion requests native prefix matches once, beyond substring distractions', async () => {
  const items = [...Array.from({ length: 200 }, (_, i) => ({ path: `Resources/Textures/A/Resources/Textures/Obj${i}.rsi` })),
    { path: 'Resources/Textures/Objects/real.rsi' }];
  let calls = 0;
  const candidates = await yamlRsiCandidates('Obj', async (query) => {
    calls++;
    assert.equal(query, 'Obj');
    return items.filter((item) => item.path.toLowerCase().startsWith(('Resources/Textures/' + query).toLowerCase())).slice(0, 80);
  });
  assert.deepEqual(candidates, ['Resources/Textures/Objects/real.rsi']);
  assert.equal(calls, 1);
});

test('component completion inserts valid spacing for bare and partial list entries', () => {
  for (const line of ['  -', '  - ', '  -Spr', '  - Spr', '  - type: Spr']) {
    const lines = ['- type: entity', '  components:', line];
    const context = yamlCompletionContext(lines, 3, line.length + 1)!;
    const result = line.slice(0, context.startColumn - 1) + yamlComponentInsertText(line, context, 'Sprite');
    assert.equal(result, '  - type: Sprite', line);
  }
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


test('completion replaces the remaining token without consuming YAML delimiters', () => {
  assert.equal(yamlCompletionEndColumn('  - type: Sprite # comment', 14, 'component-type'), 17);
  assert.equal(yamlCompletionEndColumn('  parent: [Base, Other]', 14, 'prototype-parent'), 16);
  assert.equal(yamlCompletionEndColumn('    sprite: "Objects/Test.rsi"', 18, 'rsi-path'), 30);
});


test('applied completions preserve existing YAML delimiters and values', () => {
  const apply = (line: string, column: number, name: string, before: string[]) => {
    const lines = [...before, line];
    const context = yamlCompletionContext(lines, lines.length, column)!;
    const text = context.kind === 'component-field'
      ? yamlFieldInsertText(line, column, name)
      : yamlComponentInsertText(line, context, name);
    const end = yamlCompletionEndColumn(line, column, context.kind);
    return line.slice(0, context.startColumn - 1) + text + line.slice(end - 1);
  };
  const component = ['- type: entity', '  components:', '  - type: Sprite'];
  assert.equal(apply('    scale: 1 # keep', 8, 'scale', component), '    scale: 1 # keep');
  assert.equal(apply('    scale  : 1', 8, 'scale', component), '    scale  : 1');
  assert.equal(apply('    sca # keep', 8, 'scale', component), '    scale:  # keep');
  assert.equal(apply('  parent: [Base, Other]', 14, 'Basic', ['- type: entity']), '  parent: [Basic, Other]');
  assert.equal(apply('    sprite: "Objects/Test.rsi" # keep', 18, 'Objects/New.rsi', component), '    sprite: "Objects/New.rsi" # keep');
  assert.equal(apply('  - type: Sprite # keep', 14, 'Sprite', ['- type: entity', '  components:']), '  - type: Sprite # keep');
  assert.equal(apply('  - Spr # keep', 7, 'Sprite', ['- type: entity', '  components:']), '  - type: Sprite # keep');
  assert.equal(apply('    sprite: "Objects/a@b+é.rsi" # keep', 22, 'Objects/New.rsi', component), '    sprite: "Objects/New.rsi" # keep');
  assert.equal(apply('    sprite: Objects/a@b+é.rsi # keep', 21, 'Objects/New.rsi', component), '    sprite: Objects/New.rsi # keep');
  for (const quote of ['"', "'"]) {
    const line = `    sprite: ${quote}Objects/a#old.rsi${quote} # keep`;
    const lines = [...component, line];
    const column = line.indexOf('#') - 2;
    const context = yamlCompletionContext(lines, lines.length, column);
    assert.equal(context, null, line);
  }
});

test('RSI candidate insertion quotes paths for the current scalar', () => {
  const component = ['- type: entity', '  components:', '  - type: Sprite'];
  for (const quote of ['', '"', "'"]) {
    const line = `    sprite: ${quote}Objects/old.rsi${quote} # keep`;
    const column = line.indexOf('old') + 2;
    const context = yamlCompletionContext([...component, line], 4, column)!;
    for (const candidate of ['Objects/a b@é.rsi', 'Objects/a"b.rsi', "Objects/a'b.rsi", 'Objects/a #b.rsi', 'Objects/[a].rsi', 'Objects/a: b.rsi', 'Objects/safe.rsi']) {
      assert.ok(indexedRsiPath(candidate), candidate);
      const text = yamlRsiInsertText(line, context, candidate);
      const applied = line.slice(0, context.startColumn - 1) + text + line.slice(yamlCompletionEndColumn(line, column, context.kind) - 1);
      const encoded = quote === '"' ? JSON.stringify(candidate) : quote === "'" ? "'" + candidate.replace(/'/g, "''") + "'" : /^[A-Za-z0-9_./-]+$/.test(candidate) ? candidate : JSON.stringify(candidate);
      assert.equal(applied, `    sprite: ${encoded} # keep`, candidate);
    }
  }
  const line = '    sprite: "Objects/old file@é.rsi" # keep';
  const column = line.indexOf('old') + 2;
  const context = yamlCompletionContext([...component, line], 4, column)!;
  const text = yamlRsiInsertText(line, context, 'Objects/new file@é.rsi');
  assert.equal(line.slice(0, context.startColumn - 1) + text + line.slice(yamlCompletionEndColumn(line, column, context.kind) - 1), '    sprite: "Objects/new file@é.rsi" # keep');
});

test('parent completion handles spaces after flow sequence opening', () => {
  const line = '  parent: [ Base, Other] # keep';
  const column = line.indexOf('Base') + 3;
  const lines = ['- type: entity', line];
  const model = { getLineContent: (n: number) => lines[n - 1], getVersionId: () => 1 };
  const context = yamlEditorCompletionContext(model, 2, column)!;
  assert.equal(context.query, 'Ba');
  assert.equal(line.slice(0, context.startColumn - 1) + 'Basic' + line.slice(yamlCompletionEndColumn(line, column, context.kind) - 1), '  parent: [ Basic, Other] # keep');
});

test('completion is suppressed before whitespace or quotes leading to an existing value', () => {
  for (const [before, line, column] of [
    [['- type: entity', '  components:'], '  - type: Sprite', 10],
    [['- type: entity'], '  parent: Base', 10],
    [['- type: entity'], '  parent: "Base"', 11],
    [['- type: entity'], '  parent: [ Base]', 12],
    [['- type: entity', '  components:', '  - type: Sprite'], '    sprite: "Objects/Test.rsi"', 12],
    [['- type: entity', '  components:', '  - type: Sprite'], "    sprite: 'Objects/Test.rsi'", 13],
    [['- type: entity'], '  parent: [Base.foo]', 20],
  ] as const) {
    const lines = [...before, line];
    assert.equal(yamlCompletionContext(lines, lines.length, column), null, line);
  }
});

test('existing component type key is never replaced by an entry completion', () => {
  const lines = ['- type: entity', '  components:', '  - type: Sprite'];
  for (const column of [4, 5, 6, 7, 8, 9]) {
    assert.equal(yamlCompletionContext(lines, 3, column), null, `column ${column}`);
  }
});

test('existing component mapping keys are never replaced by entry completions', () => {
  for (const line of ['  - Sprite: value', '  - Sprite  : value', '  - type: Sprite']) {
    const lines = ['- type: entity', '  components:', line];
    for (let column = 4; column <= line.indexOf(':') + 1; column++) {
      assert.equal(yamlCompletionContext(lines, 3, column), null, `${line} at ${column}`);
    }
  }
});

test('asynchronous completions are discarded when the model changes', async () => {
  let version = 1;
  let line = '    sca';
  const model = { getVersionId: () => version, getLineContent: () => line };
  let resolve!: (value: string[]) => void;
  const pending = yamlCurrentCompletion(model, () => new Promise<string[]>((done) => { resolve = done; }));
  line = '    state: icon';
  version++;
  resolve(['scale']);
  assert.equal(await pending, null);
  assert.deepEqual(await yamlCurrentCompletion(model, async () => ['scale']), ['scale']);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { componentHoverMarkdown, componentYamlExample, sampleYamlValue } from '../src/editor/component-hover';
import type { CSharpDefinition } from '../src/lib/api';

const fixture: CSharpDefinition = {
  kind: 'component', name: 'Sprite', class_name: 'SpriteComponent',
  qualified_name: 'Content.Shared.SpriteComponent', file: 'Shared/SpriteComponent.cs',
  line: 10, partial: false, base_types: 'Component', parse_uncertain: false,
  fields: [
    { name: 'visible', member: 'Visible', field_type: 'bool', line: 12, required: true, explicit_name: false },
    { name: 'sprite', member: 'Sprite', field_type: 'string', line: 13, required: false, explicit_name: false },
    { name: 'state', member: 'State', field_type: 'string', line: 14, required: false, explicit_name: false },
  ],
};

test('Electron sample templates keep familiar values for direct C# fields', () => {
  assert.equal(sampleYamlValue({ name: 'enabled', field_type: 'bool' }), 'true');
  assert.equal(sampleYamlValue({ name: 'sprite', field_type: 'string' }), '_Example/Path/example.rsi');
  assert.equal(sampleYamlValue({ name: 'state', field_type: 'string' }), 'icon');
  assert.equal(sampleYamlValue({ name: 'progress', field_type: 'float' }), '1.0');
  assert.equal(sampleYamlValue({ name: 'count', field_type: 'int' }), '1');
  assert.equal(sampleYamlValue({ name: 'groups', field_type: 'List<string>' }), '[]');
});

test('hover exposes C# source, required fields and example YAML', () => {
  const shown = componentHoverMarkdown(fixture);
  assert.match(shown, /SpriteComponent/);
  assert.match(shown, /visible.*bool.*обязательно/);
  assert.match(shown, /\x60\x60\x60yaml\n- type: Sprite\n  visible: true/);
  assert.match(shown, /не.*наследования/);
});

test('source field names cannot insert another markdown code fence', () => {
  const modified: CSharpDefinition = {
    ...fixture, name: 'Sprit\x60e',
    fields: [{ ...fixture.fields[0], name: 'bad\x60name' }],
  };
  assert.doesNotMatch(componentYamlExample(modified), /\x60/);
});

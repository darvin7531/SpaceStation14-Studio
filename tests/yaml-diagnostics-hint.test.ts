import assert from 'node:assert/strict';
import test from 'node:test';
import { yamlSyntaxHint } from '../src/lib/yaml-diagnostics-hint';

test('only invalid YAML gets general repair guidance', () => {
  assert.equal(yamlSyntaxHint(true), null);
  assert.match(yamlSyntaxHint(false) ?? '', /отступы, двоеточия и парные скобки/);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { parseYamlDiagnostics } from '../src/lib/yamlDiagnostics';

test('reports YAML parser errors with a readable line, column and guidance', () => {
  const diagnostics = parseYamlDiagnostics('- type: entity\n  id: Broken\n  components: [Sprite\n');

  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].level, 'error');
  assert.equal(diagnostics[0].line, 4);
  assert.match(diagnostics[0].message, /Flow sequence.*end with a \]/i);
  assert.match(diagnostics[0].hint, /закройте.*\]/i);
});

test('returns no parser diagnostics for valid YAML', () => {
  assert.deepEqual(parseYamlDiagnostics('- type: entity\n  id: Valid\n'), []);
});

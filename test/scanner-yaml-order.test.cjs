const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { scanProject } = require('../electron/scanner.cjs');

test('indexes and reads prototype blocks when type is not the first YAML key', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ss14-studio-scan-'));
  const file = path.join(root, 'Resources', 'Prototypes', 'mixed.yml');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '- id: First\n  type: entity\n- type: entity\n  id: Second\n', 'utf8');

  try {
    const result = scanProject(root);
    assert.equal(result.prototypes['entity:First']._line, 1);
    assert.match(result.prototypes['entity:First']._rawYaml, /^- id: First/m);
    assert.equal(result.prototypes['entity:Second']._line, 3);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { savePrototypeBlock } = require('../electron/scanner.cjs');

test('saves a valid prototype block when id comes before type', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ss14-studio-save-'));
  const relativePath = 'Resources/Prototypes/test.yml';
  const file = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '- id: Existing\n  type: entity\n  name: Before\n- type: entity\n  id: Other\n', 'utf8');

  try {
    const result = savePrototypeBlock({
      projectRoot: root,
      filePath: relativePath,
      line: 1,
      text: '- id: Existing\n  type: entity\n  name: After',
    });
    assert.match(result.text, /name: After/);
    assert.match(fs.readFileSync(file, 'utf8'), /name: After/);
    assert.match(fs.readFileSync(file, 'utf8'), /id: Other/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

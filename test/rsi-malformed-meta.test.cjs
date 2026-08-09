const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { scanProject } = require('../electron/scanner.cjs');

test('keeps malformed RSI metadata inspectable without crashing consumers', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ss14-studio-rsi-'));
  const metaFile = path.join(root, 'Resources', 'Textures', 'broken.rsi', 'meta.json');
  fs.mkdirSync(path.dirname(metaFile), { recursive: true });
  fs.mkdirSync(path.join(root, 'Resources', 'Prototypes'), { recursive: true });
  fs.writeFileSync(metaFile, `\uFEFF${JSON.stringify({ version: 1, size: { x: 32, y: 32 }, states: { invalid: true } })}`, 'utf8');

  try {
    const rsi = scanProject(root).rsis['Resources/Textures/broken.rsi'];
    assert.ok(Array.isArray(rsi.meta.states));
    assert.ok(rsi._issues.some((issue) => issue.field === 'meta.states'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

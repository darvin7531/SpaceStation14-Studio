const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createExternalRsi, createExternalLocale } = require('../electron/scanner.cjs');

test('creates RSI folder outside a project without an active index', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ss14-external-rsi-'));
  const target = path.join(root, 'icons', 'standalone.rsi');
  try {
    const result = createExternalRsi(target, { sizeX: 32, sizeY: 32, license: 'CC0-1.0', copyright: 'tester' });
    assert.equal(result.dirPath, target);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(target, 'meta.json'), 'utf8')).size, { x: 32, y: 32 });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('creates FTL outside a project without an active index', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ss14-external-locale-'));
  const target = path.join(root, 'ru-RU.ftl');
  try {
    const result = createExternalLocale(target, { locale: 'ru-RU', starterKey: 'hello', starterValue: 'Привет' });
    assert.equal(result.filePath, target);
    assert.equal(fs.readFileSync(target, 'utf8'), 'hello = Привет\n');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

const assert = require('node:assert/strict');
const test = require('node:test');
const { inspectPng } = require('../electron/png.cjs');

test('rejects non-PNG input before an RSI import mutates files', () => {
  assert.throws(() => inspectPng(Buffer.from('not a png')), /PNG/i);
});

test('reads PNG dimensions from a valid IHDR header', () => {
  const png = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]).copy(png);
  png.writeUInt32BE(64, 16);
  png.writeUInt32BE(32, 20);
  assert.deepEqual(inspectPng(png), { width: 64, height: 32 });
});

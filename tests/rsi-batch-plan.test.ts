import assert from 'node:assert/strict';
import test from 'node:test';
import { planRsiBatch, pngHeaderSize } from '../src/lib/rsi-batch-plan';

const cell = { x: 32, y: 32 };
const file = (name: string, width = 32, height = 32) => ({ name, width, height, bytes: 1024 });

test('old multi-PNG RSI drop maps distinct PNG filenames to native state requests', () => {
  assert.deepEqual(planRsiBatch([file('idle.png'), file('walk.png', 128, 32)],
    cell, 1, new Set()), [
    { name: 'idle', directions: 1, frames: 1 },
    { name: 'walk', directions: 1, frames: 4 },
  ]);
  assert.deepEqual(planRsiBatch([file('walk.png', 128, 32)], cell, 4, new Set()), [
    { name: 'walk', directions: 4, frames: 1 },
  ]);
});

test('refuses duplicate states, unsafe filenames and oversize batches before any write', () => {
  assert.throws(() => planRsiBatch([file('idle.png')], cell, 1, new Set(['idle'])), /уже существует/);
  assert.throws(() => planRsiBatch([file('walk.png'), file('walk.png')], cell, 1, new Set()), /повторяется/);
  assert.throws(() => planRsiBatch([file('../walk.png')], cell, 1, new Set()), /имя PNG/);
  assert.throws(() => planRsiBatch([file('Walk.png')], cell, 1, new Set()), /имя PNG/);
  assert.throws(() => planRsiBatch([{ ...file('large.png'), bytes: 9 * 1024 * 1024 }], cell, 1, new Set()), /8 МиБ/);
  assert.throws(() => planRsiBatch(Array.from({length: 17}, (_, i) => file('a' + i + '.png')),
    cell, 1, new Set()), /16 PNG/);
});

test('existing states require explicit replacement approval; duplicate inputs remain forbidden', () => {
  const existing = new Set(['idle']);
  assert.throws(() => planRsiBatch([file('idle.png')], cell, 1, existing), /уже существует/);
  assert.deepEqual(planRsiBatch([file('idle.png'), file('walk.png')], cell, 1, existing, 'ru', true), [
    { name: 'idle', directions: 1, frames: 1 },
    { name: 'walk', directions: 1, frames: 1 },
  ]);
  assert.throws(() => planRsiBatch([file('idle.png'), file('idle.png')], cell, 1, existing, 'ru', true), /повторяется/);
  assert.throws(() => planRsiBatch([file('idle.png', 33)], cell, 1, existing, 'ru', true), /не кратен/);
});

test('uppercase PNG extensions import and still require replacement approval', () => {
  assert.deepEqual(planRsiBatch([file('walk.PNG')], cell, 1, new Set()), [
    { name: 'walk', directions: 1, frames: 1 },
  ]);
  assert.throws(() => planRsiBatch([file('idle.PNG')], cell, 1, new Set(['idle'])), /уже существует/);
  assert.throws(() => planRsiBatch([file('walk.png'), file('walk.PNG')], cell, 1, new Set()), /повторяется/);
});

test('preflight catches incompatible PNG grids and per-direction frame overflow', () => {
  assert.throws(() => planRsiBatch([file('bad.png', 34)], cell, 1, new Set()), /не кратен/);
  assert.throws(() => planRsiBatch([file('bad.png')], cell, 4, new Set()), /направлениям/);
  assert.throws(() => planRsiBatch([file('long.png', 32 * 129)], cell, 1, new Set()), /направлениям/);
});

test('IHDR reads dimensions from the actual PNG header without trusting filename metadata', () => {
  const png = new Uint8Array(24);
  png.set([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82]);
  new DataView(png.buffer).setUint32(16, 64);
  new DataView(png.buffer).setUint32(20, 32);
  assert.deepEqual(pngHeaderSize(png), {width: 64, height: 32});
  png[12] = 0;
  assert.equal(pngHeaderSize(png), null);
  assert.equal(pngHeaderSize(new Uint8Array(6)), null);
});

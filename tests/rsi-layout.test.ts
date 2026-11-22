import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildRsiFrameLayout, isRsiLayoutError, parseRsiMetadata, regroupRsiDelays, RSI_DIRECTIONS,
} from '../src/lib/rsi-layout';

test('parses supported RSI v1 metadata and preserves direction-specific delays', () => {
  const result = parseRsiMetadata(JSON.stringify({
    version: 1,
    size: { x: 32, y: 32 },
    license: 'CC0-1.0',
    copyright: '',
    states: [{
      name: 'walk',
      directions: 4,
      delays: [[0.1, 0.2], [0.3], [0.4, 0.5], [0.6]],
    }],
  }));
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.states.length, 1);
  assert.deepEqual(result.states[0].delays, [[0.1, 0.2], [0.3], [0.4, 0.5], [0.6]]);
  assert.equal(RSI_DIRECTIONS[0], 'Юг');
  assert.equal(RSI_DIRECTIONS[3], 'Запад');
});

test('maps frames row-major, grouped by direction, not interleaved', () => {
  const state = parseRsiMetadata(JSON.stringify({
    version: 1, size: { x: 32, y: 16 },
    states: [{
      name: 'run', directions: 4,
      delays: [[0.1, 0.2], [0.3], [0.4, 0.5], [0.6]],
    }],
  })).states[0];
  const layout = buildRsiFrameLayout({ x: 32, y: 16 }, state, 96, 32);
  assert.equal(isRsiLayoutError(layout), false);
  if (isRsiLayoutError(layout)) throw new Error(layout.error);
  assert.deepEqual(layout.directions.map((frames) => frames.map(({ x, y }) => [x, y])), [
    [[0, 0], [32, 0]],
    [[64, 0]],
    [[0, 16], [32, 16]],
    [[64, 16]],
  ]);
  assert.equal(layout.directions[2][1].duration, 0.5);
});

test('static four-direction state maps one cell per direction', () => {
  const state = parseRsiMetadata(JSON.stringify({
    version: 1, size: { x: 32, y: 32 },
    states: [{ name: 'idle', directions: 4 }],
  })).states[0];
  const layout = buildRsiFrameLayout({ x: 32, y: 32 }, state, 64, 64);
  if (isRsiLayoutError(layout)) throw new Error(layout.error);
  assert.deepEqual(layout.directions.map((frames) => frames.length), [1, 1, 1, 1]);
  assert.deepEqual(layout.directions[3][0], {
    x: 32, y: 32, duration: 1, directionIndex: 3, frameIndex: 0,
  });
});

test('invalid states are skipped with precise warnings but do not hide valid states', () => {
  const metadata = parseRsiMetadata(JSON.stringify({
    version: 1, size: { x: 16, y: 16 },
    states: [
      { name: 'valid' },
      { name: 'valid' },
      { name: '../escape' },
      { name: 'bad_direction', directions: 2 },
      { name: 'bad_time', directions: 1, delays: [[0]] },
      { name: 'animated', directions: 1, delays: [[0.1, 0.2]] },
    ],
  }));
  assert.deepEqual(metadata.states.map((state) => state.name), ['valid', 'animated']);
  assert.equal(metadata.warnings.length, 4);
  assert.equal(metadata.errors.length, 0);
});

test('malformed JSON, dimensions, state arrays and too many states are bounded', () => {
  const invalid = parseRsiMetadata('{oops');
  assert.equal(invalid.states.length, 0);
  assert.equal(invalid.errors.length, 1);
  const badSize = parseRsiMetadata(JSON.stringify({
    size: { x: -1, y: 32 }, states: [],
  }));
  assert.equal(badSize.size, null);
  assert.ok(badSize.errors.some((error) => error.includes('size.x')));
  const noStates = parseRsiMetadata('{"version":1,"size":{"x":32,"y":32},"states":"wrong"}');
  assert.ok(noStates.errors.length > 0);
  const huge = parseRsiMetadata(JSON.stringify({
    version: 1, size: { x: 1, y: 1 },
    states: Array.from({ length: 513 }, (_, index) => ({ name: 'state' + index })),
  }));
  assert.ok(huge.errors.some((message) => message.includes('слишком много')));
});

test('disallows partial cells, underfilled sheets and oversized images', () => {
  const state = parseRsiMetadata(JSON.stringify({
    version: 1, size: { x: 32, y: 32 },
    states: [{ name: 'test', directions: 4 }],
  })).states[0];
  const wrongPixelCount = buildRsiFrameLayout({ x: 32, y: 32 }, state, 65, 64);
  assert.equal(isRsiLayoutError(wrongPixelCount), true);
  const fewerCells = buildRsiFrameLayout({ x: 32, y: 32 }, state, 32, 32);
  assert.equal(isRsiLayoutError(fewerCells), true);
  const oversized = buildRsiFrameLayout({ x: 32, y: 32 }, state, 20000, 32);
  assert.equal(isRsiLayoutError(oversized), true);
});

test('extra sheet padding never creates phantom animation frames', () => {
  const state = parseRsiMetadata(JSON.stringify({
    version: 1, size: { x: 16, y: 16 },
    states: [{ name: 'one' }],
  })).states[0];
  const layout = buildRsiFrameLayout({ x: 16, y: 16 }, state, 32, 16);
  if (isRsiLayoutError(layout)) throw new Error(layout.error);
  assert.equal(layout.directions[0].length, 1);
  assert.equal(layout.warnings.length, 1);
});


test('regroups only existing frames and preserves unsaved edits when switching back', () => {
  const original = [[0.1, 0.2], [0.3], [0.4, 0.5], [0.6, 0.7, 0.8]];
  const edited = [[0.9, 0.2], ...original.slice(1)];
  const one = regroupRsiDelays(edited, original, 1);
  assert.deepEqual(one, [[0.9, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]]);
  assert.deepEqual(regroupRsiDelays(one!, original, 4), edited);
  assert.equal(regroupRsiDelays([[1, 2, 3, 4, 5]], [[1, 2, 3, 4, 5]], 4), null);
});

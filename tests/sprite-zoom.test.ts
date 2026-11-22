import test from 'node:test';
import assert from 'node:assert/strict';
import { spriteZoom, SPRITE_DEFAULT_ZOOM } from '../src/lib/sprite-zoom';

test('sprite preview zoom steps by half and stays within Electron limits', () => {
  assert.equal(SPRITE_DEFAULT_ZOOM, 4);
  assert.equal(spriteZoom(4, 1), 4.5);
  assert.equal(spriteZoom(4, -1), 3.5);
  assert.equal(spriteZoom(0.5, -1), 0.5);
  assert.equal(spriteZoom(16, 1), 16);
  assert.equal(spriteZoom(NaN, 1), 4);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { toggleRsiImportMode } from '../src/lib/rsi-import-mode';

test('switching modes clears the file both ways', () => {
  assert.deepEqual(toggleRsiImportMode(true), { metadataOnly: true, file: null });
  assert.deepEqual(toggleRsiImportMode(false), { metadataOnly: false, file: null });
});

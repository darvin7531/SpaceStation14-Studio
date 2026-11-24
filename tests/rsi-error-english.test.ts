import assert from 'node:assert/strict';
import test from 'node:test';
import { rsiErrorText } from '../src/lib/rsi-error-text';

const error = (code: string) => ({ code, message: 'Русское сообщение', hint: 'Русская подсказка', details: 'disk detail' });
test('RSI error codes explain the failure and recovery in English', () => {
  assert.match(rsiErrorText(error('RSI_IMPORT_PNG_SIZE_MISMATCH'), 'en'), /PNG.*frames/i);
  assert.match(rsiErrorText(error('RSI_RENAME_STATE_EXISTS'), 'en'), /choose.*name/i);
  assert.match(rsiErrorText(error('RSI_RENAME_CLEANUP_REQUIRED'), 'en'), /inspect.*manually/i);
  assert.match(rsiErrorText(error('RSI_IMPORT_FILE_EXTENSION'), 'en'), /PNG/i);
  assert.doesNotMatch(rsiErrorText(error('toString'), 'en'), /Русск|function/);
  assert.match(rsiErrorText(error('UNKNOWN'), 'en'), /technical details/i);
  assert.equal(rsiErrorText(error('UNKNOWN'), 'ru'), 'Русское сообщение Русская подсказка');
});

test('timing guidance distinguishes import settings from existing attach metadata', () => {
  const timing = rsiErrorText(error('RSI_IMPORT_TIMING_INVALID'), 'en');
  assert.match(timing, /importing.*128.*256.*0\.01–60/i);
  assert.match(timing, /attaching.*4096.*greater than 0.*3600/i);
  assert.doesNotMatch(timing, /repair|edit|change.*metadata/i);
});

test('grid guidance distinguishes exact import grids from attach capacity', () => {
  const grid = rsiErrorText(error('RSI_IMPORT_PNG_SIZE_MISMATCH'), 'en');
  assert.match(grid, /importing.*exactly/i);
  assert.match(grid, /attaching allows extra cells.*fit all frames/i);
});

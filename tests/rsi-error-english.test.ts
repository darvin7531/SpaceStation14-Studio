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

import assert from 'node:assert/strict';
import test from 'node:test';
import { refreshAfterRsiImport } from '../src/lib/rsi-import-refresh';

test('failed import refreshes authoritative data and retains recovery details', async () => {
  const errors: any[] = [];
  let value = '';
  await refreshAfterRsiImport('a', () => 'a', async () => 'disk', (v) => { value = v; },
    (e) => errors.push(e), { code: 'FAILED', message: 'failed', hint: 'recover', details: 'archive path' });
  assert.equal(value, 'disk');
  assert.equal(errors[0].details, 'archive path');
});

test('a switched project never receives a delayed refresh', async () => {
  let root = 'a';
  let applied = false;
  await refreshAfterRsiImport('a', () => root, async () => { root = 'b'; return 'disk'; },
    () => { applied = true; }, () => assert.fail('unexpected error'));
  assert.equal(applied, false);
});

test('refresh failure preserves the operation recovery details', async () => {
  const errors: any[] = [];
  await refreshAfterRsiImport('a', () => 'a', async () => { throw new Error('read failed'); },
    () => assert.fail('unexpected result'), (e) => errors.push(e),
    { code: 'FAILED', message: 'failed', hint: 'recover', details: 'archive path' });
  assert.match(errors[1].details, /archive path/);
  assert.match(errors[1].details, /read failed/);
});

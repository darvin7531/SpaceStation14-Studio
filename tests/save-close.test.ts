import assert from 'node:assert/strict';
import test from 'node:test';
import { saveAndClose } from '../src/lib/save-close';

test('save and close waits for save and cleanup before closing', async () => {
  const events: string[] = [];
  await saveAndClose({ current: () => true, save: async () => { events.push('save'); },
    cleanup: async () => { events.push('cleanup'); }, close: () => { events.push('close'); } });
  assert.deepEqual(events, ['save', 'cleanup', 'close']);
});

test('save and close does not close after failure or a stale operation', async () => {
  let closes = 0;
  await assert.rejects(saveAndClose({ current: () => true, save: async () => { throw Error('conflict'); },
    cleanup: async () => {}, close: () => { closes++; } }), /conflict/);
  let current = true;
  await assert.rejects(saveAndClose({ current: () => current, save: async () => { current = false; },
    cleanup: async () => {}, close: () => { closes++; } }), /измен/);
  assert.equal(closes, 0);
});

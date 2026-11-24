import assert from 'node:assert/strict';
import test from 'node:test';
import { saveAndClose, deleteDraftPreservingChanges, closeCurrentTab } from '../src/lib/save-close';

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


test('a newer draft arriving during journal deletion is persisted and prevents close', async () => {
  let draft = 'submitted';
  let journal = 'submitted';
  let release!: () => void;
  let started!: () => void;
  const deleting = new Promise<void>((resolve) => { started = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let closed = false;
  const operation = saveAndClose({
    current: () => draft === 'submitted',
    save: async () => {},
    cleanup: () => deleteDraftPreservingChanges(async () => {
      started(); await gate; journal = '';
    }, () => draft, 'submitted', async (content) => { journal = content; }),
    close: () => { closed = true; },
  });
  await deleting;
  draft = 'newer';
  release();
  await assert.rejects(operation, /измен/);
  assert.equal(journal, 'newer');
  assert.equal(closed, false);
});

test('edits during recovery restoration are persisted before returning', async () => {
  let draft = 'newer';
  const writes: string[] = [];
  await deleteDraftPreservingChanges(async () => {}, () => draft, 'submitted', async (content) => {
    writes.push(content);
    if (content === 'newer') draft = 'newest';
  });
  assert.deepEqual(writes, ['newer', 'newest']);
});


test('closing after an async save retains a recovery tab opened meanwhile', async () => {
  let tabs: import('../src/lib/tabs').TabState = { tabs: [{ path: 'a.yaml', kind: 'yaml' }], active: 'a.yaml' };
  await saveAndClose({
    current: () => true,
    save: async () => { tabs = { tabs: [...tabs.tabs, { path: 'recovered.yaml', kind: 'yaml' }], active: 'recovered.yaml' }; },
    cleanup: async () => {},
    close: () => { tabs = closeCurrentTab(() => tabs, 'a.yaml'); },
  });
  assert.deepEqual(tabs.tabs.map((tab) => tab.path), ['recovered.yaml']);
  assert.equal(tabs.active, 'recovered.yaml');
});

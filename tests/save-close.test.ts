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


test('reverting during recovery persistence cannot leave a stale draft before close', async () => {
  let draft = 'A';
  let journal: string | undefined = 'A';
  let started!: () => void;
  let release!: () => void;
  const writing = new Promise<void>((resolve) => { started = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let closed = false;
  const operation = saveAndClose({
    current: () => draft === 'A',
    save: async () => {},
    cleanup: () => deleteDraftPreservingChanges(async () => { journal = undefined; draft = 'B'; },
      () => draft, 'A', async (content) => {
        if (content === 'B') { started(); await gate; }
        journal = content;
      }),
    close: () => { closed = true; },
  });
  await writing;
  draft = 'A';
  release();
  await operation;
  assert.notEqual(journal, 'B');
  assert.equal(closed, true);
});

test('edits during persistence of a reverted draft are preserved and prevent close', async () => {
  let draft = 'A';
  let journal: string | undefined = 'A';
  let closed = false;
  const operation = saveAndClose({
    current: () => draft === 'A',
    save: async () => {},
    cleanup: () => deleteDraftPreservingChanges(async () => { journal = undefined; draft = 'B'; },
      () => draft, 'A', async (content) => {
        journal = content;
        if (content === 'B') draft = 'A';
        else if (content === 'A') draft = 'C';
      }),
    close: () => { closed = true; },
  });
  await assert.rejects(operation, /измен/);
  assert.equal(journal, 'C');
  assert.equal(closed, false);
});

test('failure persisting a reverted draft prevents close', async () => {
  let draft = 'A';
  let journal: string | undefined = 'A';
  let closed = false;
  await assert.rejects(saveAndClose({
    current: () => draft === 'A',
    save: async () => {},
    cleanup: () => deleteDraftPreservingChanges(async () => { journal = undefined; draft = 'B'; },
      () => draft, 'A', async (content) => {
        if (content === 'A') throw Error('revert persistence failed');
        journal = content;
        draft = 'A';
      }),
    close: () => { closed = true; },
  }), /revert persistence failed/);
  assert.equal(journal, 'B');
  assert.equal(closed, false);
});

test('recovery deletion and persistence failures prevent close', async () => {
  for (const failure of ['delete', 'persist']) {
    let draft = 'A';
    let journal: string | undefined = 'A';
    let closed = false;
    await assert.rejects(saveAndClose({
      current: () => draft === 'A',
      save: async () => {},
      cleanup: () => deleteDraftPreservingChanges(async () => {
        draft = 'B';
        if (failure === 'delete') throw Error('delete failed');
        journal = undefined;
      }, () => draft, 'A', async (content) => {
        if (failure === 'persist') throw Error('persist failed');
        journal = content;
      }),
      close: () => { closed = true; },
    }), new RegExp(`${failure} failed`));
    assert.equal(closed, false);
    if (failure === 'delete') assert.equal(journal, 'B');
  }
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

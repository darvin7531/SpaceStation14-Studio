import assert from 'node:assert/strict';
import test from 'node:test';
import { persistExitRecovery } from '../src/lib/exit-recovery';
import { DraftWriteQueue, journalKey } from '../src/lib/draft-queue';
import type { ResourceDocument } from '../src/lib/api';

function document(path: string, revision: string): ResourceDocument {
  return { path, revision, content: 'old', bytes: 3 };
}

test('exit recovery persists every latest dirty draft using its original revision', async () => {
  const queue = new DraftWriteQueue();
  const saved: string[] = [];
  await persistExitRecovery({
    root: '/game', paths: ['a.yml', 'b.ftl'],
    documents: new Map([['a.yml', document('a.yml', 'disk-a')], ['b.ftl', document('b.ftl', 'disk-b')]]),
    drafts: { 'a.yml': 'updated', 'b.ftl': 'translated' },
    bases: { 'a.yml': 'edited-before-external-change' },
    queue,
    persist: async (path, base, content) => {
      saved.push([path, base, content].join('|'));
      return { durability_warning: null };
    },
  });
  assert.deepEqual(saved.sort(), ['a.yml|edited-before-external-change|updated', 'b.ftl|disk-b|translated']);
});

test('exit recovery queues behind older autosaves, so the latest draft wins', async () => {
  const queue = new DraftWriteQueue();
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const saved: string[] = [];
  const old = queue.run(journalKey('/game', 'a.yml'), async () => {
    await held;
    saved.push('outdated');
  });
  const latest = persistExitRecovery({
    root: '/game', paths: ['a.yml'],
    documents: new Map([['a.yml', document('a.yml', 'base')]]),
    drafts: { 'a.yml': 'latest' }, bases: {}, queue,
    persist: async (_path, _base, content) => {
      saved.push(content);
      return {};
    },
  });
  release();
  await Promise.all([old, latest]);
  assert.deepEqual(saved, ['outdated', 'latest']);
});

test('exit must remain open for missing drafts, sync warnings, or disk failures', async () => {
  const common = {
    root: '/game', paths: ['a.yml'],
    documents: new Map([['a.yml', document('a.yml', 'rev')]]),
    bases: {}, queue: new DraftWriteQueue(),
  };
  await assert.rejects(persistExitRecovery({
    ...common, drafts: {}, persist: async () => ({}),
  }), /недоступны/);
  await assert.rejects(persistExitRecovery({
    ...common, drafts: { 'a.yml': 'latest' },
    persist: async () => ({ durability_warning: 'fsync failed' }),
  }), /fsync failed/);
  await assert.rejects(persistExitRecovery({
    ...common, drafts: { 'a.yml': 'latest' },
    persist: async () => { throw new Error('disk error'); },
  }), /disk error/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { DraftWriteQueue, journalKey } from '../src/lib/draft-queue';

test('serialization prevents old autosave from resurrecting discarded draft', async () => {
  const queue = new DraftWriteQueue();
  const sequence: string[] = [];
  let finishWrite: (() => void) | undefined;
  const pause = new Promise<void>((resolve) => { finishWrite = resolve; });
  let markStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const write = queue.run('project:A', async () => {
    sequence.push('save started');
    markStarted?.();
    await pause;
    sequence.push('save finished');
  });
  const remove = queue.run('project:A', async () => {
    sequence.push('delete');
  });
  await started;
  assert.deepEqual(sequence, ['save started']);
  finishWrite?.();
  await Promise.all([write, remove]);
  assert.deepEqual(sequence, ['save started', 'save finished', 'delete']);
});

test('failed operation does not permanently block its queue', async () => {
  const queue = new DraftWriteQueue();
  await assert.rejects(queue.run('k', async () => { throw new Error('disk full'); }));
  const next = await queue.run('k', async () => 42);
  assert.equal(next, 42);
});

test('different files are not serialized against each other', async () => {
  const queue = new DraftWriteQueue();
  let resolveFirst: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { resolveFirst = resolve; });
  const first = queue.run('a', async () => { await gate; return 1; });
  const second = await queue.run('b', async () => 2);
  assert.equal(second, 2);
  resolveFirst?.();
  assert.equal(await first, 1);
});

test('journal keys distinguish project/path pairs without delimiter collisions', () => {
  assert.notEqual(journalKey('a:b', 'c'), journalKey('a', 'b:c'));
});

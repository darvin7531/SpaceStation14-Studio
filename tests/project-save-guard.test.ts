import assert from 'node:assert/strict';
import test from 'node:test';
import { completeProjectSave } from '../src/lib/project-save-guard';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test('a late save cannot update or remove recovery from a replaced project, even at the same root', async () => {
  const ipc = deferred<string>();
  let generation = 1;
  const effects: string[] = [];
  const done = completeProjectSave(ipc.promise, () => generation === 1,
    (value) => { effects.push(value); }, async () => { effects.push('delete recovery'); });
  generation++;
  ipc.resolve('saved');
  assert.equal(await done, false);
  assert.deepEqual(effects, []);
});

test('a switch while recovery deletion is pending prevents further completion', async () => {
  const deletion = deferred<void>();
  let generation = 1;
  const effects: string[] = [];
  const done = completeProjectSave(Promise.resolve('saved'), () => generation === 1,
    (value) => { effects.push(value); }, () => deletion.promise);
  await Promise.resolve();
  generation++;
  deletion.resolve();
  assert.equal(await done, false);
  assert.deepEqual(effects, ['saved']);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { importRsiBatch, readBatchOutcomes, writeBatchOutcomes } from '../src/lib/rsi-batch-import';
import type { RsiMetadata } from '../src/lib/rsi-layout';

const inspection: RsiMetadata = {
  size: { x: 32, y: 32 }, errors: [], warnings: [],
  states: [{ name: 'idle', directions: 1, delays: [[0.2]] }],
};

function png(name: string, width = 32): File {
  const bytes = new Uint8Array(24);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, 32);
  return Object.assign(new Blob([bytes]), { name }) as File;
}

function setup(handler: (command: string, args: any) => unknown) {
  const calls: { command: string; args: any }[] = [];
  (globalThis as any).window = { __TAURI_INTERNALS__: { invoke: async (command: string, args: any) => {
    calls.push({ command, args });
    return handler(command, args);
  } } };
  let refreshes = 0;
  const options = {
    projectRoot: '/project-a', path: 'test.rsi', revision: 'meta-0', inspection,
    files: [png('idle.png'), png('walk.png')], directions: 1 as const, delay: 0.1,
    replaceExisting: true, readPng: async (file: File) => 'data:' + file.name,
    refresh: async () => { refreshes++; }, onProgress: (_message: string) => {},
  };
  return { calls, options, refreshes: () => refreshes };
}

test('confirmed replacements and new states invoke native commands with chained revisions', async () => {
  const ctx = setup((command) => {
    if (command === 'read_rsi_sheet_bound') return { revision: 'png-0' };
    if (command === 'replace_rsi_state') return { revision: 'meta-1', archive_path: 'archive/idle', warning: 'notice' };
    if (command === 'import_rsi_state') return { revision: 'meta-2' };
    throw Error('unexpected command ' + command);
  });
  const result = await importRsiBatch(ctx.options);
  assert.deepEqual(ctx.calls.map((call) => call.command), ['read_rsi_sheet_bound', 'replace_rsi_state', 'import_rsi_state']);
  assert.deepEqual(ctx.calls[0].args, { path: 'test.rsi', name: 'idle.png', expectedProjectRoot: '/project-a' });
  assert.deepEqual(ctx.calls[1].args.request, {
    path: 'test.rsi', expected_revision: 'meta-0', expected_png_revision: 'png-0',
    name: 'idle', directions: 1, frames_per_direction: 1, delay_seconds: 0.1,
    data_url: 'data:idle.png', delays: [[0.2]],
  });
  assert.deepEqual(ctx.calls[2].args.request, {
    path: 'test.rsi', expected_revision: 'meta-1', name: 'walk', directions: 1,
    frames_per_direction: 1, delay_seconds: 0.1, data_url: 'data:walk.png',
  });
  assert.equal(ctx.refreshes(), 1);
  assert.equal(result.attempted, true);
  assert.match(result.outcome, /Импортировано 2 из 2/);
  assert.match(result.outcome, /idle: archive\/idle/);
  assert.match(result.outcome, /idle: notice/);
});

test('replacement without confirmation stops before snapshot or write', async () => {
  const ctx = setup(() => { throw Error('must not invoke'); });
  ctx.options.replaceExisting = false;
  const result = await importRsiBatch(ctx.options);
  assert.deepEqual(ctx.calls, []);
  assert.equal(ctx.refreshes(), 0);
  assert.equal(result.attempted, false);
  assert.match(result.outcome, /подтвердите замену/);
});

test('failed write refreshes and preserves partial successes and archive error details', async () => {
  const ctx = setup((command) => {
    if (command === 'read_rsi_sheet_bound') return { revision: 'png-0' };
    if (command === 'replace_rsi_state') return { revision: 'meta-1', archive_path: 'archive/saved', warning: 'kept' };
    throw { message: 'write failed', hint: 'restore archive', code: 'WRITE_FAILED', details: 'archive/failed' };
  });
  ctx.options.files.push(png('later.png'));
  ctx.options.refresh = async () => { throw { message: 'refresh failed', code: 'REFRESH' }; };
  const result = await importRsiBatch(ctx.options);
  assert.deepEqual(ctx.calls.map((call) => call.command), ['read_rsi_sheet_bound', 'replace_rsi_state', 'import_rsi_state']);
  assert.equal(result.attempted, true);
  assert.match(result.outcome, /Импортировано 1 из 3/);
  for (const detail of ['write failed', 'restore archive', 'WRITE_FAILED', 'archive/failed',
    'archive/saved', 'kept', 'refresh failed', 'REFRESH']) assert.ok(result.outcome.includes(detail), detail);
});

test('first failed write still refreshes; pre-write snapshot failure does not', async () => {
  const failedWrite = setup((command) => {
    if (command === 'read_rsi_sheet_bound') return { revision: 'png-0' };
    throw { message: 'failed', details: 'archive/rollback' };
  });
  const result = await importRsiBatch(failedWrite.options);
  assert.equal(failedWrite.refreshes(), 1);
  assert.equal(result.attempted, true);
  assert.match(result.outcome, /archive\/rollback/);
  const failedSnapshot = setup(() => { throw Error('snapshot failed'); });
  const preflight = await importRsiBatch(failedSnapshot.options);
  assert.equal(preflight.attempted, false);
  assert.equal(failedSnapshot.refreshes(), 0);
  assert.match(preflight.outcome, /snapshot failed/);
});

test('replacement drops old delays when the frame grid changes', async () => {
  const ctx = setup((command) => command === 'read_rsi_sheet_bound'
    ? { revision: 'png-0' } : { revision: 'meta-1' });
  ctx.options.files = [png('idle.png', 64)];
  await importRsiBatch(ctx.options);
  assert.equal(ctx.calls[1].command, 'replace_rsi_state');
  assert.equal(ctx.calls[1].args.request.frames_per_direction, 2);
  assert.ok(!('delays' in ctx.calls[1].args.request));
});

test('switching projects stops the batch and refresh stays bound to the original root', async () => {
  let active = '/project-a';
  const ctx = setup((command, args) => {
    assert.equal(args.expectedProjectRoot, '/project-a');
    if (active !== args.expectedProjectRoot) throw { code: 'PROJECT_CHANGED', message: 'project changed' };
    if (command === 'read_rsi_sheet_bound') return { revision: 'png-0' };
    active = '/project-b';
    return { revision: 'meta-1' };
  });
  let refreshedRoot = '';
  ctx.options.refresh = async (root?: string) => { refreshedRoot = root ?? ''; };
  const result = await importRsiBatch(ctx.options);
  assert.equal(ctx.calls.length, 3);
  assert.equal(refreshedRoot, '/project-a');
  assert.match(result.outcome, /PROJECT_CHANGED/);
});


test('archived failure after switching projects remains associated with its origin after reload', async () => {
  let active = '/project-a';
  const ctx = setup((command) => {
    if (command === 'read_rsi_sheet_bound') return { revision: 'png-0' };
    if (command === 'replace_rsi_state') {
      active = '/project-b';
      return { revision: 'meta-1', archive_path: 'archive/saved', warning: 'keep backup' };
    }
    throw { code: 'PROJECT_CHANGED', message: 'project changed', details: 'archive/failed' };
  });
  const result = await importRsiBatch(ctx.options);
  let stored = '';
  const storage = { getItem: () => stored, setItem: (_key: string, value: string) => { stored = value; } };
  const entries = [{ projectRoot: ctx.options.projectRoot, path: ctx.options.path, message: result.outcome }];
  assert.equal(active, '/project-b');
  assert.equal(writeBatchOutcomes(storage, entries), true);
  const restored = readBatchOutcomes(storage);
  assert.equal(restored[0].projectRoot, '/project-a');
  assert.equal(restored[0].path, 'test.rsi');
  for (const detail of ['PROJECT_CHANGED', 'archive/saved', 'archive/failed', 'keep backup'])
    assert.ok(restored[0].message.includes(detail), detail);
  writeBatchOutcomes(storage, []);
  assert.deepEqual(readBatchOutcomes(storage), []);
});

test('unavailable or malformed outcome storage does not hide the in-memory warning', () => {
  const storage = { getItem: () => '{', setItem: () => { throw Error('blocked'); } };
  assert.deepEqual(readBatchOutcomes(storage), []);
  assert.equal(writeBatchOutcomes(storage, [{ projectRoot: '/a', path: 'x.rsi', message: 'recover' }]), false);
});

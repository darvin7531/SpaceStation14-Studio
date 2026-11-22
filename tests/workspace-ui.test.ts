import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_WORKSPACE_UI, LAST_PROJECT_KEY, readLastProject, readWorkspaceUi,
  writeWorkspaceUi, workspaceUiKey,
} from '../src/lib/workspace-ui';

function storage() {
  const saved = new Map<string, string>();
  return {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => { saved.set(key, value); },
  };
}

test('Electron restore-last accepts only plausible absolute project paths', () => {
  const store = storage();
  assert.equal(readLastProject(store), null);
  store.setItem(LAST_PROJECT_KEY, '/home/dev/SS14');
  assert.equal(readLastProject(store), '/home/dev/SS14');
  store.setItem(LAST_PROJECT_KEY, 'C:\\Games\\SS14');
  assert.equal(readLastProject(store), 'C:\\Games\\SS14');
  store.setItem(LAST_PROJECT_KEY, '../../another-repo');
  assert.equal(readLastProject(store), null);
  store.setItem(LAST_PROJECT_KEY, '/dir\nother');
  assert.equal(readLastProject(store), null);
});

test('project-scoped Electron navigation state survives session restore', () => {
  const store = storage();
  const saved = { query: 'solars', kind: 'yaml' as const,
    fileView: 'folders' as const, explorerMode: 'prototypes' as const,
    prototypeQuery: 'Door', prototypeKind: 'entity' };
  writeWorkspaceUi(store, '/home/dev/SS14', saved);
  assert.deepEqual(readWorkspaceUi(store, '/home/dev/SS14'), saved);
  assert.deepEqual(readWorkspaceUi(store, '/home/dev/another'), DEFAULT_WORKSPACE_UI);
  const other = { ...saved, prototypeQuery: 'Water', prototypeKind: 'reagent' };
  writeWorkspaceUi(store, '/home/dev/another', other);
  assert.deepEqual(readWorkspaceUi(store, '/home/dev/SS14'), saved);
  assert.deepEqual(readWorkspaceUi(store, '/home/dev/another'), other);
});

test('corrupted, oversized and malicious session values are safely ignored', () => {
  const store = storage();
  store.setItem(workspaceUiKey('/home/a'), '{missing}');
  assert.deepEqual(readWorkspaceUi(store, '/home/a'), DEFAULT_WORKSPACE_UI);
  store.setItem(workspaceUiKey('/home/a'), JSON.stringify({
    query: '\u0000' + 'x'.repeat(500), kind: '__bad__',
    fileView: '__bad__', explorerMode: 'prototypes',
  }));
  assert.deepEqual(readWorkspaceUi(store, '/home/a'), {
    ...DEFAULT_WORKSPACE_UI, explorerMode: 'prototypes',
  });
  store.setItem(workspaceUiKey('/home/a'), 'a'.repeat(4100));
  assert.deepEqual(readWorkspaceUi(store, '/home/a'), DEFAULT_WORKSPACE_UI);
});

test('prototype filters default for older sessions and sanitize invalid values independently', () => {
  const store = storage();
  store.setItem(workspaceUiKey('/home/a'), JSON.stringify({ query: 'file', kind: 'yaml' }));
  assert.deepEqual(readWorkspaceUi(store, '/home/a'), {
    ...DEFAULT_WORKSPACE_UI, query: 'file', kind: 'yaml',
  });
  store.setItem(workspaceUiKey('/home/a'), JSON.stringify({
    prototypeQuery: 'bad\nquery', prototypeKind: 'x'.repeat(257),
  }));
  assert.deepEqual(readWorkspaceUi(store, '/home/a'), DEFAULT_WORKSPACE_UI);
  store.setItem(workspaceUiKey('/home/a'), JSON.stringify({
    prototypeQuery: 'valid', prototypeKind: 42,
  }));
  assert.deepEqual(readWorkspaceUi(store, '/home/a'), {
    ...DEFAULT_WORKSPACE_UI, prototypeQuery: 'valid',
  });
});

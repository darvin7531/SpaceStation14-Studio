import assert from 'node:assert/strict';
import test from 'node:test';
import { reconcileWorkspaceRefresh } from '../src/lib/workspace-refresh';
import type { ResourceDocument, ResourceEntry } from '../src/lib/api';

const file = 'Resources/Prototypes/item.yml';
const second = 'Resources/Prototypes/other.yml';
const tabs: ResourceEntry[] = [
  { path: file, kind: 'yaml' },
  { path: second, kind: 'yaml' },
];
const document = (path: string, content: string, revision: string): ResourceDocument => ({
  path, content, revision, bytes: content.length,
});

test('refresh reloads clean tabs and updates their baseline', () => {
  const before = document(file, 'old', 'a');
  const result = reconcileWorkspaceRefresh(
    [tabs[0]], new Map([[file, before]]), { [file]: 'old' }, { [file]: 'a' },
    [{ path: file, document: document(file, 'new', 'b') }],
  );
  assert.deepEqual(result.reloaded, [file]);
  assert.equal(result.documents.get(file)?.revision, 'b');
  assert.equal(result.drafts[file], 'new');
  assert.equal(result.draftBases[file], undefined);
  assert.equal(before.content, 'old');
});

test('refresh retains dirty text and its original save revision after external edits', () => {
  const old = document(file, 'base', 'base-hash');
  const result = reconcileWorkspaceRefresh(
    [tabs[0]], new Map([[file, old]]),
    { [file]: 'unsaved user changes' }, { [file]: 'base-hash' },
    [{ path: file, document: document(file, 'external changes', 'external-hash') }],
  );
  assert.deepEqual(result.conflicting, [file]);
  assert.equal(result.drafts[file], 'unsaved user changes');
  assert.equal(result.documents.get(file)?.revision, 'external-hash');
  assert.equal(result.draftBases[file], 'base-hash');
  assert.deepEqual(result.reloaded, []);
});

test('refresh does not replace dirty text even if disk is unchanged', () => {
  const old = document(file, 'base', 'hash');
  const result = reconcileWorkspaceRefresh(
    [tabs[0]], new Map([[file, old]]), { [file]: 'draft' }, {},
    [{ path: file, document: document(file, 'base', 'hash') }],
  );
  assert.equal(result.drafts[file], 'draft');
  assert.deepEqual(result.conflicting, []);
  assert.deepEqual(result.reloaded, []);
});

test('deleted and inaccessible files are retained rather than dropping drafts', () => {
  const old = document(file, 'before', 'hash');
  const result = reconcileWorkspaceRefresh(
    [tabs[0]], new Map([[file, old]]), { [file]: 'unsaved' }, { [file]: 'hash' },
    [{ path: file, document: null }],
  );
  assert.deepEqual(result.unavailable, [file]);
  assert.equal(result.documents.get(file), old);
  assert.equal(result.drafts[file], 'unsaved');
  assert.equal(result.draftBases[file], 'hash');
});

test('unrelated tabs are preserved and nonexistent tab reads are ignored', () => {
  const one = document(file, 'old', 'x');
  const two = document(second, 'other', 'y');
  const result = reconcileWorkspaceRefresh(
    tabs, new Map([[file, one], [second, two]]),
    { [file]: 'old', [second]: 'draft other' }, { [second]: 'y' },
    [
      { path: file, document: document(file, 'new', 'z') },
      { path: second, document: document(second, 'external', 'e') },
      { path: 'Resources/Prototypes/not-open.yml', document: document('Resources/Prototypes/not-open.yml', 'ignored', 'i') },
    ],
  );
  assert.deepEqual(result.reloaded, [file]);
  assert.deepEqual(result.conflicting, [second]);
  assert.equal(result.drafts[second], 'draft other');
  assert.equal(result.drafts[file], 'new');
  assert.equal(result.documents.size, 2);
});

test('unloaded tabs with restored draft preserve restore revision', () => {
  const restored = document(file, 'disk content', 'new-hash');
  const result = reconcileWorkspaceRefresh(
    [tabs[0]], new Map(), { [file]: 'restored draft' }, { [file]: 'old-hash' },
    [{ path: file, document: restored }],
  );
  assert.equal(result.documents.get(file), restored);
  assert.equal(result.drafts[file], 'restored draft');
  assert.equal(result.draftBases[file], 'old-hash');
  assert.deepEqual(result.conflicting, [file]);
});

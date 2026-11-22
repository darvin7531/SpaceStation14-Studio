import assert from 'node:assert/strict';
import test from 'node:test';
import { readTabSession, retainAvailableTabs, sessionKey, writeTabSession } from '../src/lib/tab-session';
import { MAX_OPEN_TABS, type TabState } from '../src/lib/tabs';

const yaml = (name: string) => ({ path: 'Resources/Prototypes/' + name + '.yml', kind: 'yaml' as const });

test('per-project sessions retain the active tab without storing editor contents', () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
  const original: TabState = {
    tabs: [yaml('A'), { path: 'Resources/Locale/en-US/ui.ftl', kind: 'ftl' }],
    active: 'Resources/Locale/en-US/ui.ftl',
  };
  writeTabSession(storage, '/repo/a', original);
  assert.deepEqual(readTabSession(storage, '/repo/a'), original);
  assert.deepEqual(readTabSession(storage, '/repo/b'), { tabs: [], active: null });
  assert.notEqual(sessionKey('/repo/a'), sessionKey('/repo/b'));
  assert.equal(storage.getItem(sessionKey('/repo/a'))?.includes('content'), false);
});

test('session loader bounds tabs and rejects traversal and duplicates', () => {
  const source = [yaml('A'), yaml('A'),
    { path: 'Resources/Prototypes/../../secret.yml', kind: 'yaml' },
    ...Array.from({ length: MAX_OPEN_TABS + 5 }, (_, i) => yaml('Item' + i))];
  const session = readTabSession(
    { getItem: () => JSON.stringify({ tabs: source, active: 'missing.yml' }) },
    '/repo',
  );
  assert.equal(session.tabs.length, MAX_OPEN_TABS);
  assert.equal(session.tabs[0].path, yaml('A').path);
  assert.equal(session.active, yaml('A').path);
  assert.ok(session.tabs.every((tab) => !tab.path.includes('secret')));
});

test('missing indexed resources do not become phantom tabs', () => {
  const tabs: TabState = { tabs: [yaml('A'), yaml('B'), yaml('C')], active: yaml('B').path };
  assert.deepEqual(retainAvailableTabs(tabs, new Set([yaml('A').path, yaml('C').path])), {
    tabs: [yaml('A'), yaml('C')], active: yaml('A').path,
  });
  assert.deepEqual(retainAvailableTabs(tabs, new Set()), { tabs: [], active: null });
});

test('corrupted or inaccessible storage is ignored', () => {
  assert.deepEqual(readTabSession({ getItem: () => '{' }, '/repo'), { tabs: [], active: null });
  assert.deepEqual(readTabSession({ getItem: () => { throw Error('denied'); } }, '/repo'),
    { tabs: [], active: null });
});


test('prototype sessions round trip and reject malformed locators', () => {
  const file = yaml('A').path;
  const prototype = { file, kind: 'entity', id: 'A', document_index: 1, item_index: 1, mode: 'normal' as const };
  const valid = { ...yaml('A'), prototype };
  const invalid = { ...valid, prototype: { ...prototype, file: '../other', item_index: -1 } };
  const state = readTabSession({ getItem: () => JSON.stringify({ tabs: [valid, invalid], active: file }) }, '/repo');
  assert.equal(state.tabs.length, 1);
  assert.deepEqual(state.tabs[0], valid);
});

test('large valid sessions and variant identities round trip', () => {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); } };
  const tabs = Array.from({ length: MAX_OPEN_TABS }, (_, i) => {
    const file = 'Resources/Prototypes/' + 'a'.repeat(900) + i + '.yml';
    return { path: file, kind: 'yaml' as const, prototype: { file, kind: 'entity',
      id: 'x'.repeat(1000), document_index: 1, item_index: 1, variant_index: i, mode: 'normal' as const } };
  });
  writeTabSession(storage, '/repo', { tabs, active: null });
  assert.ok(storage.getItem(sessionKey('/repo'))!.length > 32768);
  assert.deepEqual(readTabSession(storage, '/repo').tabs, tabs);
  const invalid = { ...tabs[0], prototype: { ...tabs[0].prototype, variant_index: -1 } };
  assert.equal(readTabSession({ getItem: () => JSON.stringify({ tabs: [invalid] }) }, '/repo').tabs.length, 0);
});

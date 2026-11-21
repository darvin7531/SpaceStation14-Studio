import test from 'node:test';
import assert from 'node:assert/strict';
import { closeTab, MAX_OPEN_TABS, openTab, type TabState } from '../src/lib/tabs';
import type { ResourceEntry } from '../src/lib/api';

const resource = (path: string): ResourceEntry => ({ path, kind: 'yaml' });

test('opening a file creates a tab and makes it active', () => {
  const result = openTab({ tabs: [], active: null }, resource('Resources/Prototypes/A.yml'));
  assert.equal(result.ok, true);
  assert.equal(result.state.tabs.length, 1);
  assert.equal(result.state.active, 'Resources/Prototypes/A.yml');
});

test('reopening an existing file does not create duplicate tabs', () => {
  const first = openTab({ tabs: [], active: null }, resource('A.yml')).state;
  const second = openTab(first, resource('A.yml')).state;
  assert.equal(second.tabs.length, 1);
});

test('tabs preserve case-sensitive resource identity', () => {
  const first = openTab({ tabs: [], active: null }, resource('a.yml')).state;
  const second = openTab(first, resource('A.yml')).state;
  assert.equal(second.tabs.length, 2);
});

test('the tab limit never silently discards an open document', () => {
  const tabs = Array.from({ length: MAX_OPEN_TABS }, (_, index) => resource(String(index) + '.yml'));
  const previous: TabState = { tabs, active: '0.yml' };
  const result = openTab(previous, resource('overflow.yml'));
  assert.equal(result.ok, false);
  assert.equal(result.state.tabs.length, MAX_OPEN_TABS);
  assert.equal(result.state.active, '0.yml');
});

test('closing the active tab selects a neighbor', () => {
  const state: TabState = { tabs: [resource('a'), resource('b'), resource('c')], active: 'b' };
  const result = closeTab(state, 'b');
  assert.equal(result.active, 'c');
  assert.deepEqual(result.tabs.map((tab) => tab.path), ['a', 'c']);
});

test('closing last tab clears active selection', () => {
  const state: TabState = { tabs: [resource('a')], active: 'a' };
  assert.deepEqual(closeTab(state, 'a'), { tabs: [], active: null });
});

test('closing an inactive tab preserves the current selection', () => {
  const state: TabState = { tabs: [resource('a'), resource('b')], active: 'b' };
  assert.equal(closeTab(state, 'a').active, 'b');
});

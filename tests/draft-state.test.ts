import test from 'node:test';
import assert from 'node:assert/strict';
import { dirtyDocumentPaths, reconcileSavedDraft } from '../src/lib/draft-state';

test('unchanged source is not marked dirty', () => {
  const loaded = new Map([['a.yml', { content: 'same' }]]);
  assert.deepEqual(dirtyDocumentPaths({ 'a.yml': 'same' }, loaded), []);
});

test('unsaved YAML is detected without marking other open files', () => {
  const loaded = new Map([
    ['a.yml', { content: 'original' }],
    ['b.yml', { content: 'unchanged' }],
  ]);
  assert.deepEqual(dirtyDocumentPaths({
    'a.yml': 'local edit', 'b.yml': 'unchanged',
  }, loaded), ['a.yml']);
});

test('closing a draft removes it from the dirty list', () => {
  const loaded = new Map([['a.yml', { content: 'original' }]]);
  assert.deepEqual(dirtyDocumentPaths({}, loaded), []);
});

test('save response must not overwrite edits made after submission', () => {
  assert.equal(reconcileSavedDraft('later edit', 'submitted', 'submitted'), 'later edit');
});

test('saved text resets dirty state when nothing changed during request', () => {
  assert.equal(reconcileSavedDraft('submitted', 'submitted', 'submitted'), 'submitted');
});

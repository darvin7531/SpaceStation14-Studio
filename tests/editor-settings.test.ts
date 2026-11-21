import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_EDITOR_SETTINGS, SETTINGS_KEY, readEditorSettings, sanitizeEditorSettings } from '../src/lib/editor-settings';

test('defaults and corrupted storage', () => {
  assert.deepEqual(readEditorSettings({ getItem: () => null }), DEFAULT_EDITOR_SETTINGS);
  assert.deepEqual(readEditorSettings({ getItem: () => '{broken' }), DEFAULT_EDITOR_SETTINGS);
  assert.deepEqual(readEditorSettings({ getItem: () => { throw Error('blocked'); } }), DEFAULT_EDITOR_SETTINGS);
});
test('rejects malformed settings', () => {
  assert.deepEqual(sanitizeEditorSettings({ fontSize: Infinity, tabSize: 55, wordWrap: 'bad', lineNumbers: 'bad', minimap: 'true' }), DEFAULT_EDITOR_SETTINGS);
  assert.equal(sanitizeEditorSettings({ fontSize: 300 }).fontSize, 28);
  assert.equal(sanitizeEditorSettings({ fontSize: -5 }).fontSize, 10);
});
test('loads supported values', () => {
  const settings = { fontSize: 18, tabSize: 4, wordWrap: 'off', lineNumbers: 'relative', minimap: true };
  assert.deepEqual(readEditorSettings({ getItem: k => k === SETTINGS_KEY ? JSON.stringify(settings) : null }), settings);
});

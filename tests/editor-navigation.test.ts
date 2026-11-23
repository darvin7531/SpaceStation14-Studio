import assert from 'node:assert/strict';
import test from 'node:test';
import { consumeEditorJump, identifierAtColumn, revealEditorLine } from '../src/lib/editor-navigation';

test('navigation reveals the line, positions the cursor and focuses the editor', () => {
  const calls: unknown[] = [];
  revealEditorLine({
    revealLineInCenter: (line) => calls.push(['reveal', line]),
    setPosition: (position) => calls.push(['position', position]),
    focus: () => calls.push(['focus']),
  }, 42);
  assert.deepEqual(calls, [
    ['reveal', 42], ['position', { lineNumber: 42, column: 1 }], ['focus'],
  ]);
});

test('ctrl click captures complete prototype IDs with underscores and hyphens', () => {
  assert.equal(identifierAtColumn('parent: [BaseEntity, Some-Prototype]', 11), 'BaseEntity');
  assert.equal(identifierAtColumn('parent: [BaseEntity, Some-Prototype]', 28), 'Some-Prototype');
  assert.equal(identifierAtColumn('id: NPC_25', 8), 'NPC_25');
  assert.equal(identifierAtColumn('id: a', 5), null);
});
test('ignores punctuation, invalid cursor and path-like escapes', () => {
  assert.equal(identifierAtColumn('parent: ', 2), 'parent');
  assert.equal(identifierAtColumn(':', 1), null);
  assert.equal(identifierAtColumn('any', -1), null);
  assert.equal(identifierAtColumn('foo/bar', 4), 'foo');
  assert.equal(identifierAtColumn('', 1), null);
});

test('delayed navigation still reveals its target without stealing focus', () => {
  const calls: unknown[] = [];
  revealEditorLine({
    revealLineInCenter: (line) => calls.push(['reveal', line]),
    setPosition: (position) => calls.push(['position', position]),
    focus: () => calls.push(['focus']),
  }, 42, false);
  assert.deepEqual(calls, [
    ['reveal', 42], ['position', { lineNumber: 42, column: 1 }],
  ]);
});

test('navigation tokens are consumed once and newer requests are preserved', () => {
  const calls: string[] = [];
  const editor = {
    revealLineInCenter: () => calls.push('reveal'),
    setPosition: () => calls.push('position'),
    focus: () => calls.push('focus'),
  };
  const consumed = { current: 0 };
  let currentToken = 2;
  const jump = { line: 42, token: 1, shouldFocus: () => false,
    consume: (token: number) => { if (currentToken === token) currentToken = 0; } };
  consumeEditorJump(editor, jump, consumed);
  consumeEditorJump(editor, jump, consumed);
  assert.deepEqual(calls, ['reveal', 'position']);
  assert.equal(currentToken, 2);
  consumeEditorJump(editor, { ...jump, token: 2, shouldFocus: () => true }, consumed);
  assert.deepEqual(calls, ['reveal', 'position', 'reveal', 'position', 'focus']);
  assert.equal(currentToken, 0);
});

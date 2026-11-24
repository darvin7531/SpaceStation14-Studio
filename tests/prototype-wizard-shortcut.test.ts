import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prototypeWizardShortcut } from '../src/lib/prototype-wizard-shortcut';

test('prototype wizard keyboard shortcuts ignore busy and repeated events', () => {
  const key = { key: 'Escape', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, repeat: false, isComposing: false };
  assert.equal(prototypeWizardShortcut(key, false), 'close');
  assert.equal(prototypeWizardShortcut({ ...key, key: 'Enter', ctrlKey: true }, false), 'submit');
  assert.equal(prototypeWizardShortcut({ ...key, key: 'Enter', metaKey: true }, false), 'submit');
  assert.equal(prototypeWizardShortcut({ ...key, key: 'Enter' }, false), null);
  assert.equal(prototypeWizardShortcut(key, true), null);
  assert.equal(prototypeWizardShortcut({ ...key, repeat: true }, false), null);
  assert.equal(prototypeWizardShortcut({ ...key, isComposing: true }, false), null);
});

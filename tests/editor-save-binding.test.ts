import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('editor saves are bound to the displayed project and blocked during a switch', () => {
  const app = readFileSync('src/App.tsx', 'utf8');
  const api = readFileSync('src/lib/api.ts', 'utf8');
  const native = readFileSync('src-tauri/src/lib.rs', 'utf8');
  const save = app.slice(app.indexOf('  async function saveCurrent()'), app.indexOf('  function openResource('));
  assert.match(save, /if \(!overview[^\n]*opening[^\n]*transitioning[^\n]*\) return/);
  assert.match(save, /saveYamlResource\(file, sourceRevision, submitted, overview\.project_root\)/);
  assert.match(save, /saveFtlResource\(file, sourceRevision, submitted, overview\.project_root\)/);
  assert.match(save, /\[overview,[^\]]*opening, transitioning, saving, refreshing, pendingAction, exitDialogOpen\]/);
  for (const kind of ['yaml', 'ftl']) {
    assert.match(api, new RegExp(`invoke\\('save_${kind}_resource', \\{ path, expectedRevision, content, expectedProjectRoot \\}\\)`));
    const command = native.slice(native.indexOf(`async fn save_${kind}_resource(`));
    assert.match(command.slice(0, command.indexOf('\n}')), /expected_project_root: String[\s\S]*project_for_operation\(&state, Some\(&expected_project_root\)\)/);
  }
});


test('localization preview and recovery operations retain their originating project', () => {
  const panel = readFileSync('src/components/PrototypeLocalizationPanel.tsx', 'utf8');
  const app = readFileSync('src/App.tsx', 'utf8');
  const native = readFileSync('src-tauri/src/lib.rs', 'utf8');
  assert.match(panel, /onApply\(target, preview\.baseline, preview\.patch\.content, false, preview\.sourceSnapshot, preview\.projectRoot\)/);
  assert.match(app, /pendingAction \|\| exitDialogOpen/);
  assert.match(app, /generation !== projectGeneration\.current/);
  for (const command of ['persist_draft', 'delete_draft']) {
    const body = native.slice(native.indexOf(`async fn ${command}(`));
    assert.match(body.slice(0, body.indexOf('\n}')), /expected_project_root: String[\s\S]*project_for_operation\(&state, Some\(&expected_project_root\)\)/);
  }
});

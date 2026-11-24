import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('About opens only the project repository with the system browser', () => {
  const url = 'https://github.com/darvin7531/SpaceStation14-Studio';
  const dialog = readFileSync('src/components/EditorSettingsDialog.tsx', 'utf8');
  const capabilities = JSON.parse(readFileSync('src-tauri/capabilities/default.json', 'utf8'));
  const opener = capabilities.permissions.find((permission: { identifier?: string }) => permission.identifier === 'opener:allow-open-url');
  assert.deepEqual(opener.allow, [{ url }]);
  assert.match(dialog, /openUrl\(REPOSITORY_URL\)/);
  assert.ok(dialog.includes(url));
  assert.match(dialog, /role="alert"/);
  assert.match(readFileSync('src-tauri/src/lib.rs', 'utf8'), /tauri_plugin_opener::init\(\)/);
});

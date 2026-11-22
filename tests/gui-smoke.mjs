// Real Linux WebDriver session against the release Tauri executable and IPC.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const base = 'http://127.0.0.1:4444';
const elementKey = 'element-6066-11e4-a52e-4f735466cecf';
const file = join(process.env.SMOKE_PROJECT, 'Resources/Prototypes/smoke.yml');
const saved = '[{type: entity, id: SmokeSaved}]';
const draft = '[{type: entity, id: SmokeDraft}]';
const external = '[{type: entity, id: SmokeExternal}]\n';
let session;

async function request(method, path, body) {
  const response = await fetch(base + path, {
    method, headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  const result = await response.json();
  if (!response.ok || result.value?.error) throw new Error(`${method} ${path}: ${JSON.stringify(result.value)}`);
  return result.value;
}
const call = (method, path, body) => request(method, `/session/${session}${path}`, body);
const sleep = () => new Promise((r) => setTimeout(r, 200));
async function until(label, fn, ms = 30000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try { const value = await fn(); if (value) return value; } catch (error) { last = error; }
    await sleep();
  }
  throw new Error(`Timed out waiting for ${label}${last ? ': ' + last.message : ''}`);
}
async function find(selector) {
  const elements = await call('POST', '/elements', { using: 'css selector', value: selector });
  return elements[0]?.[elementKey];
}
async function click(selector) {
  const id = await until(selector, () => find(selector));
  await call('POST', `/element/${id}/click`, {});
}
async function keys(id, text) {
  await call('POST', `/element/${id}/value`, { text, value: [...text] });
}
async function script(source) {
  return call('POST', '/execute/sync', { script: source, args: [] });
}
async function edit(value, token) {
  const editor = await until('Monaco input', () => find('.monaco-shell textarea.inputarea'));
  await script("document.querySelector('.monaco-shell textarea.inputarea').focus();");
  await keys(editor, '\uE009a\uE000'); // Ctrl+A, then release modifiers
  await keys(editor, value);
  await keys(editor, '\uE017\uE017'); // Remove Monaco's auto-inserted closing brackets.
  await until('edited draft', () => script(`return document.querySelector('.monaco-shell .view-lines')?.textContent?.includes(${JSON.stringify(token)});`));
  await until('enabled save', () => script("const button = document.querySelector('[data-testid=save-resource]'); return !!button && !button.disabled;"));
}

try {
  await until('tauri-driver', async () => (await request('GET', '/status')).ready);
  const created = await request('POST', '/session', { capabilities: { alwaysMatch: {
    'tauri:options': { application: resolve('src-tauri/target/release/ss14-studio') },
  } } });
  session = created.sessionId;
  assert.ok(session, 'WebDriver session ID');
  const path = await until('project path input', () => find('#project-path'));
  await keys(path, process.env.SMOKE_PROJECT);
  await click('.project-bar button[type=submit]');
  await click('.resource-row[title="Resources/Prototypes/smoke.yml"]');
  await edit(saved, 'SmokeSaved');
  await click('[data-testid=save-resource]');
  try {
    await until('saved file', async () => (await readFile(file, 'utf8')) === saved);
  } catch (error) {
    console.error('Saved file contents:', JSON.stringify(await readFile(file, 'utf8')));
    console.error('UI state:', await script('return document.body.innerText;'));
    throw error;
  }
  await until('save completion', () => script(`
    const button = document.querySelector('[data-testid=save-resource]');
    const editor = document.querySelector('.monaco-shell textarea.inputarea');
    const tab = document.querySelector('[role=tab][title="Resources/Prototypes/smoke.yml"]');
    return tab?.querySelector('span')?.textContent === 'smoke.yml'
      && button?.disabled && editor && !editor.readOnly;
  `));

  await edit(draft, 'SmokeDraft');
  await writeFile(file, external);
  // Wait for the watcher to reconcile the external revision with the dirty draft.
  await until('external refresh conflict', () => script("return [...document.querySelectorAll('code')].some((el) => el.textContent === 'REFRESH_TABS_REQUIRE_ATTENTION');"));
  await until('save enabled after refresh', () => script("const button = document.querySelector('[data-testid=save-resource]'); return !!button && !button.disabled;"));
  await click('[data-testid=save-resource]');
  await until('conflict review', () => find('.conflict-review'));
  await until('conflict diff', () => script(`
    const text = (selector) => document.querySelector(selector)?.textContent;
    return text('.conflict-review .original .view-lines')?.includes('SmokeExternal')
      && text('.conflict-review .modified .view-lines')?.includes('SmokeDraft');
  `));
  assert.equal(await readFile(file, 'utf8'), external, 'conflict must not overwrite external disk contents');
  assert.ok(await script("return document.querySelector('.monaco-shell .view-lines')?.textContent?.includes('SmokeDraft');"), 'conflict must retain the editor draft');
  console.log('GUI smoke passed: project opened, YAML saved, conflicting disk and draft preserved');
} finally {
  if (session) {
    try { await call('DELETE', ''); } catch (error) { console.error('WebDriver cleanup:', error.message); }
  }
}

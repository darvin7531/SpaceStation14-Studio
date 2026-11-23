// Real Linux WebDriver session against the release Tauri executable and IPC.
import assert from 'node:assert/strict';
import { access, readFile, writeFile } from 'node:fs/promises';
import { resolve, join, basename } from 'node:path';

const base = 'http://127.0.0.1:4444';
const elementKey = 'element-6066-11e4-a52e-4f735466cecf';
const file = join(process.env.SMOKE_PROJECT, 'Resources/Prototypes/smoke.yml');
const saved = '[{type: entity, id: SmokeSaved}]';
const draft = '[{type: entity, id: SmokeDraft}]';
const external = '[{type: entity, id: SmokeExternal}]\n';
const tabsPath = 'Resources/Prototypes/tabs.yml';
const tabsFile = join(process.env.SMOKE_PROJECT, tabsPath);
const tabsDraft = '[{type: entity, id: SmokeFirst, name: SharedDraft}, {type: entity, id: SmokeSecond}]';
const rsi = join(process.env.SMOKE_PROJECT, 'Resources/Textures/smoke.rsi');
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
    'tauri:options': { application: resolve(process.env.SMOKE_EXECUTABLE || 'src-tauri/target/release/ss14-studio') },
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

  await click('.resource-row[title="Resources/Textures/smoke.rsi"]');
  await click('[data-testid=rsi-import] summary');
  await click('[data-testid=rsi-import] input[type=checkbox]');
  await keys(await until('state name', () => find('[data-testid=rsi-import] input[type=text]')), 'idle');
  await click('[data-testid=rsi-import] button[type=submit]');
  await until('metadata-only state', async () => JSON.parse(await readFile(join(rsi, 'meta.json'), 'utf8')).states.some((state) => state.name === 'idle'));
  const metadata = await readFile(join(rsi, 'meta.json'));
  assert.deepEqual(JSON.parse(metadata).states, [{ name: 'idle', directions: 1, delays: [[0.1]] }]);
  await assert.rejects(access(join(rsi, 'idle.png')), { code: 'ENOENT' });

  // The attach panel is derived from refreshed metadata and the completed sheet list.
  await until('idle attach panel after RSI refresh', () => script(`
    return document.querySelector('[data-testid=rsi-attach] summary')?.textContent?.includes('idle');
  `));
  const deadline = Date.now() + 30000;
  let submitted = false;
  while (!submitted && Date.now() < deadline) {
    await until('attach input', async () => {
      await script("const panel = document.querySelector('[data-testid=rsi-attach]'); if (panel) panel.open = true;");
      const input = await find('[data-testid=rsi-attach] input[type=file]');
      if (!input) return false;
      try { await keys(input, process.env.SMOKE_PNG); } catch (error) {
        if (!/stale element|no such element/i.test(error.message)) throw error;
        return false;
      }
      return true;
    }, Math.max(0, deadline - Date.now()));
    // Check the current form and submit in one browser task; a remount loses the selection.
    submitted = await script(`
      const panel = document.querySelector('[data-testid=rsi-attach]');
      const input = panel?.querySelector('input[type=file]');
      const button = panel?.querySelector('button[type=submit]');
      if (!panel?.open || input?.files?.length !== 1
          || input.files[0].name !== ${JSON.stringify(basename(process.env.SMOKE_PNG))}
          || !button || button.disabled) return false;
      button.click();
      return true;
    `);
    if (!submitted) await sleep();
  }
  assert.ok(submitted, 'attach form must retain the selected PNG before submission');
  await until('attached PNG', async () => (await readFile(join(rsi, 'idle.png'))).equals(await readFile(process.env.SMOKE_PNG)));
  await until('attached sheet loaded', () => script(`
    const select = document.querySelector('.rsi-toolbar select');
    const image = document.querySelector('.rsi-stage img');
    return select?.value === 'idle.png' && image?.complete && image.naturalWidth > 0;
  `));
  assert.deepEqual(await readFile(join(rsi, 'meta.json')), metadata, 'attaching PNG must not change metadata');
  await click('[role=tab][title="Resources/Prototypes/smoke.yml"]');
  await until('original file reloaded after RSI', () => script("return document.querySelector('.monaco-shell .view-lines')?.textContent?.includes('SmokeSaved');"));

  const originalTabsFile = await readFile(tabsFile, 'utf8');
  await click('[data-testid=folder-view]');
  await click('.resource-tree-row[title="Resources/Prototypes"]');
  await click('.resource-tree-toggle[data-resource-path="Resources/Prototypes/tabs.yml"]');
  await click('[data-testid=tree-prototype][data-resource-path="Resources/Prototypes/tabs.yml"][data-prototype-id="SmokeFirst"]');
  await until('first prototype selected', () => find('[role=tab][data-prototype-id="SmokeFirst"][aria-selected=true]'));
  await until('prototype file loaded', () => script("return document.querySelector('.monaco-shell .view-lines')?.textContent?.includes('SmokeFirst');"));
  await edit(tabsDraft, 'SharedDraft');
  // A workspace refresh can remount the tree after the earlier save.
  const folder = '.resource-tree-row[title="Resources/Prototypes"]';
  if (await script(`return document.querySelector('${folder}')?.getAttribute('aria-expanded') === 'false';`)) await click(folder);
  const yaml = '.resource-tree-toggle[data-resource-path="Resources/Prototypes/tabs.yml"]';
  await until('prototype tree file', () => find(yaml));
  if (await script(`return document.querySelector('${yaml}')?.getAttribute('aria-expanded') === 'false';`)) await click(yaml);
  await click('[data-testid=tree-prototype][data-resource-path="Resources/Prototypes/tabs.yml"][data-prototype-id="SmokeSecond"]');
  await until('second prototype selected with shared draft', () => script(`
    return document.querySelector('[role=tab][data-prototype-id="SmokeSecond"][aria-selected=true]')
      && document.querySelector('.monaco-shell .view-lines')?.textContent?.includes('SharedDraft')
      && !document.querySelector('[data-testid=save-resource]')?.disabled;
  `));
  await click('[role=tab][data-prototype-id="SmokeFirst"]');
  await until('first prototype retains shared draft', () => script(`
    return document.querySelector('[role=tab][data-prototype-id="SmokeFirst"][aria-selected=true]')
      && document.querySelector('.monaco-shell .view-lines')?.textContent?.includes('SharedDraft');
  `));
  await click('.tab[data-prototype-id="SmokeFirst"] .tab-close');
  await until('remaining prototype retains shared draft', () => script(`
    return !document.querySelector('[role=tab][data-prototype-id="SmokeFirst"]')
      && document.querySelector('[role=tab][data-prototype-id="SmokeSecond"][aria-selected=true]')
      && document.querySelector('.monaco-shell .view-lines')?.textContent?.includes('SharedDraft')
      && !document.querySelector('[data-testid=save-resource]')?.disabled;
  `));
  assert.equal(await readFile(tabsFile, 'utf8'), originalTabsFile, 'switching and closing tabs must not save the draft');
  await click('[role=tab][title="Resources/Prototypes/smoke.yml"]');
  await until('original file selected', () => find('[role=tab][title="Resources/Prototypes/smoke.yml"][aria-selected=true]'));
  await until('original file loaded', () => script("return document.querySelector('.monaco-shell .view-lines')?.textContent?.includes('SmokeSaved');"));

  await edit(draft, 'SmokeDraft');
  await writeFile(file, external);
  // Wait for the watcher to reconcile the external revision with the dirty draft.
  await until('external refresh conflict', () => script("return [...document.querySelectorAll('code')].some((el) => el.textContent === 'REFRESH_TABS_REQUIRE_ATTENTION');"));
  await until('save enabled after refresh', () => script("const button = document.querySelector('[data-testid=save-resource]'); return !!button && !button.disabled;"));
  await click('[data-testid=save-resource]');
  await until('conflict review', () => find('.conflict-review'));
  try {
    await until('conflict diff', () => script(`
      const contains = (selector, value) => [...document.querySelectorAll(selector)].some((el) => el.textContent?.includes(value));
      return contains('.conflict-review .original .view-lines', 'SmokeExternal')
        && contains('.conflict-review .modified .view-lines', 'SmokeDraft');
    `));
  } catch (error) {
    console.error('Conflict review DOM:', await script("return document.querySelector('.conflict-review')?.outerHTML;"));
    console.error('UI state:', await script('return document.body.innerText;'));
    throw error;
  }
  assert.equal(await readFile(file, 'utf8'), external, 'conflict must not overwrite external disk contents');
  assert.ok(await script("return document.querySelector('.monaco-shell .view-lines')?.textContent?.includes('SmokeDraft');"), 'conflict must retain the editor draft');
  console.log('GUI smoke passed: RSI metadata and PNG, shared prototype drafts, YAML save and conflict protection');
} finally {
  if (session) {
    try { await call('DELETE', ''); } catch (error) { console.error('WebDriver cleanup:', error.message); }
  }
}

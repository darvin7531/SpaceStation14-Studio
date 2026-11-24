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
  await until(selector, async () => {
    const id = await find(selector);
    if (!id || !(await call('GET', `/element/${id}/enabled`))) return false;
    try { await call('POST', `/element/${id}/click`, {}); } catch (error) {
      if (!/stale element reference/i.test(error.message)) throw error;
      return false;
    }
    return true;
  });
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
  try {
    await until('edited draft', () => script(`return document.querySelector('.monaco-shell .view-lines')?.textContent?.includes(${JSON.stringify(token)});`));
  } catch (error) {
    console.error('Edit diagnostic:', await script("return JSON.stringify({active: document.activeElement?.outerHTML, lines: document.querySelector('.monaco-shell .view-lines')?.textContent, tabs: [...document.querySelectorAll('[role=tab]')].map(tab => tab.outerHTML)});"));
    throw error;
  }
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
  await until('editor before focus checks', () => find('.monaco-shell textarea.inputarea'));

  // Exercise the real modal and IPC while a write is pending.
  await click('.create-proto-open');
  await until('wizard focus', () => script("return document.activeElement?.matches('.create-proto-modal input[list=new-prototype-kinds]');"));
  const wizardInput = await find('.create-proto-modal input[placeholder=MyNewItem]');
  await keys(wizardInput, 'WizardKeyboardSmoke');
  await until('wizard validation', () => script("return !document.querySelector('.create-proto-modal button[type=submit]').disabled;"));
  await script(`
    const original = window.fetch;
    window.__wizardGate = { writes: 0, saves: 0, release: null };
    window.fetch = function(url, options) {
      if (!String(url).startsWith('ipc:')) return original.call(this, url, options);
      const command = decodeURIComponent(new URL(url).pathname.slice(1));
      if (command.startsWith('save_')) window.__wizardGate.saves++;
      if (command === 'create_new_prototype') {
        window.__wizardGate.writes++;
        return new Promise((resolve, reject) => { window.__wizardGate.release = () => original.call(this, url, options).then(resolve, reject); });
      }
      return original.call(this, url, options);
    };
    const input = document.querySelector('.create-proto-modal input[placeholder=MyNewItem]');
    for (const [key, extra] of [['s', {}], ['p', {}], ['f', {shiftKey:true}], ['w', {}], ['Tab', {}]])
      input.dispatchEvent(new KeyboardEvent('keydown', {key, ctrlKey:true, bubbles:true, cancelable:true, ...extra}));
  `);
  assert.equal(await script('return window.__wizardGate.saves;'), 0, 'workspace save is isolated');
  assert.equal(await find('.content-search-modal, .quick-open-dialog'), undefined, 'workspace search stays closed');
  assert.ok(await find('[role=tab][title="Resources/Prototypes/smoke.yml"]'), 'workspace tab stays open');
  await script(`
    const form = document.querySelector('.create-proto-modal form');
    const input = form.querySelector('input[placeholder=MyNewItem]');
    input.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', ctrlKey:true, bubbles:true, cancelable:true}));
    // A queued input and destination click can arrive before React renders disabled controls.
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'LateEdit');
    input.dispatchEvent(new Event('input', {bubbles:true}));
    form.querySelectorAll('.create-proto-mode')[1].querySelectorAll('button')[1].click();
    form.requestSubmit();
    input.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true, cancelable:true}));
  `);
  await until('wizard write held', () => script('return window.__wizardGate.release !== null;'));
  assert.equal(await script('return window.__wizardGate.writes;'), 1, 'keyboard and button submits share a synchronous guard');
  assert.ok(await find('.create-proto-modal'), 'escape cannot dismiss an in-flight write');
  await until('wizard draft disabled', () => script("return [...document.querySelectorAll('.create-proto-modal input, .create-proto-modal textarea, .create-proto-modal button')].every(el => el.matches(':disabled'));"));
  assert.equal(await script("return document.querySelector('.create-proto-modal input[placeholder=MyNewItem]').value;"), 'WizardKeyboardSmoke', 'late input must not change the submitted draft');
  assert.ok(await script("return document.querySelectorAll('.create-proto-mode')[1].querySelector('button.selected') === document.querySelectorAll('.create-proto-mode')[1].querySelector('button');"), 'late destination change is ignored');
  assert.ok(await script("return document.activeElement === document.querySelector('.create-proto-modal form');"), 'focus remains inside the busy wizard');
  assert.equal(await script("return document.activeElement.dispatchEvent(new KeyboardEvent('keydown', {key:'Tab', bubbles:true, cancelable:true}));"), false, 'busy tab is intercepted');
  assert.ok(await script("return document.activeElement === document.querySelector('.create-proto-modal form');"), 'tab cannot escape the busy wizard');
  await script('window.__wizardGate.release();');
  await until('wizard closes after create', async () => !(await find('.create-proto-modal')));
  await access(join(process.env.SMOKE_PROJECT, 'Resources/Prototypes/_PrototypeStudio/WizardKeyboardSmoke.yml'));
  await click('.create-proto-open');
  await until('wizard reopened', () => find('.create-proto-modal input[list=new-prototype-kinds]'));
  await keys(await find('.create-proto-modal input[list=new-prototype-kinds]'), '\uE00C');
  await until('wizard dismissed', async () => !(await find('.create-proto-modal')));
  assert.ok(await script("return document.activeElement === document.querySelector('.create-proto-open');"), 'escape restores launcher focus');
  await click('.explorer > .explorer-switch:first-child button:first-child');
  await click('.tab:has([role=tab][title="Resources/Prototypes/_PrototypeStudio/WizardKeyboardSmoke.yml"]) .tab-close');
  await click('[role=tab][title="Resources/Prototypes/smoke.yml"]');
  await until('original editor restored', () => script("return [...document.querySelectorAll('.monaco-shell .view-line')].some(line => line.textContent.includes('SmokeSecond'));"));

  // Resolve two Ctrl-click searches in reverse order; the older result must not win.
  await script(`
    const original = window.fetch;
    window.__navigationGate = { held: false, settled: false, release: null, searches: [], clicks: [], positions: [] };
    window.addEventListener('studio-monaco-navigation', event => window.__navigationGate.positions.push(event.detail));
    const style = document.createElement('style');
    style.id = 'navigation-smoke-style';
    style.textContent = '.prototype-outline, .yaml-diagnostics { display: none !important; }';
    document.head.appendChild(style);
    window.fetch = function(url, options) {
      if (!String(url).startsWith('ipc:')) return original.call(this, url, options);
      const command = decodeURIComponent(new URL(url).pathname.slice(1));
      const args = options?.body ? JSON.parse(options.body) : {};
      if (command === 'search_prototypes') window.__navigationGate.searches.push(args.query);
      if (command === 'search_prototypes' && args.query === 'SmokeSecond' && !window.__navigationGate.held) {
        window.__navigationGate.held = true;
        return new Promise((resolve, reject) => { window.__navigationGate.release = () =>
          original.call(this, url, options).then(value => {
            resolve(value); setTimeout(() => { window.__navigationGate.settled = true; }, 0);
          }, reject); });
      }
      return original.call(this, url, options);
    };
  `);
  const ctrlClickWord = async (word) => {
    const point = await script(`
    const lines = [...document.querySelectorAll('.monaco-shell .view-line')];
    const line = lines.find(el => el.textContent.includes(${JSON.stringify(word)}));
    line.scrollIntoView({ block: 'center', inline: 'nearest' });
    const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
    let node; while ((node = walker.nextNode()) && !node.textContent.includes(${JSON.stringify(word)})) {}
    const range = document.createRange();
    const offset = node.textContent.indexOf(${JSON.stringify(word)});
    range.setStart(node, offset); range.setEnd(node, offset + ${word.length});
    const rect = range.getBoundingClientRect();
    const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
    const target = document.elementFromPoint(x, y);
    window.__navigationGate.clicks.push({ word: ${JSON.stringify(word)}, rect: rect.toJSON(), target: target?.outerHTML });
    return { x: Math.round(x), y: Math.round(y) };
  `);
    await call('POST', '/actions', { actions: [
      { type: 'key', id: 'keyboard', actions: [{ type: 'keyDown', value: '\uE009' }, { type: 'pause' }, { type: 'pause' }, { type: 'keyUp', value: '\uE009' }] },
      { type: 'pointer', id: 'mouse', parameters: { pointerType: 'mouse' }, actions: [{ type: 'pointerMove', duration: 0, x: point.x, y: point.y, origin: 'viewport' }, { type: 'pointerDown', button: 0 }, { type: 'pointerUp', button: 0 }, { type: 'pause' }] },
    ] });
    await call('DELETE', '/actions');
  };
  await ctrlClickWord('SmokeSecond');
  try {
    await until('first prototype search held', () => script('return window.__navigationGate.held;'));
  } catch (error) {
    console.error('Navigation diagnostic:', await script(`
      const line = [...document.querySelectorAll('.monaco-shell .view-line')].find(el => el.textContent.includes('SmokeSecond'));
      const rect = line?.getBoundingClientRect();
      return JSON.stringify({ gate: window.__navigationGate, line: line?.textContent, rect: rect?.toJSON(),
        target: rect && document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)?.outerHTML,
        state: document.body.innerText });
    `));
    throw error;
  }
  await ctrlClickWord('SmokeFirst');
  try {
    await until('newer prototype selected', () => find('[role=tab][data-prototype-id="SmokeFirst"][aria-selected=true]'));
  } catch (error) {
    console.error('Second navigation diagnostic:', await script('return JSON.stringify({ gate: window.__navigationGate, state: document.body.innerText });'));
    throw error;
  }
  await script('window.__navigationGate.release();');
  await until('older prototype search settled', () => script('return window.__navigationGate.settled;'));
  assert.ok(await find('[role=tab][data-prototype-id="SmokeFirst"][aria-selected=true]'), 'older search must not override newer navigation');
  assert.equal(await find('[role=tab][data-prototype-id="SmokeSecond"]'), undefined, 'older search must not open a tab');
  console.log('Navigation diagnostic:', await script('return JSON.stringify(window.__navigationGate);'));
  await script("document.getElementById('navigation-smoke-style').remove();");
  await click('.tab[data-prototype-id="SmokeFirst"] .tab-close');
  await click('[role=tab][title="Resources/Prototypes/smoke.yml"]');

  // Hold the actual IPC response so interaction occurs while the document is loading.
  await click('[data-testid=folder-view]');
  await click('.resource-tree-row[title="Resources/Prototypes"]');
  await click('.resource-tree-toggle[data-resource-path="Resources/Prototypes/focus.yml"]');
  await until('focus prototype outline loaded', () => find('[data-testid=tree-prototype][data-prototype-id="FocusDelayed"]'));
  await script(`
    const original = window.fetch;
    window.__focusGate = { held: false, release: null };
    window.fetch = function(url, options) {
      if (!String(url).startsWith('ipc:')) return original.call(this, url, options);
      const command = decodeURIComponent(new URL(url).pathname.slice(1));
      const args = options?.body ? JSON.parse(options.body) : {};
      if (command === 'read_resource' && args.path === 'Resources/Prototypes/focus.yml' && !window.__focusGate.held) {
        window.__focusGate.held = true;
        return new Promise((resolve, reject) => { window.__focusGate.release = () => original.call(this, url, options).then(resolve, reject); });
      }
      return original.call(this, url, options);
    };
  `);
  await click('[data-testid=tree-prototype][data-prototype-id="FocusDelayed"]');
  await until('held document read', () => script('return window.__focusGate.held;'));
  await click('#project-path');
  await script('window.__focusGate.release();');
  await until('delayed prototype loaded', () => script("return document.querySelector('.monaco-shell .view-lines')?.textContent?.includes('FocusDelayed');"));
  await until('prototype jump applied', () => script(`
    const selected = document.querySelector('.prototype-outline-item.active b');
    const cursor = document.querySelector('.monaco-shell .cursors-layer .cursor');
    return selected?.textContent === 'FocusDelayed' && parseFloat(cursor?.style.top) > 0;
  `));
  assert.equal(await script('return document.activeElement?.id;'), 'project-path', 'delayed prototype must not steal later focus');

  // Escape restores the original focus; opening a search hit transfers it to Monaco.
  await keys(await find('#project-path'), '\uE009\uE008f\uE000');
  const search = await until('content search', () => find('.content-search-modal input[type=search]'));
  await keys(search, '\uE00C');
  await until('search closed', async () => !(await find('.content-search-modal')));
  assert.equal(await script('return document.activeElement?.id;'), 'project-path', 'dismissing search restores focus');
  await keys(await find('#project-path'), '\uE009\uE008f\uE000');
  await keys(await until('content search reopened', () => find('.content-search-modal input[type=search]')), 'FocusNeedle');
  await until('content hit', () => find('.content-search-list [role=option]'));
  await click('.content-search-list [role=option]');
  await until('search result focused', () => script("return document.activeElement?.matches('.monaco-shell textarea.inputarea');"));

  // A rejected open must keep the search and its keyboard focus intact.
  for (let i = 1; i <= 9; i++) {
    await click(`.resource-tree-filename[title="Resources/Prototypes/filler${i}.yml"]`);
    await until('filler tab opened', () => find(`[role=tab][title="Resources/Prototypes/filler${i}.yml"]`));
  }
  await keys(await find('#project-path'), '\uE009\uE008f\uE000');
  await keys(await until('search at tab limit', () => find('.content-search-modal input[type=search]')), 'SmokeSecond');
  await until('tab limit search hit', () => find('.content-search-list [role=option]'));
  await until('unopened result', () => script(`
    const hit = [...document.querySelectorAll('.content-search-list [role=option]')]
      .find(el => el.textContent.includes('Resources/Prototypes/tabs.yml'));
    if (!hit) return false; hit.click(); return true;
  `));
  assert.ok(await find('.content-search-modal'), 'failed open must not close search');
  assert.ok(await script("return document.activeElement?.matches('.content-search-modal input[type=search]');"), 'failed open restores search focus');
  await keys(await find('.content-search-modal input[type=search]'), '\uE00C');
  await until('tab limit search closed', async () => !(await find('.content-search-modal')));
  for (let i = 1; i <= 9; i++) {
    const close = await find(`.tab:has([role=tab][title="Resources/Prototypes/filler${i}.yml"]) .tab-close`);
    await script(`document.querySelector('.tab:has([role=tab][title="Resources/Prototypes/filler${i}.yml"]) .tab-close').focus();`);
    await keys(close, '\uE007');
    await until('filler tab closed', async () => !(await find(`[role=tab][title="Resources/Prototypes/filler${i}.yml"]`)));
  }

  // A delayed read failure must leave the query and results intact.
  await script(`
    const original = window.fetch;
    window.__failureGate = { held: false, fail: null };
    window.fetch = function(url, options) {
      if (!String(url).startsWith('ipc:')) return original.call(this, url, options);
      const command = decodeURIComponent(new URL(url).pathname.slice(1));
      const args = options?.body ? JSON.parse(options.body) : {};
      if (command === 'read_resource_bound' && args.path === 'Resources/Prototypes/tabs.yml' && !window.__failureGate.held) {
        window.__failureGate.held = true;
        window.__failureGate.root = args.expectedProjectRoot;
        return new Promise((resolve) => { window.__failureGate.fail = () => resolve(new Response('delayed read failed', { headers: { 'Tauri-Response': 'error', 'Content-Type': 'text/plain' } })); });
      }
      return original.call(this, url, options);
    };
  `);
  await keys(await find('#project-path'), '\uE009\uE008f\uE000');
  await keys(await until('search for failed read', () => find('.content-search-modal input[type=search]')), 'SmokeSecond');
  await until('failed read hit', () => script(`
    const hit = [...document.querySelectorAll('.content-search-list [role=option]')]
      .find(el => el.textContent.includes('Resources/Prototypes/tabs.yml'));
    if (!hit) return false; hit.click(); return true;
  `));
  await until('read held before failure', () => script('return window.__failureGate.held;'));
  assert.ok(await script('return window.__failureGate.root;'), 'search read must be project-bound');
  await script('window.__failureGate.fail();');
  await until('failure shown in search', () => find('.content-search-modal [role=alert]'));
  assert.equal(await script("return document.querySelector('.content-search-modal input').value;"), 'SmokeSecond');
  assert.ok(await find('.content-search-list [role=option]'), 'failed read retains results');
  assert.equal(await find('[role=tab][title="Resources/Prototypes/tabs.yml"]'), undefined, 'failed read opens no tab');
  await script(`
    const original = window.fetch;
    window.__staleFailure = { held: false, fail: null };
    window.fetch = function(url, options) {
      if (!String(url).startsWith('ipc:')) return original.call(this, url, options);
      const command = decodeURIComponent(new URL(url).pathname.slice(1));
      const args = options?.body ? JSON.parse(options.body) : {};
      if (command === 'read_resource_bound' && args.path === 'Resources/Prototypes/tabs.yml' && !window.__staleFailure.held) {
        window.__staleFailure.held = true;
        window.__staleFailure.root = args.expectedProjectRoot;
        return new Promise((resolve) => { window.__staleFailure.fail = () => resolve(new Response('stale failure', { headers: { 'Tauri-Response': 'error', 'Content-Type': 'text/plain' } })); });
      }
      return original.call(this, url, options);
    };
  `);
  await until('retry hit', () => script(`
    const hit = [...document.querySelectorAll('.content-search-list [role=option]')]
      .find(el => el.textContent.includes('Resources/Prototypes/tabs.yml'));
    if (!hit) return false; hit.click(); return true;
  `));
  await until('retry held', () => script('return window.__staleFailure.held;'));
  assert.ok(await script('return window.__staleFailure.root;'), 'retry read must be project-bound');
  await keys(await find('.content-search-modal input[type=search]'), 'x');
  await until('new query settled', () => script("return document.querySelector('.content-search-list')?.getAttribute('aria-busy') === 'false';"));
  await script('window.__staleFailure.fail();');
  assert.equal(await find('.content-search-modal [role=alert]'), undefined, 'stale failure must not replace newer search');
  assert.equal(await find('[role=tab][title="Resources/Prototypes/tabs.yml"]'), undefined, 'stale request opens no tab');
  await keys(await find('.content-search-modal input[type=search]'), '\uE00C');

  // Delay another read, dismiss search before it resolves; it must not open a tab.
  await click('[role=tab][title="Resources/Prototypes/smoke.yml"]');
  await until('smoke editor restored', () => find('.monaco-shell textarea.inputarea'));
  await script(`
    const original = window.fetch;
    window.__switchGate = { held: false, settled: false, release: null };
    window.fetch = function(url, options) {
      if (!String(url).startsWith('ipc:')) return original.call(this, url, options);
      const command = decodeURIComponent(new URL(url).pathname.slice(1));
      const args = options?.body ? JSON.parse(options.body) : {};
      if (command === 'read_resource_bound' && args.path === 'Resources/Prototypes/tabs.yml' && !window.__switchGate.held) {
        window.__switchGate.held = true;
        window.__switchGate.root = args.expectedProjectRoot;
        return new Promise((resolve, reject) => { window.__switchGate.release = () => original.call(this, url, options).then(value => { resolve(value); setTimeout(() => { window.__switchGate.settled = true; }, 0); }, reject); });
      }
      return original.call(this, url, options);
    };
  `);
  await keys(await find('.monaco-shell textarea.inputarea'), '\uE009\uE008f\uE000');
  await keys(await until('search for pending jump', () => find('.content-search-modal input[type=search]')), 'SmokeSecond');
  await until('pending search hit', () => find('.content-search-list [role=option]'));
  await until('pending tabs result', () => script(`
    const hit = [...document.querySelectorAll('.content-search-list [role=option]')]
      .find(el => el.textContent.includes('Resources/Prototypes/tabs.yml'));
    if (!hit) return false; hit.click(); return true;
  `));
  await until('held tab read', () => script('return window.__switchGate.held;'));
  assert.ok(await script('return window.__switchGate.root;'), 'pending search read must be project-bound');
  await keys(await find('.content-search-modal input[type=search]'), '\uE00C');
  await until('pending search dismissed', async () => !(await find('.content-search-modal')));
  await script('window.__switchGate.release();');
  await until('cancelled read settled', () => script('return window.__switchGate.settled;'));
  assert.equal(await find('[role=tab][title="Resources/Prototypes/tabs.yml"]'), undefined, 'cancelled read opens no tab');
  await script('document.querySelector(\'.resource-tree-filename[title="Resources/Prototypes/tabs.yml"]\').scrollIntoView({ block: "center" });');
  await click('.resource-tree-filename[title="Resources/Prototypes/tabs.yml"]');
  await click('[role=tab][title="Resources/Prototypes/tabs.yml"]');
  await until('returned prototype loaded', () => script("return document.querySelector('.monaco-shell .view-lines')?.textContent?.replace(/\\s+/g, ' ').includes('id: SmokeSecond');"));
  await until('returned editor cursor', () => find('.monaco-shell .cursors-layer .cursor'));
  assert.ok(await script(`
    const cursor = document.querySelector('.monaco-shell .cursors-layer .cursor').getBoundingClientRect();
    const firstLine = document.querySelector('.monaco-shell .view-line').getBoundingClientRect();
    return Math.abs(cursor.top - firstLine.top) < 2;
  `), 'abandoned jump must leave the cursor on the first line');
  assert.equal(await script("return document.activeElement?.matches('.monaco-shell textarea.inputarea');"), false, 'abandoned jump must not focus the editor');
  await click('[role=tab][title="Resources/Prototypes/smoke.yml"]');
  await click('.explorer-switch button:first-child');
  await click('.explorer-switch:has([data-testid=folder-view]) button:first-child');
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
  await until('RSI viewer', () => find('.rsi-viewer'));
  assert.equal(await script("return document.querySelectorAll('.editor > .yaml-diagnostics, .editor > .fluent-diagnostics').length;"), 0, 'diagnostics from previous tabs must unmount');
  try {
    await click('[data-testid=rsi-import] summary');
  } catch (error) {
    console.error('RSI import layout:', JSON.stringify(await script(`
      const target = document.querySelector('[data-testid=rsi-import] summary');
      const ancestors = [];
      for (let el = target; el; el = el.parentElement) {
        const style = getComputedStyle(el), rect = el.getBoundingClientRect();
        ancestors.push({ tag: el.tagName, class: el.className, rect: rect.toJSON(), display: style.display,
          visibility: style.visibility, overflow: style.overflow, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight });
      }
      const editor = document.querySelector('.editor');
      const children = [...editor.children].map(el => ({ tag: el.tagName, class: el.className,
        rect: el.getBoundingClientRect().toJSON(), text: el.textContent.slice(0, 200) }));
      return { ancestors, children, width: innerWidth, height: innerHeight };
    `)));
    throw error;
  }
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

  // Save and Close uses the real save and recovery IPC before removing the tab.
  await edit(draft, 'SmokeDraft');
  await click('.tab:has([role=tab][title="Resources/Prototypes/smoke.yml"]) .tab-close');
  await until('save and close confirmation', () => script("const button = [...document.querySelectorAll('.discard-confirmation button')].find(b => b.textContent.includes('Сохранить и закрыть')); if (!button) return false; button.click(); return true;"));
  await until('save and close completed', async () => !(await find('[role=tab][title="Resources/Prototypes/smoke.yml"]')));
  assert.equal(await readFile(file, 'utf8'), draft, 'save and close writes the submitted draft');
  await click('.explorer-switch:has([data-testid=folder-view]) button:first-child');
  await click('.resource-row[title="Resources/Prototypes/smoke.yml"]');
  await until('reopened saved editor', () => script("return document.querySelector('.monaco-shell .view-lines')?.textContent?.includes('SmokeDraft');"));

  // An inactive conflict must leave the draft accessible and unblock comparison.
  await edit(saved, 'SmokeSaved');
  await click('[role=tab][data-prototype-id="SmokeSecond"]');
  await until('other tab selected before inactive close', () => find('[role=tab][data-prototype-id="SmokeSecond"][aria-selected=true]'));
  await script(`
    window.__closeOriginalFetch = window.fetch;
    window.fetch = function(url, options) {
      if (String(url).startsWith('ipc:') && decodeURIComponent(new URL(url).pathname.slice(1)) === 'save_yaml_resource') {
        window.fetch = window.__closeOriginalFetch;
        return Promise.resolve(new Response(JSON.stringify({code:'RESOURCE_CHANGED_ON_DISK', message:'conflict', hint:'compare'}),
          {headers:{'Tauri-Response':'error', 'Content-Type':'application/json'}}));
      }
      return window.__closeOriginalFetch.call(this, url, options);
    };
  `);
  // WebKit WebDriver reported a successful click without dispatching it here.
  await until('inactive tab close enabled', () => script(`
    const button = document.querySelector('.tab:has([role=tab][title="Resources/Prototypes/smoke.yml"]) .tab-close');
    if (!button || button.disabled) return false;
    button.click(); return true;
  `));
  await until('save and close confirmation', () => script("const button = [...document.querySelectorAll('.discard-confirmation button')].find(b => b.textContent.includes('Сохранить и закрыть')); if (!button) return false; button.click(); return true;"));
  await until('inactive conflict reported', () => script("return document.body.innerText.includes('RESOURCE_CHANGED_ON_DISK') && !document.querySelector('.discard-confirmation');"));
  assert.ok(await find('[role=tab][title="Resources/Prototypes/smoke.yml"]'), 'conflicting tab remains open');
  await click('[role=tab][title="Resources/Prototypes/smoke.yml"]');
  await until('conflicting draft selected', () => script("return document.querySelector('.monaco-shell .view-lines')?.textContent?.includes('SmokeSaved');"));
  await click('button[title="Сравнить черновик с актуальной версией файла на диске"]');
  await until('inactive conflict can be compared', () => find('.conflict-review'));
  // Close the review by selecting the other tab and return to the draft.
  await click('[role=tab][data-prototype-id="SmokeSecond"]');
  await click('[role=tab][title="Resources/Prototypes/smoke.yml"]');
  await until('draft editor restored', () => script("return document.querySelector('.monaco-shell .view-lines')?.textContent?.includes('SmokeSaved');"));

  // The real write succeeds with a durability warning; simulated cleanup fails.
  await script(`
    window.__closeOriginalFetch = window.fetch;
    window.fetch = async function(url, options) {
      const command = String(url).startsWith('ipc:') ? decodeURIComponent(new URL(url).pathname.slice(1)) : '';
      if (command === 'delete_draft') {
        window.fetch = window.__closeOriginalFetch;
        return new Response('cleanup failed', {headers:{'Tauri-Response':'error', 'Content-Type':'text/plain'}});
      }
      const response = await window.__closeOriginalFetch.call(this, url, options);
      if (command !== 'save_yaml_resource') return response;
      const result = await response.json();
      result.durability_warning = 'durability warning smoke';
      return new Response(JSON.stringify(result), {status:response.status, headers:response.headers});
    };
  `);
  await until('warning tab close enabled', () => script(`
    const button = document.querySelector('.tab:has([role=tab][title="Resources/Prototypes/smoke.yml"]) .tab-close');
    if (!button || button.disabled) return false;
    button.click(); return true;
  `));
  await until('save and close confirmation', () => script("const button = [...document.querySelectorAll('.discard-confirmation button')].find(b => b.textContent.includes('Сохранить и закрыть')); if (!button) return false; button.click(); return true;"));
  await until('warning and cleanup failure visible', () => script("return document.body.innerText.includes('durability warning smoke') && document.body.innerText.includes('cleanup failed');"));
  assert.ok(await find('[role=tab][title="Resources/Prototypes/smoke.yml"]'), 'cleanup failure keeps tab open');
  await click('.discard-confirmation button:first-of-type');
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

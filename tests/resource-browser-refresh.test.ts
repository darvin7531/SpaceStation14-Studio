import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('workspace refresh reloads folder contents without remounting navigation', () => {
  const app = readFileSync('src/App.tsx', 'utf8');
  const folder = readFileSync('src/components/ResourceFolderBrowser.tsx', 'utf8');
  const tree = readFileSync('src/components/ResourceTreeBrowser.tsx', 'utf8');
  assert.match(app, /<ResourceFolderBrowser\s+key=\{overview\.project_root\}\s+revision=\{workspaceRevision\}/);
  assert.match(folder, /\[directory, page, revision\]/);
  assert.match(folder, /<ResourceTreeBrowser revision=\{revision\}/);
  assert.match(tree, /\[expanded, directory, page, retry, depth, revision\]/);
  assert.match(tree, /\[expanded, entry\.path, revision\]/);
});

test('failed or pending tree refresh retains branches but disables stale entries', () => {
  const tree = readFileSync('src/components/ResourceTreeBrowser.tsx', 'utf8');
  assert.doesNotMatch(tree, /setLoaded\(null\)/);
  assert.match(tree, /setLoaded\(\{ directory, page, revision, value \}\)/);
  assert.doesNotMatch(tree, /<fieldset[^>]*disabled=/);
  assert.match(tree, /aria-disabled=\{stale\}/);
  assert.match(tree, /onClickCapture=\{\(event\) => \{ if \(stale\) \{ event\.preventDefault\(\); event\.stopPropagation\(\); \} \}\}/);
  assert.match(tree, /<button type="button" onClick=\{\(\) => setRetry/);
});

test('directory entries cannot be activated while their page or revision is stale', () => {
  const folder = readFileSync('src/components/ResourceFolderBrowser.tsx', 'utf8');
  assert.match(folder, /loaded\?\.directory !== directory \|\| loaded\?\.page !== page \|\| loaded\?\.revision !== revision/);
  assert.match(folder, /aria-disabled=\{stale\}/);
  assert.match(folder, /onClickCapture=\{\(event\) => \{ if \(stale\) \{ event\.preventDefault\(\); event\.stopPropagation\(\); \} \}\}/);
});

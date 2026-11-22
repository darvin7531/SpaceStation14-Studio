import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_RECENT_PROJECTS, RECENT_PROJECTS_KEY,
  readRecentProjects, rememberRecentProject, validProjectPath, writeRecentProjects,
} from '../src/lib/recent-projects';

test('recent projects retain newest roots and discard duplicates', () => {
  const history = ['/home/a', '/home/b'];
  assert.deepEqual(rememberRecentProject(history, '/home/b'), ['/home/b', '/home/a']);
  assert.deepEqual(history, ['/home/a', '/home/b']);
  const all = Array.from({length: MAX_RECENT_PROJECTS + 3},
    (_, i) => '/root/' + i);
  assert.equal(rememberRecentProject(all, '/root/new').length, MAX_RECENT_PROJECTS);
});

test('recent project paths accept canonical Linux, Windows and UNC roots', () => {
  assert.equal(validProjectPath('/home/user/SpaceStation14'), true);
  assert.equal(validProjectPath('C:\\Source\\SS14'), true);
  assert.equal(validProjectPath('\\\\server\\share\\SS14'), true);
  assert.equal(validProjectPath('relative/project'), false);
  assert.equal(validProjectPath('/path\nunsafe'), false);
  assert.equal(validProjectPath(''), false);
});

test('history persistence handles damaged storage safely', () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
  writeRecentProjects(storage, ['/one', '/two']);
  assert.deepEqual(readRecentProjects(storage), ['/one', '/two']);
  values.set(RECENT_PROJECTS_KEY, JSON.stringify(['/one', '/one', '../bad', '/two']));
  assert.deepEqual(readRecentProjects(storage), ['/one', '/two']);
  values.set(RECENT_PROJECTS_KEY, '{');
  assert.deepEqual(readRecentProjects(storage), []);
  assert.deepEqual(readRecentProjects({getItem: () => {throw Error('denied')} }), []);
});

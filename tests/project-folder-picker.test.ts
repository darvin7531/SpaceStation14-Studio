import assert from 'node:assert/strict';
import test from 'node:test';
import { projectFolderDefaultPath, relativeProjectFolder } from '../src/lib/project-folder-picker';

test('resource folder picker keeps each file type inside its project resource root', () => {
  const root = '/game';
  assert.equal(relativeProjectFolder(root, '/game/Resources/Prototypes/Entities', 'prototype'),
    'Resources/Prototypes/Entities');
  assert.equal(relativeProjectFolder(root, '/game/Resources/Textures/Objects', 'rsi'),
    'Resources/Textures/Objects');
  assert.equal(relativeProjectFolder(root, '/game/Resources/Locale/ru-RU/entities', 'fluent'),
    'Resources/Locale/ru-RU/entities');
  assert.equal(relativeProjectFolder(root, '/game/Resources/Locale', 'fluent'), null);
  assert.equal(projectFolderDefaultPath(root, 'prototype'), '/game/Resources/Prototypes');
});

test('picker cannot use lookalike roots, traversal or foreign resource kinds', () => {
  assert.equal(relativeProjectFolder('/game', '/game2/Resources/Prototypes', 'prototype'), null);
  assert.equal(relativeProjectFolder('/game', '/other/Resources/Prototypes', 'prototype'), null);
  assert.equal(relativeProjectFolder('/game', '/game/Resources/Prototypes/../../unsafe', 'prototype'), null);
  assert.equal(relativeProjectFolder('/game', '/game/Resources/Textures/Foo', 'prototype'), null);
  assert.equal(relativeProjectFolder('/game', '/game/Resources/Prototypes/bad:', 'prototype'), null);
  assert.equal(relativeProjectFolder('/game', '/game/Resources/Prototypes/Foo.', 'prototype'), null);
});

test('Windows dialog uses backslash paths and case-insensitive drive roots', () => {
  assert.equal(relativeProjectFolder('C:\\Game', 'c:\\game\\Resources\\Prototypes\\Entities', 'prototype'),
    'Resources/Prototypes/Entities');
  assert.equal(relativeProjectFolder('C:\\Game', 'C:\\Game2\\Resources\\Prototypes', 'prototype'), null);
  assert.equal(projectFolderDefaultPath('C:\\Game\\', 'rsi'), 'C:\\Game/Resources/Textures');
});

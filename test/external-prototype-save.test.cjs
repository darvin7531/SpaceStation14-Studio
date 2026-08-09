const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createExternalPrototype, createPrototype } = require('../electron/scanner.cjs');

test('creates a prototype YAML outside the project without requiring a project-relative path', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ss14-studio-'));
  const target = path.join(directory, 'prototype.yml');

  try {
    const result = createExternalPrototype({
      filePath: target,
      yaml: '- type: entity\n  id: ExternalPrototype\n',
      mode: 'new',
    });

    assert.equal(result.filePath, target);
    assert.equal(fs.readFileSync(target, 'utf8'), '- type: entity\n  id: ExternalPrototype\n');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('does not overwrite an existing external file in new mode', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ss14-studio-'));
  const target = path.join(directory, 'prototype.yml');
  fs.writeFileSync(target, '# existing\n', 'utf8');

  try {
    assert.throws(
      () => createExternalPrototype({ filePath: target, yaml: '- type: entity\n  id: Replacement\n', mode: 'new' }),
      /already exists/i,
    );
    assert.equal(fs.readFileSync(target, 'utf8'), '# existing\n');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('rejects a project-relative path that escapes via a shared path prefix', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ss14-studio-'));
  const projectRoot = path.join(directory, 'project');
  const sibling = path.join(directory, 'project-escape', 'Resources', 'Prototypes', 'escape.yml');
  fs.mkdirSync(path.join(projectRoot, 'Resources', 'Prototypes'), { recursive: true });

  try {
    assert.throws(
      () => createPrototype({ projectRoot, type: 'entity', id: 'Escape', filePath: 'Resources/Prototypes/../../../project-escape/Resources/Prototypes/escape.yml' }),
      /escapes project root/i,
    );
    assert.equal(fs.existsSync(sibling), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

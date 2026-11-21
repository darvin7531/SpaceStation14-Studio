import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeStudioError } from '../src/lib/errors';

test('preserves structured Rust error codes and recovery hints', () => {
  assert.deepEqual(normalizeStudioError({
    code: 'PROJECT_NOT_FOUND',
    message: 'Папка не найдена.',
    hint: 'Проверьте путь.',
    details: 'ENOENT',
  }), {
    code: 'PROJECT_NOT_FOUND',
    message: 'Папка не найдена.',
    hint: 'Проверьте путь.',
    details: 'ENOENT',
  });
});

test('supports JSON string error rejections', () => {
  const result = normalizeStudioError('{"code":"RESOURCE_TOO_LARGE","message":"Слишком большой","hint":"Откройте отдельно"}');
  assert.equal(result.code, 'RESOURCE_TOO_LARGE');
  assert.equal(result.hint, 'Откройте отдельно');
});

test('does not expose raw system failures as error headings', () => {
  const result = normalizeStudioError('broken pipe');
  assert.equal(result.code, 'UNEXPECTED_ERROR');
  assert.equal(result.details, 'broken pipe');
  assert.ok(result.message && result.hint);
});

test('handles null, incomplete and invalid errors', () => {
  for (const value of [null, undefined, 42, {}, { code: '', message: 2, hint: null }]) {
    const result = normalizeStudioError(value);
    assert.equal(result.code, 'UNEXPECTED_ERROR');
    assert.ok(result.message && result.hint);
  }
});

test('keeps native Error details available for reporting', () => {
  const result = normalizeStudioError(new Error('I/O failure'));
  assert.equal(result.details, 'I/O failure');
  assert.equal(result.code, 'UNEXPECTED_ERROR');
});

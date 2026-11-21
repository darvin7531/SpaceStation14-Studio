import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeStudioError } from '../ui/error-utils.mjs';

test('preserves structured Rust errors with actionable hints', () => {
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

test('preserves error fields from JSON-string rejection', () => {
  const error = normalizeStudioError('{"code":"PROJECT_PATH_EMPTY","message":"Пусто","hint":"Укажите путь"}');
  assert.equal(error.code, 'PROJECT_PATH_EMPTY');
  assert.equal(error.hint, 'Укажите путь');
});

test('provides readable fallback for a plain-text rejection', () => {
  const error = normalizeStudioError('broken pipe');
  assert.equal(error.code, 'UNEXPECTED_ERROR');
  assert.match(error.message, /Не удалось/);
  assert.equal(error.details, 'broken pipe');
  assert.ok(error.hint);
});

test('provides stable fallback for null and invalid values', () => {
  for (const value of [null, undefined, 42, {}]) {
    const error = normalizeStudioError(value);
    assert.equal(error.code, 'UNEXPECTED_ERROR');
    assert.ok(error.message && error.hint);
  }
});

const FALLBACK = Object.freeze({
  code: 'UNEXPECTED_ERROR',
  message: 'Не удалось выполнить операцию.',
  hint: 'Повторите действие. Если ошибка повторяется, сохраните код и подробности для отчёта.',
});

/** A Tauri rejection can be a JSON object, Error, string, or malformed value. */
export function normalizeStudioError(error) {
  let value = error;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      value = { details: error };
    }
  }

  if (!value || typeof value !== 'object') {
    return { ...FALLBACK };
  }

  return {
    code: safeString(value.code, FALLBACK.code),
    message: safeString(value.message, FALLBACK.message),
    hint: safeString(value.hint, FALLBACK.hint),
    ...(value.details ? { details: String(value.details) } : {}),
  };
}

function safeString(value, fallback) {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

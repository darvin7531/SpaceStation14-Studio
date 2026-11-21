export interface StudioError {
  code: string;
  message: string;
  hint: string;
  details?: string;
}

const fallback: StudioError = {
  code: 'UNEXPECTED_ERROR',
  message: 'Не удалось выполнить операцию.',
  hint: 'Повторите действие. Если проблема повторяется, приложите код ошибки и технические сведения.',
};

function readable(value: unknown, defaultText: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : defaultText;
}

/** Converts any Tauri rejection into a predictable, explainable UI error. */
export function normalizeStudioError(input: unknown): StudioError {
  let value = input;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); }
    catch { value = { details: input }; }
  }
  if (value instanceof Error) return { ...fallback, details: value.message };
  if (typeof value !== 'object' || value === null) return { ...fallback };

  const raw = value as Record<string, unknown>;
  return {
    code: readable(raw.code, fallback.code),
    message: readable(raw.message, fallback.message),
    hint: readable(raw.hint, fallback.hint),
    ...(raw.details ? { details: String(raw.details) } : {}),
  };
}

import { normalizeStudioError, type StudioError } from './errors';

export async function refreshAfterRsiImport<T>(
  root: string, currentRoot: () => string | null, read: () => Promise<T>,
  apply: (result: T) => void, report: (error: StudioError) => void, failure?: unknown,
): Promise<void> {
  if (currentRoot() !== root) return;
  const operationError = failure === undefined ? null : normalizeStudioError(failure);
  if (operationError) report(operationError);
  try {
    const result = await read();
    if (currentRoot() === root) apply(result);
  } catch (refreshFailure) {
    if (currentRoot() !== root) return;
    const refreshError = normalizeStudioError(refreshFailure);
    report(operationError ? { ...operationError, details: [operationError.details,
      'Ошибка обновления: ' + refreshError.message + ' ' + refreshError.hint + ' ' + (refreshError.details ?? '')].filter(Boolean).join('\n') } : refreshError);
  }
}

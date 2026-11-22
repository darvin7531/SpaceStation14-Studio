/** Conservative scaffold for entity Fluent messages.
 * Never rewrites existing values or parses/serializes an entire FTL document.
 * Complex values must be edited in Monaco; this helper emits only plain text.
 */
export type EntityLocaleField = 'name' | 'description' | 'suffix';

export interface EntityLocaleValues {
  localization_id: string;
  name: string;
  description: string;
  suffix: string;
}

export interface EntityLocalePatch {
  content: string;
  added: EntityLocaleField[];
  alreadyPresent: EntityLocaleField[];
  changed: boolean;
}

const KEY = /^[A-Za-z][A-Za-z0-9_-]{0,127}$/;

function safeValue(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 4096 || /[{}\r\n\x00-\x1f\x7f]/.test(trimmed)) {
    throw new Error('Значение Fluent должно быть однострочным текстом до 4096 символов без { } и управляющих символов.');
  }
  return trimmed;
}

export function buildEntityLocalePatch(
  original: string,
  values: EntityLocaleValues,
  requested: readonly EntityLocaleField[],
): EntityLocalePatch {
  const key = values.localization_id;
  if (!KEY.test(key)) throw new Error('Fluent ID должен начинаться с латинской буквы и содержать только буквы, цифры, _ и - (до 128 символов).');
  if (original.length > 4 * 1024 * 1024) throw new Error('FTL слишком большой для безопасного изменения.');
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  const lines = original.split(/\r?\n/);
  const keyLine = new RegExp('^' + key.replace(/[.*+?^$\\{}()|[\]\\]/g, '\\$&') + '[ \\t]*=');
  const indices = lines.flatMap((line, index) => keyLine.test(line) ? [index] : []);
  if (indices.length > 1) throw new Error('Fluent ID объявлен несколько раз в выбранном файле. Исправьте дубликаты вручную.');
  const start = indices.length ? indices[0] : -1;
  const present = new Set<EntityLocaleField>();
  if (start >= 0) present.add('name');
  let end = start >= 0 ? start + 1 : -1;
  if (start >= 0) {
    while (end < lines.length && (/^[ \\t]/.test(lines[end]) || lines[end] === '')) {
      if (/^[ \\t]+\\.desc[ \\t]*=/.test(lines[end])) present.add('description');
      if (/^[ \\t]+\\.suffix[ \\t]*=/.test(lines[end])) present.add('suffix');
      end += 1;
    }
    // A blank separator is not part of the message: insert new attributes before it.
    while (end > start + 1 && lines[end - 1] === '') end -= 1;
  }

  const unique = [...new Set(requested)];
  const alreadyPresent = unique.filter((field) => present.has(field));
  const added = unique.filter((field) => !present.has(field));
  if (added.length === 0) return { content: original, added, alreadyPresent, changed: false };
  const patch = added.map((field) => {
    const value = safeValue(values[field]);
    return field === 'name' ? key + ' = ' + value
      : '    .' + (field === 'description' ? 'desc' : 'suffix') + ' = ' + value;
  });
  let next: string;
  if (start < 0) {
    // New message: the name line must precede attributes, even when user selected only desc.
    const block = added.includes('name') ? patch : [key + ' =', ...patch];
    const prefix = original.trim() ? original.replace(/(?:\r?\n)+$/, '') + eol + eol : '';
    next = prefix + block.join(eol) + eol;
  } else {
    // Existing message. Only add missing attributes; preserve the existing value verbatim.
    const insert = patch.filter((line) => line.startsWith('    .'));
    // 'name' cannot be added to an existing message; it is always considered present.
    const out = [...lines];
    out.splice(end, 0, ...insert);
    next = out.join(eol);
  }
  return { content: next, added, alreadyPresent, changed: next !== original };
}

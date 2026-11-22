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
  if (!trimmed || trimmed.length > 4096 || new TextEncoder().encode(trimmed).length > 8192 || /[{}\r\n\x00-\x1f\x7f]/.test(trimmed)) {
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
  const keyLine = new RegExp('^' + key + '[ \t]*=');
  const indices = lines.flatMap((line, index) => keyLine.test(line) ? [index] : []);
  if (indices.length > 1) throw new Error('Fluent ID объявлен несколько раз в выбранном файле. Исправьте дубликаты вручную.');
  const start = indices.length ? indices[0] : -1;
  const present = new Set<EntityLocaleField>();
  // An attribute-only Fluent message may have a blank main value.
  // Do not mistake "ent-foo =" for an existing name translation.
  if (start >= 0 && lines[start].slice(lines[start].indexOf('=') + 1).trim()) {
    present.add('name');
  }
  let end = start >= 0 ? start + 1 : -1;
  if (start >= 0) {
    while (end < lines.length && (/^[ \t]/.test(lines[end]) || lines[end] === '')) {
      if (/^[ \t]+\.desc[ \t]*=/.test(lines[end])) present.add('description');
      if (/^[ \t]+\.suffix[ \t]*=/.test(lines[end])) present.add('suffix');
      end += 1;
    }
    // A blank separator is not part of the message: insert new attributes before it.
    while (end > start + 1 && lines[end - 1] === '') end -= 1;
  }

  const unique = [...new Set(requested)];
  const alreadyPresent = unique.filter((field) => present.has(field));
  const added = unique.filter((field) => !present.has(field));
  if (added.length === 0) return { content: original, added, alreadyPresent, changed: false };
  // Fluent requires the message value before indented attributes, regardless of checkbox order.
  const patch = (['name', 'description', 'suffix'] as const).filter((field) => added.includes(field)).map((field) => {
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
    const out = [...lines];
    if (added.includes('name')) {
      // Fill an empty message value without replacing its existing attributes.
      out[start] = out[start].trimEnd() + ' ' + safeValue(values.name);
    }
    out.splice(end, 0, ...insert);
    next = out.join(eol);
  }
  return { content: next, added, alreadyPresent, changed: next !== original };
}

/** Electron quick-fix parity: select missing direct entity fields per required game locale.
 * Incomplete Rust indexes must never be treated as evidence of absent translations.
 * This is a plan, not permission to write any FTL file.
 */
export interface MissingLocalePlanItem {
  locale: string;
  path: string;
  fileExists: boolean;
  fields: EntityLocaleField[];
}

export function planMissingEntityTranslations(
  analysis: import('./api').EntityLocalizationAnalysis,
  selected: readonly EntityLocaleField[],
): MissingLocalePlanItem[] {
  if (!analysis.complete) return [];
  const unique = [...new Set(selected)];
  return analysis.targets.flatMap((target) => {
    const fields = unique.filter((field) =>
      analysis.diagnostics.some((issue) =>
        issue.field === field && issue.missing_locales.includes(target.locale)));
    return fields.length
      ? [{ locale: target.locale, path: target.path, fileExists: target.file_exists, fields }]
      : [];
  });
}

/** Reuse the scaffold's validation and include only fields confirmed missing. */
export function buildMissingFluentDraft(file: string, values: EntityLocaleValues, fields: readonly EntityLocaleField[]): import('./api').NewFluentDraft {
  const patch = buildEntityLocalePatch('', values, fields);
  if (!patch.changed) throw new Error('Нет полей для создания FTL.');
  return {
    file, starter_key: values.localization_id,
    starter_value: fields.includes('name') ? values.name.trim() : '',
    starter_description: fields.includes('description') ? values.description.trim() : undefined,
    starter_suffix: fields.includes('suffix') ? values.suffix.trim() : undefined,
    allow_empty_value: !fields.includes('name'),
  };
}

/** Pure, conservative YAML-context parser for Electron-compatible Monaco completions.
 * Only suggest IDs/types when the key being edited is structurally recognizable.
 */
export interface YamlCompletionContext {
  kind: 'prototype-parent' | 'component-type';
  query: string;
  startColumn: number;
}

function insideComponents(lines: readonly string[], lineNumber: number): boolean {
  for (let index = lineNumber - 2; index >= 0; index -= 1) {
    const line = lines[index];
    if (/^\s*components:\s*(?:#.*)?$/.test(line)) return true;
    if (/^-\s*type:\s*\S+/.test(line)) return false;
  }
  return false;
}

function insideParentList(lines: readonly string[], lineNumber: number): boolean {
  for (let index = lineNumber - 2; index >= 0; index -= 1) {
    const line = lines[index];
    if (/^\s*parent:\s*(?:#.*)?$/.test(line)) return true;
    if (/^-\s*type:\s*\S+/.test(line) || /^\s*[a-zA-Z_][\w-]*:\s*/.test(line)) return false;
  }
  return false;
}

export function yamlCompletionContext(
  lines: readonly string[], lineNumber: number, column: number,
): YamlCompletionContext | null {
  const line = lines[lineNumber - 1] ?? '';
  if (!Number.isInteger(column) || column < 1 || column > line.length + 1) return null;
  const prefix = line.slice(0, column - 1);
  let match = prefix.match(/^\s*parent:\s*([A-Za-z0-9_-]*)$/);
  if (match) return { kind: 'prototype-parent', query: match[1], startColumn: column - match[1].length };
  match = prefix.match(/^\s*parent:\s*\[[^\]\n]*$/);
  if (match) {
    const query = prefix.match(/([A-Za-z0-9_-]*)$/)?.[1] ?? '';
    return { kind: 'prototype-parent', query, startColumn: column - query.length };
  }
  match = prefix.match(/^\s*-\s*([A-Za-z0-9_-]*)$/);
  if (match && insideParentList(lines, lineNumber)) {
    return { kind: 'prototype-parent', query: match[1], startColumn: column - match[1].length };
  }
  match = prefix.match(/^(\s*-\s*type:\s*)([A-Za-z0-9_-]*)$/);
  if (match && insideComponents(lines, lineNumber)) {
    return { kind: 'component-type', query: match[2], startColumn: column - match[2].length };
  }
  return null;
}


/** Hover only the component identity under the cursor, not prototype types. */
export function yamlComponentHoverTarget(
  lines: readonly string[], lineNumber: number, column: number,
): { name: string; startColumn: number; endColumn: number } | null {
  const line = lines[lineNumber - 1] ?? '';
  const match = line.match(/^(\s*-\s*type:\s*)([A-Za-z0-9_]+)(?:\s*(?:#.*)?)?$/);
  if (!match || !insideComponents(lines, lineNumber)) return null;
  const startColumn = match[1].length + 1;
  const endColumn = startColumn + match[2].length;
  if (column < startColumn || column > endColumn) return null;
  return { name: match[2], startColumn, endColumn };
}

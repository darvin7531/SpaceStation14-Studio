/** Pure, conservative YAML-context parser for Electron-compatible Monaco completions.
 * Only suggest IDs/types when the key being edited is structurally recognizable.
 */
export interface YamlCompletionContext {
  kind: 'prototype-parent' | 'component-type' | 'component-entry-start' | 'component-field' | 'rsi-path';
  query: string;
  startColumn: number;
  componentType?: string;
  existingFields?: readonly string[];
}

export function yamlComponentInsertText(line: string, context: YamlCompletionContext, name: string): string {
  if (context.kind !== 'component-entry-start') return name;
  return (line[context.startColumn - 2] === '-' ? ' ' : '') + 'type: ' + name;
}

export function yamlFieldInsertText(line: string, column: number, name: string): string {
  const end = yamlCompletionEndColumn(line, column, 'component-field');
  return name + (/^\s*:/.test(line.slice(end - 1)) ? '' : ': ');
}

export async function yamlCurrentCompletion<T>(model: EditorModel, request: () => Promise<T>): Promise<T | null> {
  const version = model.getVersionId();
  const result = await request();
  return model.getVersionId() === version ? result : null;
}

export function yamlCompletionEndColumn(line: string, column: number, kind: YamlCompletionContext['kind']): number {
  const suffix = line.slice(column - 1);
  const quoted = kind === 'rsi-path' && /^\s*sprite:\s*["']/.test(line.slice(0, column - 1));
  const token = kind === 'rsi-path' ? (quoted ? /^[^"'#\\]*/ : /^[^"'#\s]*/) : /^[A-Za-z0-9_-]*/;
  return column + (suffix.match(token)?.[0].length ?? 0);
}

type EditorModel = { getLineContent(line: number): string; getVersionId(): number };
const editorContexts = new WeakMap<EditorModel, { version: number; lineNumber: number; lines: string[] }>();

/** Include the entire current prototype, including unsaved edits. */
// ponytail: first request per line/version scans the prototype; index scopes if large prototypes lag.
export function yamlEditorContextLines(model: EditorModel, lineNumber: number): string[] {
  const cache = editorContexts.get(model);
  const version = model.getVersionId();
  if (cache?.version === version && cache.lineNumber === lineNumber) return cache.lines;
  const lines: string[] = [];
  for (let line = lineNumber; line >= 1; line -= 1) {
    const text = model.getLineContent(line);
    lines.push(text);
    if (/^-\s*type:\s*\S+/.test(text)) break;
  }
  lines.reverse();
  editorContexts.set(model, { version, lineNumber, lines });
  return lines;
}

export function yamlEditorCompletionContext(model: EditorModel, lineNumber: number, column: number): YamlCompletionContext | null {
  const line = model.getLineContent(lineNumber);
  if (!Number.isInteger(column) || column < 1 || column > line.length + 1) return null;
  const prefix = line.slice(0, column - 1);
  if (!/^\s*(?:parent:\s*(?:[A-Za-z0-9_-]*|\[[^\]\n]*)|-\s*(?:type:\s*)?[A-Za-z0-9_-]*|sprite:\s*(?:["'][^"'#\\]*|[^"'#\s]*)|[a-zA-Z_][\w-]*)$/.test(prefix)) return null;
  const lines = yamlEditorContextLines(model, lineNumber);
  return yamlCompletionContext(lines, lines.length, column);
}

export function yamlEditorComponentHoverTarget(model: EditorModel, lineNumber: number, column: number) {
  const match = model.getLineContent(lineNumber).match(/^(\s*-\s*type:\s*)([A-Za-z0-9_]+)(?:\s*(?:#.*)?)?$/);
  if (!match || column < match[1].length + 1 || column > match[1].length + match[2].length + 1) return null;
  const lines = yamlEditorContextLines(model, lineNumber);
  return yamlComponentHoverTarget(lines, lines.length, column);
}

function insideComponents(lines: readonly string[], lineNumber: number): boolean {
  for (let index = lineNumber - 2; index >= 0; index -= 1) {
    const line = lines[index];
    if (/^\s*components:\s*(?:#.*)?$/.test(line)) return true;
    if (/^-\s*type:\s*\S+/.test(line)) return false;
  }
  return false;
}


const RSI_COMPONENTS = new Set(['Sprite', 'Clothing', 'Icon', 'HumanoidAppearance', 'Construction', 'FootstepModifier']);

/** Find a component and its already declared fields without treating other YAML lists as components. */
function componentScope(lines: readonly string[], lineNumber: number) {
  let sectionIndent: number | null = null;
  let component: { type: string; depth: number; fields: Set<string> } | null = null;
  for (let i = 0; i < lineNumber - 1; i += 1) {
    const line = lines[i];
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const depth = line.match(/^\s*/)?.[0].length ?? 0;
    const listItem = /^\s*-\s*/.test(line);
    if (sectionIndent !== null &&
        (depth < sectionIndent || (depth === sectionIndent && !listItem))) {
      sectionIndent = null;
      component = null;
    }
    if (/^\s*components:\s*(?:#.*)?$/.test(line)) {
      sectionIndent = depth;
      component = null;
      continue;
    }
    if (sectionIndent === null || depth < sectionIndent) continue;
    if (component && depth <= component.depth) component = null;
    const entry = line.match(/^\s*-\s*type:\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?:#.*)?$/);
    if (entry) {
      component = { type: entry[1], depth, fields: new Set() };
    } else if (component && depth > component.depth) {
      const field = line.match(/^\s*([a-zA-Z_][\w-]*):\s*/);
      if (field) component.fields.add(field[1]);
    }
  }
  const line = lines[lineNumber - 1] ?? '';
  const depth = line.match(/^\s*/)?.[0].length ?? 0;
  return {
    inside: sectionIndent !== null && (depth > sectionIndent ||
      (depth === sectionIndent && /^\s*-\s*/.test(line))),
    component: component && depth > component.depth ? component : null,
  };
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
  const suffix = line.slice(column - 1);
  // ponytail: skip quoted paths with # or escapes; parse YAML scalars to support them.
  if (/^\s*sprite:\s*(?:"[^"]*[#\\]|'[^']*[#\\])/.test(line)) return null;
  const quotedSprite = /^\s*sprite:\s*(["'])[^"'#\\]*$/.test(prefix);
  // Avoid inserting before an existing value, except within a quoted scalar.
  if (!quotedSprite && /^\s+[^#\s,\]:]/.test(suffix)) return null;
  if (/^["']/.test(suffix) && !quotedSprite) return null;
  const isSprite = /^\s*sprite:/.test(prefix);
  const tokenEnd = yamlCompletionEndColumn(line, column, isSprite ? 'rsi-path' : 'prototype-parent');
  const rest = line.slice(tokenEnd - 1);
  if (rest && !/^[\s#,:\]]/.test(rest) && !(quotedSprite && /^["']/.test(rest))) return null;
  let match = prefix.match(/^\s*parent:\s*([A-Za-z0-9_-]*)$/);
  if (match) return { kind: 'prototype-parent', query: match[1], startColumn: column - match[1].length };
  match = prefix.match(/^\s*parent:\s*\[\s*(?:[A-Za-z0-9_-]+\s*,\s*)*[A-Za-z0-9_-]*$/);
  if (match) {
    const query = prefix.match(/([A-Za-z0-9_-]*)$/)?.[1] ?? '';
    return { kind: 'prototype-parent', query, startColumn: column - query.length };
  }
  match = prefix.match(/^\s*-\s*([A-Za-z0-9_-]*)$/);
  if (match && insideParentList(lines, lineNumber)) {
    return { kind: 'prototype-parent', query: match[1], startColumn: column - match[1].length };
  }
  const scope = componentScope(lines, lineNumber);
  if (!scope.inside) return null;
  match = prefix.match(/^(\s*-\s*type:\s*)([A-Za-z0-9_-]*)$/);
  if (match) return { kind: 'component-type', query: match[2], startColumn: column - match[2].length };
  match = prefix.match(/^\s*-\s*([A-Za-z0-9_-]*)$/);
  if (match && !/^\s*-\s*[A-Za-z0-9_-]+\s*:/.test(line)) {
    return { kind: 'component-entry-start', query: match[1], startColumn: column - match[1].length };
  }
  if (!scope.component) return null;
  match = prefix.match(/^\s*sprite:\s*(?:(["'])([^"'#\\]*)|()([^"'#\s]*))$/);
  if (match && RSI_COMPONENTS.has(scope.component.type)) {
    const query = match[2] ?? match[4];
    return { kind: 'rsi-path', query, startColumn: column - query.length,
      componentType: scope.component.type };
  }
  match = prefix.match(/^\s*([a-zA-Z_][\w-]*)$/);
  if (match) {
    return { kind: 'component-field', query: match[1], startColumn: column - match[1].length,
      componentType: scope.component.type, existingFields: [...scope.component.fields] };
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


export function indexedRsiPath(raw: string): string | null {
  if (!raw.endsWith('.rsi') || /[\\\x00-\x1f\x7f]/.test(raw) || raw.startsWith('/') || /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(raw)) return null;
  const path = raw.startsWith('Resources/Textures/') ? raw : 'Resources/Textures/' + raw;
  const parts = path.split('/');
  if (parts.length < 4 || parts[0] !== 'Resources' || parts[1] !== 'Textures'
      || parts.some((part) => !part || part === '.' || part === '..')) return null;
  return path;
}

/** Encode an indexed path for the scalar already being edited. */
export function yamlRsiInsertText(line: string, context: YamlCompletionContext, path: string): string {
  const quote = line[context.startColumn - 2];
  if (quote === '"') return JSON.stringify(path).slice(1, -1);
  if (quote === "'") return path.replace(/'/g, "''");
  return /^[A-Za-z0-9_./-]+$/.test(path) ? path : JSON.stringify(path);
}

export function yamlSpriteLinkTarget(
  lines: readonly string[], lineNumber: number, column: number,
): string | null {
  const line = lines[lineNumber - 1] ?? '';
  const match = line.match(/^(\s*sprite:\s*)(["']?)([^"'#\s]+)(["']?)(?:\s*#.*)?$/);
  if (!match || match[2] !== match[4] || !componentScope(lines, lineNumber).component) return null;
  const start = match[1].length + match[2].length + 1;
  if (column < start || column > start + match[3].length) return null;
  return indexedRsiPath(match[3]);
}

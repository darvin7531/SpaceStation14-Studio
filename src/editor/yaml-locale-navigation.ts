import type { EntityLocaleField, PrototypeDeclaration } from '../lib/api';

/** A Ctrl+Click candidate: only direct name/description/suffix YAML scalar lines.
 * The actual entity identity, missing game locales and syntax are verified by
 * the native index; string matching here never edits or opens any file.
 */
export function yamlLocaleClickField(
  line: string, column: number,
): EntityLocaleField | null {
  if (!Number.isSafeInteger(column) || column < 1 || column > line.length + 1) return null;
  const match = line.match(/^(\s*)(name|description|suffix):[ \t]*(.*)$/);
  if (!match) return null;
  const from = match[1].length + 1;
  if (column < from || column > line.length + 1) return null;
  if (!match[3].trim() || /^#/.test(match[3].trim())) return null;
  const comment = line.indexOf(' #', from);
  if (comment >= 0 && column > comment + 1) return null;
  return match[2] as EntityLocaleField;
}

/** Prove a field is a direct sibling of the entity id, not a nested component
 * or a separate prototype. Declarations are sourced from inspect_yaml_outline.
 */
export function directEntityLocaleField(
  lines: readonly string[],
  lineNumber: number,
  declaration: PrototypeDeclaration,
): EntityLocaleField | null {
  if (declaration.kind !== 'entity' || declaration.mode !== 'normal'
    || declaration.line < 1 || declaration.line >= lineNumber
    || lineNumber > lines.length) return null;
  const header = lines[declaration.line - 1] ?? '';
  const prefix = header.match(/^(\s*)-\s*type:\s*entity(?:\s*(?:#.*)?)?$/);
  if (!prefix) return null;
  const declarationDepth = prefix[1].length;
  // A selected declaration must never claim a field from another YAML item
  // or document. The caller may have a stale outline while the user edits.
  for (let i = declaration.line; i < lineNumber - 1; i++) {
    const current = lines[i] ?? '';
    if (/^\s*(?:---|\.\.\.)(?:\s*(?:#.*)?)?$/.test(current)) return null;
    const item = current.match(/^(\s*)-\s+type\s*:/);
    if (item && item[1].length <= declarationDepth) return null;
  }
  const target = lines[lineNumber - 1] ?? '';
  const match = target.match(/^(\s*)(name|description|suffix):[ \t]*(.*)$/);
  if (!match || !match[3].trim()) return null;
  const depth = match[1].length;
  if (depth <= declarationDepth) return null;
  let idDepth: number | null = null;
  for (let i = declaration.line; i < lineNumber; i++) {
    const line = lines[i];
    const candidate = line.match(/^(\s*)id:\s*\S/);
    if (candidate && candidate[1].length > declarationDepth) {
      idDepth = idDepth === null ? candidate[1].length : Math.min(idDepth, candidate[1].length);
    }
  }
  return idDepth === depth ? match[2] as EntityLocaleField : null;
}

import type { EntityLocaleDiagnostic, PrototypeDeclaration } from '../lib/api';
import { directEntityLocaleField } from './yaml-locale-navigation';

export interface LocaleUnderline {
  line: number;
  startColumn: number;
  endColumn: number;
  field: EntityLocaleDiagnostic['field'];
  locales: readonly string[];
}

/** Electron's missing-locale inline marks, limited to a single native-indexed
 * ordinary entity and only direct fields explicitly reported as missing.
 * The next declaration boundary prevents accidentally marking another entity.
 */
export function missingEntityLocaleUnderlines(
  lines: readonly string[],
  declaration: PrototypeDeclaration,
  nextDeclarationLine: number | null,
  diagnostics: readonly EntityLocaleDiagnostic[],
): LocaleUnderline[] {
  if (declaration.kind !== 'entity' || declaration.mode !== 'normal') return [];
  const last = Math.min(lines.length, nextDeclarationLine === null
    ? lines.length : nextDeclarationLine - 1);
  if (last <= declaration.line) return [];
  const missing = new Map(diagnostics
    .filter((item) => item.missing_locales.length > 0)
    .map((item) => [item.field, [...item.missing_locales]] as const));
  const marked = new Set<string>();
  const markers: LocaleUnderline[] = [];
  for (let i = declaration.line + 1; i <= last && markers.length < 3; i++) {
    const line = lines[i - 1] ?? '';
    const direct = directEntityLocaleField(lines, i, declaration);
    if (!direct || marked.has(direct)) continue;
    const locales = missing.get(direct);
    if (!locales) continue;
    const match = line.match(/^(\s*)(name|description|suffix):/);
    if (!match) continue;
    const startColumn = match[1].length + 1;
    markers.push({
      line: i, startColumn, endColumn: startColumn + match[2].length,
      field: direct, locales,
    });
    marked.add(direct);
  }
  return markers;
}

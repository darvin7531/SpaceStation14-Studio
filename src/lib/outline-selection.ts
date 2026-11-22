import type { PrototypeDeclaration, SourceOutlineEntry } from './api';

/** Stable identity of a YAML item, independent of its editable ID. */
export function outlineDeclarationKey(
  item: Pick<PrototypeDeclaration, 'document_index' | 'item_index' | 'variant_index'>,
): string {
  return item.document_index + ':' + item.item_index + ':' + (item.variant_index ?? 'base');
}

/** Connect the Monaco cursor with the exact declaration shown in the inspector.
 * Use native outline positions, not a regular expression over the source.
 * For generated variants sharing the same line, prefer the literal base item.
 */
export function outlineKeyAtLine(
  entries: readonly Pick<SourceOutlineEntry, 'declaration'>[],
  line: number | null,
): string | null {
  if (!entries.length) return null;
  if (line === null) return outlineDeclarationKey(entries[0].declaration);
  if (!Number.isSafeInteger(line) || line < 1) return null;
  let selected: PrototypeDeclaration | null = null;
  for (const { declaration } of entries) {
    if (!Number.isSafeInteger(declaration.line) || declaration.line > line
        || declaration.line < 1) continue;
    if (!selected || declaration.line > selected.line
        || (declaration.line === selected.line
          && selected.variant_index !== null && declaration.variant_index === null)) {
      selected = declaration;
    }
  }
  return selected ? outlineDeclarationKey(selected) : null;
}

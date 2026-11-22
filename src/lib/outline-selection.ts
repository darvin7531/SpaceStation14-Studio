import type { PrototypeDeclaration, PrototypeFieldLocator, SourceOutlineEntry } from './api';
import type { EditorTab } from './tabs';

export function canApplyPrototypeFields(target: PrototypeFieldLocator | null, current: PrototypeFieldLocator | null, locator: PrototypeFieldLocator, path: string | null): boolean {
  return !!target && target === current && path === target.file
    && locator.file === target.file && locator.id === target.id && locator.kind === target.kind
    && locator.document_index === target.document_index && locator.item_index === target.item_index
    && locator.mode === target.mode;
}

export function resolvePrototypeTab(entries: readonly SourceOutlineEntry[], target: NonNullable<EditorTab['prototype']>, truncated: boolean): PrototypeDeclaration | null {
  if (truncated) return null;
  const matches = entries.map(({ declaration }) => declaration).filter((item) =>
    item.file === target.file && item.kind === target.kind && item.id === target.id
    && item.document_index === target.document_index && item.item_index === target.item_index
    && (target.variant_index === undefined || item.variant_index === target.variant_index)
    && item.mode === target.mode);
  return matches.length === 1 ? matches[0] : null;
}

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

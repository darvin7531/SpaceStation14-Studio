import type { SourceOutline } from './api';
export const RESOURCE_TREE_PAGE_SIZE = 100;
export const RESOURCE_TREE_MAX_DEPTH = 32;
export function treePageOffset(page: number): number {
  return Number.isSafeInteger(page) && page >= 0 && page < 100_000 ? page * RESOURCE_TREE_PAGE_SIZE : 0;
}
/** Same identity that the native YAML outline uses for source declarations. */
export function treePrototypes(outline: SourceOutline) {
  return outline.declarations.map((entry) => entry.declaration).filter((entry) => entry.line > 0);
}
export function treePrototypeKey(declaration: ReturnType<typeof treePrototypes>[number]): string {
  return [declaration.document_index, declaration.item_index, declaration.variant_index ?? 'base'].join(':');
}

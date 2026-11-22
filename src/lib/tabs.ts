import type { ResourceEntry, PrototypeFieldLocator } from './api';

export type EditorTab = ResourceEntry & { prototype?: PrototypeFieldLocator & { variant_index?: number | null } };
export function tabId(tab: EditorTab): string {
  return tab.prototype ? 'prototype:' + JSON.stringify([tab.path, tab.prototype.kind, tab.prototype.id, tab.prototype.document_index, tab.prototype.item_index, tab.prototype.mode, ...(tab.prototype.variant_index == null ? [] : [tab.prototype.variant_index])]) : tab.path;
}
export function isLastFileView(state: TabState, id: string): boolean {
  const tab = state.tabs.find((item) => tabId(item) === id);
  return !!tab && state.tabs.filter((item) => item.path === tab.path).length === 1;
}

export const MAX_OPEN_TABS = 12;

export interface TabState {
  tabs: EditorTab[];
  active: string | null;
}

export type OpenTabResult =
  | { ok: true; state: TabState }
  | { ok: false; reason: 'LIMIT_REACHED'; state: TabState };

/**
 * File paths are case-sensitive IDs because SS14 is developed on Linux too.
 * Never discard a tab silently (a later editing mode will have unsaved drafts).
 */
export function openTab(state: TabState, resource: EditorTab, limit = MAX_OPEN_TABS): OpenTabResult {
  if (state.tabs.some((tab) => tabId(tab) === tabId(resource))) {
    return { ok: true, state: { tabs: state.tabs.map((tab) => tabId(tab) === tabId(resource) ? resource : tab), active: tabId(resource) } };
  }
  if (state.tabs.length >= limit) {
    return { ok: false, reason: 'LIMIT_REACHED', state };
  }
  return { ok: true, state: { tabs: [...state.tabs, resource], active: tabId(resource) } };
}

/** Closing the selected tab activates the nearest remaining neighbor. */
export function closeTab(state: TabState, path: string): TabState {
  const index = state.tabs.findIndex((tab) => tabId(tab) === path);
  if (index < 0) return state;
  const tabs = state.tabs.filter((tab) => tabId(tab) !== path);
  const active = state.active === path
    ? (tabs.length ? tabId(tabs[Math.min(index, tabs.length - 1)]) : null)
    : state.active;
  return { tabs, active };
}

/** Electron tab reorder parity: moving a tab never changes its active file or draft. */
export function reorderTab(state: TabState, path: string, index: number): TabState {
  const previousIndex = state.tabs.findIndex((tab) => tabId(tab) === path);
  if (previousIndex < 0 || !Number.isSafeInteger(index)
    || index < 0 || index >= state.tabs.length || index === previousIndex) return state;
  const tabs = [...state.tabs];
  const [item] = tabs.splice(previousIndex, 1);
  tabs.splice(index, 0, item);
  return { tabs, active: state.active };
}

/** Calculate a drop index without mutating tabs or requiring DOM in tests.
 * Centers are the remaining tabs in current visual order.
 */
export function insertionIndexForTabPointer(
  pointerX: number, centers: readonly { path: string; center: number }[],
): number {
  if (!Number.isFinite(pointerX)) return 0;
  return centers.filter((item) => Number.isFinite(item.center) && pointerX > item.center).length;
}

/** Select the next or previous visible tab without discarding any draft. */
export function nextTabPath(state: TabState, backwards = false): string | null {
  const count = state.tabs.length;
  if (count === 0) return null;
  const current = state.tabs.findIndex((tab) => tabId(tab) === state.active);
  const next = current < 0 ? 0 : (current + (backwards ? count - 1 : 1)) % count;
  return tabId(state.tabs[next]);
}

import type { ResourceEntry } from './api';

export const MAX_OPEN_TABS = 12;

export interface TabState {
  tabs: ResourceEntry[];
  active: string | null;
}

export type OpenTabResult =
  | { ok: true; state: TabState }
  | { ok: false; reason: 'LIMIT_REACHED'; state: TabState };

/**
 * File paths are case-sensitive IDs because SS14 is developed on Linux too.
 * Never discard a tab silently (a later editing mode will have unsaved drafts).
 */
export function openTab(state: TabState, resource: ResourceEntry, limit = MAX_OPEN_TABS): OpenTabResult {
  if (state.tabs.some((tab) => tab.path === resource.path)) {
    return { ok: true, state: { ...state, active: resource.path } };
  }
  if (state.tabs.length >= limit) {
    return { ok: false, reason: 'LIMIT_REACHED', state };
  }
  return { ok: true, state: { tabs: [...state.tabs, resource], active: resource.path } };
}

/** Closing the selected tab activates the nearest remaining neighbor. */
export function closeTab(state: TabState, path: string): TabState {
  const index = state.tabs.findIndex((tab) => tab.path === path);
  if (index < 0) return state;
  const tabs = state.tabs.filter((tab) => tab.path !== path);
  const active = state.active === path
    ? (tabs[Math.min(index, tabs.length - 1)]?.path ?? null)
    : state.active;
  return { tabs, active };
}

/** Electron tab reorder parity: moving a tab never changes its active file or draft. */
export function reorderTab(state: TabState, path: string, index: number): TabState {
  const previousIndex = state.tabs.findIndex((tab) => tab.path === path);
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
  const current = state.tabs.findIndex((tab) => tab.path === state.active);
  const next = current < 0 ? 0 : (current + (backwards ? count - 1 : 1)) % count;
  return state.tabs[next].path;
}

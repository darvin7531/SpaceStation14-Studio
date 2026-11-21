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

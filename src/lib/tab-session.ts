import { MAX_OPEN_TABS, tabId, type EditorTab, type TabState } from './tabs';

const PREFIX = 'ss14-studio-open-tabs-v1:';

/** Persisted paths are untrusted and may refer to old or deleted resources. */
export function validTab(value: unknown): value is EditorTab {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const tab = value as Record<string, unknown>;
  if (typeof tab.path !== 'string' || tab.path.length > 1024
    || /[\\\u0000]/.test(tab.path)
    || tab.path.split('/').some((segment) => !segment || segment === '.' || segment === '..')) return false;
  if (tab.prototype !== undefined) {
    if (tab.kind !== 'yaml' || !tab.prototype || typeof tab.prototype !== 'object' || Array.isArray(tab.prototype)) return false;
    const p = tab.prototype as Record<string, unknown>;
    if (p.file !== tab.path || typeof p.kind !== 'string' || !p.kind || p.kind.length > 256
      || typeof p.id !== 'string' || !p.id || p.id.length > 1024
      || !Number.isSafeInteger(p.document_index) || (p.document_index as number) < 1
      || !Number.isSafeInteger(p.item_index) || (p.item_index as number) < 1
      || (p.variant_index !== undefined && p.variant_index !== null
        && (!Number.isSafeInteger(p.variant_index) || (p.variant_index as number) < 0))
      || !['normal', 'configured_partial', 'tagged_partial', 'partial_only'].includes(p.mode as string)) return false;
  }
  const lower = tab.path.toLowerCase();
  return (tab.kind === 'yaml' && tab.path.startsWith('Resources/Prototypes/')
      && (lower.endsWith('.yml') || lower.endsWith('.yaml')))
    || (tab.kind === 'ftl' && tab.path.startsWith('Resources/Locale/') && lower.endsWith('.ftl'))
    || (tab.kind === 'rsi' && tab.path.startsWith('Resources/Textures/') && lower.endsWith('.rsi'));
}

export function sessionKey(root: string): string { return PREFIX + root; }

export function readTabSession(storage: Pick<Storage, 'getItem'>, root: string): TabState {
  const empty: TabState = { tabs: [], active: null };
  try {
    const raw = storage.getItem(sessionKey(root));
    if (!raw) return empty;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return empty;
    const data = parsed as Record<string, unknown>;
    if (!Array.isArray(data.tabs)) return empty;
    const seen = new Set<string>();
    const tabs: EditorTab[] = data.tabs.filter((candidate) => {
      if (!validTab(candidate) || seen.has(tabId(candidate))) return false;
      seen.add(tabId(candidate));
      return true;
    }).slice(0, MAX_OPEN_TABS) as EditorTab[];
    const active = typeof data.active === 'string' && tabs.some((tab) => tabId(tab) === data.active)
      ? data.active : (tabs[0] ? tabId(tabs[0]) : null);
    return { tabs, active };
  } catch { return empty; }
}

/** Only paths and active selection are stored; drafts remain in the Rust journal. */
export function writeTabSession(storage: Pick<Storage, 'setItem'>, root: string, state: TabState): void {
  const tabs = state.tabs.filter(validTab).slice(0, MAX_OPEN_TABS);
  const active = tabs.some((tab) => tabId(tab) === state.active) ? state.active : (tabs[0] ? tabId(tabs[0]) : null);
  storage.setItem(sessionKey(root), JSON.stringify({ tabs, active }));
}

export function retainAvailableTabs(state: TabState, paths: ReadonlySet<string>): TabState {
  const tabs = state.tabs.filter((tab) => paths.has(tab.path));
  const active = state.active && tabs.some((tab) => tabId(tab) === state.active) ? state.active : (tabs[0] ? tabId(tabs[0]) : null);
  return { tabs, active };
}

import { create } from 'zustand';
import { EditorResourceTab, ProjectSummary, PrototypeDetail, PrototypeEditorTab, RsiAssetDetail, RsiEditorTab, ValidationIssue } from '../types';

interface ProjectState {
  projectRoot: string | null;
  counts: ProjectSummary['counts'];
  validationIssues: ValidationIssue[];
  selectedPrototypeId: string | null;
  selectedPrototype: PrototypeDetail | null;
  selectedRsiPath: string | null;
  selectedRsi: RsiAssetDetail | null;
  selectedEditorTab: 'form' | 'raw' | 'resolved';
  editorJumpQuery: string | null;
  highlightedRsiState: string | null;
  searchQuery: string;
  filterType: string;
  isScanning: boolean;
  scanProgress: string;
  tabOrder: string[];
  tabsById: Record<string, EditorResourceTab>;
  activeTabId: string | null;

  setProject: (result: ProjectSummary) => void;
  setValidationIssues: (issues: ValidationIssue[]) => void;
  setSelectedPrototypeId: (id: string | null) => void;
  setSelectedPrototype: (detail: PrototypeDetail | null) => void;
  setSelectedRsiPath: (path: string | null) => void;
  setSelectedRsi: (detail: RsiAssetDetail | null) => void;
  setSelectedEditorTab: (tab: 'form' | 'raw' | 'resolved') => void;
  setEditorJumpQuery: (query: string | null) => void;
  setHighlightedRsiState: (state: string | null) => void;
  setSearchQuery: (query: string) => void;
  setFilterType: (type: string) => void;
  setIsScanning: (isScanning: boolean) => void;
  setScanProgress: (progress: string) => void;
  updateSelectedPrototype: (updated: Partial<PrototypeDetail['prototype']>) => void;
  openPrototypeTab: (key: string, detail: PrototypeDetail | null, options?: { editorTab?: 'form' | 'raw' | 'resolved'; jumpQuery?: string | null }) => void;
  openRsiTab: (path: string, detail: RsiAssetDetail | null, options?: { highlightedState?: string | null }) => void;
  activateTab: (tabId: string) => void;
  closeTab: (tabId: string) => void;
  reorderTab: (tabId: string, targetIndex: number) => void;
  updateActivePrototypeDraft: (yaml: string) => void;
  updatePrototypeDraftById: (tabId: string, yaml: string) => void;
  updateActivePrototypeDetail: (detail: PrototypeDetail | null, options?: { preserveDraft?: boolean; dirty?: boolean }) => void;
  updatePrototypeDetailById: (tabId: string, detail: PrototypeDetail | null, options?: { preserveDraft?: boolean; dirty?: boolean }) => void;
  updateActivePrototypeSaved: (detail: PrototypeDetail | null, rawYaml: string) => void;
  updateActiveRsiDetail: (detail: RsiAssetDetail | null, dirty?: boolean) => void;
  updateActiveRsiMeta: (updater: (detail: RsiAssetDetail) => RsiAssetDetail) => void;
}

const emptyCounts = {
  prototypes: 0,
  rsis: 0,
  components: 0,
  prototypeKinds: 0,
  issues: 0,
};

function prototypeTabId(key: string) {
  return `prototype:${key}`;
}

function rsiTabId(path: string) {
  return `rsi:${path}`;
}

function syncActiveSelection(tab: EditorResourceTab | null) {
  if (!tab) {
    return {
      activeTabId: null,
      selectedPrototypeId: null,
      selectedPrototype: null,
      selectedRsiPath: null,
      selectedRsi: null,
      selectedEditorTab: 'form' as const,
      editorJumpQuery: null,
      highlightedRsiState: null,
    };
  }

  if (tab.kind === 'prototype') {
    return {
      activeTabId: tab.id,
      selectedPrototypeId: tab.prototypeKey,
      selectedPrototype: tab.detail,
      selectedRsiPath: null,
      selectedRsi: null,
      selectedEditorTab: tab.editorTab,
      editorJumpQuery: tab.jumpQuery ?? null,
      highlightedRsiState: null,
    };
  }

  return {
    activeTabId: tab.id,
    selectedPrototypeId: null,
    selectedPrototype: null,
    selectedRsiPath: tab.rsiPath,
    selectedRsi: tab.detail,
    selectedEditorTab: 'form' as const,
    editorJumpQuery: null,
    highlightedRsiState: tab.highlightedState ?? null,
  };
}

function getTabById(state: Pick<ProjectState, 'tabsById'>, tabId: string | null) {
  if (!tabId) return null;
  return state.tabsById[tabId] ?? null;
}

function nextTabIdAfterClose(order: string[], closingId: string) {
  const index = order.indexOf(closingId);
  if (index < 0) return null;
  return order[index + 1] ?? order[index - 1] ?? null;
}

function moveItem<T>(items: T[], fromIndex: number, toIndex: number) {
  if (fromIndex === toIndex) return items;
  const next = [...items];
  const [item] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, item);
  return next;
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  projectRoot: null,
  counts: emptyCounts,
  validationIssues: [],
  selectedPrototypeId: null,
  selectedPrototype: null,
  selectedRsiPath: null,
  selectedRsi: null,
  selectedEditorTab: 'form',
  editorJumpQuery: null,
  highlightedRsiState: null,
  searchQuery: '',
  filterType: 'all',
  isScanning: false,
  scanProgress: '',
  tabOrder: [],
  tabsById: {},
  activeTabId: null,

  setProject: (result) => set({
    projectRoot: result.projectRoot,
    counts: result.counts,
    validationIssues: result.issues,
  }),
  setValidationIssues: (issues) => set({ validationIssues: issues }),
  setSelectedPrototypeId: (id) => set({ selectedPrototypeId: id }),
  setSelectedPrototype: (detail) => set({ selectedPrototype: detail }),
  setSelectedRsiPath: (path) => set({ selectedRsiPath: path }),
  setSelectedRsi: (detail) => set({ selectedRsi: detail }),
  setSelectedEditorTab: (tab) => set((state) => {
    const active = getTabById(state, state.activeTabId);
    if (!active || active.kind !== 'prototype') return { selectedEditorTab: tab };
    const nextTab: PrototypeEditorTab = { ...active, editorTab: tab };
    return {
      selectedEditorTab: tab,
      tabsById: { ...state.tabsById, [nextTab.id]: nextTab },
    };
  }),
  setEditorJumpQuery: (query) => set((state) => {
    const active = getTabById(state, state.activeTabId);
    if (!active || active.kind !== 'prototype') return { editorJumpQuery: query };
    const nextTab: PrototypeEditorTab = { ...active, jumpQuery: query };
    return {
      editorJumpQuery: query,
      tabsById: { ...state.tabsById, [nextTab.id]: nextTab },
    };
  }),
  setHighlightedRsiState: (stateValue) => set((state) => {
    const active = getTabById(state, state.activeTabId);
    if (!active || active.kind !== 'rsi') return { highlightedRsiState: stateValue };
    const nextTab: RsiEditorTab = { ...active, highlightedState: stateValue };
    return {
      highlightedRsiState: stateValue,
      tabsById: { ...state.tabsById, [nextTab.id]: nextTab },
    };
  }),
  setSearchQuery: (query) => set({ searchQuery: query }),
  setFilterType: (type) => set({ filterType: type }),
  setIsScanning: (isScanning) => set({ isScanning }),
  setScanProgress: (progress) => set({ scanProgress: progress }),
  updateSelectedPrototype: (updated) => set((state) => {
    const active = getTabById(state, state.activeTabId);
    if (!state.selectedPrototype || !active || active.kind !== 'prototype') return {};
    const nextDetail = { ...state.selectedPrototype, prototype: { ...state.selectedPrototype.prototype, ...updated } };
    return {
      selectedPrototype: nextDetail,
      tabsById: {
        ...state.tabsById,
        [active.id]: { ...active, detail: nextDetail },
      },
    };
  }),
  openPrototypeTab: (key, detail, options) => set((state) => {
    const id = prototypeTabId(key);
    const existing = state.tabsById[id];
    let nextTab: PrototypeEditorTab;

    if (existing && existing.kind === 'prototype') {
      nextTab = existing.dirty || !detail
        ? {
            ...existing,
            editorTab: options?.editorTab ?? existing.editorTab,
            jumpQuery: options?.jumpQuery ?? existing.jumpQuery,
          }
        : {
            ...existing,
            detail,
            rawYaml: detail.prototype._rawYaml || '',
            title: String(detail.prototype.id ?? key),
            subtitle: detail.prototype._filePath,
            editorTab: options?.editorTab ?? existing.editorTab,
            jumpQuery: options?.jumpQuery ?? existing.jumpQuery,
          };
    } else {
      nextTab = {
        id,
        kind: 'prototype',
        prototypeKey: key,
        title: String(detail?.prototype.id ?? key),
        subtitle: detail?.prototype._filePath ?? '',
        dirty: false,
        detail,
        rawYaml: detail?.prototype._rawYaml || '',
        editorTab: options?.editorTab ?? 'form',
        jumpQuery: options?.jumpQuery ?? null,
      };
    }

    return {
      tabOrder: state.tabOrder.includes(id) ? state.tabOrder : [...state.tabOrder, id],
      tabsById: { ...state.tabsById, [id]: nextTab },
      ...syncActiveSelection(nextTab),
    };
  }),
  openRsiTab: (path, detail, options) => set((state) => {
    const id = rsiTabId(path);
    const existing = state.tabsById[id];
    let nextTab: RsiEditorTab;

    if (existing && existing.kind === 'rsi') {
      nextTab = existing.dirty || !detail
        ? {
            ...existing,
            highlightedState: options?.highlightedState ?? existing.highlightedState,
          }
        : {
            ...existing,
            detail,
            title: path.split('/').at(-1) ?? path,
            subtitle: path,
            highlightedState: options?.highlightedState ?? existing.highlightedState,
          };
    } else {
      nextTab = {
        id,
        kind: 'rsi',
        rsiPath: path,
        title: path.split('/').at(-1) ?? path,
        subtitle: path,
        dirty: false,
        detail,
        highlightedState: options?.highlightedState ?? null,
      };
    }

    return {
      tabOrder: state.tabOrder.includes(id) ? state.tabOrder : [...state.tabOrder, id],
      tabsById: { ...state.tabsById, [id]: nextTab },
      ...syncActiveSelection(nextTab),
    };
  }),
  activateTab: (tabId) => set((state) => syncActiveSelection(getTabById(state, tabId))),
  closeTab: (tabId) => set((state) => {
    const nextOrder = state.tabOrder.filter((id) => id !== tabId);
    const nextTabsById = { ...state.tabsById };
    delete nextTabsById[tabId];
    const nextActiveId = state.activeTabId === tabId ? nextTabIdAfterClose(state.tabOrder, tabId) : state.activeTabId;
    return {
      tabOrder: nextOrder,
      tabsById: nextTabsById,
      ...syncActiveSelection(nextActiveId ? nextTabsById[nextActiveId] ?? null : null),
    };
  }),
  reorderTab: (tabId, targetIndex) => set((state) => {
    const fromIndex = state.tabOrder.indexOf(tabId);
    if (fromIndex < 0) return {};
    const clampedIndex = Math.max(0, Math.min(targetIndex, state.tabOrder.length - 1));
    if (fromIndex === clampedIndex) return {};
    return {
      tabOrder: moveItem(state.tabOrder, fromIndex, clampedIndex),
    };
  }),
  updateActivePrototypeDraft: (yaml) => set((state) => {
    const active = getTabById(state, state.activeTabId);
    if (!active || active.kind !== 'prototype') return {};
    const nextTab: PrototypeEditorTab = { ...active, rawYaml: yaml, dirty: true };
    return {
      tabsById: { ...state.tabsById, [active.id]: nextTab },
      selectedPrototype: nextTab.detail,
    };
  }),
  updatePrototypeDraftById: (tabId, yaml) => set((state) => {
    const tab = state.tabsById[tabId];
    if (!tab || tab.kind !== 'prototype') return {};
    if (tab.rawYaml === yaml && tab.dirty) return {};
    const nextTab: PrototypeEditorTab = { ...tab, rawYaml: yaml, dirty: true };
    return {
      tabsById: { ...state.tabsById, [tabId]: nextTab },
      ...(state.activeTabId === tabId ? { selectedPrototype: nextTab.detail } : {}),
    };
  }),
  updateActivePrototypeDetail: (detail, options) => set((state) => {
    const active = getTabById(state, state.activeTabId);
    if (!active || active.kind !== 'prototype') return {};
    const nextTab: PrototypeEditorTab = {
      ...active,
      detail,
      title: String(detail?.prototype.id ?? active.title),
      subtitle: detail?.prototype._filePath ?? active.subtitle,
      rawYaml: options?.preserveDraft ? active.rawYaml : detail?.prototype._rawYaml || active.rawYaml,
      dirty: options?.dirty ?? active.dirty,
    };
    return {
      tabsById: { ...state.tabsById, [active.id]: nextTab },
      selectedPrototype: nextTab.detail,
      selectedPrototypeId: nextTab.prototypeKey,
      selectedEditorTab: nextTab.editorTab,
      editorJumpQuery: nextTab.jumpQuery ?? null,
    };
  }),
  updatePrototypeDetailById: (tabId, detail, options) => set((state) => {
    const tab = state.tabsById[tabId];
    if (!tab || tab.kind !== 'prototype') return {};
    const nextTab: PrototypeEditorTab = {
      ...tab,
      detail,
      title: String(detail?.prototype.id ?? tab.title),
      subtitle: detail?.prototype._filePath ?? tab.subtitle,
      rawYaml: options?.preserveDraft ? tab.rawYaml : detail?.prototype._rawYaml || tab.rawYaml,
      dirty: options?.dirty ?? tab.dirty,
    };
    return {
      tabsById: { ...state.tabsById, [tabId]: nextTab },
      ...(state.activeTabId === tabId ? {
        selectedPrototype: nextTab.detail,
        selectedPrototypeId: nextTab.prototypeKey,
        selectedEditorTab: nextTab.editorTab,
        editorJumpQuery: nextTab.jumpQuery ?? null,
      } : {}),
    };
  }),
  updateActivePrototypeSaved: (detail, rawYaml) => set((state) => {
    const active = getTabById(state, state.activeTabId);
    if (!active || active.kind !== 'prototype') return {};
    const nextTab: PrototypeEditorTab = {
      ...active,
      detail,
      rawYaml,
      dirty: false,
      title: String(detail?.prototype.id ?? active.title),
      subtitle: detail?.prototype._filePath ?? active.subtitle,
    };
    return {
      tabsById: { ...state.tabsById, [active.id]: nextTab },
      selectedPrototype: nextTab.detail,
    };
  }),
  updateActiveRsiDetail: (detail, dirty = false) => set((state) => {
    const active = getTabById(state, state.activeTabId);
    if (!active || active.kind !== 'rsi') return {};
    const nextTab: RsiEditorTab = {
      ...active,
      detail,
      dirty,
      title: detail?.path.split('/').at(-1) ?? active.title,
      subtitle: detail?.path ?? active.subtitle,
    };
    return {
      tabsById: { ...state.tabsById, [active.id]: nextTab },
      selectedRsi: nextTab.detail,
      selectedRsiPath: nextTab.rsiPath,
      highlightedRsiState: nextTab.highlightedState ?? null,
    };
  }),
  updateActiveRsiMeta: (updater) => set((state) => {
    const active = getTabById(state, state.activeTabId);
    if (!active || active.kind !== 'rsi' || !active.detail) return {};
    const nextTab: RsiEditorTab = {
      ...active,
      detail: updater(active.detail),
      dirty: true,
    };
    return {
      tabsById: { ...state.tabsById, [active.id]: nextTab },
      selectedRsi: nextTab.detail,
      highlightedRsiState: nextTab.highlightedState ?? null,
    };
  }),
}));

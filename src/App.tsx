import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useI18n } from './i18n';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { open as openDirectoryDialog } from '@tauri-apps/plugin-dialog';
import {
  AlertCircle, AlertTriangle, CheckCircle2, ChevronLeft, ChevronRight,
  FileCode2, FileText, FolderOpen, Image as ImageIcon, Search, X, RotateCcw, Save, FilePlus2, Settings2,
} from 'lucide-react';
import { studio, type DraftList, type DraftSnapshot, type CreatedPrototype, type CreatedFluent, type CreatedRsi, type DeletedRsiState, type ImportedRsiState, RenamedRsiState, type RestoredRsiState, type PrototypeDeclaration, type PrototypeFieldLocator, type ProjectOverview, type ResourceDocument, type ResourceEntry, type ResourceKind, type ResourcePage, type NewFluentDraft } from './lib/api';
import { normalizeStudioError, type StudioError } from './lib/errors';
import type { ProjectScanProgress } from './lib/api';
import { closeTab, openTab, nextTabPath, reorderTab, type TabState } from './lib/tabs';
import { readTabSession, retainAvailableTabs, writeTabSession } from './lib/tab-session';
import { readRecentProjects, rememberRecentProject, writeRecentProjects } from './lib/recent-projects';
import { dirtyDocumentPaths, reconcileSavedDraft } from './lib/draft-state';
import { DraftWriteQueue, journalKey } from './lib/draft-queue';
import { persistExitRecovery } from './lib/exit-recovery';
import { reviewDecision } from './lib/review-guard';
import { reconcileWorkspaceRefresh } from './lib/workspace-refresh';
import MonacoPreview from './editor/MonacoPreview';
import RsiPreview from './components/RsiPreview';
import CreateRsiWizard from './components/CreateRsiWizard';
import PrototypeExplorer from './components/PrototypeExplorer';
import PrototypeFieldsPanel from './components/PrototypeFieldsPanel';
import PrototypeParentsPanel from './components/PrototypeParentsPanel';
import PrototypeOutlinePanel from './components/PrototypeOutlinePanel';
import PrototypeLocalizationPanel from './components/PrototypeLocalizationPanel';
import PrototypeComponentsPanel from './components/PrototypeComponentsPanel';
import RecoveryPanel from './components/RecoveryPanel';
import CreatePrototypeWizard, { type PrototypeDestinationMode } from './components/CreatePrototypeWizard';
import CreateFluentWizard from './components/CreateFluentWizard';
import FluentDiagnosticsPanel from './components/FluentDiagnosticsPanel';
import YamlDiagnosticsPanel from './components/YamlDiagnosticsPanel';
import CSharpCatalogPanel from './components/CSharpCatalogPanel';
import UiSourcesPanel from './components/UiSourcesPanel';
import ConflictReviewPanel from './components/ConflictReviewPanel';
import EditorSettingsDialog from './components/EditorSettingsDialog';
import StatusPanel from './components/StatusPanel';
import ResourceTabStrip from './components/ResourceTabStrip';
import QuickOpenPanel from './components/QuickOpenPanel';
import ContentSearchPanel from './components/ContentSearchPanel';
import type { ContentSearchHit, OpenRevision, ResourceDriftReport } from './lib/api';
import ResourceDriftBanner from './components/ResourceDriftBanner';
import ResourceFolderBrowser from './components/ResourceFolderBrowser';
import { retainCurrentDrifts } from './lib/resource-drift';
import { readEditorSettings, sanitizeEditorSettings, SETTINGS_KEY } from './lib/editor-settings';
import { readLocalizationSettings, sanitizeLocalizationSettings, LOCALIZATION_SETTINGS_KEY } from './lib/localization-settings';

const PAGE_SIZE = 100;
const LAST_PROJECT_KEY = 'ss14-studio-rust.last-project-root';
const kinds: ResourceKind[] = ['all', 'yaml', 'rsi', 'ftl'];
const isEditableText = (kind: ResourceEntry['kind']) => kind === 'yaml' || kind === 'ftl';
type PendingAction =
  | { type: 'open'; path: string }
  | { type: 'close'; path: string }
  | { type: 'reload'; path: string };

interface DiskComparison {
  path: string;
  disk: ResourceDocument;
  reviewedDraft: string;
}

function ResourceIcon({ kind }: { kind: ResourceEntry['kind'] }) {
  if (kind === 'rsi') return <ImageIcon size={15} />;
  if (kind === 'ftl') return <FileText size={15} />;
  return <FileCode2 size={15} />;
}

function ErrorPanel({ error, close }: { error: StudioError; close: () => void }) {
  const { t } = useI18n();
  return <section className="error-panel" role="alert">
    <div className="error-heading"><AlertCircle size={18}/><strong>{error.message}</strong></div>
    <p>{error.hint}</p>
    <div className="error-footer">
      <code>{error.code}</code>
      {error.details && <details><summary>{t('app.errorDetails')}</summary><pre>{error.details}</pre></details>}
      <button type="button" onClick={close}>{t('common.close')}</button>
    </div>
  </section>;
}

export default function App() {
  const { t } = useI18n();
  const [path, setPath] = useState(() => {
    try {
      return window.localStorage.getItem(LAST_PROJECT_KEY) ?? '';
    } catch {
      return '';
    }
  });
  const [recentProjects, setRecentProjects] = useState<string[]>(() => {
    const recent = readRecentProjects(window.localStorage);
    try {
      const last = window.localStorage.getItem(LAST_PROJECT_KEY);
      return last ? rememberRecentProject(recent, last) : recent;
    } catch { return recent; }
  });
  const [overview, setOverview] = useState<ProjectOverview | null>(null);
  const [opening, setOpening] = useState(false);
  const [scanProgress, setScanProgress] = useState<ProjectScanProgress | null>(null);
  const openingRequestPath = useRef<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [fileView, setFileView] = useState<'search' | 'folders'>('search');
  const [quickOpen, setQuickOpen] = useState(false);
  const [contentSearchOpen, setContentSearchOpen] = useState(false);
  const [contentSearchSeed, setContentSearchSeed] = useState('');
  const [editorSettings, setEditorSettings] = useState(() => readEditorSettings(window.localStorage));
  const [localizationSettings, setLocalizationSettings] = useState(() => readLocalizationSettings(window.localStorage));
  useEffect(() => {
    try { window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(editorSettings)); } catch { /* storage may be blocked */ }
  }, [editorSettings]);
  useEffect(() => {
    try { window.localStorage.setItem(LOCALIZATION_SETTINGS_KEY, JSON.stringify(localizationSettings)); } catch { /* storage may be blocked */ }
  }, [localizationSettings]);
  const [refreshing, setRefreshing] = useState(false);
  const [autoRefreshTick, setAutoRefreshTick] = useState(0);
  const autoRefreshHandled = useRef(0);
  const pendingAutoPaths = useRef(new Set<string>());
  const pendingAutoFull = useRef(false);
  const [driftReport, setDriftReport] = useState<ResourceDriftReport | null>(null);
  const [driftChecking, setDriftChecking] = useState(false);
  const [driftError, setDriftError] = useState<StudioError | null>(null);
  const [driftRetry, setDriftRetry] = useState(0);
  const [creatingPrototype, setCreatingPrototype] = useState(false);
  const [creatingFluent, setCreatingFluent] = useState(false);
  const [quickFixFluentDraft, setQuickFixFluentDraft] = useState<NewFluentDraft | null>(null);
  const [creatingRsi, setCreatingRsi] = useState(false);
  const [showingCSharp, setShowingCSharp] = useState(false);
  const [showingUiSources, setShowingUiSources] = useState(false);
  const [fieldTarget, setFieldTarget] = useState<PrototypeFieldLocator | null>(null);
  const [prototypePanel, setPrototypePanel] = useState<'fields' | 'components' | 'localization' | 'parents'>('fields');
  const [showYamlOutline, setShowYamlOutline] = useState(false);
  const [rsiRequested, setRsiRequested] = useState<{ path: string; state: string | null } | null>(null);
  const [picking, setPicking] = useState(false);
  const [explorerMode, setExplorerMode] = useState<'files' | 'prototypes'>('files');
  const [workspaceRevision, setWorkspaceRevision] = useState(0);
  const [jumpTarget, setJumpTarget] = useState<{ path: string; line: number; token: number } | null>(null);
  const jumpCounter = useRef(0);
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<ResourceKind>('all');
  const [page, setPage] = useState(0);
  const [results, setResults] = useState<ResourcePage>({ total: 0, items: [] });
  const [searching, setSearching] = useState(false);
  const [tabState, setTabState] = useState<TabState>({ tabs: [], active: null });
  const selected = tabState.tabs.find((tab) => tab.path === tabState.active) ?? null;
  const documents = useRef(new Map<string, ResourceDocument>());
  const [document, setDocument] = useState<ResourceDocument | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [draftBases, setDraftBases] = useState<Record<string, string>>({});
  const [recoveries, setRecoveries] = useState<DraftList>({ items: [], warnings: [] });
  const journal = useRef(new DraftWriteQueue());
  const journalTimers = useRef(new Map<string, number>());
  const journalSignatures = useRef(new Map<string, string>());
  const journalEpoch = useRef(0);
  const [transitioning, setTransitioning] = useState(false);
  const [comparison, setComparison] = useState<DiskComparison | null>(null);
  const [comparing, setComparing] = useState(false);
  const comparisonVersion = useRef(0);
  const [saving, setSaving] = useState(false);
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [exitDialogOpen, setExitDialogOpen] = useState(false);
  const [exitSaving, setExitSaving] = useState(false);
  const [exitFailure, setExitFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;
  const draftBasesRef = useRef(draftBases);
  draftBasesRef.current = draftBases;
  const selectedPathRef = useRef(selected?.path ?? null);
  selectedPathRef.current = selected?.path ?? null;
  const projectRootRef = useRef(overview?.project_root ?? null);
  projectRootRef.current = overview?.project_root ?? null;
  const dirtyPaths = dirtyDocumentPaths(drafts, documents.current);
  const dirtyPathsRef = useRef(dirtyPaths);
  dirtyPathsRef.current = dirtyPaths;
  const isDirty = (file: string) => dirtyPaths.includes(file);
  const activeConflict = selected && document?.path === selected.path
    && draftBases[selected.path] !== undefined
    && draftBases[selected.path] !== document.revision;
  const reviewDirty = Boolean(comparison && selected
    && comparison.path === selected.path
    && comparison.reviewedDraft !== (drafts[selected.path] ?? documents.current.get(selected.path)?.content ?? ''));
  const activeText = selected
    ? (drafts[selected.path] ?? document?.content ?? '')
    : '';
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<StudioError | null>(null);
  const readVersion = useRef(0);

  // The backend emits observed phases, not fabricated percentage progress.
  // Ignore stale events for a different project when an open is superseded.
  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | undefined;
    void listen<ProjectScanProgress>('studio:scan-progress', (event) => {
      if (!active || openingRequestPath.current !== event.payload.requested_path) return;
      setScanProgress(event.payload);
    }).then((dispose) => {
      if (active) unlisten = dispose;
      else dispose();
    }).catch(() => {
      // The normal opening state remains usable if events are unavailable.
    });
    return () => {
      active = false;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (dirtyPaths.length === 0) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirtyPaths.length]);

  // The OS close control must not silently discard a webview's dirty buffers.
  useEffect(() => {
    let active = true;
    let stop: (() => void) | undefined;
    void getCurrentWindow().onCloseRequested((event) => {
      if (dirtyPathsRef.current.length > 0) {
        event.preventDefault();
        if (active) {
          setExitFailure(null);
          setExitDialogOpen(true);
        }
      }
    }).then((unlisten) => {
      if (active) stop = unlisten;
      else unlisten();
    }).catch((failure) => {
      if (active) setError(normalizeStudioError(failure));
    });
    return () => { active = false; stop?.(); };
  }, []);

  async function closeAfterRecovery() {
    if (exitSaving || !overview) return;
    setExitSaving(true);
    setExitFailure(null);
    try {
      await persistExitRecovery({
        root: overview.project_root,
        paths: dirtyPathsRef.current,
        documents: documents.current,
        drafts: draftsRef.current,
        bases: draftBasesRef.current,
        queue: journal.current,
        persist: (file, base, content) => studio.persistDraft(file, base, content),
      });
      cancelJournalTimers();
      await getCurrentWindow().destroy();
    } catch (failure) {
      setExitFailure(failure instanceof Error ? failure.message : String(failure));
      setExitSaving(false);
    }
  }

  function cancelJournalTimers() {
    journalEpoch.current += 1;
    for (const timer of journalTimers.current.values()) window.clearTimeout(timer);
    journalTimers.current.clear();
  }

  useEffect(() => {
    return () => {
      journalEpoch.current += 1;
      for (const timer of journalTimers.current.values()) window.clearTimeout(timer);
    };
  }, []);

  // Per-file debounce. Switching tabs must not cancel a different file's draft.
  useEffect(() => {
    if (!overview || opening || saving || transitioning || refreshing) return;
    const active = new Set<string>();
    const epoch = journalEpoch.current;
    for (const file of dirtyPaths) {
      const loaded = documents.current.get(file);
      const content = drafts[file];
      if (!loaded || content === undefined) continue;
      const base = draftBases[file] ?? loaded.revision;
      const key = journalKey(overview.project_root, file);
      active.add(key);
      const signature = JSON.stringify([base, content]);
      if (journalSignatures.current.get(key) === signature) continue;
      const previous = journalTimers.current.get(key);
      if (previous !== undefined) window.clearTimeout(previous);
      journalTimers.current.set(key, window.setTimeout(() => {
        journalTimers.current.delete(key);
        if (epoch !== journalEpoch.current) return;
        journalSignatures.current.set(key, signature);
        void journal.current.run(key, () => studio.persistDraft(file, base, content))
          .then((saved) => {
            if (saved.durability_warning) setNotice(saved.durability_warning);
          })
          .catch((failure) => {
            journalSignatures.current.delete(key);
            setError(normalizeStudioError(failure));
          });
      }, 750));
    }
    for (const [key, timer] of journalTimers.current) {
      if (!active.has(key)) {
        window.clearTimeout(timer);
        journalTimers.current.delete(key);
      }
    }
  }, [overview, drafts, draftBases, document, saving, transitioning, opening, refreshing]);

  // OS filesystem events are hints, never direct commands to accept an
  // external revision. Coalesce bursts and reuse draft-aware refresh.
  useEffect(() => {
    if (!overview) return;
    let active = true;
    let unlisten: (() => void) | undefined;
    let debounce: number | undefined;
    void listen<{ project_root: string; paths: string[]; full: boolean }>('studio:project-changed', (event) => {
      if (!active || event.payload.project_root !== overview.project_root) return;
      if (event.payload.full || !Array.isArray(event.payload.paths)) {
        pendingAutoFull.current = true;
      } else {
        for (const changed of event.payload.paths) {
          pendingAutoPaths.current.add(changed);
          if (pendingAutoPaths.current.size > 256) pendingAutoFull.current = true;
        }
      }
      if (debounce !== undefined) window.clearTimeout(debounce);
      debounce = window.setTimeout(() => {
        if (active) setAutoRefreshTick((value) => value + 1);
      }, 1100);
    }).then((dispose) => {
      if (active) unlisten = dispose;
      else dispose();
    }).catch((failure: unknown) => {
      if (active) setDriftError(normalizeStudioError(failure));
    });
    return () => {
      active = false;
      if (debounce !== undefined) window.clearTimeout(debounce);
      unlisten?.();
    };
  }, [overview?.project_root]);

  // The local session stores only tab identities, never unsaved YAML/FTL data.
  useEffect(() => {
    if (!overview || opening) return;
    try {
      writeTabSession(window.localStorage, overview.project_root, tabState);
    } catch { /* Unavailable storage must not block the editor. */ }
  }, [overview?.project_root, opening, tabState]);

  async function loadProject(requestedPath: string) {
    setCreatingPrototype(false);
    setCreatingFluent(false);
    setCreatingRsi(false);
    setShowingCSharp(false);
    setShowingUiSources(false);
    setQuickOpen(false);
    setContentSearchOpen(false);
    setFieldTarget(null);
    setRsiRequested(null);
    comparisonVersion.current += 1;
    setComparison(null);
    cancelJournalTimers();
    openingRequestPath.current = requestedPath;
    setScanProgress(null);
    setOpening(true);
    setNotice(null);
    setError(null);
    try {
      const next = await studio.openProject(requestedPath);
      setRecentProjects((current) => {
        const updated = rememberRecentProject(current, next.project_root);
        try { writeRecentProjects(window.localStorage, updated); } catch { /* optional */ }
        return updated;
      });
      try {
        window.localStorage.setItem(LAST_PROJECT_KEY, next.project_root);
      } catch {
        // Saving a recent path is optional and must not block opening.
      }
      // Old sessions are revalidated against the current immutable Rust index.
      // Unavailable files remain recoverable through the separate draft journal.
      const storedTabs = readTabSession(window.localStorage, next.project_root);
      const verifiedPaths = await Promise.all(storedTabs.tabs.map(async (tab) => {
        try {
          await studio.readResource(tab.path);
          return tab.path;
        } catch { return null; }
      }));
      const restored = retainAvailableTabs(storedTabs,
        new Set(verifiedPaths.filter((item): item is string => item !== null)));
      let available: DraftList = { items: [], warnings: [] };
      try {
        available = await studio.listDrafts();
      } catch (failure) {
        const explained = normalizeStudioError(failure);
        available.warnings.push(explained.message + ' ' + explained.hint);
      }
      readVersion.current += 1;
      setWorkspaceRevision((value) => value + 1);
      setRecoveries(available);
      setJumpTarget(null);
      documents.current.clear();
      setDrafts({});
      setDraftBases({});
      setComparison(null);
      setPendingAction(null);
      setOverview(next);
      setResults({ total: 0, items: [] });
      setTabState(restored);
      setDriftReport(null);
      autoRefreshHandled.current = 0;
      pendingAutoPaths.current.clear();
      pendingAutoFull.current = false;
      setAutoRefreshTick(0);
      setDriftError(null);
      setDocument(null);
      setReading(false);
      setQuery('');
      setKind('all');
      setPage(0);
      // Trigger the restored file read only after resetting the previous
      // document. Otherwise a late setDocument(null) can hide that read.
      if (restored.active) void focusResource(restored.active);
    } catch (failure) {
      setError(normalizeStudioError(failure));
    } finally {
      openingRequestPath.current = null;
      setScanProgress(null);
      setOpening(false);
    }
  }

  /** Manual full scan or bounded automatic refresh without discarding in-memory drafts
   * or silently taking a changed on-disk YAML revision as the draft baseline.
   */
  async function refreshProject(automatic = false) {
    if (!overview || opening || reading || saving || transitioning || refreshing || creatingPrototype || creatingFluent) return;
    setRefreshing(true);
    cancelJournalTimers();
    setError(null);
    setNotice(null);
    try {
      // Persist pending unsaved edits before rebuilding the indexed path set.
      // The new index may no longer contain a file deleted by another editor.
      for (const file of dirtyPaths) {
        const loaded = documents.current.get(file);
        const content = draftsRef.current[file];
        if (!loaded || content === undefined) continue;
        const base = draftBases[file] ?? loaded.revision;
        const key = journalKey(overview.project_root, file);
        const saved = await journal.current.run(key, () => studio.persistDraft(file, base, content));
        if (saved.durability_warning) {
          throw {
            code: 'REFRESH_DRAFT_DURABILITY',
            message: 'Обновление остановлено: черновик записан с предупреждением о надёжности хранения.',
            hint: 'Проверьте доступность диска и повторите обновление индекса.',
            details: file + ': ' + saved.durability_warning,
          };
        }
        journalSignatures.current.set(key, JSON.stringify([base, content]));
      }
      // Snapshot only after draft persistence. Events arriving during IPC are
      // collected separately and trigger the next refresh, never silently lost.
      const changedPaths = automatic && !pendingAutoFull.current
        ? [...pendingAutoPaths.current] : undefined;
      pendingAutoPaths.current.clear();
      pendingAutoFull.current = false;
      const changed = await studio.refreshProject(changedPaths);
      // Any old read that finishes now belongs to the replaced index.
      readVersion.current += 1;
      const reads = await Promise.all(tabState.tabs.map(async (tab) => {
        try {
          return { path: tab.path, document: await studio.readResource(tab.path), error: null };
        } catch (failure) {
          return { path: tab.path, document: null, error: normalizeStudioError(failure) };
        }
      }));
      const result = reconcileWorkspaceRefresh(
        tabState.tabs, documents.current, draftsRef.current, draftBases, reads,
      );
      documents.current = result.documents;
      draftsRef.current = result.drafts;
      setDrafts(result.drafts);
      setDraftBases(result.draftBases);
      setDocument(tabState.active ? result.documents.get(tabState.active) ?? null : null);
      setReading(false);
      setOverview(changed.overview);
      setDriftReport(null);
      setPage(0);
      setWorkspaceRevision((value) => value + 1);
      setFieldTarget(null);
      closeComparison();

      try {
        setRecoveries(await studio.listDrafts());
      } catch (failure) {
        const explained = normalizeStudioError(failure);
        setRecoveries((previous) => ({
          ...previous,
          warnings: [...previous.warnings, explained.message + ' ' + explained.hint],
        }));
      }
      if (!automatic || changed.added_resources || changed.removed_resources || result.reloaded.length) {
        setNotice(
          (automatic ? 'Внешние изменения обнаружены. ' : '')
          + 'Индекс обновлён: +' + changed.added_resources + ' / −' + changed.removed_resources
          + ' ресурсов. Перечитано вкладок: ' + result.reloaded.length
          + '. Черновики сохранены в памяти.',
        );
      }
      if (result.conflicting.length || result.unavailable.length) {
        const unavailable = reads.filter((item) => item.error !== null);
        setError({
          code: 'REFRESH_TABS_REQUIRE_ATTENTION',
          message: 'Некоторые открытые файлы требуют внимания после обновления.',
          hint: 'Изменённые черновики не перезаписаны. Для изменённого YAML откройте сравнение версий. '
            + 'Для удалённого файла сохраните копию текста вручную.',
          details: [
            ...result.conflicting.map((file) => 'Изменён на диске (черновик сохранён): ' + file),
            ...unavailable.map((item) => 'Недоступен: ' + item.path + ' [' + item.error?.code + ']'),
          ].join('\n'),
        });
      }
    } catch (failure) {
      setError(normalizeStudioError(failure));
    } finally {
      setRefreshing(false);
    }
  }

  // If the app is busy, retain the pending signal and refresh once idle.
  // The handled counter prevents an endless refresh loop on setRefreshing(false).
  useEffect(() => {
    if (!overview || autoRefreshTick <= autoRefreshHandled.current || opening || reading
      || saving || transitioning || refreshing || creatingPrototype || creatingFluent || creatingRsi) return;
    autoRefreshHandled.current = autoRefreshTick;
    void refreshProject(true);
  }, [autoRefreshTick, overview?.project_root, opening, reading, saving, transitioning,
      refreshing, creatingPrototype, creatingFluent, creatingRsi]);

  // Poll open resources only; Rust never accepts revisions or modifies drafts.
  // The submitted baseline is checked again after IPC to suppress stale alerts.
  useEffect(() => {
    if (!overview || opening || reading || saving || refreshing || transitioning) return;
    let active = true;
    let running = false;
    async function check() {
      if (!active || running) return;
      const opened: OpenRevision[] = tabState.tabs.flatMap((tab) => {
        const loaded = documents.current.get(tab.path);
        return loaded ? [{ path: tab.path, expected_revision: loaded.revision }] : [];
      });
      if (!opened.length) {
        setDriftReport(null);
        return;
      }
      running = true;
      setDriftChecking(true);
      try {
        const result = await studio.probeOpenRevisions(opened);
        if (!active) return;
        setDriftReport(retainCurrentDrifts(result, opened, documents.current));
        setDriftError(null);
      } catch (failure) {
        if (active) setDriftError(normalizeStudioError(failure));
      } finally {
        running = false;
        if (active) setDriftChecking(false);
      }
    }
    const initial = window.setTimeout(() => void check(), 1200);
    const interval = window.setInterval(() => void check(), 12000);
    return () => {
      active = false;
      window.clearTimeout(initial);
      window.clearInterval(interval);
      setDriftChecking(false);
    };
  }, [overview?.project_root, tabState.tabs, opening, reading, saving, refreshing, transitioning, driftRetry]);

  useEffect(() => {
    if (!overview) return;
    let active = true;
    const handle = window.setTimeout(async () => {
      setSearching(true);
      try {
        const found = await studio.searchResources(query, kind, page * PAGE_SIZE, PAGE_SIZE);
        if (active) setResults(found);
      } catch (failure) {
        if (active) setError(normalizeStudioError(failure));
      } finally {
        if (active) setSearching(false);
      }
    }, 150);
    return () => {
      active = false;
      window.clearTimeout(handle);
    };
  }, [overview, query, kind, page, workspaceRevision]);

  async function chooseProjectFolder() {
    setPicking(true);
    setError(null);
    try {
      const selected = await openDirectoryDialog({
        directory: true,
        multiple: false,
        title: 'Выберите корень исходников Space Station 14',
      });
      if (typeof selected === 'string') {
        setPath(selected);
        requestAction({ type: 'open', path: selected });
      }
    } catch (failure) {
      const normalized = normalizeStudioError(failure);
      setError({
        code: 'FOLDER_PICKER_FAILED',
        message: 'Не удалось выбрать папку через системный диалог.',
        hint: 'Введите путь вручную или проверьте доступность графического окружения.',
        details: normalized.details ?? normalized.message,
      });
    } finally {
      setPicking(false);
    }
  }

  /** A late IPC response must never replace the content of a newer tab. */
  async function focusResource(path: string) {
    const version = ++readVersion.current;
    setError(null);
    const cached = documents.current.get(path);
    setDocument(cached ?? null);
    if (cached) {
      setReading(false);
      return;
    }
    setReading(true);
    try {
      const loaded = await studio.readResource(path);
      if (version === readVersion.current) {
        documents.current.set(path, loaded);
        setDrafts((previous) => previous[path] === undefined ? { ...previous, [path]: loaded.content } : previous);
        setDocument(loaded);
      }
    } catch (failure) {
      if (version === readVersion.current) {
        setError(normalizeStudioError(failure));
      }
    } finally {
      if (version === readVersion.current) setReading(false);
    }
  }

  async function clearRecoveryCopy(file: string) {
    if (!overview) return;
    const key = journalKey(overview.project_root, file);
    const timer = journalTimers.current.get(key);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      journalTimers.current.delete(key);
    }
    await journal.current.run(key, () => studio.deleteDraft(file));
    journalSignatures.current.delete(key);
    setRecoveries((previous) => ({
      ...previous,
      items: previous.items.filter((item) => item.path !== file),
    }));
  }

  async function discardRecoveryCopy(file: string) {
    await clearRecoveryCopy(file);
    setNotice('Сохранённая копия черновика удалена. Исходный YAML не изменён.');
  }

  function restoreRecovery(snapshot: DraftSnapshot): boolean {
    if (!overview || isDirty(snapshot.path)) return false;
    closeComparison();
    const item: ResourceEntry = {
      path: snapshot.path,
      kind: snapshot.path.toLowerCase().endsWith('.ftl') ? 'ftl' : 'yaml',
    };
    const result = openTab(tabState, item);
    if (!result.ok) {
      setError({
        code: 'TAB_LIMIT_REACHED',
        message: 'Нельзя восстановить черновик: достигнут лимит вкладок.',
        hint: 'Закройте ненужную вкладку и повторите восстановление.',
      });
      return false;
    }
    setDraftBases((previous) => ({
      ...previous, [snapshot.path]: snapshot.base_revision,
    }));
    setDrafts((previous) => ({
      ...previous, [snapshot.path]: snapshot.content,
    }));
    setTabState(result.state);
    void focusResource(snapshot.path);
    setNotice('Черновик восстановлен в редактор. Исходный YAML пока не изменён.');
    return true;
  }

  async function confirmPendingAction() {
    const action = pendingAction;
    if (!action || !overview) return;
    setTransitioning(true);
    cancelJournalTimers();
    setError(null);
    try {
      const paths = action.type === 'open' ? dirtyPaths : [action.path];
      for (const file of paths) {
        await clearRecoveryCopy(file);
      }
      executeAction(action);
    } catch (failure) {
      setError(normalizeStudioError(failure));
    } finally {
      setTransitioning(false);
    }
  }

  function requestAction(action: PendingAction) {
    if (saving || transitioning || opening || refreshing) return;
    const needsConfirmation = action.type === 'open'
      ? dirtyPaths.length > 0
      : isDirty(action.path);
    if (needsConfirmation) {
      setPendingAction(action);
    } else {
      executeAction(action);
    }
  }

  function executeAction(action: PendingAction) {
    setFieldTarget(null);
    closeComparison();
    setPendingAction(null);
    if (action.type === 'open') {
      void loadProject(action.path);
      return;
    }
    if (action.type === 'reload') {
      documents.current.delete(action.path);
      setDrafts((previous) => {
        const next = { ...previous };
        delete next[action.path];
        return next;
      });
      setDraftBases((previous) => {
        const next = { ...previous };
        delete next[action.path];
        return next;
      });
      void focusResource(action.path);
      return;
    }
    const next = closeTab(tabState, action.path);
    setTabState(next);
    documents.current.delete(action.path);
    setDraftBases((previous) => {
      const updated = { ...previous };
      delete updated[action.path];
      return updated;
    });
    setDrafts((previous) => {
      const updated = { ...previous };
      delete updated[action.path];
      return updated;
    });
    if (next.active !== tabState.active) {
      if (next.active) {
        void focusResource(next.active);
      } else {
        readVersion.current += 1;
        setDocument(null);
        setReading(false);
        setError(null);
      }
    }
  }

  // Inspect fresh disk contents. This does not update the editor baseline or write.
  async function compareCurrent() {
    const file = selectedPathRef.current;
    if (!file || !overview || opening || transitioning || refreshing) return;
    const loaded = documents.current.get(file);
    if (!loaded) return;
    const request = ++comparisonVersion.current;
    const snapshot = draftsRef.current[file] ?? loaded.content;
    setComparing(true);
    try {
      const disk = await studio.readResource(file);
      if (request !== comparisonVersion.current || selectedPathRef.current !== file) return;
      setComparison({ path: file, disk, reviewedDraft: snapshot });
      setError(null);
    } catch (failure) {
      if (request === comparisonVersion.current) setError(normalizeStudioError(failure));
    } finally {
      if (request === comparisonVersion.current) setComparing(false);
    }
  }

  async function acceptComparison() {
    const review = comparison;
    if (!review || comparing || saving || opening || transitioning || refreshing) return;
    const request = ++comparisonVersion.current;
    setComparing(true);
    try {
      // Re-read the file immediately before accepting the revision. It is still
      // rechecked by Rust with SHA-256 when the user eventually presses Save.
      const disk = await studio.readResource(review.path);
      if (request !== comparisonVersion.current || selectedPathRef.current !== review.path) return;
      const draft = draftsRef.current[review.path] ?? documents.current.get(review.path)?.content ?? '';
      const verdict = reviewDecision({
        path: review.path,
        reviewedDraft: review.reviewedDraft,
        reviewedDiskRevision: review.disk.revision,
      }, review.path, draft, disk.revision);
      if (verdict !== 'accept') {
        setComparison({ path: review.path, disk, reviewedDraft: draft });
        setError({
          code: 'DIFF_REVIEW_STALE',
          message: 'Сравнение устарело. Принятие новой версии отменено.',
          hint: verdict === 'draft-changed'
            ? 'Черновик был изменён после просмотра. Повторно изучите отличия.'
            : 'Файл на диске снова изменился. Изучите новое сравнение перед повторным подтверждением.',
        });
        return;
      }
      documents.current.set(review.path, disk);
      setDocument((current) => current?.path === review.path ? disk : current);
      setDraftBases((previous) => ({ ...previous, [review.path]: disk.revision }));
      setComparison(null);
      setError(null);
      setNotice('Текущая версия файла принята как новая основа черновика. Исходный YAML ещё не изменён; проверьте правки и сохраните вручную.');
    } catch (failure) {
      if (request === comparisonVersion.current) setError(normalizeStudioError(failure));
    } finally {
      if (request === comparisonVersion.current) setComparing(false);
    }
  }

  function closeComparison() {
    comparisonVersion.current += 1;
    setComparing(false);
    setComparison(null);
  }

  async function saveCurrent() {
    if (!selected || !isEditableText(selected.kind) || saving || refreshing) return;
    const file = selected.path;
    const baseline = documents.current.get(file);
    if (!baseline) return;
    const submitted = drafts[file] ?? baseline.content;
    if (submitted === baseline.content) return;
    const sourceRevision = draftBases[file] ?? baseline.revision;
    if (sourceRevision !== baseline.revision) {
      setError({
        code: 'RECOVERED_DRAFT_CONFLICT',
        message: 'Восстановленный черновик основан на другой версии файла.',
        hint: 'Изучите различия во встроенном diff. Принятие новой ревизии не сохраняет файл автоматически.',
      });
      void compareCurrent();
      return;
    }
    const key = journalKey(overview!.project_root, file);
    const timer = journalTimers.current.get(key);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      journalTimers.current.delete(key);
    }

    setSaving(true);
    setNotice(null);
    setError(null);
    try {
      const result = selected.kind === 'yaml'
        ? await studio.saveYamlResource(file, sourceRevision, submitted)
        : await studio.saveFtlResource(file, sourceRevision, submitted);
      documents.current.set(file, result.document);
      setDriftReport((current) => current ? {
        ...current, items: current.items.filter((item) => item.path !== file),
      } : current);
      setDrafts((previous) => ({
        ...previous,
        [file]: reconcileSavedDraft(previous[file], submitted, result.document.content),
      }));
      setDocument((current) => current?.path === file ? result.document : current);
      setDraftBases((previous) => {
        const next = { ...previous };
        delete next[file];
        return next;
      });
      let cleanupWarning: string | null = null;
      try {
        await clearRecoveryCopy(file);
      } catch (failure) {
        cleanupWarning = 'Старая резервная копия не удалена: ' + normalizeStudioError(failure).message;
      }
      closeComparison();
      setWorkspaceRevision((previous) => previous + 1);
      setNotice([
        selected.kind === 'yaml'
          ? 'YAML сохранён. Индекс прототипов будет перестроен при следующем обращении.'
          : 'FTL сохранён без изменения форматирования. Диагностика доступна в панели Fluent.',
        result.durability_warning,
        cleanupWarning,
      ].filter(Boolean).join(' '));
    } catch (failure) {
      const explained = normalizeStudioError(failure);
      setError(explained);
      if (explained.code === 'RESOURCE_CHANGED_ON_DISK') void compareCurrent();
    } finally {
      setSaving(false);
    }
  }

  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void saveCurrent();
      }
    };
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  }, [selected?.path, document?.revision, drafts, saving, refreshing]);

  function openResource(item: ResourceEntry, preferredRsiState?: string | null) {
    if (saving || transitioning || opening || refreshing) return;
    if (item.kind === 'rsi') {
      setRsiRequested(preferredRsiState === undefined ? null : { path: item.path, state: preferredRsiState });
    }
    if (item.path !== fieldTarget?.file) setFieldTarget(null);
    if (selectedPathRef.current !== item.path) closeComparison();
    const outcome = openTab(tabState, item);
    if (!outcome.ok) {
      setError({
        code: 'TAB_LIMIT_REACHED',
        message: 'Достигнут лимит открытых вкладок.',
        hint: 'Закройте ненужную вкладку перед открытием следующего файла.',
      });
      return;
    }
    setTabState(outcome.state);
    if (tabState.active !== item.path || (!document && !reading)) {
      void focusResource(item.path);
    }
  }

  async function navigatePrototypeIdentifier(identifier: string, sourcePath: string) {
    if (!overview || opening || saving || refreshing || transitioning) return;
    const root = overview.project_root;
    try {
      const result = await studio.searchPrototypes(identifier, '', 0, 100);
      if (selectedPathRef.current !== sourcePath || projectRootRef.current !== root) return;
      const exact = result.items.filter((item) => item.id === identifier);
      // Partial, generated variants and duplicate IDs require explicit choice.
      if (exact.length === 1 && result.total <= 100) {
        openPrototypeSource(exact[0].file, exact[0].line);
      } else {
        setContentSearchSeed(identifier);
        setQuickOpen(false);
        setContentSearchOpen(true);
        setNotice('Однозначное определение «' + identifier
          + '» не найдено. Выберите нужный исходник в поиске по содержимому.');
      }
    } catch (failure) {
      if (selectedPathRef.current === sourcePath && projectRootRef.current === root) {
        setError(normalizeStudioError(failure));
      }
    }
  }

  async function navigateIndexedRsi(path: string, sourcePath: string) {
    if (!overview || opening || saving || refreshing || transitioning) return;
    const root = overview.project_root;
    try {
      // A YAML literal is never an arbitrary FS read: Rust verifies index identity.
      await studio.readResource(path);
      if (selectedPathRef.current !== sourcePath || projectRootRef.current !== root) return;
      openResource({ path, kind: 'rsi' });
    } catch (failure) {
      if (selectedPathRef.current === sourcePath && projectRootRef.current === root) {
        setError(normalizeStudioError(failure));
      }
    }
  }

  function openPrototypeSource(file: string, line: number) {
    setJumpTarget({ path: file, line, token: ++jumpCounter.current });
    openResource({ path: file, kind: 'yaml' });
  }

  function editPrototypeFields(entry: PrototypeDeclaration, panel: 'fields' | 'components' | 'localization' | 'parents') {
    if (saving || opening || transitioning || refreshing) return;
    openPrototypeSource(entry.file, entry.line);
    setPrototypePanel(panel);
    setFieldTarget({
      file: entry.file, kind: entry.kind, id: entry.id,
      document_index: entry.document_index, item_index: entry.item_index,
      mode: entry.mode,
    });
  }

  function applyPrototypeFields(
    locator: PrototypeFieldLocator, original: string, changed: string,
  ): boolean {
    const file = fieldTarget?.file;
    if (!file || selectedPathRef.current !== file || saving || opening || transitioning || refreshing) return false;
    // A slow native IPC result must never apply to a different declaration
    // even when another selected prototype shares the same source file.
    if (locator.file !== fieldTarget.file || locator.id !== fieldTarget.id
        || locator.kind !== fieldTarget.kind
        || locator.document_index !== fieldTarget.document_index
        || locator.item_index !== fieldTarget.item_index
        || locator.mode !== fieldTarget.mode) return false;
    const live = draftsRef.current[file] ?? documents.current.get(file)?.content;
    if (live !== original) return false;
    const next = { ...draftsRef.current, [file]: changed };
    draftsRef.current = next;
    setDrafts(next);
    setNotice('Форма изменила черновик YAML. Проверьте текст и нажмите Ctrl+S для сохранения.');
    return true;
  }

  /** Explicit localization write: never clobber an open FTL draft or stale file. */
  async function applyEntityLocalization(
    file: string, baseline: ResourceDocument, content: string,
  ): Promise<boolean> {
    if (!overview || !file.startsWith('Resources/Locale/') || !file.endsWith('.ftl')
        || baseline.path !== file || saving || opening || refreshing || transitioning) {
      throw new Error('Невозможно записать FTL во время другой операции.');
    }
    const root = overview.project_root;
    const opened = documents.current.get(file);
    if (opened && (draftsRef.current[file] ?? opened.content) !== opened.content) {
      throw new Error('У выбранного FTL уже есть несохранённый черновик. Сохраните или закройте его перед генерацией локализации.');
    }
    if (draftBases[file] !== undefined && opened && draftBases[file] !== opened.revision) {
      throw new Error('У FTL есть восстановленный черновик с другой ревизией. Сначала разрешите конфликт.');
    }
    setSaving(true);
    try {
      if (projectRootRef.current !== root) throw new Error('Проект изменился. Повторите действие.');
      // Rust requires the exact revision observed during the preview.
      const result = await studio.saveFtlResource(file, baseline.revision, content);
      if (projectRootRef.current !== root) return false;
      documents.current.set(file, result.document);
      setDrafts((previous) => {
        const next = { ...previous };
        delete next[file];
        return next;
      });
      setDraftBases((previous) => {
        const next = { ...previous };
        delete next[file];
        return next;
      });
      setDocument((current) => current?.path === file ? result.document : current);
      setWorkspaceRevision((previous) => previous + 1);
      setNotice(['Fluent-ключи добавлены. Проверьте FTL в редакторе.',
        result.durability_warning].filter(Boolean).join(' '));
      setFieldTarget(null);
      setSaving(false);
      openResource({ path: file, kind: 'ftl' });
      return true;
    } finally {
      setSaving(false);
    }
  }

  function selectTab(path: string) {
    if (saving || transitioning || opening || refreshing || tabState.active === path) return;
    setFieldTarget(null);
    closeComparison();
    setTabState((state) => ({ ...state, active: path }));
    void focusResource(path);
  }

  function removeTab(path: string) {
    requestAction({ type: 'close', path });
  }

  useEffect(() => {
    function shortcut(event: KeyboardEvent) {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === 'p' && !event.shiftKey && overview && !settingsOpen) {
        event.preventDefault();
        if (!opening && !refreshing && !transitioning) {
          setContentSearchOpen(false);
          setQuickOpen(true);
        }
        return;
      }
      if (key === 'f' && event.shiftKey && overview && !settingsOpen) {
        event.preventDefault();
        if (!opening && !refreshing && !transitioning) {
          setQuickOpen(false);
          setContentSearchSeed('');
          setContentSearchOpen(true);
        }
        return;
      }
      if (!overview || settingsOpen || quickOpen || contentSearchOpen || opening || refreshing || transitioning || saving) return;
      if (key === 'tab') {
        const next = nextTabPath(tabState, event.shiftKey);
        if (next) { event.preventDefault(); selectTab(next); }
      } else if (key === 'w' && !event.shiftKey && selected) {
        event.preventDefault();
        removeTab(selected.path);
      }
    }
    window.addEventListener('keydown', shortcut, true);
    return () => window.removeEventListener('keydown', shortcut, true);
  }, [overview, settingsOpen, quickOpen, contentSearchOpen, opening, refreshing, transitioning, saving, tabState]);

  function reloadCurrent() {
    if (tabState.active) requestAction({ type: 'reload', path: tabState.active });
  }

  function onExternalPrototypeCreated(result: import('./lib/api').ExternalCreatedPrototype) {
    setCreatingPrototype(false);
    setNotice(result.warning
      ? 'Внешний YAML создан: ' + result.path + '. ' + result.warning
      : 'Внешний YAML создан: ' + result.path + '. Открытый проект не изменён.');
  }

  function onPrototypeCreated(result: CreatedPrototype, mode: PrototypeDestinationMode) {
    setCreatingPrototype(false);
    setFieldTarget(null);
    if (result.overview) {
      setOverview(result.overview);
      setWorkspaceRevision((old) => old + 1);
      setPage(0);
      setExplorerMode('prototypes');
      if (mode === 'append') {
        if (isDirty(result.file)) {
          setNotice('Прототип добавлен на диск, но во вкладке остался отдельный несохранённый черновик. Не закрывайте его: сравните с изменённым файлом.');
          return;
        }
        // A clean, already-open tab must not continue showing the old text.
        // Keep unrelated tabs and recovery drafts intact.
        documents.current.delete(result.file);
        setDrafts((previous) => {
          const updated = { ...previous };
          delete updated[result.file];
          return updated;
        });
        setDraftBases((previous) => {
          const updated = { ...previous };
          delete updated[result.file];
          return updated;
        });
        if (tabState.active === result.file) {
          closeComparison();
          void focusResource(result.file);
        } else {
          openResource({ path: result.file, kind: 'yaml' });
        }
      } else {
        openResource({ path: result.file, kind: 'yaml' });
      }
    }
    const verb = mode === 'append' ? 'добавлен в' : 'создан в';
    setNotice(result.warning
      ? 'Прототип ' + result.kind + ':' + result.id + ' ' + verb + ' ' + result.file + '. ' + result.warning
      : 'Прототип ' + result.kind + ':' + result.id + ' ' + verb + ' ' + result.file);
  }

  function onRsiImported(path: string, result: ImportedRsiState, action: 'import' | 'timing' | 'credits' = 'import') {
    const updated: ResourceDocument = {
      path,
      content: result.content,
      revision: result.revision,
      bytes: new TextEncoder().encode(result.content).length,
    };
    documents.current.set(path, updated);
    setDocument((current) => current?.path === path ? updated : current);
    setDrafts((previous) => ({ ...previous, [path]: result.content }));
    const baseNotice = result.archive_path
      ? 'Состояние RSI «' + result.name + '» заменено. Предыдущая версия сохранена: ' + result.archive_path
      : action === 'credits'
        ? 'Лицензия и авторство RSI сохранены. PNG не изменены.'
        : action === 'timing'
          ? 'Сохранены задержки RSI: ' + result.name + '. PNG не изменены.'
          : 'Добавлено состояние RSI: ' + result.name + '. PNG и meta.json записаны.';
    setNotice(result.warning ? baseNotice + '. ' + result.warning : baseNotice);
  }

  function onRsiRenamed(path: string, result: RenamedRsiState) {
    onRsiImported(path, result, 'import');
    setNotice(
      'Состояние RSI «' + result.old_name + '» переименовано в «' + result.name
      + '». Резервная копия: ' + result.archive_path
      + (result.warning ? '. Внимание: ' + result.warning : '')
      + '. Проверьте ссылки на старое имя в других ресурсах.',
    );
  }

  function onRsiDeleted(path: string, result: DeletedRsiState) {
    onRsiImported(path, result, 'timing');
    setNotice(
      'Состояние RSI «' + result.name + '» убрано из meta.json. Резервная копия: '
      + result.archive_path
      + (result.warning ? '. Внимание: ' + result.warning : ''),
    );
  }

  function onRsiRestored(path: string, result: RestoredRsiState) {
    onRsiImported(path, result, 'timing');
    setNotice(
      'Восстановлено состояние RSI «' + result.name + '». Архив сохранён: '
      + result.archive_path
      + (result.warning ? '. Внимание: ' + result.warning : ''),
    );
  }

  function onExternalRsiCreated(created: import('./lib/api').ExternalCreatedRsi) {
    setCreatingRsi(false);
    setNotice(created.warning
      ? 'Внешний RSI создан: ' + created.path + '. ' + created.warning
      : 'Внешний RSI создан: ' + created.path + '. Открытый проект не менялся.');
  }

  function onRsiCreated(created: CreatedRsi) {
    setCreatingRsi(false);
    setFieldTarget(null);
    if (created.overview) {
      setOverview(created.overview);
      setWorkspaceRevision((value) => value + 1);
      setPage(0);
      setKind('rsi');
      setExplorerMode('files');
      openResource({ path: created.path, kind: 'rsi' });
    }
    setNotice(created.warning
      ? 'RSI создан: ' + created.path + '. ' + created.warning
      : 'RSI создан: ' + created.path + '. Каталог готов для добавления кадров.');
  }

  function onExternalFluentCreated(created: import('./lib/api').ExternalCreatedFluent) {
    setCreatingFluent(false);
    setQuickFixFluentDraft(null);
    setNotice(created.warning
      ? 'Внешний FTL создан: ' + created.path + '. ' + created.warning
      : 'Внешний FTL создан: ' + created.path + '. Файл не добавлен в открытый проект.');
  }

  function onFluentCreated(created: CreatedFluent) {
    setCreatingFluent(false);
    setQuickFixFluentDraft(null);
    setFieldTarget(null);
    if (created.overview) {
      setOverview(created.overview);
      setWorkspaceRevision((value) => value + 1);
      setPage(0);
      setKind('ftl');
      setExplorerMode('files');
      openResource({ path: created.file, kind: 'ftl' });
    }
    setNotice(created.warning
      ? 'FTL создан: ' + created.file + '. ' + created.warning
      : 'FTL создан: ' + created.file + '. Редактор готов для дальнейшей работы.');
  }

  function openContentHit(hit: ContentSearchHit) {
    setContentSearchOpen(false);
    setJumpTarget({ path: hit.path, line: hit.line, token: ++jumpCounter.current });
    openResource({ path: hit.path, kind: hit.kind });
  }

  return <div className="app">
    {contentSearchOpen && overview && <ContentSearchPanel
      key={contentSearchSeed}
      initialQuery={contentSearchSeed}
      onClose={() => setContentSearchOpen(false)} onOpen={openContentHit}/>}
    {quickOpen && overview && <QuickOpenPanel onClose={() => setQuickOpen(false)}
      onOpen={(resource) => { setQuickOpen(false); openResource(resource); }}/>}
    {settingsOpen && <EditorSettingsDialog value={editorSettings}
      onChange={(settings) => setEditorSettings(sanitizeEditorSettings(settings))}
      localizationSettings={localizationSettings}
      onLocalizationChange={(settings) => setLocalizationSettings(sanitizeLocalizationSettings(settings))}
      onClose={() => setSettingsOpen(false)}/>}
    {showingUiSources && overview && <UiSourcesPanel
      projectKey={overview.project_root + ':' + workspaceRevision}
      onClose={() => setShowingUiSources(false)}/>}
    {showingCSharp && overview && <CSharpCatalogPanel
      projectKey={overview.project_root + ':' + workspaceRevision}
      onClose={() => setShowingCSharp(false)}/>}
    {creatingRsi && overview && <CreateRsiWizard
      projectRoot={overview.project_root}
      onClose={() => setCreatingRsi(false)}
      onCreated={onRsiCreated}
      onExternalCreated={onExternalRsiCreated}
      preferredPath={selected?.kind === 'rsi' ? selected.path : undefined}/>}
    {creatingFluent && overview && <CreateFluentWizard
      projectRoot={overview.project_root}
      requiredLocales={localizationSettings.requiredLocales}
      onClose={() => { setCreatingFluent(false); setQuickFixFluentDraft(null); }}
      onCreated={onFluentCreated}
      onExternalCreated={onExternalFluentCreated}
      preferredDraft={quickFixFluentDraft ?? undefined}
      preferredFile={selected?.kind === 'ftl' ? selected.path : undefined}/>}
    {creatingPrototype && overview && <CreatePrototypeWizard
      projectRoot={overview.project_root}
      onClose={() => setCreatingPrototype(false)} onCreated={onPrototypeCreated}
      onExternalCreated={onExternalPrototypeCreated}
      dirtyPaths={dirtyPaths}
      preferredExistingFile={selected?.kind === 'yaml' ? selected.path : undefined}/>}
    <header className="titlebar">
      <div className="brand"><span className="logo">S</span><div><strong>SS14 Studio</strong><small>RUST REWORK</small></div></div>
      <div className="titlebar-actions">
        <button type="button" className="settings-trigger" disabled={!overview || opening || refreshing}
          title={t('app.quickHint')} onClick={() => setQuickOpen(true)}>
          <Search size={15}/> {t('app.quickOpen')}
        </button>
        <button type="button" className="settings-trigger" disabled={!overview || opening || refreshing}
          title={t('app.searchHint')} onClick={() => { setContentSearchSeed(''); setContentSearchOpen(true); }}>
          <Search size={15}/> {t('app.searchContent')}
        </button>
        <button type="button" className="settings-trigger"
        onClick={() => setSettingsOpen(true)}><Settings2 size={15}/> {t('app.settings')}</button>
        <span className="version">0.1.5 alpha · Rust + Tauri</span></div>
    </header>

    <section className="project-bar">
      <form onSubmit={(event: FormEvent<HTMLFormElement>) => { event.preventDefault(); requestAction({ type: 'open', path }); }}>
        <label htmlFor="project-path"><FolderOpen size={16}/> {t('app.sourceFolder')}</label>
        <div className="path-control">
          <input id="project-path" value={path} spellCheck={false} autoComplete="off"
            placeholder="/home/user/SpaceStation14 или C:\SpaceStation14"
            onChange={(event) => setPath(event.target.value)}/>
          {recentProjects.length > 0 && <select className="recent-project-select"
            aria-label={t('app.recentProjects')} title={t('app.recentProjects')} value=""
            disabled={opening || picking || saving || refreshing || transitioning}
            onChange={(event) => {
              const selected = event.target.value;
              if (!selected) return;
              setPath(selected);
              requestAction({ type: 'open', path: selected });
            }}>
            <option value="">{t('app.recentProjects')}</option>
            {recentProjects.map((project) => <option key={project} value={project}>{project}</option>)}
          </select>}
          <button type="button" className="browse-button" disabled={opening || picking || saving || refreshing} onClick={() => void chooseProjectFolder()}>{t('app.browse')}</button>
          <button type="submit" disabled={opening || picking || saving || refreshing}><FolderOpen size={16}/>{opening ? t('app.opening') : t('app.openProject')}</button>
        </div>
      </form>
      {opening && <div className="project-scan-status" role="status" aria-live="polite">
        <RotateCcw size={15}/>
        <span>{scanProgress ? ({
          prototypes: t('app.scanPrototypes'),
          textures: t('app.scanTextures'),
          locale: t('app.scanLocale'),
          finalizing: t('app.scanFinalizing'),
        }[scanProgress.phase] ?? t('app.scanPreparing')) : t('app.scanPreparing')}</span>
        {scanProgress && <small>{t('app.scanIndexed', { count: scanProgress.indexed_resources })}</small>}
      </div>}
      {overview && <div className="project-counts">
        <span><b>{overview.prototype_files}</b> {t('app.yamlFiles')}</span>
        <span><b>{overview.rsi_directories}</b> RSI</span>
        <span><b>{overview.locale_files}</b> FTL</span>
        <button type="button" className="create-proto-open" disabled={opening || saving || transitioning || refreshing || creatingFluent || creatingRsi || creatingPrototype}
          onClick={() => setCreatingPrototype(true)}>
          <FilePlus2 size={15}/> {t('app.createPrototype')}
        </button>
        <button type="button" className="create-proto-open"
          disabled={opening || saving || transitioning || refreshing || creatingPrototype || creatingFluent || creatingRsi}
          onClick={() => setCreatingRsi(true)}>
          <FilePlus2 size={15}/> {t('app.createRsi')}
        </button>
        <button type="button" className="create-proto-open"
          disabled={opening || saving || transitioning || refreshing || creatingPrototype || creatingFluent || creatingRsi}
          onClick={() => setCreatingFluent(true)}>
          <FilePlus2 size={15}/> {t('app.createFtl')}
        </button>
        <button type="button" className="create-proto-open"
          disabled={opening || saving || transitioning || refreshing || creatingPrototype || creatingFluent || creatingRsi}
          onClick={() => setShowingCSharp(true)}>
          <FileCode2 size={15}/> {t('app.csharpSchemas')}
        </button>
        <button type="button" className="create-proto-open"
          disabled={opening || saving || transitioning || refreshing}
          onClick={() => setShowingUiSources(true)}>
          <FileCode2 size={15}/> {t('app.uiSources')}
        </button>
        <button type="button" className="create-proto-open"
          disabled={opening || saving || refreshing || transitioning || driftChecking || !tabState.tabs.length}
          title={t('app.checkHint')}
          onClick={() => setDriftRetry((value) => value + 1)}>
          <RotateCcw size={15}/>{driftChecking ? t('app.checking') : t('app.checkFiles')}
        </button>
        <button type="button" className="create-proto-open" disabled={opening || picking || saving || transitioning || reading || refreshing || creatingPrototype || creatingFluent || creatingRsi}
          title={t('app.rescanHint')}
          onClick={() => void refreshProject()}>
          <RotateCcw size={15}/>{refreshing ? t('app.refreshing') : t('app.refreshIndex')}
        </button>
      </div>}
    </section>

    {error && <ErrorPanel error={error} close={() => setError(null)}/>}
    {notice && <div className="save-notice" role="status">
      <CheckCircle2 size={16}/><span>{notice}</span>
      <button type="button" onClick={() => setNotice(null)}>Закрыть</button>
    </div>}
    {exitDialogOpen && <div className="discard-confirmation" role="alertdialog"
      aria-label="Закрытие приложения с несохранёнными черновиками">
      <AlertTriangle size={18}/>
      <div>
        <strong>Остались несохранённые изменения ({dirtyPaths.length})</strong>
        <p>Перед выходом черновики будут сохранены в хранилище восстановления SS14 Studio.
          Игровые YAML/FTL на диске не изменятся.</p>
        {exitFailure && <p role="alert">Не удалось сохранить черновики: {exitFailure}. Приложение не закрыто.</p>}
      </div>
      <button type="button" disabled={exitSaving} onClick={() => { setExitDialogOpen(false); setExitFailure(null); }}>
        Остаться
      </button>
      <button type="button" disabled={exitSaving} onClick={() => void closeAfterRecovery()}>
        {exitSaving ? 'Сохраняю…' : 'Сохранить черновики и выйти'}
      </button>
    </div>}
    {pendingAction && <div className="discard-confirmation" role="alertdialog"
      aria-label="Подтверждение удаления черновика">
      <AlertTriangle size={18}/>
      <div>
        <strong>{t('app.unsavedTitle')}</strong>
        <p>{pendingAction.type === 'open'
          ? t('app.unsavedOpen')
          : t('app.unsavedFile')}</p>
      </div>
      <button type="button" disabled={transitioning} onClick={() => setPendingAction(null)}>{t('common.cancel')}</button>
      <button type="button" className="danger-button" disabled={transitioning}
        onClick={() => void confirmPendingAction()}>
        {t('app.discard')}
      </button>
    </div>}
    {activeConflict && selected && <div className="recovery-conflict-notice" role="alert">
      <AlertTriangle size={16}/>
      <span>{t('app.draftConflict')}</span>
      <button type="button" disabled={comparing} onClick={() => void compareCurrent()}>{t('app.compareVersions')}</button>
    </div>}
    {overview && <RecoveryPanel entries={recoveries.items}
      warnings={recoveries.warnings} dirtyPaths={dirtyPaths}
      onRestore={restoreRecovery} onDiscard={discardRecoveryCopy}/>}
    {overview && <ResourceDriftBanner
      report={driftReport ?? { checked: 0, skipped: 0, items: [] }}
      activePath={selected?.path ?? null} activeDirty={selected ? isDirty(selected.path) : false}
      busy={opening || refreshing || saving || transitioning || reading}
      onActivate={selectTab}
      onCompare={() => void compareCurrent()}
      onReload={reloadCurrent}
      onRefreshIndex={() => void refreshProject()}/>}
    {overview && driftError && <div className="resource-drift-warning" role="status">
      <AlertTriangle size={14}/> {t('app.driftFailure')}{driftError.message}
      <button type="button" onClick={() => setDriftError(null)}>Закрыть</button>
    </div>}
    {overview?.warnings.map((message) =>
      <div key={message} className="warning"><AlertTriangle size={15}/>{message}</div>)}

    {!overview ? <main className="empty-workspace">
      <FolderOpen size={46} strokeWidth={1.2}/>
      <h1>{t('app.emptyTitle')}</h1>
      <p>{t('app.emptyDescription')}</p>
      <small>{t('app.emptyHelp')}</small>
    </main> :
    <main className="workspace">
      <aside className="explorer">
        <div className="explorer-switch" role="group" aria-label={t('app.explorerMode')}>
          <button type="button" className={explorerMode === 'files' ? 'selected' : ''}
            onClick={() => setExplorerMode('files')}>{t('app.files')}</button>
          <button type="button" className={explorerMode === 'prototypes' ? 'selected' : ''}
            onClick={() => setExplorerMode('prototypes')}>{t('app.prototypes')}</button>
        </div>
        {explorerMode === 'files' ? <>
        <div className="explorer-switch" role="group" aria-label={t('app.fileView')}>
          <button type="button" className={fileView === 'search' ? 'selected' : ''}
            onClick={() => setFileView('search')}>{t('app.search')}</button>
          <button type="button" className={fileView === 'folders' ? 'selected' : ''}
            onClick={() => setFileView('folders')}>{t('app.folders')}</button>
        </div>
        {fileView === 'search' ? <>
        <div className="section-heading"><strong>{t('app.resources')}</strong><small>{t('app.matchCount', { count: results.total })}</small></div>
        <div className="search"><Search size={16}/><input aria-label={t('app.searchResources')} value={query}
          placeholder={t('app.searchPaths')} onChange={(event) => { setQuery(event.target.value); setPage(0); }}/></div>
        <div className="filters" role="group" aria-label={t('app.resourceKind')}>
          {kinds.map((option) => <button type="button" key={option}
            aria-pressed={kind === option} className={kind === option ? 'selected' : ''}
            onClick={() => { setKind(option); setPage(0); }}>{option === 'all' ? t('app.all') : option.toUpperCase()}</button>)}
        </div>
        <div className="resource-list" aria-busy={searching}>
          {!results.items.length && <p className="muted">{searching ? t('app.searching') : t('app.noMatches')}</p>}
          {results.items.map((item) => <button key={item.path} title={item.path} type="button"
            className={'resource-row' + (selected?.path === item.path ? ' active' : '')}
            onClick={() => void openResource(item)}>
            <ResourceIcon kind={item.kind}/><span>{item.path.split('/').at(-1)}</span>
            <small>{item.kind.toUpperCase()}</small>
          </button>)}
        </div>
        <div className="pagination">
          <button type="button" aria-label={t('common.previous')} disabled={page === 0} onClick={() => setPage((value) => value - 1)}><ChevronLeft size={17}/></button>
          <span>{results.total ? t('common.countRange', { from: page * PAGE_SIZE + 1, to: Math.min((page + 1) * PAGE_SIZE, results.total), total: results.total }) : t('common.totalResources', { count: 0 })}</span>
          <button type="button" aria-label={t('common.next')} disabled={(page + 1) * PAGE_SIZE >= results.total} onClick={() => setPage((value) => value + 1)}><ChevronRight size={17}/></button>
        </div>
        </> : <ResourceFolderBrowser
          key={overview.project_root + ':' + workspaceRevision}
          selectedPath={selected?.path ?? null} onOpen={(item) => void openResource(item)} />}
        </> : <PrototypeExplorer workspaceKey={overview.project_root + ':' + workspaceRevision}
          onOpen={openPrototypeSource} onEdit={editPrototypeFields} />}
      </aside>
      <section className="editor">
        {tabState.tabs.length > 0 && <ResourceTabStrip
          tabs={tabState.tabs} activePath={tabState.active}
          dirtyPaths={dirtyPaths} disabled={saving || refreshing || transitioning}
          renderIcon={(kind) => <ResourceIcon kind={kind}/>}
          label={t('app.openTabs')}
          closeLabel={(path) => t('app.closeTab', { path })}
          onSelect={selectTab} onClose={removeTab}
          onReorder={(path, index) => setTabState((state) => reorderTab(state, path, index))}/>}

        {selected ? <>
          <div className="editor-heading">
            <div><ResourceIcon kind={selected.kind}/><span>{selected.path}</span></div>
            <div className="editor-tools">
              {selected.kind === 'yaml' && <button type="button"
                aria-pressed={showYamlOutline}
                disabled={reading || refreshing}
                onClick={() => setShowYamlOutline((value) => !value)}>
                <FileCode2 size={14}/>{showYamlOutline ? 'Скрыть инспектор' : 'Инспектор'}
              </button>}
              <button type="button" onClick={reloadCurrent} disabled={reading || saving || refreshing} title={t('app.reloadHint')}>
                <RotateCcw size={14}/> {t('app.reload')}
              </button>
              {isEditableText(selected.kind) && <button type="button" onClick={() => void compareCurrent()}
                disabled={saving || reading || comparing || refreshing || !isDirty(selected.path)}
                title={t('app.compareHint')}>
                <FileCode2 size={14}/>{comparing ? t('app.comparing') : t('app.compare')}
              </button>}
              {isEditableText(selected.kind) && <button type="button" onClick={() => void saveCurrent()}
                disabled={saving || reading || refreshing || !isDirty(selected.path)} title={t('app.saveHint')}>
                <Save size={14}/>{saving ? t('app.saving') : t('app.save')}
              </button>}
              <span className="readonly"><CheckCircle2 size={14}/>
                {isEditableText(selected.kind)
                  ? (isDirty(selected.path) ? t('app.modified') : t('app.editing', { kind: selected.kind.toUpperCase() }))
                  : t('app.readOnly')}
              </span>
            </div>
          </div>
          {showYamlOutline && selected.kind === 'yaml' && document?.path === selected.path && !reading
            && <PrototypeOutlinePanel key={overview.project_root + ':' + workspaceRevision + ':' + selected.path}
              path={selected.path} source={activeText}
              busy={saving || refreshing || transitioning}
              requiredLocales={localizationSettings.requiredLocales}
              liveValidation={editorSettings.liveValidation}
              validationDelay={editorSettings.validationDelay}
              onJump={(line) => setJumpTarget({
                path: selected.path, line, token: ++jumpCounter.current,
              })}
              onEdit={editPrototypeFields}
              onOpenRsi={(path, state) => openResource({ path, kind: 'rsi' }, state)}/>}
          {selected.kind === 'yaml' && document?.path === selected.path && !reading
            && <YamlDiagnosticsPanel key={selected.path} path={selected.path} source={activeText}
              enabled={editorSettings.liveValidation} delayMs={editorSettings.validationDelay}
              onRevealLine={(line) => setJumpTarget({
                path: selected.path, line, token: ++jumpCounter.current,
              })}/>}
          {selected.kind === 'ftl' && document?.path === selected.path && !reading
            && <FluentDiagnosticsPanel key={selected.path} path={selected.path} source={activeText}
              enabled={editorSettings.liveValidation} delayMs={editorSettings.validationDelay}
              onRevealLine={(line) => setJumpTarget({
                path: selected.path, line, token: ++jumpCounter.current,
              })}
              onRevealSource={(file, line) => {
                setJumpTarget({ path: file, line, token: ++jumpCounter.current });
                openResource({ path: file, kind: 'ftl' });
              }}/>} 
          {fieldTarget && selected.kind === 'yaml' && selected.path === fieldTarget.file
            && document?.path === selected.path && !reading && (prototypePanel === 'fields'
              ? <PrototypeFieldsPanel
                  key={fieldTarget.file + ':' + fieldTarget.document_index + ':' + fieldTarget.item_index}
                  locator={fieldTarget} source={activeText} busy={saving || transitioning || refreshing}
                  onApply={applyPrototypeFields} onClose={() => setFieldTarget(null)}/>
              : prototypePanel === 'parents'
                ? <PrototypeParentsPanel
                    key={fieldTarget.file + ':' + fieldTarget.document_index + ':' + fieldTarget.item_index}
                    locator={fieldTarget} source={activeText} busy={saving || transitioning || refreshing}
                    onApply={applyPrototypeFields} onClose={() => setFieldTarget(null)}/>
              : prototypePanel === 'localization'
                ? <PrototypeLocalizationPanel
                    key={fieldTarget.file + ':' + fieldTarget.document_index + ':' + fieldTarget.item_index}
                    locator={fieldTarget} source={activeText} busy={saving || transitioning || refreshing}
                    requiredLocales={localizationSettings.requiredLocales}
                    onCreateMissing={(draft) => {
                      setQuickFixFluentDraft(draft);
                      setCreatingFluent(true);
                    }}
                    onApply={applyEntityLocalization} onClose={() => setFieldTarget(null)}/>
                : <PrototypeComponentsPanel
                    key={fieldTarget.file + ':' + fieldTarget.document_index + ':' + fieldTarget.item_index}
                    locator={fieldTarget} source={activeText} workspaceRevision={workspaceRevision}
                    busy={saving || transitioning || refreshing}
                    onApply={applyPrototypeFields} onClose={() => setFieldTarget(null)}/>)}
          {comparison && comparison.path === selected.path && <ConflictReviewPanel
            file={comparison.path} disk={comparison.disk} draft={comparison.reviewedDraft}
            draftChanged={Boolean(reviewDirty)} busy={comparing}
            onAccept={() => void acceptComparison()} onRefresh={() => void compareCurrent()}
            onClose={closeComparison}/>}
          {reading ? <div className="placeholder">Чтение ресурса…</div> :
            document && selected.kind === 'rsi'
              ? <RsiPreview key={document.path + ':' + document.revision + ':' + workspaceRevision}
                initialState={rsiRequested?.path === selected.path ? rsiRequested.state : null}
                path={selected.path} metadata={document.content} revision={document.revision}
                onImported={(result) => onRsiImported(selected.path, result)}
                onBatchOutcome={(message) => setNotice(message)}
                onTimingUpdated={(result) => onRsiImported(selected.path, result, 'timing')}
                onCreditsUpdated={(result) => onRsiImported(selected.path, result, 'credits')}
                onDeleted={(result) => onRsiDeleted(selected.path, result)}
                onRestored={(result) => onRsiRestored(selected.path, result)}
                onRenamed={(result) => onRsiRenamed(selected.path, result)}/>
              : document ? <MonacoPreview settings={editorSettings} key={document.path} resource={selected} document={document}
              value={activeText} editable={isEditableText(selected.kind) && !saving && !refreshing}
              onNavigateIdentifier={selected.kind === 'yaml'
                ? (id) => void navigatePrototypeIdentifier(id, selected.path) : undefined}
              onNavigateRsi={selected.kind === 'yaml'
                ? (indexedPath) => void navigateIndexedRsi(indexedPath, selected.path) : undefined}
              onChange={isEditableText(selected.kind) ? (value) => {
                const next = { ...draftsRef.current, [selected.path]: value };
                draftsRef.current = next;
                setDrafts(next);
              } : undefined}
              revealLine={jumpTarget?.path === selected.path ? jumpTarget.line : undefined}
              jumpToken={jumpTarget?.path === selected.path ? jumpTarget.token : 0}/> :
              <div className="placeholder">Не удалось открыть ресурс. Объяснение ошибки показано выше.</div>}
        </> : <div className="placeholder"><FileCode2 size={44} strokeWidth={1.2}/><h2>Выбери ресурс слева</h2><p>Здесь откроется его исходный текст.</p></div>}
      </section>
    </main>}
    <StatusPanel overview={overview} scanProgress={scanProgress}
      opening={opening} refreshing={refreshing} dirtyCount={dirtyPaths.length}
      notice={notice} error={error} revision={workspaceRevision}
      onOpenIssue={(file, line) => {
        setJumpTarget({ path: file, line, token: ++jumpCounter.current });
        void openResource({ path: file, kind: 'yaml' });
      }}/>
  </div>;
}

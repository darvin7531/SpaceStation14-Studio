import { useEffect, useRef, useState, type FormEvent } from 'react';
import { open as openDirectoryDialog } from '@tauri-apps/plugin-dialog';
import {
  AlertCircle, AlertTriangle, CheckCircle2, ChevronLeft, ChevronRight,
  FileCode2, FileText, FolderOpen, Image as ImageIcon, Search, X, RotateCcw, Save, FilePlus2,
} from 'lucide-react';
import { studio, type DraftList, type DraftSnapshot, type CreatedPrototype, type PrototypeDeclaration, type PrototypeFieldLocator, type ProjectOverview, type ResourceDocument, type ResourceEntry, type ResourceKind, type ResourcePage } from './lib/api';
import { normalizeStudioError, type StudioError } from './lib/errors';
import { closeTab, openTab, type TabState } from './lib/tabs';
import { dirtyDocumentPaths, reconcileSavedDraft } from './lib/draft-state';
import { DraftWriteQueue, journalKey } from './lib/draft-queue';
import { reviewDecision } from './lib/review-guard';
import MonacoPreview from './editor/MonacoPreview';
import RsiPreview from './components/RsiPreview';
import PrototypeExplorer from './components/PrototypeExplorer';
import PrototypeFieldsPanel from './components/PrototypeFieldsPanel';
import PrototypeComponentsPanel from './components/PrototypeComponentsPanel';
import RecoveryPanel from './components/RecoveryPanel';
import CreatePrototypeWizard, { type PrototypeDestinationMode } from './components/CreatePrototypeWizard';
import ConflictReviewPanel from './components/ConflictReviewPanel';

const PAGE_SIZE = 100;
const LAST_PROJECT_KEY = 'ss14-studio-rust.last-project-root';
const kinds: ResourceKind[] = ['all', 'yaml', 'rsi', 'ftl'];
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
  return <section className="error-panel" role="alert">
    <div className="error-heading"><AlertCircle size={18}/><strong>{error.message}</strong></div>
    <p>{error.hint}</p>
    <div className="error-footer">
      <code>{error.code}</code>
      {error.details && <details><summary>Технические сведения</summary><pre>{error.details}</pre></details>}
      <button type="button" onClick={close}>Закрыть</button>
    </div>
  </section>;
}

export default function App() {
  const [path, setPath] = useState(() => {
    try {
      return window.localStorage.getItem(LAST_PROJECT_KEY) ?? '';
    } catch {
      return '';
    }
  });
  const [overview, setOverview] = useState<ProjectOverview | null>(null);
  const [opening, setOpening] = useState(false);
  const [creatingPrototype, setCreatingPrototype] = useState(false);
  const [fieldTarget, setFieldTarget] = useState<PrototypeFieldLocator | null>(null);
  const [prototypePanel, setPrototypePanel] = useState<'fields' | 'components'>('fields');
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
  const [notice, setNotice] = useState<string | null>(null);
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;
  const selectedPathRef = useRef(selected?.path ?? null);
  selectedPathRef.current = selected?.path ?? null;
  const dirtyPaths = dirtyDocumentPaths(drafts, documents.current);
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

  useEffect(() => {
    if (dirtyPaths.length === 0) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirtyPaths.length]);

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
    if (!overview || opening || saving || transitioning) return;
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
  }, [overview, drafts, draftBases, document, saving, transitioning, opening]);

  async function loadProject(requestedPath: string) {
    setCreatingPrototype(false);
    setFieldTarget(null);
    comparisonVersion.current += 1;
    setComparison(null);
    cancelJournalTimers();
    setOpening(true);
    setNotice(null);
    setError(null);
    try {
      const next = await studio.openProject(requestedPath);
      try {
        window.localStorage.setItem(LAST_PROJECT_KEY, next.project_root);
      } catch {
        // Saving a recent path is optional and must not block opening.
      }
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
      setTabState({ tabs: [], active: null });
      setDocument(null);
      setReading(false);
      setQuery('');
      setKind('all');
      setPage(0);
    } catch (failure) {
      setError(normalizeStudioError(failure));
    } finally {
      setOpening(false);
    }
  }

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
  }, [overview, query, kind, page]);

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
    const item: ResourceEntry = { path: snapshot.path, kind: 'yaml' };
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
    if (saving || transitioning || opening) return;
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
    if (!file || !overview || opening || transitioning) return;
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
    if (!review || comparing || saving || opening || transitioning) return;
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
    if (!selected || selected.kind !== 'yaml' || saving) return;
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
      const result = await studio.saveYamlResource(file, sourceRevision, submitted);
      documents.current.set(file, result.document);
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
        'YAML сохранён. Индекс прототипов будет перестроен при следующем обращении.',
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
  }, [selected?.path, document?.revision, drafts, saving]);

  function openResource(item: ResourceEntry) {
    if (saving || transitioning || opening) return;
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

  function openPrototypeSource(file: string, line: number) {
    setJumpTarget({ path: file, line, token: ++jumpCounter.current });
    openResource({ path: file, kind: 'yaml' });
  }

  function editPrototypeFields(entry: PrototypeDeclaration, panel: 'fields' | 'components') {
    if (saving || opening || transitioning) return;
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
    if (!file || selectedPathRef.current !== file || saving || opening || transitioning) return false;
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

  function selectTab(path: string) {
    if (saving || transitioning || opening || tabState.active === path) return;
    setFieldTarget(null);
    closeComparison();
    setTabState((state) => ({ ...state, active: path }));
    void focusResource(path);
  }

  function removeTab(path: string) {
    requestAction({ type: 'close', path });
  }

  function reloadCurrent() {
    if (tabState.active) requestAction({ type: 'reload', path: tabState.active });
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

  return <div className="app">
    {creatingPrototype && overview && <CreatePrototypeWizard
      onClose={() => setCreatingPrototype(false)} onCreated={onPrototypeCreated}
      dirtyPaths={dirtyPaths}
      preferredExistingFile={selected?.kind === 'yaml' ? selected.path : undefined}/>}
    <header className="titlebar">
      <div className="brand"><span className="logo">S</span><div><strong>SS14 Studio</strong><small>RUST REWORK</small></div></div>
      <span className="version">0.1.5 alpha · Rust + Tauri</span>
    </header>

    <section className="project-bar">
      <form onSubmit={(event: FormEvent<HTMLFormElement>) => { event.preventDefault(); requestAction({ type: 'open', path }); }}>
        <label htmlFor="project-path"><FolderOpen size={16}/> Папка исходников SS14</label>
        <div className="path-control">
          <input id="project-path" value={path} spellCheck={false} autoComplete="off"
            placeholder="/home/user/SpaceStation14 или C:\SpaceStation14"
            onChange={(event) => setPath(event.target.value)}/>
          <button type="button" className="browse-button" disabled={opening || picking || saving} onClick={() => void chooseProjectFolder()}>Обзор…</button>
          <button type="submit" disabled={opening || picking || saving}><FolderOpen size={16}/>{opening ? 'Проверяю…' : 'Открыть проект'}</button>
        </div>
      </form>
      {overview && <div className="project-counts">
        <span><b>{overview.prototype_files}</b> YAML-файлов</span>
        <span><b>{overview.rsi_directories}</b> RSI</span>
        <span><b>{overview.locale_files}</b> FTL</span>
        <button type="button" className="create-proto-open" disabled={opening || saving || transitioning}
          onClick={() => setCreatingPrototype(true)}>
          <FilePlus2 size={15}/> Создать прототип
        </button>
      </div>}
    </section>

    {error && <ErrorPanel error={error} close={() => setError(null)}/>}
    {notice && <div className="save-notice" role="status">
      <CheckCircle2 size={16}/><span>{notice}</span>
      <button type="button" onClick={() => setNotice(null)}>Закрыть</button>
    </div>}
    {pendingAction && <div className="discard-confirmation" role="alertdialog"
      aria-label="Подтверждение удаления черновика">
      <AlertTriangle size={18}/>
      <div>
        <strong>Есть несохранённые изменения.</strong>
        <p>{pendingAction.type === 'open'
          ? 'Открытие другого проекта удалит все несохранённые черновики.'
          : 'Это действие удалит несохранённые изменения выбранного файла.'}</p>
      </div>
      <button type="button" disabled={transitioning} onClick={() => setPendingAction(null)}>Отмена</button>
      <button type="button" className="danger-button" disabled={transitioning}
        onClick={() => void confirmPendingAction()}>
        Удалить черновик и продолжить
      </button>
    </div>}
    {activeConflict && selected && <div className="recovery-conflict-notice" role="alert">
      <AlertTriangle size={16}/>
      <span>Восстановленный черновик основан на старой версии YAML. Сохранение заблокировано до проверки diff.</span>
      <button type="button" disabled={comparing} onClick={() => void compareCurrent()}>Сравнить версии</button>
    </div>}
    {overview && <RecoveryPanel entries={recoveries.items}
      warnings={recoveries.warnings} dirtyPaths={dirtyPaths}
      onRestore={restoreRecovery} onDiscard={discardRecoveryCopy}/>}
    {overview?.warnings.map((message) =>
      <div key={message} className="warning"><AlertTriangle size={15}/>{message}</div>)}

    {!overview ? <main className="empty-workspace">
      <FolderOpen size={46} strokeWidth={1.2}/>
      <h1>Открыть проект SS14</h1>
      <p>Rust-ядро безопасно проверит структуру репозитория, построит индекс ресурсов и откроет их для просмотра.</p>
      <small>YAML-файлы прототипов можно редактировать с проверкой конфликта; RSI и FTL пока доступны только для просмотра.</small>
    </main> :
    <main className="workspace">
      <aside className="explorer">
        <div className="explorer-switch" role="group" aria-label="Режим навигации">
          <button type="button" className={explorerMode === 'files' ? 'selected' : ''}
            onClick={() => setExplorerMode('files')}>Файлы</button>
          <button type="button" className={explorerMode === 'prototypes' ? 'selected' : ''}
            onClick={() => setExplorerMode('prototypes')}>Прототипы</button>
        </div>
        {explorerMode === 'files' ? <>
        <div className="section-heading"><strong>Ресурсы</strong><small>{results.total} найдено</small></div>
        <div className="search"><Search size={16}/><input aria-label="Поиск ресурсов" value={query}
          placeholder="Поиск по путям…" onChange={(event) => { setQuery(event.target.value); setPage(0); }}/></div>
        <div className="filters" role="group" aria-label="Тип ресурсов">
          {kinds.map((option) => <button type="button" key={option}
            aria-pressed={kind === option} className={kind === option ? 'selected' : ''}
            onClick={() => { setKind(option); setPage(0); }}>{option === 'all' ? 'Все' : option.toUpperCase()}</button>)}
        </div>
        <div className="resource-list" aria-busy={searching}>
          {!results.items.length && <p className="muted">{searching ? 'Поиск…' : 'Совпадений нет'}</p>}
          {results.items.map((item) => <button key={item.path} title={item.path} type="button"
            className={'resource-row' + (selected?.path === item.path ? ' active' : '')}
            onClick={() => void openResource(item)}>
            <ResourceIcon kind={item.kind}/><span>{item.path.split('/').at(-1)}</span>
            <small>{item.kind.toUpperCase()}</small>
          </button>)}
        </div>
        <div className="pagination">
          <button type="button" aria-label="Предыдущая страница" disabled={page === 0} onClick={() => setPage((value) => value - 1)}><ChevronLeft size={17}/></button>
          <span>{results.total ? (page * PAGE_SIZE + 1) + '–' + Math.min((page + 1) * PAGE_SIZE, results.total) + ' из ' + results.total : '0 ресурсов'}</span>
          <button type="button" aria-label="Следующая страница" disabled={(page + 1) * PAGE_SIZE >= results.total} onClick={() => setPage((value) => value + 1)}><ChevronRight size={17}/></button>
        </div>
        </> : <PrototypeExplorer workspaceKey={overview.project_root + ':' + workspaceRevision}
          onOpen={openPrototypeSource} onEdit={editPrototypeFields} />}
      </aside>
      <section className="editor">
        {tabState.tabs.length > 0 && <div className="tab-strip" role="tablist" aria-label="Открытые файлы">
          {tabState.tabs.map((tab) => <div className={'tab' + (tabState.active === tab.path ? ' active' : '')} key={tab.path}>
            <button type="button" role="tab" title={tab.path}
              aria-selected={tabState.active === tab.path}
              className="tab-focus" disabled={saving} onClick={() => selectTab(tab.path)}>
              <ResourceIcon kind={tab.kind}/>
              <span>{tab.path.split('/').at(-1)}{isDirty(tab.path) ? ' ●' : ''}</span>
            </button>
            <button className="tab-close" type="button"
              aria-label={'Закрыть вкладку ' + tab.path} disabled={saving} onClick={() => removeTab(tab.path)}>
              <X size={13}/>
            </button>
          </div>)}
        </div>}
        {selected ? <>
          <div className="editor-heading">
            <div><ResourceIcon kind={selected.kind}/><span>{selected.path}</span></div>
            <div className="editor-tools">
              <button type="button" onClick={reloadCurrent} disabled={reading || saving} title="Загрузить содержимое файла с диска">
                <RotateCcw size={14}/> Перечитать
              </button>
              {selected.kind === 'yaml' && <button type="button" onClick={() => void compareCurrent()}
                disabled={saving || reading || comparing || !isDirty(selected.path)}
                title="Сравнить черновик с актуальным YAML на диске">
                <FileCode2 size={14}/>{comparing ? 'Сравниваю…' : 'Сравнить'}
              </button>}
              {selected.kind === 'yaml' && <button type="button" onClick={() => void saveCurrent()}
                disabled={saving || reading || !isDirty(selected.path)} title="Сохранить YAML (Ctrl+S)">
                <Save size={14}/>{saving ? 'Сохраняю…' : 'Сохранить'}
              </button>}
              <span className="readonly"><CheckCircle2 size={14}/>
                {selected.kind === 'yaml' ? (isDirty(selected.path) ? 'Черновик изменён' : 'YAML · редактирование') : 'Только чтение'}
              </span>
            </div>
          </div>
          {fieldTarget && selected.kind === 'yaml' && selected.path === fieldTarget.file
            && document?.path === selected.path && !reading && (prototypePanel === 'fields'
              ? <PrototypeFieldsPanel
                  key={fieldTarget.file + ':' + fieldTarget.document_index + ':' + fieldTarget.item_index}
                  locator={fieldTarget} source={activeText} busy={saving || transitioning}
                  onApply={applyPrototypeFields} onClose={() => setFieldTarget(null)}/>
              : <PrototypeComponentsPanel
                  key={fieldTarget.file + ':' + fieldTarget.document_index + ':' + fieldTarget.item_index}
                  locator={fieldTarget} source={activeText} busy={saving || transitioning}
                  onApply={applyPrototypeFields} onClose={() => setFieldTarget(null)}/>)}
          {comparison && comparison.path === selected.path && <ConflictReviewPanel
            file={comparison.path} disk={comparison.disk} draft={comparison.reviewedDraft}
            draftChanged={Boolean(reviewDirty)} busy={comparing}
            onAccept={() => void acceptComparison()} onRefresh={() => void compareCurrent()}
            onClose={closeComparison}/>}
          {reading ? <div className="placeholder">Чтение ресурса…</div> :
            document && selected.kind === 'rsi'
              ? <RsiPreview key={document.path + ':' + document.revision} path={selected.path} metadata={document.content}/>
              : document ? <MonacoPreview key={document.path} resource={selected} document={document}
              value={activeText} editable={selected.kind === 'yaml' && !saving}
              onChange={selected.kind === 'yaml' ? (value) => {
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
    <footer className="statusbar"><span>● {overview ? ('Проект открыт · ' + dirtyPaths.length + ' несохранённых черновиков') : 'Ожидание проекта'}</span><span>Rust Core · Tauri 2 · без Electron</span></footer>
  </div>;
}

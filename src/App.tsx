import { useEffect, useRef, useState, type FormEvent } from 'react';
import { open as openDirectoryDialog } from '@tauri-apps/plugin-dialog';
import {
  AlertCircle, AlertTriangle, CheckCircle2, ChevronLeft, ChevronRight,
  FileCode2, FileText, FolderOpen, Image as ImageIcon, Search, X, RotateCcw, Save,
} from 'lucide-react';
import { studio, type ProjectOverview, type ResourceDocument, type ResourceEntry, type ResourceKind, type ResourcePage } from './lib/api';
import { normalizeStudioError, type StudioError } from './lib/errors';
import { closeTab, openTab, type TabState } from './lib/tabs';
import MonacoPreview from './editor/MonacoPreview';
import PrototypeExplorer from './components/PrototypeExplorer';

const PAGE_SIZE = 100;
const LAST_PROJECT_KEY = 'ss14-studio-rust.last-project-root';
const kinds: ResourceKind[] = ['all', 'yaml', 'rsi', 'ftl'];
type PendingAction =
  | { type: 'open'; path: string }
  | { type: 'close'; path: string }
  | { type: 'reload'; path: string };

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
  const [saving, setSaving] = useState(false);
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const dirtyPaths = Object.entries(drafts)
    .filter(([file, text]) => documents.current.get(file)?.content !== text)
    .map(([file]) => file);
  const isDirty = (file: string) => dirtyPaths.includes(file);
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

  async function loadProject(requestedPath: string) {
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
      readVersion.current += 1;
      setWorkspaceRevision((value) => value + 1);
      setJumpTarget(null);
      documents.current.clear();
      setDrafts({});
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

  function requestAction(action: PendingAction) {
    if (saving) return;
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
      void focusResource(action.path);
      return;
    }
    const next = closeTab(tabState, action.path);
    setTabState(next);
    documents.current.delete(action.path);
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

  async function saveCurrent() {
    if (!selected || selected.kind !== 'yaml' || saving) return;
    const file = selected.path;
    const baseline = documents.current.get(file);
    if (!baseline) return;
    const submitted = drafts[file] ?? baseline.content;
    if (submitted === baseline.content) return;

    setSaving(true);
    setNotice(null);
    setError(null);
    try {
      const result = await studio.saveYamlResource(file, baseline.revision, submitted);
      documents.current.set(file, result.document);
      setDrafts((previous) => ({
        ...previous,
        [file]: previous[file] === submitted ? result.document.content : previous[file],
      }));
      setDocument((current) => current?.path === file ? result.document : current);
      setWorkspaceRevision((previous) => previous + 1);
      setNotice(result.durability_warning
        ? 'Файл записан. ' + result.durability_warning
        : 'YAML сохранён. Индекс прототипов будет перестроен при следующем обращении.');
    } catch (failure) {
      setError(normalizeStudioError(failure));
    } finally {
      setSaving(false);
    }
  }

  function openResource(item: ResourceEntry) {
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

  function selectTab(path: string) {
    if (tabState.active === path) return;
    setTabState((state) => ({ ...state, active: path }));
    void focusResource(path);
  }

  function removeTab(path: string) {
    requestAction({ type: 'close', path });
  }

  function reloadCurrent() {
    if (tabState.active) requestAction({ type: 'reload', path: tabState.active });
  }

  return <div className="app">
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
      <button type="button" onClick={() => setPendingAction(null)}>Отмена</button>
      <button type="button" className="danger-button" onClick={() => executeAction(pendingAction)}>
        Удалить черновик и продолжить
      </button>
    </div>}
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
          onOpen={openPrototypeSource} />}
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
              {selected.kind === 'yaml' && <button type="button" onClick={() => void saveCurrent()}
                disabled={saving || reading || !isDirty(selected.path)} title="Сохранить YAML (Ctrl+S)">
                <Save size={14}/>{saving ? 'Сохраняю…' : 'Сохранить'}
              </button>}
              <span className="readonly"><CheckCircle2 size={14}/>
                {selected.kind === 'yaml' ? (isDirty(selected.path) ? 'Черновик изменён' : 'YAML · редактирование') : 'Только чтение'}
              </span>
            </div>
          </div>
          {reading ? <div className="placeholder">Чтение ресурса…</div> :
            document ? <MonacoPreview key={document.path} resource={selected} document={document}
              value={activeText} editable={selected.kind === 'yaml' && !saving}
              onChange={selected.kind === 'yaml' ? (value) => setDrafts((previous) => ({ ...previous, [selected.path]: value })) : undefined}
              revealLine={jumpTarget?.path === selected.path ? jumpTarget.line : undefined}
              jumpToken={jumpTarget?.path === selected.path ? jumpTarget.token : 0}/> :
              <div className="placeholder">Не удалось открыть ресурс. Объяснение ошибки показано выше.</div>}
        </> : <div className="placeholder"><FileCode2 size={44} strokeWidth={1.2}/><h2>Выбери ресурс слева</h2><p>Здесь откроется его исходный текст.</p></div>}
      </section>
    </main>}
    <footer className="statusbar"><span>● {overview ? ('Проект открыт · ' + dirtyPaths.length + ' несохранённых') : 'Ожидание проекта'}</span><span>Rust Core · Tauri 2 · без Electron</span></footer>
  </div>;
}

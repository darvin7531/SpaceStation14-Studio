import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  AlertCircle, AlertTriangle, CheckCircle2, ChevronLeft, ChevronRight,
  FileCode2, FileText, FolderOpen, Image as ImageIcon, Search,
} from 'lucide-react';
import { studio, type ProjectOverview, type ResourceDocument, type ResourceEntry, type ResourceKind, type ResourcePage } from './lib/api';
import { normalizeStudioError, type StudioError } from './lib/errors';

const PAGE_SIZE = 100;
const kinds: ResourceKind[] = ['all', 'yaml', 'rsi', 'ftl'];

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
  const [path, setPath] = useState('');
  const [overview, setOverview] = useState<ProjectOverview | null>(null);
  const [opening, setOpening] = useState(false);
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<ResourceKind>('all');
  const [page, setPage] = useState(0);
  const [results, setResults] = useState<ResourcePage>({ total: 0, items: [] });
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<ResourceEntry | null>(null);
  const [document, setDocument] = useState<ResourceDocument | null>(null);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<StudioError | null>(null);
  const readVersion = useRef(0);

  async function openProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setOpening(true);
    setError(null);
    try {
      const next = await studio.openProject(path);
      readVersion.current += 1;
      setOverview(next);
      setResults({ total: 0, items: [] });
      setSelected(null);
      setDocument(null);
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

  async function openResource(item: ResourceEntry) {
    const version = ++readVersion.current;
    setSelected(item);
    setDocument(null);
    setError(null);
    setReading(true);
    try {
      const loaded = await studio.readResource(item.path);
      if (version === readVersion.current) setDocument(loaded);
    } catch (failure) {
      if (version === readVersion.current) setError(normalizeStudioError(failure));
    } finally {
      if (version === readVersion.current) setReading(false);
    }
  }

  return <div className="app">
    <header className="titlebar">
      <div className="brand"><span className="logo">S</span><div><strong>SS14 Studio</strong><small>RUST REWORK</small></div></div>
      <span className="version">0.1.5 alpha · Rust + Tauri</span>
    </header>

    <section className="project-bar">
      <form onSubmit={(event) => void openProject(event)}>
        <label htmlFor="project-path"><FolderOpen size={16}/> Папка исходников SS14</label>
        <div className="path-control">
          <input id="project-path" value={path} spellCheck={false} autoComplete="off"
            placeholder="/home/user/SpaceStation14 или C:\SpaceStation14"
            onChange={(event) => setPath(event.target.value)}/>
          <button type="submit" disabled={opening}><FolderOpen size={16}/>{opening ? 'Проверяю…' : 'Открыть проект'}</button>
        </div>
      </form>
      {overview && <div className="project-counts">
        <span><b>{overview.prototype_files}</b> YAML-файлов</span>
        <span><b>{overview.rsi_directories}</b> RSI</span>
        <span><b>{overview.locale_files}</b> FTL</span>
      </div>}
    </section>

    {error && <ErrorPanel error={error} close={() => setError(null)}/>}
    {overview?.warnings.map((message) =>
      <div key={message} className="warning"><AlertTriangle size={15}/>{message}</div>)}

    {!overview ? <main className="empty-workspace">
      <FolderOpen size={46} strokeWidth={1.2}/>
      <h1>Открыть проект SS14</h1>
      <p>Rust-ядро безопасно проверит структуру репозитория, построит индекс ресурсов и откроет их для просмотра.</p>
      <small>Это первая стадия переноса: изменения исходников пока отключены.</small>
    </main> :
    <main className="workspace">
      <aside className="explorer">
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
      </aside>
      <section className="editor">
        {selected ? <>
          <div className="editor-heading">
            <div><ResourceIcon kind={selected.kind}/><span>{selected.path}</span></div>
            <span className="readonly"><CheckCircle2 size={14}/> Только чтение</span>
          </div>
          {reading ? <div className="placeholder">Чтение ресурса…</div> :
            document ? <pre className="code-preview" tabIndex={0} aria-label={'Содержимое ' + document.path}><code>{document.content}</code></pre> :
              <div className="placeholder">Не удалось открыть ресурс. Объяснение ошибки показано выше.</div>}
        </> : <div className="placeholder"><FileCode2 size={44} strokeWidth={1.2}/><h2>Выбери ресурс слева</h2><p>Здесь откроется его исходный текст.</p></div>}
      </section>
    </main>}
    <footer className="statusbar"><span>● {overview ? 'Проект открыт · режим чтения' : 'Ожидание проекта'}</span><span>Rust Core · Tauri 2 · без Electron</span></footer>
  </div>;
}

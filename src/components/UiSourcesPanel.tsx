import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, ChevronLeft, ChevronRight, FileCode2, FileText, Search, X } from 'lucide-react';
import { studio, type ResourceDocument, type UiSourceEntry, type UiSourcePage } from '../lib/api';
import { normalizeStudioError } from '../lib/errors';

interface Props { projectKey: string; onClose: () => void; }
const PAGE_SIZE = 80;
const SOURCE_WINDOW = 120;

/** Read-only, indexed UI source explorer. Never modifies project files. */
export default function UiSourcesPanel({ projectKey, onClose }: Props) {
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const [list, setList] = useState<UiSourcePage | null>(null);
  const [listBusy, setListBusy] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [selected, setSelected] = useState<UiSourceEntry | null>(null);
  const [document, setDocument] = useState<ResourceDocument | null>(null);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [sourceBusy, setSourceBusy] = useState(false);
  const [start, setStart] = useState(1);

  useEffect(() => {
    let active = true;
    setListBusy(true);
    setListError(null);
    const timer = window.setTimeout(() => {
      void studio.searchUiSources(query, page * PAGE_SIZE, PAGE_SIZE)
        .then((value) => { if (active) setList(value); })
        .catch((error: unknown) => {
          if (!active) return;
          const issue = normalizeStudioError(error);
          setListError(issue.message + ' ' + issue.hint);
          setList(null);
        }).finally(() => { if (active) setListBusy(false); });
    }, query ? 180 : 0);
    return () => { active = false; window.clearTimeout(timer); };
  }, [projectKey, query, page]);

  useEffect(() => {
    if (!selected) { setDocument(null); return; }
    let active = true;
    setDocument(null);
    setSourceError(null);
    setSourceBusy(true);
    void studio.readUiSource(selected.path)
      .then((value) => { if (active) setDocument(value); })
      .catch((error: unknown) => {
        if (!active) return;
        const issue = normalizeStudioError(error);
        setSourceError(issue.message + ' ' + issue.hint);
      }).finally(() => { if (active) setSourceBusy(false); });
    return () => { active = false; };
  }, [selected?.path, projectKey]);

  const lines = useMemo(() => document?.content.split(/\r?\n/) ?? [], [document]);
  const last = Math.min(lines.length, start + SOURCE_WINDOW - 1);

  function choose(entry: UiSourceEntry) {
    setSelected(entry);
    setStart(1);
  }

  function selectPair() {
    if (!selected?.paired_with) return;
    choose({
      path: selected.paired_with,
      kind: selected.kind === 'xaml' ? 'code_behind' : 'xaml',
      paired_with: selected.path,
    });
  }

  return <div className="csharp-catalog-backdrop">
    <section className="csharp-catalog-modal ui-source-modal" role="dialog"
      aria-modal="true" aria-labelledby="ui-source-heading"
      onKeyDown={(event) => { if (event.key === 'Escape') {
        event.stopPropagation();
        if (selected) setSelected(null); else onClose();
      } }}>
      <header>
        <div>
          <small>Rust Rework · XAML / Avalonia / C#</small>
          <h2 id="ui-source-heading">{selected ? selected.path : 'UI-исходники проекта'}</h2>
        </div>
        <div className="ui-source-actions">
          {selected && <button type="button" onClick={() => setSelected(null)}>
            <ArrowLeft size={16}/> К списку
          </button>}
          <button type="button" aria-label="Закрыть UI-исходники" onClick={onClose}>
            <X size={18}/>
          </button>
        </div>
      </header>

      {!selected ? <>
        <p className="ui-source-explanation">Поиск XAML/Avalonia, связанных .xaml.cs и
          C# файлов в каталогах UI. Только просмотр: изменения в исходники не записываются.</p>
        <label className="ui-source-search"><Search size={17}/>
          <input type="search" value={query} placeholder="Название окна, путь или файл…"
            onChange={(event) => { setQuery(event.target.value); setPage(0); }}/>
        </label>
        {listError && <p role="alert" className="csharp-source-error">{listError}</p>}
        {list?.warnings.map((warning, index) =>
          <p role="status" className="csharp-source-error" key={index}>{warning}</p>)}
        <div className="ui-source-list" aria-busy={listBusy}>
          {listBusy && <p role="status">Индексирую UI-исходники…</p>}
          {!listBusy && !list?.items.length && !listError &&
            <p>UI-исходников не найдено. Проверьте структуру Content.*.</p>}
          {!listBusy && list?.items.map((item) =>
            <button type="button" className="ui-source-item" key={item.path}
              onClick={() => choose(item)}>
              {item.kind === 'xaml' ? <FileText size={17}/> : <FileCode2 size={17}/>}
              <span><strong>{item.path.split('/').at(-1)}</strong>
                <small>{item.path}</small></span>
              <em>{item.kind === 'xaml' ? 'XAML' : 'C#'}
                {item.paired_with ? ' · есть связанный файл' : ''}</em>
            </button>)}
        </div>
        <footer>
          <small>{list?.total ?? 0} файлов · просмотрено {list?.files_scanned ?? 0}
            {!list?.complete ? ' · неполный индекс' : ''}</small>
          <div>
            <button type="button" disabled={listBusy || page === 0}
              aria-label="Предыдущая страница UI"
              onClick={() => setPage((value) => value - 1)}><ChevronLeft size={17}/></button>
            <span>{list?.total
              ? (page * PAGE_SIZE + 1) + '–' + Math.min((page + 1) * PAGE_SIZE, list.total)
              : '0'} / {list?.total ?? 0}</span>
            <button type="button"
              disabled={listBusy || (page + 1) * PAGE_SIZE >= (list?.total ?? 0)}
              aria-label="Следующая страница UI"
              onClick={() => setPage((value) => value + 1)}><ChevronRight size={17}/></button>
          </div>
        </footer>
      </> : <>
        <div className="ui-source-explanation">
          Только чтение · {selected.kind === 'xaml' ? 'Разметка XAML' : 'Исходный код C#'}
          {selected.paired_with && <button type="button" className="ui-source-pair" onClick={selectPair}>
            <FileCode2 size={15}/> Перейти к {selected.paired_with.split('/').at(-1)}
          </button>}
        </div>
        {sourceBusy && <p role="status" className="csharp-source-loading">Читаю файл…</p>}
        {sourceError && <p role="alert" className="csharp-source-error">{sourceError}</p>}
        {document && <div className="csharp-source-lines ui-source-code"
          aria-label="Содержимое UI-исходника">
          {lines.slice(start - 1, last).map((line, index) =>
            <div className="csharp-source-line" key={start + index}>
              <span aria-hidden="true">{start + index}</span><code>{line || ' '}</code>
            </div>)}
        </div>}
        <footer>
          <small>{document
            ? 'Строки ' + start + '–' + last + ' из ' + lines.length
              + ' · ' + Math.round(document.bytes / 1024) + ' КиБ'
            : 'Только чтение'}</small>
          <div>
            <button type="button" disabled={!document || start <= 1}
              onClick={() => setStart(Math.max(1, start - SOURCE_WINDOW))}>Ранее</button>
            <button type="button" disabled={!document || last >= lines.length}
              onClick={() => setStart(start + SOURCE_WINDOW)}>Далее</button>
          </div>
        </footer>
      </>}
    </section>
  </div>;
}

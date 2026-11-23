import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Search, X } from 'lucide-react';
import { studio, type ContentSearchHit, type ContentSearchResults, type ResourceKind } from '../lib/api';
import { normalizeStudioError } from '../lib/errors';

interface Props {
  onClose: () => void;
  onOpen: (hit: ContentSearchHit, signal: AbortSignal) => Promise<boolean>;
  initialQuery?: string;
}

export default function ContentSearchPanel({ onClose, onOpen, initialQuery = '' }: Props) {
  const [query, setQuery] = useState(initialQuery);
  const [kind, setKind] = useState<ResourceKind>('all');
  const [results, setResults] = useState<ContentSearchResults | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const openingHit = useRef(false);
  const openRequest = useRef<AbortController | null>(null);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    inputRef.current?.focus();
    return () => { openRequest.current?.abort(); if (!openingHit.current) previous?.focus(); };
  }, []);

  useEffect(() => {
    openRequest.current?.abort();
    let active = true;
    if (query.trim().length < 2) {
      setResults(null);
      setError(null);
      setBusy(false);
      return;
    }
    setBusy(true);
    setError(null);
    const timer = window.setTimeout(() => {
      void studio.searchResourceContent(query, kind)
        .then((result) => {
          if (!active) return;
          setResults(result);
          setSelected(0);
        })
        .catch((failure: unknown) => {
          if (!active) return;
          const detail = normalizeStudioError(failure);
          setError(detail.message + ' ' + detail.hint);
          setResults(null);
        })
        .finally(() => { if (active) setBusy(false); });
    }, 250);
    return () => { active = false; window.clearTimeout(timer); };
  }, [query, kind]);

  const items = !busy ? results?.items ?? [] : [];
  function close() {
    openRequest.current?.abort();
    onClose();
  }
  async function open(hit: ContentSearchHit) {
    openRequest.current?.abort();
    const request = new AbortController();
    openRequest.current = request;
    try {
      const opened = await onOpen(hit, request.signal);
      if (request.signal.aborted) return;
      if (opened) {
        openingHit.current = true;
        onClose();
      } else inputRef.current?.focus();
    } catch (failure) {
      if (request.signal.aborted) return;
      const detail = normalizeStudioError(failure);
      setError(detail.message + ' ' + detail.hint);
      inputRef.current?.focus();
    }
  }

  return <div className="content-search-backdrop" onMouseDown={(event) => {
    if (event.target === event.currentTarget) close();
  }}>
    <section className="content-search-modal" role="dialog" aria-modal="true"
      aria-label="Поиск по содержимому проекта"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          close();
        } else if (event.key === 'ArrowDown') {
          event.preventDefault();
          setSelected((i) => Math.min(items.length - 1, i + 1));
        } else if (event.key === 'ArrowUp') {
          event.preventDefault();
          setSelected((i) => Math.max(0, i - 1));
        } else if (event.key === 'Enter' && items[selected]) {
          event.preventDefault();
          open(items[selected]);
        }
      }}>
      <header>
        <Search size={18}/>
        <input type="search" value={query} ref={inputRef} autoComplete="off"
          aria-label="Текст для поиска в файлах" placeholder="Поиск текста в YAML, FTL, RSI…"
          onChange={(event) => { openRequest.current?.abort(); setQuery(event.target.value); }}/>
        <select value={kind} aria-label="Тип файлов"
          onChange={(event) => { openRequest.current?.abort(); setKind(event.target.value as ResourceKind); }}>
          <option value="all">Все</option>
          <option value="yaml">YAML</option>
          <option value="ftl">FTL</option>
          <option value="rsi">RSI</option>
        </select>
        <button type="button" aria-label="Закрыть поиск" onClick={close}><X size={18}/></button>
      </header>
      <div className="content-search-info">
        {busy ? 'Ищу по файлам…' :
          results ? `Совпадений: ${results.items.length} · Файлов просмотрено: ${results.files_scanned} · Прочитано: ${Math.round(results.bytes_scanned / 1024)} КиБ`
            : 'Введите не менее двух символов, чтобы искать внутри ресурсов проекта.'}
      </div>
      <div className="content-search-list" aria-busy={busy} role="listbox" aria-label="Совпадения">
        {error && <p role="alert">{error}</p>}
        {results && !busy && !results.complete && <p className="content-search-warning">
          <AlertTriangle size={15}/> Результаты неполные — уточните запрос или тип файлов.
        </p>}
        {results && !busy && results.warnings.map((warning, i) =>
          <p className="content-search-warning" key={i}><AlertTriangle size={15}/>{warning}</p>)}
        {!busy && results && items.length === 0 && !error && <p>Совпадений не найдено.</p>}
        {items.map((hit, index) =>
          <button type="button" role="option" aria-selected={index === selected}
            key={hit.path + ':' + hit.line} className={index === selected ? 'selected' : ''}
            onMouseEnter={() => setSelected(index)} onClick={() => open(hit)}>
            <strong>{hit.path}:{hit.line}</strong>
            <code>{hit.preview}</code>
            <small>{hit.kind.toUpperCase()}</small>
          </button>)}
      </div>
      <footer>Ctrl+Shift+F — поиск · ↑↓ — выбрать · Enter — открыть файл на строке</footer>
    </section>
  </div>;
}

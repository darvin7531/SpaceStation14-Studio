import { useEffect, useState } from 'react';
import { AlertTriangle, FileCode2, LoaderCircle, Search, X } from 'lucide-react';
import { studio, type CSharpPage } from '../lib/api';
import { normalizeStudioError, type StudioError } from '../lib/errors';

type Kind = 'all' | 'component' | 'prototype';
const PAGE_SIZE = 50;

interface Props {
  projectKey: string;
  onClose: () => void;
}

export default function CSharpCatalogPanel({ projectKey, onClose }: Props) {
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<Kind>('all');
  const [page, setPage] = useState(0);
  const [results, setResults] = useState<CSharpPage | null>(null);
  const [error, setError] = useState<StudioError | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    const timer = window.setTimeout(() => {
      void studio.searchCSharpDefinitions(query, kind, page * PAGE_SIZE, PAGE_SIZE)
        .then((result) => {
          if (!active) return;
          setResults(result);
          setError(null);
        })
        .catch((failure: unknown) => {
          if (!active) return;
          setError(normalizeStudioError(failure));
          setResults(null);
        })
        .finally(() => { if (active) setLoading(false); });
    }, query ? 200 : 0);
    return () => { active = false; window.clearTimeout(timer); };
  }, [projectKey, query, kind, page]);

  return <div className="csharp-catalog-backdrop">
    <section className="csharp-catalog-modal" role="dialog"
      aria-modal="true" aria-labelledby="csharp-catalog-heading">
      <header>
        <div>
          <small>Rust Rework · Tree-sitter C#</small>
          <h2 id="csharp-catalog-heading">Схемы C#</h2>
        </div>
        <button type="button" onClick={onClose} aria-label="Закрыть C#-схемы">
          <X size={18}/>
        </button>
      </header>
      <div className="csharp-catalog-summary">
        <p>Поиск по объявлениям <code>[RegisterComponent]</code>,
          <code>[Prototype]</code> и <code>[DataField]</code>. Данные исходников — только для чтения.</p>
        {results && <p>
          Просканировано файлов: <strong>{results.files_scanned}</strong> ·
          байт: <strong>{results.bytes_scanned.toLocaleString('ru-RU')}</strong> ·
          объявлений найдено: <strong>{results.total}</strong>
          {!results.complete && <strong className="csharp-catalog-incomplete"> · Индекс неполный</strong>}
        </p>}
      </div>
      <div className="csharp-catalog-controls">
        <label>
          <Search size={16}/>
          <input type="search" value={query} placeholder="Имя класса, YAML-тип, путь, DataField…"
            onChange={(event) => { setQuery(event.target.value); setPage(0); }}/>
        </label>
        <div role="group" aria-label="Тип C#-объявления">
          {(['all', 'component', 'prototype'] as const).map((value) =>
            <button type="button" key={value} aria-pressed={kind === value}
              className={kind === value ? 'active' : ''}
              onClick={() => { setKind(value); setPage(0); }}>
              {value === 'all' ? 'Все' : value === 'component' ? 'Компоненты' : 'Прототипы'}
            </button>)}
        </div>
      </div>
      {error && <div className="csharp-catalog-warning" role="alert">
        <AlertTriangle size={16}/><span>{error.message} {error.hint}</span>
      </div>}
      {results?.warnings.map((message, index) =>
        <div className="csharp-catalog-warning" key={index}>
          <AlertTriangle size={14}/><span>{message}</span>
        </div>)}
      <div className="csharp-catalog-results" aria-busy={loading}>
        {loading && <p role="status"><LoaderCircle size={16}/> Индексирую C#-исходники…</p>}
        {!loading && !results?.items.length && !error && <p>Совпадений не найдено.</p>}
        {!loading && results?.items.map((definition) =>
          <article key={[definition.kind, definition.file, definition.line].join(':')}>
            <div className="csharp-catalog-definition">
              <FileCode2 size={17}/>
              <div>
                <strong>{definition.name}</strong>
                <small>{definition.kind === 'component' ? 'Компонент' : 'Прототип'} ·
                  {definition.class_name}{definition.partial ? ' · partial' : ''}
                  {definition.parse_uncertain ? ' · синтаксис требует проверки' : ''}
                </small>
              </div>
            </div>
            <p className="csharp-catalog-location">{definition.file}:{definition.line}</p>
            {definition.base_types && <p>Базовые типы: <code>{definition.base_types}</code></p>}
            {definition.fields.length > 0 &&
              <details>
                <summary>DataField: {definition.fields.length}</summary>
                <table>
                  <thead><tr><th>Ключ YAML</th><th>Тип C#</th><th>Член</th><th>Строка</th></tr></thead>
                  <tbody>{definition.fields.map((field, i) =>
                    <tr key={field.member + ':' + i}>
                      <td>{field.name}{field.required ? ' *' : ''}</td>
                      <td><code>{field.field_type}</code></td>
                      <td>{field.member}</td>
                      <td>{field.line}</td>
                    </tr>)}</tbody>
                </table>
              </details>}
          </article>)}
      </div>
      <footer>
        <small>Результаты кэшируются до обновления индекса проекта.
          Это структурный анализ, а не полноценная компиляция C# через Roslyn.</small>
        <div>
          <button type="button" disabled={loading || page === 0}
            onClick={() => setPage((current) => current - 1)}>Назад</button>
          <span>{results?.total ? page * PAGE_SIZE + 1 : 0}–
            {Math.min((page + 1) * PAGE_SIZE, results?.total ?? 0)}</span>
          <button type="button" disabled={loading || (page + 1) * PAGE_SIZE >= (results?.total ?? 0)}
            onClick={() => setPage((current) => current + 1)}>Вперёд</button>
        </div>
      </footer>
    </section>
  </div>;
}

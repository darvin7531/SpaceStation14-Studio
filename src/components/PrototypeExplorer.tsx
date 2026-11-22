import { useEffect, useState } from 'react';
import { AlertTriangle, ChevronLeft, ChevronRight, GitBranch, Search } from 'lucide-react';
import {
  studio,
  type PrototypeDeclaration,
  type PrototypeDiagnostic,
  type PrototypeDiagnosticPage,
  type PrototypePage,
} from '../lib/api';
import { normalizeStudioError, type StudioError } from '../lib/errors';
import PrototypeRelationsPanel from './PrototypeRelationsPanel';

const PAGE_SIZE = 80;

interface Props {
  workspaceKey: string;
  onOpen: (path: string, line: number) => void;
  onEdit: (entry: PrototypeDeclaration, panel: 'fields' | 'components') => void;
}

export default function PrototypeExplorer({ workspaceKey, onOpen, onEdit }: Props) {
  const [section, setSection] = useState<'catalog' | 'diagnostics'>('catalog');
  const [inspected, setInspected] = useState<{ kind: string; id: string } | null>(null);
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState('');
  const [page, setPage] = useState(0);
  const [diagnosticsPage, setDiagnosticsPage] = useState(0);
  const [result, setResult] = useState<PrototypePage>({ total: 0, items: [], diagnostic_count: 0 });
  const [issues, setIssues] = useState<PrototypeDiagnosticPage>({ total: 0, items: [] });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<StudioError | null>(null);

  useEffect(() => {
    let cancelled = false;
    const handle = window.setTimeout(async () => {
      setBusy(true);
      setError(null);
      try {
        if (section === 'catalog') {
          const found = await studio.searchPrototypes(query, kind, page * PAGE_SIZE, PAGE_SIZE);
          if (!cancelled) setResult(found);
        } else {
          const found = await studio.listPrototypeDiagnostics(diagnosticsPage * PAGE_SIZE, PAGE_SIZE);
          if (!cancelled) setIssues(found);
        }
      } catch (failure) {
        if (!cancelled) setError(normalizeStudioError(failure));
      } finally {
        if (!cancelled) setBusy(false);
      }
    }, 180);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [workspaceKey, section, query, kind, page, diagnosticsPage]);

  function navigate(kindName: string, id: string) {
    setSection('catalog');
    setKind(kindName);
    setQuery(id);
    setPage(0);
    setInspected({ kind: kindName, id });
  }

  return <div className="prototype-explorer">
    <div className="proto-sections" role="group" aria-label="Режим каталога прототипов">
      <button type="button" className={section === 'catalog' ? 'selected' : ''} onClick={() => setSection('catalog')}>
        Каталог
      </button>
      <button type="button" className={section === 'diagnostics' ? 'selected' : ''} onClick={() => setSection('diagnostics')}>
        Проблемы {result.diagnostic_count > 0 ? '(' + result.diagnostic_count + ')' : ''}
      </button>
    </div>
    {section === 'catalog' && <>
      <div className="search">
        <Search size={16}/>
        <input aria-label="Поиск прототипа по типу, ID или файлу" placeholder="ID, тип, путь…" value={query}
          onChange={(event) => { setQuery(event.target.value); setPage(0); }}/>
      </div>
      <div className="proto-kind">
        <label htmlFor="prototype-kind-filter">Тип</label>
        <input id="prototype-kind-filter" placeholder="Все типы (entity, reagent…)" value={kind}
          onChange={(event) => { setKind(event.target.value); setPage(0); }}/>
      </div>
    </>}
    <div className="section-heading">
      <strong>{section === 'catalog' ? 'Объявления прототипов' : 'Диагностика YAML'}</strong>
      <small>{section === 'catalog' ? result.total : issues.total}</small>
    </div>
    {inspected && <PrototypeRelationsPanel selected={inspected} workspaceKey={workspaceKey}
      onClose={() => setInspected(null)} onNavigate={navigate} onOpen={onOpen}/>}
    {error && <div className="proto-error" role="alert">
      <strong>{error.message}</strong><p>{error.hint}</p>
      <code>{error.code}</code>
    </div>}
    <div className="resource-list prototype-results" aria-busy={busy}>
      {busy && !result.items.length && <p className="muted">Индексация YAML…</p>}
      {section === 'catalog' && <>
        {!busy && result.total === 0 && <p className="muted">
          {result.diagnostic_count > 0
            ? 'Прототипов не найдено. Проверьте вкладку «Проблемы».'
            : 'По запросу нет объявлений прототипов.'}
        </p>}
        {result.items.map((entry: PrototypeDeclaration) => <div
          className="prototype-entry" key={entry.file + ':' + entry.document_index + ':' + entry.item_index + ':' + (entry.variant_index ?? 'base')}>
          <button type="button" className="prototype-open" onClick={() => onOpen(entry.file, entry.line)}
            title={'Открыть ' + entry.file + ':' + entry.line}>
            <span className="prototype-id"><GitBranch size={14}/>{entry.id}</span>
            <span className="prototype-kind-text">{entry.kind}
              {entry.abstract_prototype ? ' · abstract' : ''}
              {entry.source_count > 1 ? ' · ' + entry.source_count + ' объявл.' : ''}
            </span>
            <span className="prototype-path">{entry.file.split('/').at(-1)}:{entry.line}</span>
          </button>
          {entry.mode === 'normal' && entry.variant_index === null && <button type="button" className="prototype-relations-trigger"
            title="Редактировать простые поля через форму"
            onClick={() => onEdit(entry, 'fields')}>
            Поля
          </button>}
          {entry.kind === 'entity' && entry.mode === 'normal' && entry.variant_index === null && <button
            type="button" className="prototype-relations-trigger"
            title="Просмотр, добавление и удаление явно объявленных компонентов"
            onClick={() => onEdit(entry, 'components')}>
            Компоненты
          </button>}
          <button type="button" className="prototype-relations-trigger"
            aria-label={'Показать связи прототипа ' + entry.kind + ':' + entry.id}
            aria-pressed={inspected?.kind === entry.kind && inspected.id === entry.id}
            onClick={() => setInspected((prev) => prev?.kind === entry.kind && prev.id === entry.id
              ? null : { kind: entry.kind, id: entry.id })}>
            Связи и потомки
          </button>
          {entry.variant_index !== null && <span className="prototype-partial">Вариант {entry.variant_index + 1}</span>}
          {entry.partial_order !== null && <span className="prototype-partial">Порядок partial: {entry.partial_order}</span>}
          {entry.mode !== 'normal' && <span className="prototype-partial">{{
            configured_partial: 'Partial-каталог', tagged_partial: 'Tagged Partial',
            partial_only: 'Partial Only', normal: '',
          }[entry.mode]}</span>}
          {entry.parents.length > 0 && <div className="prototype-parents">
            <span>Родители: </span>
            {entry.parents.map((parent) => <button type="button" className="prototype-parent-link"
              key={parent} title={'Искать объявления ' + entry.kind + ':' + parent}
              onClick={() => navigate(entry.kind, parent)}>
              {parent}
            </button>)}
            {entry.parent_tag && <span className="prototype-parent-tag">({entry.parent_tag})</span>}
          </div>}
        </div>)}
      </>}
      {section === 'diagnostics' && <>
        {!busy && issues.total === 0 && <p className="muted">Диагностических сообщений нет.</p>}
        {issues.items.map((issue: PrototypeDiagnostic, index: number) => <button
          type="button" className="proto-diagnostic" key={issue.file + ':' + issue.line + ':' + index}
          onClick={() => onOpen(issue.file, issue.line)}
          title="Открыть исходный файл">
          <span><AlertTriangle size={14}/>{issue.code}</span>
          <strong>{issue.message}</strong>
          <small>{issue.file}{issue.line > 0 ? ':' + issue.line : ''}</small>
        </button>)}
      </>}
    </div>
    <div className="pagination">
      <button type="button" aria-label="Предыдущая страница"
        disabled={(section === 'catalog' ? page : diagnosticsPage) === 0}
        onClick={() => section === 'catalog' ? setPage((n) => n - 1) : setDiagnosticsPage((n) => n - 1)}>
        <ChevronLeft size={17}/>
      </button>
      <span>{section === 'catalog' ? page * PAGE_SIZE + Math.min(result.items.length, 1) : diagnosticsPage * PAGE_SIZE + Math.min(issues.items.length, 1)}
        –{section === 'catalog' ? page * PAGE_SIZE + result.items.length : diagnosticsPage * PAGE_SIZE + issues.items.length}
        {' из '}{section === 'catalog' ? result.total : issues.total}</span>
      <button type="button" aria-label="Следующая страница"
        disabled={(section === 'catalog' ? (page + 1) * PAGE_SIZE >= result.total : (diagnosticsPage + 1) * PAGE_SIZE >= issues.total)}
        onClick={() => section === 'catalog' ? setPage((n) => n + 1) : setDiagnosticsPage((n) => n + 1)}>
        <ChevronRight size={17}/>
      </button>
    </div>
  </div>;
}

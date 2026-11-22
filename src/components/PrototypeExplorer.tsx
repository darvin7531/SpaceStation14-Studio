import { useEffect, useState } from 'react';
import { AlertTriangle, ChevronLeft, ChevronRight, GitBranch, Search } from 'lucide-react';
import {
  studio,
  type PrototypeDeclaration,
  type PrototypeDiagnostic,
  type PrototypeDiagnosticPage,
  type PrototypePage,
} from '../lib/api';
import { useI18n } from '../i18n';
import { normalizeStudioError, type StudioError } from '../lib/errors';
import PrototypeRelationsPanel from './PrototypeRelationsPanel';

const PAGE_SIZE = 80;

interface Props {
  workspaceKey: string;
  query: string;
  kind: string;
  onQueryChange: (query: string) => void;
  onKindChange: (kind: string) => void;
  onOpen: (path: string, line: number) => void;
  onEdit: (entry: PrototypeDeclaration, panel: 'fields' | 'components' | 'localization' | 'parents') => void;
}

export default function PrototypeExplorer({ workspaceKey, query, kind, onQueryChange, onKindChange, onOpen, onEdit }: Props) {
  const { t } = useI18n();
  const [section, setSection] = useState<'catalog' | 'diagnostics'>('catalog');
  const [inspected, setInspected] = useState<{ kind: string; id: string } | null>(null);
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
    onKindChange(kindName);
    onQueryChange(id);
    setPage(0);
    setInspected({ kind: kindName, id });
  }

  return <div className="prototype-explorer">
    <div className="proto-sections" role="group" aria-label={t('prototypeExplorer.mode')}>
      <button type="button" className={section === 'catalog' ? 'selected' : ''} onClick={() => setSection('catalog')}>
        {t('prototypeExplorer.catalog')}
      </button>
      <button type="button" className={section === 'diagnostics' ? 'selected' : ''} onClick={() => setSection('diagnostics')}>
        {t('prototypeExplorer.problems')} {result.diagnostic_count > 0 ? '(' + result.diagnostic_count + ')' : ''}
      </button>
    </div>
    {section === 'catalog' && <>
      <div className="search">
        <Search size={16}/>
        <input aria-label={t('prototypeExplorer.searchLabel')} placeholder={t('prototypeExplorer.searchPlaceholder')} value={query}
          onChange={(event) => { onQueryChange(event.target.value); setPage(0); }}/>
      </div>
      <div className="proto-kind">
        <label htmlFor="prototype-kind-filter">{t('prototypeExplorer.kind')}</label>
        <input id="prototype-kind-filter" placeholder={t('prototypeExplorer.allKinds')} value={kind}
          onChange={(event) => { onKindChange(event.target.value); setPage(0); }}/>
      </div>
    </>}
    <div className="section-heading">
      <strong>{section === 'catalog' ? t('prototypeExplorer.declarations') : t('prototypeExplorer.diagnostics')}</strong>
      <small>{section === 'catalog' ? result.total : issues.total}</small>
    </div>
    {inspected && <PrototypeRelationsPanel selected={inspected} workspaceKey={workspaceKey}
      onClose={() => setInspected(null)} onNavigate={navigate} onOpen={onOpen}/>}
    {error && <div className="proto-error" role="alert">
      <strong>{t('prototypeExplorer.error')}</strong><p>{error.message}</p><p>{error.hint}</p>
      <code>{error.code}</code>
    </div>}
    <div className="resource-list prototype-results" aria-busy={busy}>
      {busy && !(section === 'catalog' ? result.items.length : issues.items.length) && <p className="muted" role="status">{t('prototypeExplorer.loading')}</p>}
      {section === 'catalog' && <>
        {!busy && !error && result.total === 0 && <p className="muted">
          {result.diagnostic_count > 0
            ? t('prototypeExplorer.emptyProblems')
            : t('prototypeExplorer.empty')}
        </p>}
        {result.items.map((entry: PrototypeDeclaration) => <div
          className="prototype-entry" key={entry.file + ':' + entry.document_index + ':' + entry.item_index + ':' + (entry.variant_index ?? 'base')}>
          <button type="button" className="prototype-open" onClick={() => onOpen(entry.file, entry.line)}
            title={t('prototypeExplorer.open', { path: entry.file, line: entry.line })}>
            <span className="prototype-id"><GitBranch size={14}/>{entry.id}</span>
            <span className="prototype-kind-text">{entry.kind}
              {entry.abstract_prototype ? ' · ' + t('prototypeExplorer.abstract') : ''}
              {entry.source_count > 1 ? ' · ' + entry.source_count + ' ' + t('prototypeExplorer.sources') : ''}
            </span>
            <span className="prototype-path">{entry.file.split('/').at(-1)}:{entry.line}</span>
          </button>
          {entry.mode === 'normal' && entry.variant_index === null && <button type="button" className="prototype-relations-trigger"
            title={t('prototypeExplorer.fieldsTitle')}
            onClick={() => onEdit(entry, 'fields')}>
            {t('prototypeExplorer.fields')}
          </button>}
          {entry.mode === 'normal' && entry.variant_index === null && <button
            type="button" className="prototype-relations-trigger"
            title={t('prototypeExplorer.parentsTitle')}
            onClick={() => onEdit(entry, 'parents')}>
            {t('prototypeExplorer.parents')}
          </button>}
          {entry.kind === 'entity' && entry.mode === 'normal' && entry.variant_index === null && <button
            type="button" className="prototype-relations-trigger"
            title={t('prototypeExplorer.componentsTitle')}
            onClick={() => onEdit(entry, 'components')}>
            {t('prototypeExplorer.components')}
          </button>}
          {entry.kind === 'entity' && entry.mode === 'normal' && entry.variant_index === null && <button
            type="button" className="prototype-relations-trigger"
            title={t('prototypeExplorer.localizationTitle')}
            onClick={() => onEdit(entry, 'localization')}>
            {t('prototypeExplorer.localization')}
          </button>}
          <button type="button" className="prototype-relations-trigger"
            aria-label={t('prototypeExplorer.relationsLabel', { kind: entry.kind, id: entry.id })}
            aria-pressed={inspected?.kind === entry.kind && inspected.id === entry.id}
            onClick={() => setInspected((prev) => prev?.kind === entry.kind && prev.id === entry.id
              ? null : { kind: entry.kind, id: entry.id })}>
            {t('prototypeExplorer.relations')}
          </button>
          {entry.variant_index !== null && <span className="prototype-partial">{t('prototypeExplorer.variant', { number: entry.variant_index + 1 })}</span>}
          {entry.partial_order !== null && <span className="prototype-partial">{t('prototypeExplorer.partialOrder', { order: entry.partial_order })}</span>}
          {entry.mode !== 'normal' && <span className="prototype-partial">{{
            configured_partial: t('prototypeExplorer.configuredPartial'), tagged_partial: t('prototypeExplorer.taggedPartial'),
            partial_only: t('prototypeExplorer.partialOnly'), normal: '',
          }[entry.mode]}</span>}
          {entry.parents.length > 0 && <div className="prototype-parents">
            <span>{t('prototypeExplorer.parents')}: </span>
            {entry.parents.map((parent) => <button type="button" className="prototype-parent-link"
              key={parent} title={t('prototypeExplorer.searchParent', { kind: entry.kind, id: parent })}
              onClick={() => navigate(entry.kind, parent)}>
              {parent}
            </button>)}
            {entry.parent_tag && <span className="prototype-parent-tag">({entry.parent_tag})</span>}
          </div>}
        </div>)}
      </>}
      {section === 'diagnostics' && <>
        {!busy && !error && issues.total === 0 && <p className="muted">{t('prototypeExplorer.noDiagnostics')}</p>}
        {issues.items.map((issue: PrototypeDiagnostic, index: number) => <button
          type="button" className="proto-diagnostic" key={issue.file + ':' + issue.line + ':' + index}
          onClick={() => onOpen(issue.file, issue.line)}
          title={t('prototypeExplorer.openSource')}>
          <span><AlertTriangle size={14}/>{issue.code}</span>
          <strong>{issue.message}</strong>
          <small>{issue.file}{issue.line > 0 ? ':' + issue.line : ''}</small>
        </button>)}
      </>}
    </div>
    <div className="pagination">
      <button type="button" aria-label={t('prototypeExplorer.previous')}
        disabled={(section === 'catalog' ? page : diagnosticsPage) === 0}
        onClick={() => section === 'catalog' ? setPage((n) => n - 1) : setDiagnosticsPage((n) => n - 1)}>
        <ChevronLeft size={17}/>
      </button>
      <span>{t('prototypeExplorer.range', {
        start: section === 'catalog' ? page * PAGE_SIZE + Math.min(result.items.length, 1) : diagnosticsPage * PAGE_SIZE + Math.min(issues.items.length, 1),
        end: section === 'catalog' ? page * PAGE_SIZE + result.items.length : diagnosticsPage * PAGE_SIZE + issues.items.length,
        total: section === 'catalog' ? result.total : issues.total,
      })}</span>
      <button type="button" aria-label={t('prototypeExplorer.next')}
        disabled={(section === 'catalog' ? (page + 1) * PAGE_SIZE >= result.total : (diagnosticsPage + 1) * PAGE_SIZE >= issues.total)}
        onClick={() => section === 'catalog' ? setPage((n) => n + 1) : setDiagnosticsPage((n) => n + 1)}>
        <ChevronRight size={17}/>
      </button>
    </div>
  </div>;
}

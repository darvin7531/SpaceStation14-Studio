import { useEffect, useState } from 'react';
import { useI18n } from '../i18n';
import { AlertCircle, GitBranch, X } from 'lucide-react';
import { studio, type PrototypeAncestor, type PrototypePartialPreview, type PrototypeRelationLink, type PrototypeRelations, type PrototypeSourceReport } from '../lib/api';
import { normalizeStudioError, type StudioError } from '../lib/errors';
import InheritancePreviewPanel from './InheritancePreviewPanel';
import LinkedPrototypePanel from './LinkedPrototypePanel';

interface PrototypeIdentity {
  kind: string;
  id: string;
}

interface Props {
  selected: PrototypeIdentity;
  workspaceKey: string;
  onClose: () => void;
  onNavigate: (kind: string, id: string) => void;
  onOpen: (file: string, line: number) => void;
}


function RelationItems({
  title,
  items,
  total,
  onNavigate,
  onOpen,
}: {
  title: string;
  items: PrototypeRelationLink[];
  total: number;
  onNavigate: Props['onNavigate'];
  onOpen: Props['onOpen'];
}) {
  const { t } = useI18n();
  return <section className="proto-relation-group">
    <strong>{title} ({total})</strong>
    {total === 0 && <p className="muted">{t('relations.emptyLinks')}</p>}
    {items.map((link, index) => <div className="proto-relation-row"
      key={link.id + ':' + link.file + ':' + link.line + ':' + index}>
      <button type="button" className="proto-relation-link"
        title={t('relations.find', { kind: link.kind, id: link.id })}
        onClick={() => onNavigate(link.kind, link.id)}>
        {link.id}
      </button>
      <span title={t(`relations.status.${link.status}`)}>{t(`relations.status.${link.status}`)}</span>
      <button type="button" className="proto-relation-source"
        title={t('relations.open', { file: link.file, line: link.line })}
        onClick={() => onOpen(link.file, link.line)}>
        {link.file.split('/').at(-1)}:{link.line}
      </button>
      {link.source_mode !== 'normal' && <small>{t('relations.sourceMode', { mode: link.source_mode })}</small>}
    </div>)}
    {total > items.length && <small className="proto-relation-more">
      {t('relations.linksMore', { shown: items.length, total })}
    </small>}
  </section>;
}

/** Each row is a declared parent edge with its own file and source mode.
 * Partial-origin links are intentionally not traversed as resolved inheritance. */
function AncestorItems({
  items, complete, truncated, onNavigate, onOpen,
}: {
  items: PrototypeAncestor[];
  complete: boolean;
  truncated: boolean;
  onNavigate: Props['onNavigate'];
  onOpen: Props['onOpen'];
}) {
  const { t } = useI18n();
  return <section className="proto-relation-group proto-ancestor-group">
    <strong>{t('relations.ancestors')} ({items.length}{truncated ? '+' : ''})</strong>
    <p className="proto-relations-caveat">
      {complete
        ? t('relations.ancestorsComplete')
        : t('relations.ancestorsIncomplete')}
      {truncated && t('relations.ancestorsLimit')}
    </p>
    {items.length === 0 && <p className="muted">{t('relations.noAncestors')}</p>}
    {items.map((entry, index) => <div className="proto-ancestor-row"
      key={entry.source_file + ':' + entry.source_line + ':' + entry.id + ':' + index}
      style={{ marginLeft: Math.min(entry.depth - 1, 7) * 11 }}>
      <div className="proto-ancestor-main">
        <span className="proto-ancestor-depth">{entry.depth}</span>
        <button type="button" className="proto-relation-link"
          disabled={entry.status === 'not_indexed'} onClick={() => onNavigate(entry.kind, entry.id)}>
          {entry.id}
        </button>
        <small>← {entry.via}</small>
        {entry.status !== 'defined' && <span className="proto-ancestor-state">{t(`relations.status.${entry.status}`)}</span>}
        {entry.source_mode !== 'normal' && <span className="proto-ancestor-state">
          {t('relations.uncertainBranch', { mode: entry.source_mode })}
        </span>}
        {entry.partial_sources > 0 && <span className="proto-ancestor-state">
          {t('relations.partialSources', { count: entry.partial_sources })}
        </span>}
        {entry.cycle && <span className="proto-ancestor-state">{t('relations.cycle')}</span>}
        {!entry.cycle && entry.repeated && <small>{t('relations.repeated')}</small>}
      </div>
      <div className="proto-ancestor-sources">
        <button type="button" className="proto-relation-source" onClick={() =>
          onOpen(entry.source_file, entry.source_line)}>
          {t('relations.parentSource', { file: entry.source_file.split('/').at(-1), line: entry.source_line })}
        </button>
        {entry.definition_file && <button type="button" className="proto-relation-source"
          onClick={() => onOpen(entry.definition_file!, entry.definition_line ?? 1)}>
          {t('relations.definitionSource', { file: entry.definition_file.split('/').at(-1), line: entry.definition_line ?? '?' })}
        </button>}
      </div>
    </div>)}
  </section>;
}

/** Partial overlay is not the final RobustToolbox inheritance result: parents
 * and C# DataField defaults remain deliberately outside this preview. */
function PartialOverlayPreview({
  selected, workspaceKey, onOpen,
}: {
  selected: PrototypeIdentity;
  workspaceKey: string;
  onOpen: Props['onOpen'];
}) {
  const { t } = useI18n();
  const [report, setReport] = useState<PrototypePartialPreview | null>(null);
  const [failure, setFailure] = useState<StudioError | null>(null);
  const [busy, setBusy] = useState(true);

  useEffect(() => {
    let active = true;
    setBusy(true);
    setFailure(null);
    setReport(null);
    void studio.prototypePartialPreview(selected.kind, selected.id).then((result) => {
      if (active) setReport(result);
    }).catch((reason: unknown) => {
      if (active) setFailure(normalizeStudioError(reason));
    }).finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [selected.kind, selected.id, workspaceKey]);

  return <section className="proto-source-report" aria-label={t('relations.partialLabel')}>
    {busy && <p className="muted" role="status">{t('relations.partialLoading')}</p>}
    {failure && <div role="alert" className="proto-error">
      <strong>{failure.message}</strong><p>{failure.hint}</p><code>{failure.code}</code>
    </div>}
    {report && <>
      <p className="proto-relations-caveat">
        {report.exact
          ? t('relations.partialExact')
          : t('relations.partialIncomplete')}
        {' '}{t('relations.applied', { count: report.applied_partials })}
      </p>
      {report.warnings.map((warning, i) => <p key={i} className="proto-source-warning">{warning}</p>)}
      <div className="proto-source-tags">
        <strong>{t('relations.parentAfter')}</strong>
        {report.parents.length ? report.parents.map((parent, index) => <code key={index}>{parent}</code>)
          : <small>{t('relations.notSet')}</small>}
      </div>
      <strong className="proto-source-label">{t('relations.fieldsAfter', { count: report.fields.length })}</strong>
      {!report.fields.length && <p className="muted">{t('relations.noFields')}</p>}
      {report.fields.map((item) => <div className="proto-merged-row" key={item.key}>
        <strong>{item.key}</strong>
        <span>{item.preview}</span>
        {item.source_file && <button className="proto-relation-source" type="button"
          title={t('relations.openFieldSource')} onClick={() => onOpen(item.source_file, 1)}>
          {item.source_file.split('/').at(-1)}
        </button>}
      </div>)}
      <strong className="proto-source-label">{t('relations.componentsAfter', { count: report.components.length })}</strong>
      {report.components.map((item) => <div className="proto-merged-row" key={item.type_name}>
        <strong>{item.type_name}</strong>
        <span>{item.keys.length ? item.keys.join(', ') : t('relations.noExplicitFields')}</span>
        {item.source_file && <button className="proto-relation-source" type="button"
          title={t('relations.openComponentSource')} onClick={() => onOpen(item.source_file, 1)}>
          {item.source_file.split('/').at(-1)}
        </button>}
      </div>)}
    </>}
  </section>;
}

/** Loads source YAML only when explicitly expanded, avoiding expensive reads
 * for every catalogue selection. Displays declarations, not a final merged value. */
function SourceContributions({
  selected, workspaceKey, onOpen,
}: {
  selected: PrototypeIdentity;
  workspaceKey: string;
  onOpen: Props['onOpen'];
}) {
  const { t } = useI18n();
  const [report, setReport] = useState<PrototypeSourceReport | null>(null);
  const [failure, setFailure] = useState<StudioError | null>(null);
  const [busy, setBusy] = useState(true);

  useEffect(() => {
    let active = true;
    setBusy(true);
    setReport(null);
    setFailure(null);
    void studio.prototypeSources(selected.kind, selected.id).then((value) => {
      if (active) setReport(value);
    }).catch((reason: unknown) => {
      if (active) setFailure(normalizeStudioError(reason));
    }).finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [selected.kind, selected.id, workspaceKey]);

  return <div className="proto-source-report" aria-label={t('relations.sourcesLabel')}>
    {busy && <p className="muted" role="status">{t('relations.sourcesLoading')}</p>}
    {failure && <div role="alert" className="proto-error">
      <strong>{failure.message}</strong><p>{failure.hint}</p><code>{failure.code}</code>
    </div>}
    {report && <>
      <p className="proto-relations-caveat">
        {t('relations.sourceCaveat')}
        {!report.ancestry_complete && t('relations.sourcesUncertain')}
        {report.truncated && t('relations.sourcesLimited')}
      </p>
      {report.warnings.map((warning, i) => <p key={i} className="proto-relations-caveat">{warning}</p>)}
      {!report.items.length && <p className="muted">{t('relations.noSources')}</p>}
      {report.items.map((item, i) => <div className="proto-source-card"
        key={item.file + ':' + item.line + ':' + item.id + ':' + i}>
        <div className="proto-source-head">
          <button type="button" className="proto-definition-link"
            onClick={() => onOpen(item.file, item.line)}>
            {item.id} · {item.file.split('/').at(-1)}:{item.line}
          </button>
          <small>{t('relations.level', { depth: item.depth, mode: item.mode })}
            {item.partial_order !== null ? ' · partial index ' + item.partial_order : ''}
          </small>
        </div>
        {item.notice && <p className="proto-relations-caveat">{item.notice}</p>}
        {item.fields.length > 0 && <div className="proto-source-tags">
          <strong>{t('relations.fields')}</strong>{item.fields.map((field) =>
            <code key={field}>{field}</code>)}
        </div>}
        {item.components.length > 0 && <div className="proto-source-tags">
          <strong>{t('relations.components')}</strong>{item.components.map((name, index) =>
            <code key={index}>{name}</code>)}
        </div>}
        {item.notice === null && !item.fields.length && !item.components.length
          && <small>{t('relations.noOtherSources')}</small>}
      </div>)}
    </>}
  </div>;
}

export default function PrototypeRelationsPanel({
  selected, workspaceKey, onClose, onNavigate, onOpen,
}: Props) {
  const { t } = useI18n();
  const [details, setDetails] = useState<PrototypeRelations | null>(null);
  const [error, setError] = useState<StudioError | null>(null);
  const [loading, setLoading] = useState(false);
  const [showSources, setShowSources] = useState(false);
  const [showPartial, setShowPartial] = useState(false);
  const [showInheritance, setShowInheritance] = useState(false);
  const [showLinked, setShowLinked] = useState(false);

  useEffect(() => {
    let active = true;
    setDetails(null);
    setError(null);
    setLoading(true);
    void studio.prototypeRelations(selected.kind, selected.id).then((value) => {
      if (active) setDetails(value);
    }).catch((reason: unknown) => {
      if (active) setError(normalizeStudioError(reason));
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [selected.kind, selected.id, workspaceKey]);

  return <section className="proto-relations" aria-label={t('relations.label', { kind: selected.kind, id: selected.id })}>
    <div className="proto-relations-heading">
      <span><GitBranch size={15}/> {selected.id} <small>({selected.kind})</small></span>
      <button type="button" aria-label={t('relations.close')} onClick={onClose}><X size={15}/></button>
    </div>
    {loading && <p className="muted" role="status">{t('relations.loading')}</p>}
    {error && <div role="alert" className="proto-error">
      <span><AlertCircle size={14}/> {error.message}</span>
      <p>{error.hint}</p>
    </div>}
    {details && <div className="proto-relations-body">
      <p className="proto-relations-caveat">
        {t('relations.caveat')}
        {!details.index_complete && t('relations.indexIncomplete')}
      </p>
      <section className="proto-relation-group">
        <strong>{t('relations.declarations', { count: details.declarations.length })}</strong>
        {[...details.declarations].sort((a, b) => {
          const aOrder = a.mode === 'normal' ? -1 : a.partial_order ?? Number.MAX_SAFE_INTEGER;
          const bOrder = b.mode === 'normal' ? -1 : b.partial_order ?? Number.MAX_SAFE_INTEGER;
          return aOrder - bOrder || a.file.localeCompare(b.file) || a.line - b.line;
        }).map((item) => <button type="button"
          className="proto-definition-link" key={item.file + ':' + item.document_index + ':' + item.item_index + ':' + (item.variant_index ?? 'base')}
          onClick={() => onOpen(item.file, item.line)}>
          {item.file.split('/').at(-1)}:{item.line} — {item.mode}
          {item.partial_order !== null ? ' (partial index ' + item.partial_order + ')' : ''}
          {item.parent_tag ? ' · parent: ' + item.parent_tag : ''}
        </button>)}
      </section>
      <RelationItems title={t('relations.parents')} items={details.parents} total={details.parent_total}
        onNavigate={onNavigate} onOpen={onOpen}/>
      <AncestorItems items={details.ancestors} complete={details.ancestry_complete}
        truncated={details.ancestry_truncated} onNavigate={onNavigate} onOpen={onOpen}/>
      <section className="proto-relation-group">
        <button type="button" className="prototype-relations-trigger"
          aria-expanded={showInheritance} onClick={() => setShowInheritance((value) => !value)}>
          {showInheritance ? t('relations.hideInheritance') : t('relations.showInheritance')}
        </button>
        {showInheritance && <InheritancePreviewPanel kind={selected.kind} id={selected.id}
          workspaceKey={workspaceKey} onNavigate={onNavigate} onOpen={onOpen}/>}
      </section>
      <section className="proto-relation-group">
        <button type="button" className="prototype-relations-trigger"
          aria-expanded={showPartial} onClick={() => setShowPartial((value) => !value)}>
          {showPartial ? t('relations.hidePartial') : t('relations.showPartial')}
        </button>
        {showPartial && <PartialOverlayPreview selected={selected}
          workspaceKey={workspaceKey} onOpen={onOpen}/>}
      </section>
      <section className="proto-relation-group">
        <button type="button" className="prototype-relations-trigger"
          aria-expanded={showSources} onClick={() => setShowSources((value) => !value)}>
          {showSources ? t('relations.hideSources') : t('relations.showSources')}
        </button>
        {showSources && <SourceContributions selected={selected}
          workspaceKey={workspaceKey} onOpen={onOpen}/>}
      </section>
      <section className="proto-relation-group">
        <button type="button" className="prototype-relations-trigger"
          aria-expanded={showLinked} onClick={() => setShowLinked((value) => !value)}>
          {showLinked ? t('relations.hideLinked') : t('relations.showLinked')}
        </button>
        {showLinked && <LinkedPrototypePanel kind={selected.kind} id={selected.id}
          workspaceKey={workspaceKey} onNavigate={onNavigate}/>}
      </section>
      <RelationItems title={t('relations.children')} items={details.children} total={details.child_total}
        onNavigate={onNavigate} onOpen={onOpen}/>
    </div>}
  </section>;
}

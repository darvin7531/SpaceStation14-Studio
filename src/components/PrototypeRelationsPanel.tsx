import { useEffect, useState } from 'react';
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

const statusLabel: Record<PrototypeRelationLink['status'], string> = {
  defined: 'Объявлен',
  partial_only: 'Только partial',
  ambiguous: 'Несколько базовых объявлений',
  not_indexed: 'Нет в индексе',
  tagged: 'YAML-тег: точная связь неизвестна',
};

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
  return <section className="proto-relation-group">
    <strong>{title} ({total})</strong>
    {total === 0 && <p className="muted">Ссылок нет.</p>}
    {items.map((link, index) => <div className="proto-relation-row"
      key={link.id + ':' + link.file + ':' + link.line + ':' + index}>
      <button type="button" className="proto-relation-link"
        title={'Найти ' + link.kind + ':' + link.id}
        onClick={() => onNavigate(link.kind, link.id)}>
        {link.id}
      </button>
      <span title={statusLabel[link.status]}>{statusLabel[link.status]}</span>
      <button type="button" className="proto-relation-source"
        title={'Открыть ' + link.file + ':' + link.line}
        onClick={() => onOpen(link.file, link.line)}>
        {link.file.split('/').at(-1)}:{link.line}
      </button>
      {link.source_mode !== 'normal' && <small>Источник: {link.source_mode}</small>}
    </div>)}
    {total > items.length && <small className="proto-relation-more">
      Показаны первые {items.length} ссылок из {total}. Полный индекс остаётся в Rust.
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
  return <section className="proto-relation-group proto-ancestor-group">
    <strong>Цепочка предков ({items.length}{truncated ? '+' : ''})</strong>
    <p className="proto-relations-caveat">
      {complete
        ? 'Все предки по прямым обычным parent-ссылкам найдены. Это не объединение полей движком.'
        : 'Цепочка содержит неопределённости: partial-правки, теги, отсутствующие/дублирующиеся определения, циклы либо неполный индекс. Отдельные partial-ветви показаны, но не разворачиваются.'}
      {truncated && ' Достигнут предел: 200 связей или 32 уровня.'}
    </p>
    {items.length === 0 && <p className="muted">У обычного объявления нет обнаруженных предков.</p>}
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
        {entry.status !== 'defined' && <span className="proto-ancestor-state">{statusLabel[entry.status]}</span>}
        {entry.source_mode !== 'normal' && <span className="proto-ancestor-state">
          {entry.source_mode} (неопределённая ветвь)
        </span>}
        {entry.partial_sources > 0 && <span className="proto-ancestor-state">
          partial-источников: {entry.partial_sources}
        </span>}
        {entry.cycle && <span className="proto-ancestor-state">Цикл</span>}
        {!entry.cycle && entry.repeated && <small>Уже встречался</small>}
      </div>
      <div className="proto-ancestor-sources">
        <button type="button" className="proto-relation-source" onClick={() =>
          onOpen(entry.source_file, entry.source_line)}>
          parent в {entry.source_file.split('/').at(-1)}:{entry.source_line}
        </button>
        {entry.definition_file && <button type="button" className="proto-relation-source"
          onClick={() => onOpen(entry.definition_file!, entry.definition_line ?? 1)}>
          объявление: {entry.definition_file.split('/').at(-1)}:{entry.definition_line ?? '?'}
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

  return <section className="proto-source-report" aria-label="Предпросмотр PartialPrototypes">
    {busy && <p className="muted" role="status">Вычисляю partial-операции без записи на диск…</p>}
    {failure && <div role="alert" className="proto-error">
      <strong>{failure.message}</strong><p>{failure.hint}</p><code>{failure.code}</code>
    </div>}
    {report && <>
      <p className="proto-relations-caveat">
        {report.exact
          ? 'Статические partial-операции исходного прототипа применены; наследование от parent и C# DataField ещё не вычислены.'
          : 'Неполный расчёт. Часть правил, исходников или порядка применения не подтверждена. Не считайте показанные значения финальными.'}
        {' '}Применено partial-объявлений: {report.applied_partials}.
      </p>
      {report.warnings.map((warning, i) => <p key={i} className="proto-source-warning">{warning}</p>)}
      <div className="proto-source-tags">
        <strong>Parent после partial:</strong>
        {report.parents.length ? report.parents.map((parent, index) => <code key={index}>{parent}</code>)
          : <small>Не задан</small>}
      </div>
      <strong className="proto-source-label">Поля после partial ({report.fields.length})</strong>
      {!report.fields.length && <p className="muted">Нет доступных статических полей.</p>}
      {report.fields.map((item) => <div className="proto-merged-row" key={item.key}>
        <strong>{item.key}</strong>
        <span>{item.preview}</span>
        {item.source_file && <button className="proto-relation-source" type="button"
          title="Открыть последний источник изменения ключа" onClick={() => onOpen(item.source_file, 1)}>
          {item.source_file.split('/').at(-1)}
        </button>}
      </div>)}
      <strong className="proto-source-label">Компоненты после partial ({report.components.length})</strong>
      {report.components.map((item) => <div className="proto-merged-row" key={item.type_name}>
        <strong>{item.type_name}</strong>
        <span>{item.keys.length ? item.keys.join(', ') : 'Без явных полей'}</span>
        {item.source_file && <button className="proto-relation-source" type="button"
          title="Открыть последний источник изменения компонента" onClick={() => onOpen(item.source_file, 1)}>
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

  return <div className="proto-source-report" aria-label="Источники полей и компонентов">
    {busy && <p className="muted" role="status">Читаю исходные YAML для анализа происхождения…</p>}
    {failure && <div role="alert" className="proto-error">
      <strong>{failure.message}</strong><p>{failure.hint}</p><code>{failure.code}</code>
    </div>}
    {report && <>
      <p className="proto-relations-caveat">
        Это только явно объявленные ключи и type компонентов. Не вычисляются
        переопределения, YAML-теги, partial-операции и значения после наследования.
        {!report.ancestry_complete && ' Есть неоднозначные источники или ошибки чтения.'}
        {report.truncated && ' Обзор ограничен: не все источники показаны.'}
      </p>
      {report.warnings.map((warning, i) => <p key={i} className="proto-relations-caveat">{warning}</p>)}
      {!report.items.length && <p className="muted">Подходящие объявления не найдены.</p>}
      {report.items.map((item, i) => <div className="proto-source-card"
        key={item.file + ':' + item.line + ':' + item.id + ':' + i}>
        <div className="proto-source-head">
          <button type="button" className="proto-definition-link"
            onClick={() => onOpen(item.file, item.line)}>
            {item.id} · {item.file.split('/').at(-1)}:{item.line}
          </button>
          <small>Уровень {item.depth} · {item.mode}
            {item.partial_order !== null ? ' · partial index ' + item.partial_order : ''}
          </small>
        </div>
        {item.notice && <p className="proto-relations-caveat">{item.notice}</p>}
        {item.fields.length > 0 && <div className="proto-source-tags">
          <strong>Поля:</strong>{item.fields.map((field) =>
            <code key={field}>{field}</code>)}
        </div>}
        {item.components.length > 0 && <div className="proto-source-tags">
          <strong>Компоненты:</strong>{item.components.map((name, index) =>
            <code key={index}>{name}</code>)}
        </div>}
        {item.notice === null && !item.fields.length && !item.components.length
          && <small>Других ключей и компонентов не объявлено.</small>}
      </div>)}
    </>}
  </div>;
}

export default function PrototypeRelationsPanel({
  selected, workspaceKey, onClose, onNavigate, onOpen,
}: Props) {
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

  return <section className="proto-relations" aria-label={'Связи ' + selected.kind + ':' + selected.id}>
    <div className="proto-relations-heading">
      <span><GitBranch size={15}/> {selected.id} <small>({selected.kind})</small></span>
      <button type="button" aria-label="Закрыть сведения о связях" onClick={onClose}><X size={15}/></button>
    </div>
    {loading && <p className="muted" role="status">Получаю связи из Rust-индекса…</p>}
    {error && <div role="alert" className="proto-error">
      <span><AlertCircle size={14}/> {error.message}</span>
      <p>{error.hint}</p>
    </div>}
    {details && <div className="proto-relations-body">
      <p className="proto-relations-caveat">
        Прямые ссылки из YAML, не вычисленный результат наследования RobustToolbox.
        {!details.index_complete && ' Индекс неполный: некоторые файлы не удалось разобрать.'}
      </p>
      <section className="proto-relation-group">
        <strong>Объявления ({details.declarations.length})</strong>
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
      <RelationItems title="Родители" items={details.parents} total={details.parent_total}
        onNavigate={onNavigate} onOpen={onOpen}/>
      <AncestorItems items={details.ancestors} complete={details.ancestry_complete}
        truncated={details.ancestry_truncated} onNavigate={onNavigate} onOpen={onOpen}/>
      <section className="proto-relation-group">
        <button type="button" className="prototype-relations-trigger"
          aria-expanded={showInheritance} onClick={() => setShowInheritance((value) => !value)}>
          {showInheritance ? 'Скрыть структурное наследование' : 'Вычислить структурное наследование + partial'}
        </button>
        {showInheritance && <InheritancePreviewPanel kind={selected.kind} id={selected.id}
          workspaceKey={workspaceKey} onNavigate={onNavigate} onOpen={onOpen}/>}
      </section>
      <section className="proto-relation-group">
        <button type="button" className="prototype-relations-trigger"
          aria-expanded={showPartial} onClick={() => setShowPartial((value) => !value)}>
          {showPartial ? 'Скрыть PartialPrototypes' : 'Вычислить PartialPrototypes'}
        </button>
        {showPartial && <PartialOverlayPreview selected={selected}
          workspaceKey={workspaceKey} onOpen={onOpen}/>}
      </section>
      <section className="proto-relation-group">
        <button type="button" className="prototype-relations-trigger"
          aria-expanded={showSources} onClick={() => setShowSources((value) => !value)}>
          {showSources ? 'Скрыть происхождение полей и компонентов' : 'Показать происхождение полей и компонентов'}
        </button>
        {showSources && <SourceContributions selected={selected}
          workspaceKey={workspaceKey} onOpen={onOpen}/>}
      </section>
      <section className="proto-relation-group">
        <button type="button" className="prototype-relations-trigger"
          aria-expanded={showLinked} onClick={() => setShowLinked((value) => !value)}>
          {showLinked ? 'Скрыть связанные прототипы' : 'Связанные прототипы'}
        </button>
        {showLinked && <LinkedPrototypePanel kind={selected.kind} id={selected.id}
          workspaceKey={workspaceKey} onNavigate={onNavigate}/>}
      </section>
      <RelationItems title="Потомки" items={details.children} total={details.child_total}
        onNavigate={onNavigate} onOpen={onOpen}/>
    </div>}
  </section>;
}

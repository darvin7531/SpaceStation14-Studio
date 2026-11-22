import { useEffect, useState } from 'react';
import { AlertCircle, GitBranch, X } from 'lucide-react';
import { studio, type PrototypeAncestor, type PrototypeRelationLink, type PrototypeRelations } from '../lib/api';
import { normalizeStudioError, type StudioError } from '../lib/errors';

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

export default function PrototypeRelationsPanel({
  selected, workspaceKey, onClose, onNavigate, onOpen,
}: Props) {
  const [details, setDetails] = useState<PrototypeRelations | null>(null);
  const [error, setError] = useState<StudioError | null>(null);
  const [loading, setLoading] = useState(false);

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
      <RelationItems title="Потомки" items={details.children} total={details.child_total}
        onNavigate={onNavigate} onOpen={onOpen}/>
    </div>}
  </section>;
}

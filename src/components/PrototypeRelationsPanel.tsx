import { useEffect, useState } from 'react';
import { AlertCircle, GitBranch, X } from 'lucide-react';
import { studio, type PrototypeRelationLink, type PrototypeRelations } from '../lib/api';
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
        {details.declarations.map((item) => <button type="button"
          className="proto-definition-link" key={item.file + ':' + item.document_index + ':' + item.item_index}
          onClick={() => onOpen(item.file, item.line)}>
          {item.file.split('/').at(-1)}:{item.line} — {item.mode}
        </button>)}
      </section>
      <RelationItems title="Родители" items={details.parents} total={details.parent_total}
        onNavigate={onNavigate} onOpen={onOpen}/>
      <RelationItems title="Потомки" items={details.children} total={details.child_total}
        onNavigate={onNavigate} onOpen={onOpen}/>
    </div>}
  </section>;
}

import { useEffect, useState } from 'react';
import { AlertCircle, ArrowUpRight, FileCode2, GitBranch, Image, Layers, Search } from 'lucide-react';
import {
  studio, type PrototypeDeclaration, type SourceOutline,
} from '../lib/api';
import { normalizeStudioError, type StudioError } from '../lib/errors';

type EditorPanel = 'fields' | 'components' | 'localization' | 'parents';

interface Props {
  path: string;
  source: string;
  busy: boolean;
  onJump: (line: number) => void;
  onEdit: (declaration: PrototypeDeclaration, panel: EditorPanel) => void;
  onOpenRsi: (path: string, state: string | null) => void;
}

/** Parses the currently visible YAML draft, not the last saved catalog copy. */
export default function PrototypeOutlinePanel({
  path, source, busy, onJump, onEdit, onOpenRsi,
}: Props) {
  const [snapshot, setSnapshot] = useState<{ path: string; source: string; outline: SourceOutline } | null>(null);
  const [failure, setFailure] = useState<StudioError | null>(null);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setFailure(null);
    const timer = window.setTimeout(() => {
      void studio.inspectYamlOutline(path, source)
        .then((outline) => {
          if (active) setSnapshot({ path, source, outline });
        })
        .catch((error) => {
          if (active) setFailure(normalizeStudioError(error));
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    }, 220);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [path, source]);

  const outline = snapshot?.path === path && snapshot.source === source
    ? snapshot.outline : null;
  const declarations = outline?.declarations ?? [];
  const filtered = declarations.filter(({ declaration }) => {
    const needle = query.trim().toLocaleLowerCase();
    return !needle || (declaration.kind + ' ' + declaration.id).toLocaleLowerCase().includes(needle);
  });
  const selected = declarations.find(({ declaration }) =>
    selectedKey === declaration.document_index + ':' + declaration.item_index + ':' + (declaration.variant_index ?? 'base'),
  ) ?? null;
  // Source forms rely on one normal, unambiguous YAML document and do not
  // guess PartialPrototypes merge semantics or rewrite generated IDs.
  const formsAvailable = declarations.length > 0
    && declarations.every(({ declaration }) => declaration.document_index === 1 && declaration.mode === 'normal');
  const editable = Boolean(selected && formsAvailable && selected.declaration.variant_index === null);
  const visualLine = (line: number) => line > 0 ? line : 1;

  return <section className="prototype-outline" aria-label="Инспектор открытого YAML">
    <div className="prototype-outline-top">
      <strong><Layers size={15}/> Прототипы в файле</strong>
      <span>{outline ? declarations.length : '…'} объявлений · черновик</span>
      {loading && <small>Разбор YAML…</small>}
    </div>
    <label className="prototype-outline-filter">
      <Search size={14}/>
      <input value={query} placeholder="Найти ID или тип в файле"
        onChange={(event) => setQuery(event.target.value)}
        aria-label="Найти прототип в текущем файле"/>
    </label>
    {failure && <p role="alert" className="prototype-outline-error">
      <AlertCircle size={14}/>{failure.message} {failure.hint} [{failure.code}]
    </p>}
    {outline && <>
      {outline.truncated && <p className="prototype-outline-warning">
        Список ограничен 256 объявлениями и 64 диагностическими сообщениями. Для полного поиска используйте каталог.
      </p>}
      {outline.diagnostics.slice(0, 5).map((diagnostic, index) =>
        <button type="button" className="prototype-outline-issue"
          key={diagnostic.code + ':' + diagnostic.line + ':' + index}
          onClick={() => onJump(visualLine(diagnostic.line))}>
          <AlertCircle size={13}/> {diagnostic.message} {diagnostic.line > 0 ? '(строка ' + diagnostic.line + ')' : ''}
        </button>)}
      {declarations.length === 0 && <p className="muted">
        {outline.diagnostics.length ? 'Исправьте YAML, чтобы увидеть объявления.' : 'В файле пока нет объявлений прототипов.'}
      </p>}
      <div className="prototype-outline-list">
        {filtered.map(({ declaration }) => {
          const key = declaration.document_index + ':' + declaration.item_index + ':' + (declaration.variant_index ?? 'base');
          return <button key={key} type="button" onClick={() => { setSelectedKey(key); onJump(visualLine(declaration.line)); }}
            className={'prototype-outline-item' + (selectedKey === key ? ' active' : '')}
            title={'Строка ' + declaration.line + ' · ' + declaration.file}>
            <FileCode2 size={14}/>
            <span><b>{declaration.id}</b><small>{declaration.kind}
              {declaration.mode !== 'normal' ? ' · ' + declaration.mode : ''}
              {declaration.variant_index !== null ? ' · вариант ' + (declaration.variant_index + 1) : ''}
            </small></span>
            <span className="prototype-outline-line">:{declaration.line}</span>
          </button>;
        })}
      </div>
      {selected && <div className="prototype-outline-detail">
        <div className="prototype-outline-detail-heading">
          <strong>{selected.declaration.kind}:{selected.declaration.id}</strong>
          {selected.declaration.abstract_prototype && <small>abstract</small>}
        </div>
        {selected.declaration.parents.length > 0 && <p>
          <GitBranch size={13}/> Прямые родители: {selected.declaration.parents.join(', ')}
        </p>}
        {selected.sprite && <div className="prototype-outline-sprite">
          <Image size={14}/>
          <div><strong>Sprite: {selected.sprite.path.split('/').at(-1)}</strong>
            <small>{selected.sprite.state ? 'Состояние: ' + selected.sprite.state : 'Состояние не указано'}
              {!selected.sprite.indexed && ' · RSI не найден в индексе'}</small>
          </div>
          <button type="button" disabled={!selected.sprite.indexed || busy}
            title="Открыть существующий RSI в редакторе"
            onClick={() => onOpenRsi(selected.sprite!.path, selected.sprite!.state)}>
            <ArrowUpRight size={14}/> Открыть
          </button>
        </div>}
        <div className="prototype-outline-actions">
          {editable ? <>
            <button type="button" disabled={busy} onClick={() => onEdit(selected.declaration, 'fields')}>Поля</button>
            <button type="button" disabled={busy} onClick={() => onEdit(selected.declaration, 'parents')}>Родители</button>
            {selected.declaration.kind === 'entity' && <>
              <button type="button" disabled={busy} onClick={() => onEdit(selected.declaration, 'components')}>Компоненты</button>
              <button type="button" disabled={busy} onClick={() => onEdit(selected.declaration, 'localization')}>Локализация</button>
            </>}
          </> : <small>Сложные, partial и генерируемые объявления доступны для навигации, но не для автоматических форм.</small>}
        </div>
        <small className="prototype-outline-footnote">Показаны только прямые поля исходного YAML, не итоговое наследование RobustToolbox.</small>
      </div>}
    </>}
  </section>;
}

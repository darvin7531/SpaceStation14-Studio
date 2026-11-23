import { useEffect, useState } from 'react';
import { AlertCircle, FileCode2, GitBranch, Layers, Search } from 'lucide-react';
import {
  studio, type EntityLocalizationAnalysis, type PrototypeDeclaration, type SourceOutline, type SourceOutlineEntry, type PrototypeInheritancePreview,
} from '../lib/api';
import { normalizeStudioError, type StudioError } from '../lib/errors';
import SpriteLayerInspector from './SpriteLayerInspector';
import LinkedPrototypePanel from './LinkedPrototypePanel';
import InheritancePreviewPanel from './InheritancePreviewPanel';
import { missingLocaleFiles } from '../lib/localization-navigation';
import { outlineDeclarationKey, outlineKeyAtLine } from '../lib/outline-selection';
import { prototypeNotice } from '../lib/prototype-notices';
import { useI18n } from '../i18n';

type EditorPanel = 'fields' | 'components' | 'localization' | 'parents';

interface Props {
  path: string;
  source: string;
  busy: boolean;
  onJump: (line: number) => void;
  onEdit: (declaration: PrototypeDeclaration, panel: EditorPanel) => void;
  onOpenRsi: (path: string, state: string | null) => void;
  onOpenFtl: (path: string) => void;
  requiredLocales: readonly string[];
  liveValidation: boolean;
  validationDelay: number;
  cursorLine: number | null;
  prototypeJump: { key: string; line: number; token: number } | null;
  workspaceKey: string;
  sourceDirty: boolean;
  onNavigatePrototype: (kind: string, id: string) => void;
  onOpenSource: (file: string, line: number) => void;
}

/** Electron parity: live missing-locale diagnostics for the selected normal entity.
 * Never infers a runtime fallback and never writes without an explicit user action.
 */
function SelectedEntityLocaleStatus({
  declaration, source, requiredLocales, enabled, delayMs, busy, onRepair, onOpenFtl,
}: {
  declaration: PrototypeDeclaration;
  source: string;
  requiredLocales: readonly string[];
  enabled: boolean;
  delayMs: number;
  busy: boolean;
  onRepair: () => void;
  onOpenFtl: (path: string) => void;
}) {
  const [report, setReport] = useState<EntityLocalizationAnalysis | null>(null);
  const [failure, setFailure] = useState<StudioError | null>(null);
  const [requested, setRequested] = useState(0);
  const localesKey = requiredLocales.join('\u0000');
  const shouldRun = enabled || requested > 0;
  useEffect(() => {
    if (!shouldRun) return;
    let live = true;
    setReport(null);
    setFailure(null);
    const timer = window.setTimeout(() => {
      void studio.analyzeEntityLocalization(declaration, source, [...requiredLocales])
        .then((value) => {
          if (live) setReport(value);
        }).catch((reason) => {
          if (live) setFailure(normalizeStudioError(reason));
        });
    }, enabled ? delayMs : 0);
    return () => { live = false; window.clearTimeout(timer); };
  }, [
    declaration.file, declaration.kind, declaration.id,
    declaration.document_index, declaration.item_index, declaration.mode,
    source, localesKey, enabled, delayMs, requested, shouldRun,
  ]);
  return <div className="prototype-entity-locale-status" aria-live="polite">
    <strong>Игровые локализации ({requiredLocales.join(', ')})</strong>
    {!enabled && <button type="button" disabled={busy}
      onClick={() => setRequested((count) => count + 1)}>Проверить переводы</button>}
    {!shouldRun ? <small>Автоматическая проверка отключена в настройках редактора.</small>
      : failure ? <small role="alert">Не удалось проверить: {failure.message} [{failure.code}]</small>
        : !report ? <small>Проверяю существующие FTL…</small>
          : !report.complete ? <small role="alert">Неполный индекс локалей: {report.warnings.join(' ')}</small>
            : report.diagnostics.length === 0 ? <small>Пропущенных переводов явных полей не найдено.</small>
              : <div>
                <small>Отсутствуют: {report.diagnostics.map((issue) =>
                  issue.field + ' (' + issue.missing_locales.join(', ') + ')').join('; ')}</small>
                <button type="button" disabled={busy} onClick={onRepair}>Исправить локализацию</button>
                <div className="prototype-outline-actions" aria-label="Открыть существующий FTL">
                  {missingLocaleFiles(report).map((target) => <button type="button"
                    disabled={busy} key={target.locale + ':' + target.path}
                    title={target.path} onClick={() => onOpenFtl(target.path)}>
                    Открыть {target.locale} · {target.path.split('/').at(-1)}
                  </button>)}
                </div>
              </div>}
  </div>;
}

function InheritedSpriteInspector({ entry, workspaceKey, busy, onOpenRsi, onOpenSource }: {
  entry: SourceOutlineEntry; workspaceKey: string; busy: boolean;
  onOpenRsi: (path: string, state: string | null) => void;
  onOpenSource: (file: string, line: number) => void;
}) {
  const { language } = useI18n();
  const [report, setReport] = useState<PrototypeInheritancePreview | null>(null);
  const [failure, setFailure] = useState<StudioError | null>(null);
  useEffect(() => {
    let active = true;
    setReport(null); setFailure(null);
    void studio.prototypeInheritancePreview(entry.declaration.kind, entry.declaration.id)
      .then((value) => { if (active) setReport(value); })
      .catch((error: unknown) => { if (active) setFailure(normalizeStudioError(error)); });
    return () => { active = false; };
  }, [entry.declaration.kind, entry.declaration.id, workspaceKey]);
  const projection = report?.sprite;
  return <>
    {!report && !failure && <p role="status">Загрузка структурного Sprite…</p>}
    {failure && <p role="alert">Не удалось разрешить Sprite: {failure.message} [{failure.code}]</p>}
    {report && <>
      <p className="prototype-outline-warning">Структурный Sprite из сохранённых источников; не итоговая композиция игры.
        {!report.structural_complete && ' Цепочка неоднозначна или неполна — результат приблизителен.'}</p>
      {report.warnings.map((warning, index) => <p className="prototype-outline-warning" key={index}>{prototypeNotice(language, warning)}</p>)}
      {projection?.source && <button type="button" onClick={() => onOpenSource(projection.source!.file, projection.source!.line)}>
        Последний источник компонента: {projection.source.file}:{projection.source.line}
      </button>}
      {projection && <SpriteLayerInspector sprite={projection.sprite} layers={projection.layers}
        total={projection.layers_total} busy={busy} onOpenRsi={onOpenRsi}/>}
    </>}
  </>;
}

/** Parses the currently visible YAML draft, not the last saved catalog copy. */
export default function PrototypeOutlinePanel({
  path, source, busy, onJump, onEdit, onOpenRsi, onOpenFtl,
  requiredLocales, liveValidation, validationDelay, cursorLine, prototypeJump,
  workspaceKey, sourceDirty, onNavigatePrototype, onOpenSource,
}: Props) {
  const [snapshot, setSnapshot] = useState<{ path: string; source: string; outline: SourceOutline } | null>(null);
  const [failure, setFailure] = useState<StudioError | null>(null);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [manualSelection, setManualSelection] = useState<{ key: string; line: number } | null>(null);
  const [showLinked, setShowLinked] = useState(false);
  const [showInheritance, setShowInheritance] = useState(false);

  useEffect(() => {
    setManualSelection(prototypeJump ? { key: prototypeJump.key, line: prototypeJump.line } : null);
  }, [prototypeJump]);

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
  const cursorSelection = outlineKeyAtLine(declarations, cursorLine);
  const selectedKey = manualSelection && manualSelection.line === cursorLine
    ? manualSelection.key : cursorSelection;
  const selected = declarations.find(({ declaration }) =>
    selectedKey === outlineDeclarationKey(declaration),
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
          const key = outlineDeclarationKey(declaration);
          return <button key={key} type="button" onClick={() => {
            setManualSelection({ key, line: declaration.line });
            onJump(visualLine(declaration.line));
          }}
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
        {!sourceDirty && selected.declaration.kind === 'entity' && selected.declaration.mode === 'normal'
          && selected.declaration.variant_index === null && selected.declaration.parents.length > 0
          ? <InheritedSpriteInspector key={outlineDeclarationKey(selected.declaration)} entry={selected}
              workspaceKey={workspaceKey} busy={busy} onOpenRsi={onOpenRsi} onOpenSource={onOpenSource}/>
          : <>{sourceDirty && selected.declaration.parents.length > 0 && <p className="prototype-outline-warning">
              Сохраните YAML для просмотра унаследованного Sprite; сейчас показан только черновик.
            </p>}
            {(selected.sprite || selected.sprite_layers.length > 0) && <SpriteLayerInspector
              key={outlineDeclarationKey(selected.declaration)} sprite={selected.sprite} layers={selected.sprite_layers}
              total={selected.sprite_layers_total} busy={busy} onOpenRsi={onOpenRsi}/>}</>}
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
        <div className="prototype-outline-actions" aria-label="Разделы инспектора Electron">
          <button type="button" className="prototype-relations-trigger"
            aria-expanded={showLinked} onClick={() => setShowLinked((value) => !value)}>
            {showLinked ? 'Скрыть связанные прототипы' : 'Связанные прототипы'}
          </button>
          <button type="button" className="prototype-relations-trigger"
            aria-expanded={showInheritance} onClick={() => setShowInheritance((value) => !value)}>
            {showInheritance ? 'Скрыть наследование' : 'Наследование'}
          </button>
        </div>
        {(showLinked || showInheritance) && sourceDirty && <p className="prototype-outline-warning">
          В YAML есть несохранённые изменения. Связи и наследование берутся из Rust-индекса
          сохранённого проекта; сохраните черновик, чтобы увидеть актуальный результат.
        </p>}
        {!sourceDirty && showLinked && <LinkedPrototypePanel
          key={selected.declaration.kind + ':' + selected.declaration.id}
          kind={selected.declaration.kind} id={selected.declaration.id}
          workspaceKey={workspaceKey}
          onNavigate={onNavigatePrototype}/>}
        {!sourceDirty && showInheritance && <InheritancePreviewPanel
          key={selected.declaration.kind + ':' + selected.declaration.id}
          kind={selected.declaration.kind} id={selected.declaration.id}
          workspaceKey={workspaceKey}
          onNavigate={onNavigatePrototype} onOpen={onOpenSource}/>}
        {editable && selected.declaration.kind === 'entity' && <SelectedEntityLocaleStatus
          declaration={selected.declaration} source={source} requiredLocales={requiredLocales}
          enabled={liveValidation} delayMs={validationDelay} busy={busy}
          onRepair={() => onEdit(selected.declaration, 'localization')}
          onOpenFtl={onOpenFtl}/>}
        <small className="prototype-outline-footnote">Показаны только прямые поля исходного YAML, не итоговое наследование RobustToolbox.</small>
      </div>}
    </>}
  </section>;
}

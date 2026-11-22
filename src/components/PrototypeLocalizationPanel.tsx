import { useEffect, useState } from 'react';
import { AlertTriangle, Languages, RefreshCw, X } from 'lucide-react';
import { studio, type EntityLocalizationSource, type EntityLocalizationAnalysis, type PrototypeFieldLocator, type ResourceDocument, type ResourceEntry } from '../lib/api';
import { buildEntityLocalePatch, type EntityLocaleField, type EntityLocalePatch } from '../lib/entity-localization';
import { normalizeStudioError, type StudioError } from '../lib/errors';
import { localeFromFtlPath, localeResourceSearch } from '../lib/localization-settings';

interface Props {
  locator: PrototypeFieldLocator;
  source: string;
  busy: boolean;
  requiredLocales: readonly string[];
  onApply: (file: string, original: ResourceDocument, content: string) => Promise<boolean>;
  onClose: () => void;
}

const FIELDS: { field: EntityLocaleField; label: string }[] = [
  { field: 'name', label: 'name → основное значение' },
  { field: 'description', label: 'description → .desc' },
  { field: 'suffix', label: 'suffix → .suffix' },
];

export default function PrototypeLocalizationPanel({ locator, source, busy, requiredLocales, onApply, onClose }: Props) {
  const [entity, setEntity] = useState<EntityLocalizationSource | null>(null);
  const [analysis, setAnalysis] = useState<EntityLocalizationAnalysis | null>(null);
  const [files, setFiles] = useState<ResourceEntry[]>([]);
  const [fileTotal, setFileTotal] = useState(0);
  const [search, setSearch] = useState('');
  const [target, setTarget] = useState('');
  const [selected, setSelected] = useState<EntityLocaleField[]>(['name', 'description', 'suffix']);
  const [preview, setPreview] = useState<{ baseline: ResourceDocument; patch: EntityLocalePatch; sourceSnapshot: string } | null>(null);
  const [reading, setReading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<StudioError | null>(null);
  const [notice, setNotice] = useState('');

  useEffect(() => {
    let live = true;
    setEntity(null);
    setAnalysis(null);
    setPreview(null);
    setError(null);
    void Promise.all([
      studio.inspectEntityLocalization(locator, source),
      studio.analyzeEntityLocalization(locator, source, [...requiredLocales]),
    ]).then(([result, report]) => {
      if (!live) return;
      setEntity(result);
      setAnalysis(report);
    }).catch((failure) => {
      if (live) setError(normalizeStudioError(failure));
    });
    return () => { live = false; };
  }, [locator, source, requiredLocales]);

  useEffect(() => {
    let live = true;
    const timer = window.setTimeout(() => {
      void studio.searchResources(search, 'ftl', 0, 100).then((result) => {
        if (!live) return;
        setFiles(result.items);
        setFileTotal(result.total);
      }).catch((failure) => {
        if (live) setError(normalizeStudioError(failure));
      });
    }, 160);
    return () => { live = false; window.clearTimeout(timer); };
  }, [search]);

  const chosen = selected.filter((field) => entity?.[field]?.trim());
  const disabled = busy || applying || reading || !entity;

  async function inspectTarget() {
    if (!entity || !target || chosen.length === 0 || disabled) return;
    setReading(true);
    setError(null);
    setPreview(null);
    try {
      // The old Electron implementation could create duplicate IDs in separate FTLs.
      // Check the indexed locale before editing, refusing incomplete scans instead of guessing.
      const matches = await studio.searchResourceContent(entity.localization_id, 'ftl');
      if (!matches.complete) {
        throw new Error('Проверка Fluent-файлов неполная. Обновите или сузьте проект и проверьте существующие ID вручную.');
      }
      const localeRoot = target.split('/').slice(0, 3).join('/') + '/';
      const otherDefinition = matches.items.find((hit) => hit.path !== target
        && hit.path.startsWith(localeRoot)
        && new RegExp('^' + entity.localization_id + '[ \t]*=').test(hit.preview));
      if (otherDefinition) {
        throw new Error('Fluent ID уже объявлен в ' + otherDefinition.path
          + ':' + otherDefinition.line + '. Выберите этот файл вместо создания дубликата.');
      }
      const baseline = await studio.readResource(target);
      if (baseline.path !== target) throw new Error('Выбранный Fluent-файл изменился. Повторите выбор.');
      const patch = buildEntityLocalePatch(baseline.content, entity, chosen);
      setPreview({ baseline, patch, sourceSnapshot: source });
      setNotice(patch.changed ? 'Предпросмотр готов. Существующие значения не заменяются.' : 'Выбранные поля уже присутствуют в FTL.');
    } catch (failure) {
      setError(normalizeStudioError(failure));
    } finally {
      setReading(false);
    }
  }

  async function save() {
    if (!preview || !preview.patch.changed || disabled || !target || preview.baseline.path !== target || preview.sourceSnapshot !== source) return;
    setApplying(true);
    setError(null);
    try {
      const success = await onApply(target, preview.baseline, preview.patch.content);
      if (!success) return;
      setPreview(null);
      setNotice('Fluent обновлён. Файл открыт для проверки.');
    } catch (failure) {
      setError(normalizeStudioError(failure));
    } finally {
      setApplying(false);
    }
  }

  return <section className="prototype-field-editor entity-locale-panel" aria-label={'Локализация ' + locator.id}>
    <header>
      <div><strong><Languages size={15}/> Локализация entity:{locator.id}</strong>
        <small>{locator.file} · только выбранное объявление YAML</small>
      </div>
      <button type="button" title="Закрыть" aria-label="Закрыть" onClick={onClose}><X size={16}/></button>
    </header>
    {error && <div className="prototype-field-error" role="alert">
      <AlertTriangle size={15}/><span>{error.message} {error.hint} <code>{error.code}</code></span>
    </div>}
    {!entity ? <p className="prototype-field-notice"><RefreshCw size={14}/> Проверка YAML…</p> : <>
      <p className="prototype-field-notice">
        Fluent ID: <code>{entity.localization_id}</code>. Берутся только явно заданные поля,
        без предположений о наследовании и fallback локалей.
      </p>
      {analysis && <div className="entity-locale-status" aria-live="polite">
        <strong>Проверка игровых локалей</strong>
        {!analysis.complete ? <p role="alert">Проверка неполная: отсутствующие переводы не считаются подтверждёнными.
          {analysis.warnings.map((warning) => <span key={warning}>{warning} </span>)}</p>
          : analysis.diagnostics.length === 0 ? <p>В выбранных локалях нет пропусков для явно заданных полей entity.</p>
          : <div>
            <p>Отсутствуют переводы:</p>
            {analysis.diagnostics.map((issue) => <div key={issue.field}>
              <strong>{issue.field}</strong>: {issue.missing_locales.join(', ')}
              {issue.targets.filter((target) => issue.missing_locales.includes(target.locale)).map((target) =>
                target.file_exists ? <button type="button" key={target.locale} disabled={disabled}
                  onClick={() => {
                    setSearch(localeResourceSearch(target.locale));
                    setTarget(target.path);
                    setSelected([issue.field]);
                    setPreview(null);
                  }}>Исправить {target.locale}</button>
                  : <small key={target.locale}> {target.locale}: файл {target.path} отсутствует — создайте FTL в мастере локализаций.</small>)}
            </div>)}
          </div>}
      </div>}
      <div className="entity-locale-fields">
        {FIELDS.map(({ field, label }) => <label key={field}>
          <input type="checkbox" checked={selected.includes(field)}
            disabled={disabled || !entity[field]}
            onChange={(event) => {
              setSelected((current) => event.target.checked
                ? [...current, field] : current.filter((candidate) => candidate !== field));
              setPreview(null);
            }}/>
          <span>{label} — <code>{entity[field] || 'нет значения в YAML'}</code></span>
        </label>)}
      </div>
      <div className="entity-locale-shortcuts">
        <small>Локали проекта для проверки: </small>
        {requiredLocales.map((locale) => <button type="button" key={locale}
          disabled={disabled} onClick={() => { setSearch(localeResourceSearch(locale)); setTarget(''); setPreview(null); }}>
          {locale}</button>)}
        <button type="button" disabled={disabled}
          onClick={() => { setSearch(''); setTarget(''); setPreview(null); }}>Все FTL</button>
      </div>
      <label className="entity-locale-filter">Поиск существующего FTL-файла
        <input type="search" placeholder="имя файла или путь в Resources/Locale…"
          value={search} onChange={(event) => { setSearch(event.target.value); setPreview(null); }}/>
      </label>
      <label className="entity-locale-filter">Назначение ({fileTotal} найдено, показано до 100)
        <select value={target} disabled={disabled}
          onChange={(event) => { setTarget(event.target.value); setPreview(null); setError(null); }}>
          <option value="">Выберите FTL в текущем проекте</option>
          {target && !files.some((entry) => entry.path === target)
            && <option value={target}>{target}</option>}
          {files.map((entry) => <option key={entry.path} value={entry.path}>{entry.path}</option>)}
        </select>
        {target && <small>Локаль выбранного файла: {localeFromFtlPath(target) ?? 'не определена'}.
          Переводы вне списка обязательных локалей тоже можно редактировать.</small>}
      </label>
      {preview && <div className="entity-locale-preview">
        <strong>Предпросмотр:</strong>
        <small>Добавится: {preview.patch.added.join(', ') || 'ничего'}.
          Уже есть: {preview.patch.alreadyPresent.join(', ') || 'нет'}.</small>
        <pre>{preview.patch.content === preview.baseline.content ? 'Без изменений'
          : preview.patch.content.slice(-3500)}</pre>
      </div>}
      <div className="prototype-field-actions">
        <small>{notice || 'Новые ключи добавляются только в выбранный FTL; при изменении файла запись отклоняется.'}</small>
        <button type="button" disabled={disabled || !target || chosen.length === 0} onClick={() => void inspectTarget()}>
          <RefreshCw size={14}/>{reading ? 'Проверка…' : 'Предпросмотр FTL'}
        </button>
        <button type="button" disabled={disabled || !preview?.patch.changed || preview?.sourceSnapshot !== source}
          onClick={() => void save()}>
          <Languages size={14}/>{applying ? 'Запись…' : 'Записать FTL'}
        </button>
      </div>
    </>}
  </section>;
}

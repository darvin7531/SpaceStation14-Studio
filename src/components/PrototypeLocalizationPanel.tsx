import { useEffect, useState } from 'react';
import { AlertTriangle, Languages, RefreshCw, X } from 'lucide-react';
import { studio, type EntityLocalizationSource, type PrototypeFieldLocator, type ResourceDocument, type ResourceEntry } from '../lib/api';
import { buildEntityLocalePatch, type EntityLocaleField, type EntityLocalePatch } from '../lib/entity-localization';
import { normalizeStudioError, type StudioError } from '../lib/errors';

interface Props {
  locator: PrototypeFieldLocator;
  source: string;
  busy: boolean;
  onApply: (file: string, original: ResourceDocument, content: string) => Promise<boolean>;
  onClose: () => void;
}

const FIELDS: { field: EntityLocaleField; label: string }[] = [
  { field: 'name', label: 'name → основное значение' },
  { field: 'description', label: 'description → .desc' },
  { field: 'suffix', label: 'suffix → .suffix' },
];

export default function PrototypeLocalizationPanel({ locator, source, busy, onApply, onClose }: Props) {
  const [entity, setEntity] = useState<EntityLocalizationSource | null>(null);
  const [files, setFiles] = useState<ResourceEntry[]>([]);
  const [fileTotal, setFileTotal] = useState(0);
  const [search, setSearch] = useState('');
  const [target, setTarget] = useState('');
  const [selected, setSelected] = useState<EntityLocaleField[]>(['name', 'description', 'suffix']);
  const [preview, setPreview] = useState<{ baseline: ResourceDocument; patch: EntityLocalePatch } | null>(null);
  const [reading, setReading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<StudioError | null>(null);
  const [notice, setNotice] = useState('');

  useEffect(() => {
    let live = true;
    setEntity(null);
    setPreview(null);
    setError(null);
    void studio.inspectEntityLocalization(locator, source).then((result) => {
      if (live) setEntity(result);
    }).catch((failure) => {
      if (live) setError(normalizeStudioError(failure));
    });
    return () => { live = false; };
  }, [locator, source]);

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
      const baseline = await studio.readResource(target);
      if (baseline.path !== target) throw new Error('Выбранный Fluent-файл изменился. Повторите выбор.');
      const patch = buildEntityLocalePatch(baseline.content, entity, chosen);
      setPreview({ baseline, patch });
      setNotice(patch.changed ? 'Предпросмотр готов. Существующие значения не заменяются.' : 'Выбранные поля уже присутствуют в FTL.');
    } catch (failure) {
      setError(normalizeStudioError(failure));
    } finally {
      setReading(false);
    }
  }

  async function save() {
    if (!preview || !preview.patch.changed || disabled || !target || preview.baseline.path !== target) return;
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
        <button type="button" disabled={disabled || !preview?.patch.changed}
          onClick={() => void save()}>
          <Languages size={14}/>{applying ? 'Запись…' : 'Записать FTL'}
        </button>
      </div>
    </>}
  </section>;
}

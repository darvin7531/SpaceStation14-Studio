import { useEffect, useState, type FormEvent } from 'react';
import { AlertTriangle, FilePenLine, RefreshCw, X } from 'lucide-react';
import { studio, type PrototypeFieldLocator, type PrototypeFields } from '../lib/api';
import { normalizeStudioError, type StudioError } from '../lib/errors';

interface Props {
  locator: PrototypeFieldLocator;
  source: string;
  busy: boolean;
  onApply: (locator: PrototypeFieldLocator, original: string, changed: string) => boolean;
  onClose: () => void;
}

export default function PrototypeFieldsPanel({ locator, source, busy, onApply, onClose }: Props) {
  const [fields, setFields] = useState<PrototypeFields | null>(null);
  const [original, setOriginal] = useState<PrototypeFields | null>(null);
  const [inspecting, setInspecting] = useState(true);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<StudioError | null>(null);
  const [notice, setNotice] = useState('');
  const [revisionToken, setRevisionToken] = useState(0);

  useEffect(() => {
    let active = true;
    setInspecting(true);
    setFields(null);
    setOriginal(null);
    setError(null);
    const timer = window.setTimeout(() => {
      void studio.inspectPrototypeFields(locator, source)
        .then((result) => {
          if (!active) return;
          setOriginal(result.fields);
          setFields(result.fields);
          setNotice(result.notice);
        })
        .catch((failure) => {
          if (active) setError(normalizeStudioError(failure));
        })
        .finally(() => {
          if (active) setInspecting(false);
        });
    }, 170);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [locator, source, revisionToken]);

  function update<K extends keyof PrototypeFields>(field: K, value: PrototypeFields[K]) {
    setFields((current) => current ? { ...current, [field]: value } : current);
    setError(null);
  }

  async function apply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!fields || !original || inspecting || applying || busy) return;
    setApplying(true);
    setError(null);
    const sourceSnapshot = source;
    try {
      const updated = await studio.patchPrototypeFields(locator, sourceSnapshot, fields);
      if (!updated.changed) {
        setNotice('Изменений нет. Исходный YAML не затронут.');
        return;
      }
      if (onApply(locator, sourceSnapshot, updated.content)) {
        setNotice('Поля применены к несохранённому черновику. Нажмите Ctrl+S для записи YAML.');
        setRevisionToken((value) => value + 1);
      } else {
        setError({
          code: 'FIELDS_EDITOR_CHANGED',
          message: 'Текст YAML изменился, пока форма готовила правки.',
          hint: 'Обновите форму и повторите изменение. Новые правки не применялись.',
        });
      }
    } catch (failure) {
      setError(normalizeStudioError(failure));
    } finally {
      setApplying(false);
    }
  }

  const pending = fields && original && (
    fields.name !== original.name
    || fields.description !== original.description
    || fields.parent !== original.parent
    || fields.abstract_prototype !== original.abstract_prototype
  );
  const disabled = Boolean(busy || inspecting || applying || !fields);

  return <section className="prototype-field-editor" aria-label={'Поля прототипа ' + locator.kind + ':' + locator.id}>
    <header>
      <div>
        <strong><FilePenLine size={15}/> {locator.kind}:{locator.id}</strong>
        <small>{locator.file} · документ {locator.document_index} · элемент {locator.item_index}</small>
      </div>
      <button type="button" disabled={applying} title="Закрыть форму" aria-label="Закрыть форму" onClick={onClose}><X size={16}/></button>
    </header>
    {inspecting && <p className="prototype-field-notice"><RefreshCw size={14}/> Чтение полей YAML…</p>}
    {error && <div className="prototype-field-error" role="alert">
      <AlertTriangle size={15}/>
      <span>{error.message} {error.hint} <code>{error.code}</code></span>
    </div>}
    <form onSubmit={(event) => void apply(event)}>
      <div className="prototype-field-grid">
        <label>Имя (name)
          <input type="text" value={fields?.name ?? ''} disabled={disabled}
            onChange={(event) => update('name', event.target.value)}/>
        </label>
        <label>Родитель (parent, один ID)
          <input type="text" value={fields?.parent ?? ''} disabled={disabled}
            spellCheck={false} onChange={(event) => update('parent', event.target.value)}/>
        </label>
        <label className="prototype-field-wide">Описание (description)
          <textarea rows={2} value={fields?.description ?? ''} disabled={disabled}
            onChange={(event) => update('description', event.target.value)}/>
        </label>
        <label className="prototype-field-abstract">
          <input type="checkbox" checked={fields?.abstract_prototype ?? false} disabled={disabled}
            onChange={(event) => update('abstract_prototype', event.target.checked)}/>
          Абстрактный прототип
        </label>
      </div>
      <div className="prototype-field-actions">
        <small>{notice}</small>
        <button type="button" disabled={disabled} onClick={() => setRevisionToken((x) => x + 1)}>
          <RefreshCw size={14}/> Сбросить поля
        </button>
        <button type="submit" disabled={disabled || !pending}>
          <FilePenLine size={14}/>{applying ? 'Применение…' : 'Применить к черновику'}
        </button>
      </div>
    </form>
  </section>;
}

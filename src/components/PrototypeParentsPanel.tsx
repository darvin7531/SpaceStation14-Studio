import { useEffect, useState, type FormEvent } from 'react';
import { AlertTriangle, GitBranch, RefreshCw, X } from 'lucide-react';
import { studio, type PrototypeFieldLocator } from '../lib/api';
import { normalizeStudioError, type StudioError } from '../lib/errors';

interface Props {
  locator: PrototypeFieldLocator;
  source: string;
  busy: boolean;
  onApply: (locator: PrototypeFieldLocator, original: string, changed: string) => boolean;
  onClose: () => void;
}

/** One line per explicit parent ID; never resolves or guesses inherited content. */
export default function PrototypeParentsPanel({ locator, source, busy, onApply, onClose }: Props) {
  const [original, setOriginal] = useState<string[] | null>(null);
  const [text, setText] = useState('');
  const [reading, setReading] = useState(true);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<StudioError | null>(null);
  const [notice, setNotice] = useState('');
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    let live = true;
    setReading(true);
    setError(null);
    setOriginal(null);
    const timer = window.setTimeout(() => {
      void studio.inspectPrototypeParents(locator, source)
        .then((result) => {
          if (!live) return;
          setOriginal(result.parents);
          setText(result.parents.join('\n'));
          setNotice(result.notice);
        })
        .catch((failure) => {
          if (live) setError(normalizeStudioError(failure));
        })
        .finally(() => {
          if (live) setReading(false);
        });
    }, 150);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [locator, source, refresh]);

  const requested = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const changed = original && (original.length !== requested.length
    || original.some((id, index) => id !== requested[index]));
  const disabled = busy || reading || applying || original === null;

  async function apply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled || !changed) return;
    setApplying(true);
    setError(null);
    const snapshot = source;
    try {
      const patch = await studio.patchPrototypeParents(locator, snapshot, requested);
      if (!patch.changed) {
        setNotice('Список родителей не изменился.');
        return;
      }
      if (onApply(locator, snapshot, patch.content)) {
        setNotice('Список родителей изменён в черновике YAML. Сохраните файл Ctrl+S.');
        setRefresh((current) => current + 1);
      } else {
        setError({
          code: 'PARENT_DRAFT_CHANGED',
          message: 'Исходный YAML изменился во время подготовки правки.',
          hint: 'Повторно откройте список родителей. Результат не применён.',
        });
      }
    } catch (failure) {
      setError(normalizeStudioError(failure));
    } finally {
      setApplying(false);
    }
  }

  return <section className="prototype-field-editor" aria-label={'Родители ' + locator.kind + ':' + locator.id}>
    <header>
      <div>
        <strong><GitBranch size={15}/> Родители {locator.kind}:{locator.id}</strong>
        <small>{locator.file} · прямые связи, без наследуемых значений</small>
      </div>
      <button type="button" disabled={applying} onClick={onClose} aria-label="Закрыть редактор родителей">
        <X size={16}/>
      </button>
    </header>
    {reading && <p className="prototype-field-notice"><RefreshCw size={14}/> Проверяю YAML-объявление…</p>}
    {error && <div className="prototype-field-error" role="alert">
      <AlertTriangle size={15}/><span>{error.message} {error.hint} <code>{error.code}</code></span>
    </div>}
    <form onSubmit={(event) => void apply(event)}>
      <div className="prototype-field-grid">
        <label className="prototype-field-wide">Прямые родители (по одному ID на строку)
          <textarea rows={Math.min(10, Math.max(3, requested.length + 1))}
            spellCheck={false} value={text} disabled={disabled} placeholder={'BaseItem\nBaseStructure'}
            onChange={(event) => { setText(event.target.value); setError(null); }}/>
        </label>
      </div>
      <p className="prototype-field-notice">
        Один ID станет обычным parent. Несколько ID будут записаны YAML-списком.
        Пустой список удалит поле parent. Порядок родителей сохраняется.
      </p>
      <div className="prototype-field-actions">
        <small>{notice}</small>
        <button type="button" disabled={disabled} onClick={() => setRefresh((current) => current + 1)}>
          <RefreshCw size={14}/> Сбросить
        </button>
        <button type="submit" disabled={disabled || !changed}>
          <GitBranch size={14}/>{applying ? 'Применение…' : 'Применить к черновику'}
        </button>
      </div>
    </form>
  </section>;
}

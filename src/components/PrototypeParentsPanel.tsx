import { prototypeNotice } from '../lib/prototype-notices';
import { useEffect, useState, type FormEvent } from 'react';
import { useI18n } from '../i18n';
import { AlertTriangle, GitBranch, RefreshCw, X } from 'lucide-react';
import { studio, type PrototypeNotice, type PrototypeFieldLocator } from '../lib/api';
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
  const { t, language } = useI18n();
  const [original, setOriginal] = useState<string[] | null>(null);
  const [text, setText] = useState('');
  const [reading, setReading] = useState(true);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<StudioError | null>(null);
  const [notice, setNotice] = useState<PrototypeNotice>('');
  const [noticeKey, setNoticeKey] = useState<'parents.unchanged' | 'parents.applied' | null>(null);
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
          setNoticeKey(null);
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
        setNoticeKey('parents.unchanged');
        return;
      }
      if (onApply(locator, snapshot, patch.content)) {
        setNoticeKey('parents.applied');
        setRefresh((current) => current + 1);
      } else {
        setError({
          code: 'PARENT_DRAFT_CHANGED',
          message: t('parents.changed'),
          hint: t('parents.retry'),
        });
      }
    } catch (failure) {
      setError(normalizeStudioError(failure));
    } finally {
      setApplying(false);
    }
  }

  return <section className="prototype-field-editor" aria-label={t('parents.label', { kind: locator.kind, id: locator.id })}>
    <header>
      <div>
        <strong><GitBranch size={15}/> {t('parents.label', { kind: locator.kind, id: locator.id })}</strong>
        <small>{t('parents.description', { file: locator.file })}</small>
      </div>
      <button type="button" disabled={applying} onClick={onClose} aria-label={t('parents.close')}>
        <X size={16}/>
      </button>
    </header>
    {reading && <p className="prototype-field-notice"><RefreshCw size={14}/> {t('parents.loading')}</p>}
    {error && <div className="prototype-field-error" role="alert">
      <AlertTriangle size={15}/><span>{error.message} {error.hint} <code>{error.code}</code></span>
    </div>}
    <form onSubmit={(event) => void apply(event)}>
      <div className="prototype-field-grid">
        <label className="prototype-field-wide">{t('parents.input')}
          <textarea rows={Math.min(10, Math.max(3, requested.length + 1))}
            spellCheck={false} value={text} disabled={disabled} placeholder={'BaseItem\nBaseStructure'}
            onChange={(event) => { setText(event.target.value); setError(null); }}/>
        </label>
      </div>
      <p className="prototype-field-notice">
        {t('parents.help')}
      </p>
      <div className="prototype-field-actions">
        <small>{noticeKey ? t(noticeKey) : prototypeNotice(language, notice)}</small>
        <button type="button" disabled={disabled} onClick={() => setRefresh((current) => current + 1)}>
          <RefreshCw size={14}/> {t('parents.reset')}
        </button>
        <button type="submit" disabled={disabled || !changed}>
          <GitBranch size={14}/>{applying ? t('parents.applying') : t('parents.apply')}
        </button>
      </div>
    </form>
  </section>;
}

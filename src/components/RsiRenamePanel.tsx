import { useI18n } from '../i18n';
import { useState, type FormEvent } from 'react';
import { AlertTriangle, Pencil } from 'lucide-react';
import { studio, type RenamedRsiState } from '../lib/api';
import { normalizeStudioError, type StudioError } from '../lib/errors';
import { rsiErrorText } from '../lib/rsi-error-text';

interface Props {
  path: string;
  revision: string;
  name: string;
  expectedPngRevision?: string;
  expectedMissingPng?: boolean;
  onRenamed: (result: RenamedRsiState) => void;
}

export default function RsiRenamePanel({
  path, revision, name, expectedPngRevision, expectedMissingPng = false, onRenamed,
}: Props) {
  const { t, language } = useI18n();
  const [nextName, setNextName] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<StudioError | null>(null);
  const validName = /^[a-z0-9_-]{1,128}$/.test(name) && /^[a-z0-9_-]{1,128}$/.test(nextName) && nextName !== name;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!validName || confirmation !== name || saving) return;
    setSaving(true);
    setError(null);
    try {
      const result = await studio.renameRsiState({
        path,
        expected_revision: revision,
        expected_png_revision: expectedPngRevision ?? null,
        expected_missing_png: expectedMissingPng,
        old_name: name,
        new_name: nextName,
      });
      onRenamed(result);
    } catch (failure) {
      setError(normalizeStudioError(failure));
    } finally {
      setSaving(false);
    }
  }

  return <details className="rsi-import-panel">
    <summary><Pencil size={15}/> {t('rsi.rename.title', { name })}</summary>
    <form onSubmit={(event) => void submit(event)}>
      <p>{t(expectedMissingPng ? 'rsi.rename.missingIntro' : 'rsi.rename.intro')}</p>
      <p className="rsi-warning"><AlertTriangle size={15}/>{t('rsi.rename.warning', { name })}</p>
      <div className="rsi-import-fields">
        <label>{t('rsi.rename.name')}
          <input type="text" required maxLength={128} pattern="[a-z0-9_-]+"
            value={nextName} autoComplete="off" spellCheck={false} disabled={saving}
            onChange={(event) => setNextName(event.target.value)} placeholder="idle_new"/>
        </label>
        <label>{t('rsi.rename.confirm', { name })}
          <input type="text" required value={confirmation} disabled={saving}
            autoComplete="off" spellCheck={false}
            onChange={(event) => setConfirmation(event.target.value)} placeholder={name}/>
        </label>
      </div>
      {error && <div className="rsi-error" role="alert">
        <AlertTriangle size={16}/>
        <span>{rsiErrorText(error, language)} <code>{error.code}</code></span>
        {language === 'en' && <details><summary>{t('app.errorDetails')}</summary><pre>{error.message} {error.hint}{error.details && `\n${error.details}`}</pre></details>}
        {language === 'ru' && error.details && <pre>{error.details}</pre>}
      </div>}
      <button type="submit" disabled={saving || !validName || confirmation !== name}>
        <Pencil size={15}/>{saving ? t('rsi.rename.busy') : t('rsi.rename.submit')}
      </button>
    </form>
  </details>;
}

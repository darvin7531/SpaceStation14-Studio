import { useState, type FormEvent } from 'react';
import { FileSignature, AlertCircle } from 'lucide-react';
import { studio, type ImportedRsiState } from '../lib/api';
import { normalizeStudioError, type StudioError } from '../lib/errors';

interface Props {
  path: string;
  revision: string;
  metadata: string;
  onSaved: (result: ImportedRsiState) => void;
}

function creditsFromMetadata(source: string): { license: string; copyright: string } | null {
  try {
    const value: unknown = JSON.parse(source);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const object = value as Record<string, unknown>;
    if (object.version !== 1 || !Array.isArray(object.states)
      || !object.size || typeof object.size !== 'object'
      || (object.license !== undefined && typeof object.license !== 'string')
      || (object.copyright !== undefined && typeof object.copyright !== 'string')) return null;
    return {
      license: typeof object.license === 'string' ? object.license : '',
      copyright: typeof object.copyright === 'string' ? object.copyright : '',
    };
  } catch {
    return null;
  }
}

export default function RsiCreditsPanel({ path, revision, metadata, onSaved }: Props) {
  const original = creditsFromMetadata(metadata);
  const [license, setLicense] = useState(original?.license ?? '');
  const [copyright, setCopyright] = useState(original?.copyright ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<StudioError | null>(null);
  const dirty = original && (license !== original.license || copyright !== original.copyright);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!dirty || saving || !original) return;
    setError(null);
    if (new TextEncoder().encode(license).length > 128 || /[\x00-\x1f\x7f]/.test(license)
      || new TextEncoder().encode(copyright).length > 8192 || copyright.includes('\0')) {
      setError({
        code: 'RSI_CREDITS_INVALID',
        message: 'Лицензия или авторство не соответствуют ограничениям.',
        hint: 'Лицензия до 128 байт без управляющих символов; авторство до 8 КиБ.',
      });
      return;
    }
    setSaving(true);
    try {
      onSaved(await studio.updateRsiCredits({
        path, expected_revision: revision, license, copyright,
      }));
    } catch (failure) {
      setError(normalizeStudioError(failure));
    } finally {
      setSaving(false);
    }
  }

  return <details className="rsi-credits-panel">
    <summary><FileSignature size={15}/> Лицензия и авторство RSI</summary>
    {!original ? <p>Редактирование метаданных недоступно: требуется корректный RSI v1.</p>
      : <form onSubmit={(event) => void submit(event)}>
        <p>Меняет только <code>license</code> и <code>copyright</code> в meta.json.
          Состояния и PNG останутся без изменений. Размер кадра изменяется отдельно от изображений и здесь заблокирован.</p>
        <div className="rsi-credits-fields">
          <label>Лицензия
            <input type="text" value={license} maxLength={128} disabled={saving}
              onChange={(event) => setLicense(event.target.value)} placeholder="CC-BY-SA-3.0"/>
          </label>
          <label>Авторство
            <textarea value={copyright} rows={3} disabled={saving}
              onChange={(event) => setCopyright(event.target.value)}
              placeholder="Автор, источник и условия использования"/>
          </label>
        </div>
        {error && <div className="rsi-error" role="alert">
          <AlertCircle size={16}/><span><strong>{error.message}</strong> {error.hint}
            <code>{error.code}</code></span>
        </div>}
        <button type="submit" disabled={!dirty || saving}>
          {saving ? 'Сохраняю…' : 'Сохранить метаданные'}
        </button>
      </form>}
  </details>;
}

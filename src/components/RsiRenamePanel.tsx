import { useState, type FormEvent } from 'react';
import { AlertTriangle, Pencil } from 'lucide-react';
import { studio, type RenamedRsiState } from '../lib/api';
import { normalizeStudioError, type StudioError } from '../lib/errors';

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
    <summary><Pencil size={15}/> Переименовать состояние «{name}»</summary>
    <form onSubmit={(event) => void submit(event)}>
      {expectedMissingPng ? <p>Studio сохранит резервную копию <code>meta.json</code> и изменит имя состояния. PNG не изменяются; архив восстанавливается вручную. Остановите внешние процессы записи до завершения операции: они не блокируются и могут создать PNG со старым или новым именем после проверки, изменив связь состояния с изображением.</p> : <p>Studio создаст резервную копию <code>meta.json</code> и исходного PNG,
        затем создаст PNG с новым именем и изменит только поле <code>name</code>
        выбранного состояния. Другие состояния, тайминги и изображения сохраняются.</p>}
      <p className="rsi-warning"><AlertTriangle size={15}/>
        Ссылки на состояние «{name}» в других YAML, коде и ресурсах автоматически
        не переписываются. После переименования проверьте их вручную.</p>
      <div className="rsi-import-fields">
        <label>Новое имя состояния
          <input type="text" required maxLength={128} pattern="[a-z0-9_-]+"
            value={nextName} autoComplete="off" spellCheck={false} disabled={saving}
            onChange={(event) => setNextName(event.target.value)} placeholder="idle_new"/>
        </label>
        <label>Подтверждение: введите «{name}»
          <input type="text" required value={confirmation} disabled={saving}
            autoComplete="off" spellCheck={false}
            onChange={(event) => setConfirmation(event.target.value)} placeholder={name}/>
        </label>
      </div>
      {error && <div className="rsi-error" role="alert">
        <AlertTriangle size={16}/>
        <span>{error.message} {error.hint} <code>{error.code}</code></span>
      </div>}
      <button type="submit" disabled={saving || !validName || confirmation !== name}>
        <Pencil size={15}/>{saving ? 'Переименовываю…' : 'Переименовать с резервной копией'}
      </button>
    </form>
  </details>;
}

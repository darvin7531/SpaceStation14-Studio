import { useState, type FormEvent } from 'react';
import { AlertTriangle, Trash2 } from 'lucide-react';
import { studio, type DeletedRsiState } from '../lib/api';
import { normalizeStudioError, type StudioError } from '../lib/errors';

interface Props {
  path: string;
  revision: string;
  name: string;
  expectedMissingPng?: boolean;
  onDeleted: (result: DeletedRsiState) => void;
}

/** Intentional, name-confirmed deletion; backups are never silently removed. */
export default function RsiDeletePanel({ path, revision, name, expectedMissingPng = false, onDeleted }: Props) {
  const [confirmation, setConfirmation] = useState('');
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<StudioError | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (confirmation !== name || removing) return;
    setRemoving(true);
    setError(null);
    try {
      const result = await studio.deleteRsiState({
        path, expected_revision: revision, name, expected_missing_png: expectedMissingPng,
      });
      onDeleted(result);
    } catch (failure) {
      setError(normalizeStudioError(failure));
    } finally {
      setRemoving(false);
    }
  }

  return <details className="rsi-delete-panel">
    <summary><Trash2 size={15}/> Убрать состояние «{name}» из RSI</summary>
    <form onSubmit={(event) => void submit(event)}>
      <p><AlertTriangle size={16}/>
        {expectedMissingPng
          ? 'Studio сохранит meta.json в архив и удалит только запись состояния. PNG не проверяется и не удаляется, даже если он уже существует или появится извне. Восстановление архива — только вручную.'
          : 'Studio сохранит meta.json и PNG в архив, затем удалит запись и PNG при совпадении контрольной суммы. Внешний процесс может изменить PNG между проверкой и удалением.'}
        <code> .ss14-studio-archive</code>
      </p>
      <label>Введите точное имя <strong>{name}</strong> для подтверждения
        <input type="text" autoComplete="off" spellCheck={false}
          value={confirmation} disabled={removing}
          onChange={(event) => setConfirmation(event.target.value)}
          placeholder={name}/>
      </label>
      {error && <p role="alert" className="rsi-error">
        <AlertTriangle size={15}/> {error.message} {error.hint}
        <code>{error.code}</code>
      </p>}
      <button type="submit" disabled={confirmation !== name || removing}>
        <Trash2 size={14}/>{removing ? 'Архивирую…' : 'Архивировать и убрать состояние'}
      </button>
    </form>
  </details>;
}

import { useState, type FormEvent } from 'react';
import { AlertTriangle, Trash2 } from 'lucide-react';
import { studio, type DeletedRsiState } from '../lib/api';
import { normalizeStudioError, type StudioError } from '../lib/errors';

interface Props {
  path: string;
  revision: string;
  name: string;
  onDeleted: (result: DeletedRsiState) => void;
}

/** Intentional, name-confirmed deletion; backups are never silently removed. */
export default function RsiDeletePanel({ path, revision, name, onDeleted }: Props) {
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
        path, expected_revision: revision, name,
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
        Studio предварительно сохранит исходные PNG и meta.json в скрытую папку
        <code> .ss14-studio-archive</code> внутри RSI.
        После этого состояние будет исключено из meta.json, а оригинальный PNG удалён
        только при совпадении контрольной суммы.
      </p>
      <p>Это не корзина ОС. Восстановить удалённое состояние можно в панели
        архивов ниже, если его имя и PNG ещё не заняты.
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

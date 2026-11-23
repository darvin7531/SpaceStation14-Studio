import { useEffect, useState, type FormEvent } from 'react';
import { AlertTriangle, RotateCcw } from 'lucide-react';
import { studio, type RestoredRsiState, type RsiArchive, type RsiArchiveList } from '../lib/api';
import { normalizeStudioError, type StudioError } from '../lib/errors';

interface Props {
  path: string;
  revision: string;
  onRestored: (result: RestoredRsiState) => void;
}

export function RsiArchiveAction({ path, selected, saving, confirmation, onConfirmation }: {
  path: string; selected: RsiArchive | null; saving: boolean; confirmation: string;
  onConfirmation: (value: string) => void;
}) {
  if (selected && !selected.automatic_restore) return <p className="rsi-warning">
    Только ручное восстановление. Архив: <code>{path}/.ss14-studio-archive/{selected.id}/meta.json.before</code>
  </p>;
  return <>
    <p className="rsi-restore-warning"><AlertTriangle size={15}/> Если в каталоге уже есть PNG или состояние с таким именем,
      восстановление будет отклонено. Файлы не перезаписываются.</p>
    <label>Введите имя <strong>{selected?.state ?? ''}</strong> для подтверждения
      <input type="text" spellCheck={false} autoComplete="off" disabled={saving} value={confirmation}
        onChange={(event) => onConfirmation(event.target.value)}/>
    </label>
    <button type="submit" disabled={!selected || confirmation !== selected.state || saving}>
      <RotateCcw size={14}/>{saving ? 'Восстанавливаю…' : 'Восстановить состояние'}
    </button>
  </>;
}

/** Archive IDs are returned by Rust: callers never construct paths. */
export default function RsiRestorePanel({ path, revision, onRestored }: Props) {
  const [list, setList] = useState<RsiArchiveList | null>(null);
  const [listError, setListError] = useState<StudioError | null>(null);
  const [error, setError] = useState<StudioError | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [id, setId] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const selected = list?.archives.find((entry) => entry.id === id) ?? null;

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    setListError(null);
    setConfirmation('');
    void studio.listRsiArchives(path).then((result) => {
      if (!active) return;
      setList(result);
      setId((previous) =>
        result.archives.some((entry) => entry.id === previous)
          ? previous : (result.archives[0]?.id ?? ''));
    }).catch((failure: unknown) => {
      if (active) {
        setList(null);
        setListError(normalizeStudioError(failure));
      }
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [path, revision]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected?.automatic_restore || confirmation !== selected.state || saving) return;
    setSaving(true);
    setError(null);
    try {
      const restored = await studio.restoreRsiState({
        path, expected_revision: revision, archive_id: selected.id,
      });
      onRestored(restored);
    } catch (failure) {
      setError(normalizeStudioError(failure));
    } finally {
      setSaving(false);
    }
  }

  return <details className="rsi-restore-panel">
    <summary><RotateCcw size={15}/> Восстановить состояние из архива
      {list && <span> · {list.archives.length}</span>}
    </summary>
    <form onSubmit={(event) => void submit(event)}>
      <p>Восстановление добавляет исходное состояние в текущий <code>meta.json</code>
        и создаёт его PNG заново, если он был в архиве. Другие состояния и последующие изменения метаданных
        сохраняются. Архив остаётся на диске. Архивы без PNG восстанавливаются только вручную: остановите внешние изменения и проверьте PNG. Переносите запись из архивного meta.json.before в текущий meta.json только если в обоих файлах version равен 1, size совпадает, в архиве ровно одна запись с этим именем, а в текущем файле её нет. Иначе не переносите запись. При отмене переименования не переносите архивную запись без изменений: сначала сравните её с текущей записью под новым именем и согласуйте все последующие изменения, сохранив нужные данные в восстановленной записи. Проверьте оба PNG; не удаляйте и не заменяйте текущую запись или файлы, пока изменения не сохранены и не согласованы. При неоднозначности остановитесь и сделайте резервную копию. Не заменяйте meta.json целиком.</p>
      {loading && <p>Чтение резервных копий…</p>}
      {listError && <p role="alert" className="rsi-error">
        <AlertTriangle size={15}/>{listError.message} {listError.hint}
      </p>}
      {list?.warnings.map((warning, index) =>
        <p key={index} className="rsi-warning">{warning}</p>)}
      {!loading && list && list.archives.length === 0 &&
        <p>В этом RSI пока нет резервных копий, созданных Studio.</p>}
      {list && list.archives.length > 0 && <>
        <label>Архивная копия
          <select value={id} disabled={saving} aria-label="Архив RSI для восстановления"
            onChange={(event) => {
              setId(event.target.value);
              setConfirmation('');
              setError(null);
            }}>
            {list.archives.map((entry) => <option value={entry.id} key={entry.id}>
              {entry.state} · {entry.id}{!entry.automatic_restore && ' · только вручную'}
            </option>)}
          </select>
        </label>
        <RsiArchiveAction path={path} selected={selected} saving={saving}
          confirmation={confirmation} onConfirmation={setConfirmation}/>
        {error && <p role="alert" className="rsi-error">
          <AlertTriangle size={15}/>{error.message} {error.hint}
          <code>{error.code}</code> {error.details && <code>{error.details}</code>}
        </p>}
      </>}
    </form>
  </details>;
}

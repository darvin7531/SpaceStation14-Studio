import { useState } from 'react';
import { AlertTriangle, FileClock, X } from 'lucide-react';
import {
  studio,
  type DraftSnapshot,
  type DraftSummary,
  type ResourceDocument,
} from '../lib/api';
import { normalizeStudioError, type StudioError } from '../lib/errors';
import YamlDiffView from '../editor/YamlDiffView';

interface Preview {
  snapshot: DraftSnapshot;
  current: ResourceDocument | null;
  sourceWarning: string | null;
}

interface Props {
  entries: DraftSummary[];
  warnings: string[];
  dirtyPaths: string[];
  onRestore: (snapshot: DraftSnapshot) => boolean;
  onDiscard: (path: string) => Promise<void>;
}

export default function RecoveryPanel({
  entries, warnings, dirtyPaths, onRestore, onDiscard,
}: Props) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busyPath, setBusyPath] = useState<string | null>(null);
  const [error, setError] = useState<StudioError | null>(null);

  async function inspect(entry: DraftSummary) {
    setBusyPath(entry.path);
    setError(null);
    try {
      const snapshot = await studio.readDraft(entry.path);
      if (!snapshot) {
        setError({
          code: 'DRAFT_NOT_FOUND',
          message: 'Сохранённая копия больше не найдена.',
          hint: 'Обновите проект, чтобы перечитать список копий.',
        });
        return;
      }
      let current: ResourceDocument | null = null;
      let sourceWarning: string | null = null;
      if (entry.source_indexed) {
        try {
          current = await studio.readResource(entry.path);
        } catch (failure) {
          const explained = normalizeStudioError(failure);
          sourceWarning = explained.message;
        }
      } else {
        sourceWarning = 'Исходный YAML больше не входит в индекс проекта. Текст копии можно выделить и скопировать.';
      }
      setPreview({ snapshot, current, sourceWarning });
    } catch (failure) {
      setError(normalizeStudioError(failure));
    } finally {
      setBusyPath(null);
    }
  }

  async function discard(path: string) {
    setBusyPath(path);
    setError(null);
    try {
      await onDiscard(path);
      setPreview(null);
    } catch (failure) {
      setError(normalizeStudioError(failure));
    } finally {
      setBusyPath(null);
    }
  }

  if (entries.length === 0 && warnings.length === 0) return null;

  const mismatched = preview?.current?.revision !== preview?.snapshot.base_revision;
  const openedDirty = preview ? dirtyPaths.includes(preview.snapshot.path) : false;

  return <section className="recovery-panel" aria-label="Восстановление черновиков">
    <div className="recovery-heading">
      <FileClock size={17}/>
      <strong>Восстановление черновиков</strong>
      <span>{entries.length} копий</span>
    </div>
    {warnings.map((warning, index) => <p key={index} className="recovery-warning">
      <AlertTriangle size={14}/>{warning}
    </p>)}
    <div className="recovery-entry-list">
      {entries.map((entry) => <div className="recovery-entry" key={entry.path}>
        <span title={entry.path}>{entry.path}</span>
        <small>{new Date(entry.saved_at_ms).toLocaleString('ru-RU')}</small>
        <button type="button" onClick={() => void inspect(entry)} disabled={busyPath !== null}>
          {busyPath === entry.path ? 'Читаю…' : 'Просмотреть'}
        </button>
      </div>)}
    </div>
    {error && <div className="recovery-warning" role="alert">
      <AlertTriangle size={15}/><span>{error.message} {error.hint}</span>
    </div>}
    {preview && <div className="recovery-preview" role="dialog" aria-label={'Черновик ' + preview.snapshot.path}>
      <div className="recovery-preview-title">
        <strong>{preview.snapshot.path}</strong>
        <button type="button" onClick={() => setPreview(null)} aria-label="Закрыть просмотр копии"><X size={16}/></button>
      </div>
      {mismatched && <p className="recovery-warning" role="status">
        <AlertTriangle size={15}/>
        Исходный файл изменился после создания этой копии или недоступен.
        Автоматическая перезапись исходника запрещена.
      </p>}
      {preview.sourceWarning && <p className="recovery-warning">{preview.sourceWarning}</p>}
      {openedDirty && <p className="recovery-warning">
        В редакторе уже открыт другой несохранённый черновик этого файла.
        Восстановление поверх него заблокировано.
      </p>}
      <YamlDiffView original={preview.current?.content ?? ''}
        modified={preview.snapshot.content}
        originalLabel={preview.current ? 'Текущий файл на диске' : 'Исходный файл недоступен'}
        modifiedLabel="Сохранённый черновик"
        fileLabel={preview.snapshot.path}/>
      <div className="recovery-actions">
        <button type="button" disabled={busyPath !== null || openedDirty || !preview.current}
          onClick={() => {
            if (onRestore(preview.snapshot)) setPreview(null);
          }}>
          Восстановить в редактор
        </button>
        <button type="button" className="recovery-delete"
          disabled={busyPath !== null || openedDirty}
          onClick={() => void discard(preview.snapshot.path)}>
          Удалить сохранённую копию
        </button>
        <button type="button" onClick={() => setPreview(null)}>Позже</button>
      </div>
      <small>Просмотр не меняет исходники. При несовпадении ревизий восстановленный текст
        откроется как конфликтный черновик — записать его поверх чужих правок без отдельного
        решения не получится.</small>
    </div>}
  </section>;
}

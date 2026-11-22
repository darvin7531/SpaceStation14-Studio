import { useState, type FormEvent } from 'react';
import { AlertCircle, Maximize2 } from 'lucide-react';
import { studio, type ImportedRsiState } from '../lib/api';
import { normalizeStudioError, type StudioError } from '../lib/errors';
import { parseRsiMetadata } from '../lib/rsi-layout';

interface Props {
  path: string;
  revision: string;
  metadata: string;
  onSaved: (result: ImportedRsiState) => void;
}

/** Electron RSI size.x/size.y editor; native Rust validates all state-sheet grids. */
export default function RsiSizePanel({ path, revision, metadata, onSaved }: Props) {
  const inspection = parseRsiMetadata(metadata);
  const old = inspection.size;
  const [width, setWidth] = useState(old?.x ?? 32);
  const [height, setHeight] = useState(old?.y ?? 32);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<StudioError | null>(null);
  const changed = old && (width !== old.x || height !== old.y);
  const valid = Number.isSafeInteger(width) && Number.isSafeInteger(height)
    && width >= 1 && width <= 2048 && height >= 1 && height <= 2048;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!changed || !valid || saving || !old) return;
    setFailure(null);
    setSaving(true);
    try {
      onSaved(await studio.updateRsiSize({
        path, expected_revision: revision, size_x: width, size_y: height,
      }));
    } catch (reason) {
      setFailure(normalizeStudioError(reason));
    } finally {
      setSaving(false);
    }
  }

  return <details className="rsi-credits-panel">
    <summary><Maximize2 size={15}/> Размер кадра RSI (Electron)</summary>
    {!old ? <p>Нельзя прочитать исходные size.x / size.y из meta.json.</p>
      : <form onSubmit={(event) => void submit(event)}>
        <p>Редактирует только <code>size.x</code> и <code>size.y</code>.
          Все существующие PNG должны иметь сетку, точно совпадающую с числом кадров в meta.json.
          PNG не пересоздаются, неизвестные свойства метаданных сохраняются. При несоответствии
          изменение будет отклонено с причиной.</p>
        <div className="rsi-credits-fields">
          <label>Ширина кадра (px)
            <input type="number" min={1} max={2048} step={1} value={width}
              disabled={saving} onChange={(event) => setWidth(Number(event.target.value))}/>
          </label>
          <label>Высота кадра (px)
            <input type="number" min={1} max={2048} step={1} value={height}
              disabled={saving} onChange={(event) => setHeight(Number(event.target.value))}/>
          </label>
        </div>
        {failure && <div className="rsi-error" role="alert">
          <AlertCircle size={16}/><span>{failure.message} {failure.hint} <code>{failure.code}</code></span>
        </div>}
        <button type="submit" disabled={!changed || !valid || saving}>
          {saving ? 'Сохраняю…' : 'Сохранить размер кадра'}
        </button>
      </form>}
  </details>;
}

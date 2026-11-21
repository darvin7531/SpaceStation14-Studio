import { useRef, useState, type FormEvent } from 'react';
import { AlertCircle, ImagePlus } from 'lucide-react';
import { studio, type ImportedRsiState } from '../lib/api';
import { normalizeStudioError, type StudioError } from '../lib/errors';

interface Props {
  path: string;
  revision: string;
  onImported: (updated: ImportedRsiState) => void;
}

const PNG_LIMIT = 8 * 1024 * 1024;

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') resolve(reader.result);
      else reject(new Error('Не удалось прочитать PNG как Data URL.'));
    };
    reader.onerror = () => reject(reader.error ?? new Error('Ошибка чтения PNG.'));
    reader.readAsDataURL(file);
  });
}

/** Append-only import. Existing states and PNG files are never replaced. */
export default function RsiImportPanel({ path, revision, onImported }: Props) {
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState('');
  const [directions, setDirections] = useState<1 | 4 | 8>(1);
  const [frames, setFrames] = useState(1);
  const [delay, setDelay] = useState(0.1);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<StudioError | null>(null);
  const input = useRef<HTMLInputElement>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file || uploading) return;
    setError(null);
    if (file.size > PNG_LIMIT || file.size === 0) {
      setError({
        code: 'RSI_IMPORT_PNG_TOO_LARGE',
        message: 'Выберите непустой PNG не больше 8 МиБ.',
        hint: 'Уменьшите размер файла или сохраните изображение повторно.',
      });
      return;
    }
    setUploading(true);
    try {
      const data_url = await fileToDataUrl(file);
      const result = await studio.importRsiState({
        path, expected_revision: revision,
        name, directions, frames_per_direction: frames, delay_seconds: delay,
        data_url,
      });
      onImported(result);
      setFile(null);
      if (input.current) input.current.value = '';
    } catch (failure) {
      setError(normalizeStudioError(failure));
    } finally {
      setUploading(false);
    }
  }

  return <details className="rsi-import-panel">
    <summary><ImagePlus size={15}/> Импортировать PNG как новое состояние</summary>
    <form onSubmit={(event) => void submit(event)}>
      <p>Импорт добавляет состояние в <code>meta.json</code> и создаёт новый
        <code> state.png</code>. Существующие изображения и состояния не перезаписываются.
        PNG должен содержать ровно столько кадров, сколько указано ниже.</p>
      <div className="rsi-import-fields">
        <label>PNG-лист
          <input ref={input} type="file" accept="image/png,.png" required disabled={uploading}
            onChange={(event) => {
              const candidate = event.target.files?.[0] ?? null;
              setFile(candidate);
              setError(null);
              if (candidate) {
                const suggested = candidate.name.replace(/\.png$/i, '')
                  .toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 128);
                setName(suggested);
              }
            }}/>
        </label>
        <label>Имя состояния
          <input type="text" value={name} required maxLength={128}
            pattern="[a-z0-9_-]+" disabled={uploading}
            onChange={(event) => setName(event.target.value)}
            placeholder="walk"/>
        </label>
        <label>Направления
          <select value={directions} disabled={uploading}
            onChange={(event) => setDirections(Number(event.target.value) as 1 | 4 | 8)}>
            <option value={1}>1 — одно</option>
            <option value={4}>4 — стороны света</option>
            <option value={8}>8 — с диагоналями</option>
          </select>
        </label>
        <label>Кадров на направление
          <input type="number" min={1} max={Math.floor(256 / directions)} step={1}
            value={frames} disabled={uploading}
            onChange={(event) => setFrames(Number(event.target.value))}/>
        </label>
        <label>Длительность кадра, сек
          <input type="number" min={0.01} max={60} step={0.01}
            value={delay} disabled={uploading}
            onChange={(event) => setDelay(Number(event.target.value))}/>
        </label>
      </div>
      <p className="rsi-import-hint">
        Порядок кадров: сначала все кадры юга, затем севера, востока, запада и диагоналей.
        Выберите число ячеек = направления × кадры на направление.
      </p>
      {file && <small>Выбран: {file.name} · {Math.ceil(file.size / 1024)} КиБ</small>}
      {error && <div className="rsi-error" role="alert"><AlertCircle size={16}/>
        <span>{error.message} {error.hint} <code>{error.code}</code></span>
      </div>}
      <button type="submit" disabled={uploading || !file || !name || !Number.isInteger(frames)
          || frames < 1 || frames * directions > 256}>
        <ImagePlus size={15}/>{uploading ? 'Импортирую…' : 'Добавить новое состояние'}
      </button>
    </form>
  </details>;
}

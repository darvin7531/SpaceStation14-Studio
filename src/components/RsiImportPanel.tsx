import { useRef, useState, type DragEvent, type FormEvent } from 'react';
import { AlertCircle, ImagePlus } from 'lucide-react';
import { studio, type ImportedRsiState } from '../lib/api';
import { normalizeStudioError, type StudioError } from '../lib/errors';
import type { RsiState } from '../lib/rsi-layout';

interface Props {
  path: string;
  revision: string;
  onImported: (updated: ImportedRsiState) => void;
  replaceState?: RsiState;
  expectedPngRevision?: string;
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

/** Append a new state or replace an existing PNG through an archived, conflict-aware operation. */
export default function RsiImportPanel({
  path, revision, onImported, replaceState, expectedPngRevision,
}: Props) {
  const replacing = Boolean(replaceState);
  const [metadataOnly, setMetadataOnly] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState(replaceState?.name ?? '');
  const [directions, setDirections] = useState<1 | 4 | 8>(replaceState?.directions ?? 1);
  const [frames, setFrames] = useState(replaceState?.delays[0]?.length ?? 1);
  const [delay, setDelay] = useState(replaceState?.delays[0]?.[0] ?? 0.1);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<StudioError | null>(null);
  const input = useRef<HTMLInputElement>(null);

  function chooseFile(candidate: File | null) {
    setError(null);
    if (!candidate) {
      setFile(null);
      return;
    }
    if (!candidate.name.toLowerCase().endsWith('.png')) {
      setError({
        code: 'RSI_IMPORT_FILE_EXTENSION',
        message: 'Для импорта нужен файл PNG.',
        hint: 'Выберите PNG-лист со спрайтами, а не другой формат изображения.',
      });
      return;
    }
    if (candidate.size === 0 || candidate.size > PNG_LIMIT) {
      setError({
        code: 'RSI_IMPORT_PNG_TOO_LARGE',
        message: 'Выберите непустой PNG не больше 8 МиБ.',
        hint: 'Уменьшите размер файла или сохраните изображение повторно.',
      });
      return;
    }
    setFile(candidate);
    if (!replacing) {
      const suggested = candidate.name.replace(/\.png$/i, '')
        .toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 128);
      setName(suggested);
    }
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    if (uploading) return;
    const candidates = Array.from(event.dataTransfer.files);
    if (candidates.length !== 1) {
      setError({
        code: 'RSI_IMPORT_SINGLE_FILE',
        message: 'Для операции выберите один PNG.',
        hint: 'Импортируйте изображения по одному, чтобы явно задать сетку кадров.',
      });
      return;
    }
    if (input.current) input.current.value = '';
    chooseFile(candidates[0]);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if ((!file && !metadataOnly) || uploading) return;
    setError(null);
    if (file && (file.size > PNG_LIMIT || file.size === 0)) {
      setError({
        code: 'RSI_IMPORT_PNG_TOO_LARGE',
        message: 'Выберите непустой PNG не больше 8 МиБ.',
        hint: 'Уменьшите размер файла или сохраните изображение повторно.',
      });
      return;
    }
    if (replacing && !expectedPngRevision) {
      setError({
        code: 'RSI_REPLACE_PNG_REVISION_MISSING',
        message: 'Не удалось зафиксировать исходную ревизию PNG.',
        hint: 'Обновите предпросмотр RSI и повторите замену.',
      });
      return;
    }
    setUploading(true);
    try {
      const data_url = !metadataOnly && file ? await fileToDataUrl(file) : '';
      const preserveDelays = Boolean(replaceState
        && directions === replaceState.directions
        && replaceState.delays.length === directions
        && replaceState.delays.every((items) => items.length === frames));
      const request = {
        path,
        expected_revision: revision,
        name: replaceState?.name ?? name,
        directions,
        frames_per_direction: frames,
        delay_seconds: delay,
        data_url,
        ...(replacing ? { expected_png_revision: expectedPngRevision } : {}),
        ...(preserveDelays && replaceState ? { delays: replaceState.delays } : {}),
      };
      const result = replacing
        ? await studio.replaceRsiState(request)
        : metadataOnly ? await studio.createRsiState(request) : await studio.importRsiState(request);
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
    <summary><ImagePlus size={15}/>{replacing
      ? 'Заменить PNG и перестроить кадры: ' + replaceState?.name
      : 'Добавить состояние RSI'}</summary>
    <form onSubmit={(event) => void submit(event)}>
      {replacing
        ? <p>Старая версия состояния и PNG сначала попадут в <code>.ss14-studio-archive</code>.
            Новая сетка может изменить число направлений и кадров. При ошибке Studio попытается
            восстановить прежнее состояние; внешние изменения не перезаписываются.</p>
        : <p>Добавление записывает состояние в <code>meta.json</code>; PNG создаётся только при импорте.
            Существующие изображения и состояния не перезаписываются.</p>}
      {!replacing && <label><input type="checkbox" checked={metadataOnly} disabled={uploading}
        onChange={(event) => setMetadataOnly(event.target.checked)}/> Только метаданные, без PNG</label>}
      {metadataOnly && <p>PNG не создаётся. Чтобы добавить изображение позже, поместите файл
        с именем состояния и расширением .png в папку RSI и обновите просмотр.</p>}
      {!metadataOnly && <>
      <div className={'rsi-dropzone' + (dragging ? ' dragging' : '')}
        role="group" aria-label="Перетащить PNG для импорта"
        onDragOver={(event) => { event.preventDefault(); if (!uploading) setDragging(true); }}
        onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}
        onDrop={onDrop}>
        Перетащите сюда один PNG-лист или выберите файл ниже.
      </div>
      <div className="rsi-import-fields">
        <label>PNG-лист
          <input ref={input} type="file" accept="image/png,.png" disabled={uploading}
            onChange={(event) => chooseFile(event.target.files?.[0] ?? null)}/>
        </label>
      </div></>}
      <div className="rsi-import-fields">
        {replacing
          ? <label>Состояние<strong>{replaceState?.name}</strong></label>
          : <label>Имя состояния
              <input type="text" value={name} required maxLength={128}
                pattern="[a-z0-9_-]+" disabled={uploading}
                onChange={(event) => setName(event.target.value)} placeholder="walk"/>
            </label>}
        <label>Направления
          <select value={directions} disabled={uploading}
            onChange={(event) => setDirections(Number(event.target.value) as 1 | 4 | 8)}>
            <option value={1}>1 — одно</option>
            <option value={4}>4 — стороны света</option>
            <option value={8}>8 — с диагоналями</option>
          </select>
        </label>
        <label>Кадров на направление
          <input type="number" min={1} max={Math.min(128, Math.floor(256 / directions))} step={1}
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
        PNG должен содержать ровно направления × кадры ячеек. Если сетка не меняется,
        покадровые задержки исходного состояния сохраняются.
      </p>
      {!metadataOnly && file && <small>Выбран: {file.name} · {Math.ceil(file.size / 1024)} КиБ</small>}
      {error && <div className="rsi-error" role="alert"><AlertCircle size={16}/>
        <span>{error.message} {error.hint} <code>{error.code}</code></span>
      </div>}
      <button type="submit" disabled={uploading || (!metadataOnly && !file) || (!replacing && !name)
          || !Number.isInteger(frames) || frames < 1 || frames > 128 || frames * directions > 256
          || (replacing && !expectedPngRevision)}>
        <ImagePlus size={15}/>{uploading
          ? (replacing ? 'Заменяю…' : 'Импортирую…')
          : (replacing ? 'Заменить PNG и перестроить кадры' : metadataOnly ? 'Создать без PNG' : 'Добавить новое состояние')}
      </button>
    </form>
  </details>;
}

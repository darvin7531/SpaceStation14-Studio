import { useRef, useState, type DragEvent, type FormEvent } from 'react';
import { AlertCircle, Upload } from 'lucide-react';
import { studio, type ImportedRsiState } from '../lib/api';
import { normalizeStudioError } from '../lib/errors';
import { parseRsiMetadata } from '../lib/rsi-layout';
import { planRsiBatch, pngHeaderSize } from '../lib/rsi-batch-plan';

interface Props {
  path: string;
  revision: string;
  metadata: string;
  onImported: (result: ImportedRsiState) => void;
  onBatchOutcome: (message: string) => void;
}

function readPngAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') resolve(reader.result);
      else reject(new Error('Невозможно прочитать PNG ' + file.name));
    };
    reader.onerror = () => reject(reader.error ?? new Error('Не удалось прочитать ' + file.name));
    // Old PNG assets may have an empty MIME type; Rust still requires PNG Data URL.
    reader.readAsDataURL(new Blob([file], { type: 'image/png' }));
  });
}

/** Restore Electron's multi-PNG drag/drop, using the safe native one-state write
 * repeatedly. All PNG dimensions and names are checked before the first write.
 */
export default function RsiBulkImportPanel({
  path, revision, metadata, onImported, onBatchOutcome,
}: Props) {
  const [files, setFiles] = useState<File[]>([]);
  const [directions, setDirections] = useState<1 | 4 | 8>(1);
  const [delay, setDelay] = useState(0.1);
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState('');
  const [dragging, setDragging] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const inspection = parseRsiMetadata(metadata);

  function selectFiles(next: File[]) {
    setFailure(null);
    setProgress('');
    setFiles(next);
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    if (!importing) selectFiles(Array.from(event.dataTransfer.files));
  }

  async function importAll(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (importing) return;
    setFailure(null);
    setProgress('Проверяю все PNG перед записью…');
    setImporting(true);
    let last: ImportedRsiState | null = null;
    let imported = 0;
    try {
      if (!inspection.size || inspection.errors.length) {
        throw new Error('Невозможно импортировать пакет в RSI с некорректным meta.json.');
      }
      const headers = await Promise.all(files.map(async (file) => {
        const head = new Uint8Array(await file.slice(0, 24).arrayBuffer());
        const dimensions = pngHeaderSize(head);
        if (!dimensions) throw new Error(file.name + ': PNG не содержит корректного IHDR.');
        return {
          name: file.name, bytes: file.size,
          width: dimensions.width, height: dimensions.height,
        };
      }));
      const plan = planRsiBatch(
        headers, inspection.size, directions,
        new Set(inspection.states.map((state) => state.name)),
      );
      if (!Number.isFinite(delay) || delay < 0.01 || delay > 60) {
        throw new Error('Длительность кадра должна быть от 0.01 до 60 секунд.');
      }
      let expectedRevision = revision;
      for (let i = 0; i < plan.length; i++) {
        const item = plan[i];
        setProgress('Импорт ' + (i + 1) + ' / ' + plan.length + ': ' + item.name);
        const data_url = await readPngAsDataUrl(files[i]);
        const result = await studio.importRsiState({
          path,
          expected_revision: expectedRevision,
          name: item.name,
          directions: item.directions,
          frames_per_direction: item.frames,
          delay_seconds: delay,
          data_url,
        });
        expectedRevision = result.revision;
        last = result;
        imported++;
      }
      if (last) {
        onImported(last);
        onBatchOutcome('Импортировано ' + imported + ' PNG-состояний в ' + path
          + '. Создание выполнено через безопасные Rust-операции.');
      }
    } catch (error) {
      const normalized = normalizeStudioError(error);
      const detail = normalized.message + (normalized.hint ? ' ' + normalized.hint : '');
      if (last) {
        onImported(last);
        onBatchOutcome('Импортировано ' + imported + ' из ' + files.length
          + ' PNG. Оставшиеся файлы не записаны: ' + detail);
      } else {
        setFailure(detail);
      }
    } finally {
      setImporting(false);
      setProgress('');
    }
  }

  return <details className="rsi-import-panel">
    <summary><Upload size={15}/> Импортировать несколько PNG (Electron)</summary>
    <form onSubmit={(event) => void importAll(event)}>
      <p>Перетащите несколько PNG-состояний сразу. Имя файла становится именем состояния.
        Все размеры и имена проверяются до записи; файлы создаются по очереди через Rust.
        Уже существующие состояния никогда не перезаписываются. При частичной ошибке
        успешно созданные состояния сохраняются.</p>
      <div className={'rsi-dropzone' + (dragging ? ' dragging' : '')}
        onDragOver={(event) => { event.preventDefault(); if (!importing) setDragging(true); }}
        onDragLeave={(event) => { event.preventDefault(); setDragging(false); }}
        onDrop={onDrop} role="group" aria-label="Пакетный импорт PNG">
        Перетащите сюда несколько PNG или выберите их ниже.
      </div>
      <div className="rsi-import-fields">
        <label>PNG-файлы
          <input ref={input} type="file" multiple accept="image/png,.png" disabled={importing}
            onChange={(event) => selectFiles(Array.from(event.target.files ?? []))}/>
        </label>
        <label>Направлений на состояние
          <select value={directions} disabled={importing}
            onChange={(event) => setDirections(Number(event.target.value) as 1 | 4 | 8)}>
            <option value={1}>1</option>
            <option value={4}>4</option>
            <option value={8}>8</option>
          </select>
        </label>
        <label>Длительность каждого кадра, сек.
          <input type="number" min={0.01} max={60} step={0.01} value={delay}
            disabled={importing} onChange={(event) => setDelay(Number(event.target.value))}/>
        </label>
      </div>
      {files.length > 0 && <p>Выбрано PNG: {files.length}.
        Имена: {files.slice(0, 12).map((file) => file.name).join(', ')}
        {files.length > 12 ? '…' : ''}</p>}
      <p>Размер кадров берётся из meta.json; число кадров каждого PNG определяется по его сетке.
        Для многосторонних состояний выберите 4 или 8 направлений.</p>
      {progress && <p role="status">{progress}</p>}
      {failure && <div className="rsi-error" role="alert">
        <AlertCircle size={15}/><span>{failure}</span>
      </div>}
      <button type="submit" disabled={importing || files.length === 0 || files.length > 16 ||
        !inspection.size || inspection.errors.length > 0}>
        <Upload size={14}/>{importing ? 'Импорт…' : 'Импортировать ' + files.length + ' PNG'}
      </button>
    </form>
  </details>;
}

import { useI18n } from '../i18n';
import { uiText, type Language } from '../lib/ui-language';
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

function readPngAsDataUrl(file: File, language: Language): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') resolve(reader.result);
      else reject(new Error(uiText(language, 'rsi.bulk.read', { name: file.name })));
    };
    reader.onerror = () => reject(reader.error ?? new Error(uiText(language, 'rsi.bulk.readFailed', { name: file.name })));
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
  const { t, language } = useI18n();
  const [files, setFiles] = useState<File[]>([]);
  const [directions, setDirections] = useState<1 | 4 | 8>(1);
  const [delay, setDelay] = useState(0.1);
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState('');
  const [dragging, setDragging] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const inspection = parseRsiMetadata(metadata, language);

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
    setProgress(t('rsi.bulk.checking'));
    setImporting(true);
    let last: ImportedRsiState | null = null;
    let imported = 0;
    try {
      if (!inspection.size || inspection.errors.length) {
        throw new Error(t('rsi.bulk.invalidMeta'));
      }
      const headers = await Promise.all(files.map(async (file) => {
        const head = new Uint8Array(await file.slice(0, 24).arrayBuffer());
        const dimensions = pngHeaderSize(head);
        if (!dimensions) throw new Error(t('rsi.bulk.invalidHeader', { name: file.name }));
        return {
          name: file.name, bytes: file.size,
          width: dimensions.width, height: dimensions.height,
        };
      }));
      const plan = planRsiBatch(
        headers, inspection.size, directions,
        new Set(inspection.states.map((state) => state.name)), language,
      );
      if (!Number.isFinite(delay) || delay < 0.01 || delay > 60) {
        throw new Error(t('rsi.bulk.invalidDelay'));
      }
      let expectedRevision = revision;
      for (let i = 0; i < plan.length; i++) {
        const item = plan[i];
        setProgress(t('rsi.bulk.progress', { current: i + 1, total: plan.length, name: item.name }));
        const data_url = await readPngAsDataUrl(files[i], language);
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
        onBatchOutcome(t('rsi.bulk.success', { count: imported, path }));
      }
    } catch (error) {
      const normalized = normalizeStudioError(error);
      const detail = error instanceof Error ? error.message : [normalized.message, normalized.hint, normalized.code, normalized.details].filter(Boolean).join(' ');
      if (last) {
        onImported(last);
        onBatchOutcome(t('rsi.bulk.partial', { count: imported, total: files.length, detail }));
      } else {
        setFailure(detail);
      }
    } finally {
      setImporting(false);
      setProgress('');
    }
  }

  return <details className="rsi-import-panel">
    <summary><Upload size={15}/> {t('rsi.bulk.title')}</summary>
    <form onSubmit={(event) => void importAll(event)}>
      <p>{t('rsi.bulk.intro')}</p>
      <div className={'rsi-dropzone' + (dragging ? ' dragging' : '')}
        onDragOver={(event) => { event.preventDefault(); if (!importing) setDragging(true); }}
        onDragLeave={(event) => { event.preventDefault(); setDragging(false); }}
        onDrop={onDrop} role="group" aria-label={t('rsi.bulk.dropLabel')}>
        {t('rsi.bulk.drop')}
      </div>
      <div className="rsi-import-fields">
        <label>{t('rsi.bulk.files')}
          <input ref={input} type="file" multiple accept="image/png,.png" disabled={importing}
            onChange={(event) => selectFiles(Array.from(event.target.files ?? []))}/>
        </label>
        <label>{t('rsi.bulk.directions')}
          <select value={directions} disabled={importing}
            onChange={(event) => setDirections(Number(event.target.value) as 1 | 4 | 8)}>
            <option value={1}>1</option>
            <option value={4}>4</option>
            <option value={8}>8</option>
          </select>
        </label>
        <label>{t('rsi.bulk.delay')}
          <input type="number" min={0.01} max={60} step={0.01} value={delay}
            disabled={importing} onChange={(event) => setDelay(Number(event.target.value))}/>
        </label>
      </div>
      {files.length > 0 && <p>{t('rsi.bulk.selected', { count: files.length, names: files.slice(0, 12).map((file) => file.name).join(', '), suffix: files.length > 12 ? '…' : '' })}</p>}
      <p>{t('rsi.bulk.help')}</p>
      {progress && <p role="status">{progress}</p>}
      {failure && <div className="rsi-error" role="alert">
        <AlertCircle size={15}/><span>{failure}</span>
      </div>}
      <button type="submit" disabled={importing || files.length === 0 || files.length > 16 ||
        !inspection.size || inspection.errors.length > 0}>
        <Upload size={14}/>{importing ? t('rsi.bulk.importing') : t('rsi.bulk.submit', { count: files.length })}
      </button>
    </form>
  </details>;
}

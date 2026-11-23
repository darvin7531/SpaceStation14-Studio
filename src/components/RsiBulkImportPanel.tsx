import { useI18n } from '../i18n';
import { useRef, useState, type DragEvent, type FormEvent } from 'react';
import { AlertCircle, Upload } from 'lucide-react';
import { parseRsiMetadata } from '../lib/rsi-layout';
import { readPngAsDataUrl } from '../lib/rsi-png-data-url';
import { importRsiBatch } from '../lib/rsi-batch-import';

interface Props {
  projectRoot: string;
  path: string;
  revision: string;
  metadata: string;
  onBatchRefresh: (projectRoot: string) => Promise<void>;
  onBatchOutcome: (message: string) => void;
}

/** Restore Electron's multi-PNG drag/drop, using the safe native one-state write
 * repeatedly. All PNG dimensions and names are checked before the first write.
 */
export default function RsiBulkImportPanel({
  projectRoot, path, revision, metadata, onBatchRefresh, onBatchOutcome,
}: Props) {
  const { t, language } = useI18n();
  const [files, setFiles] = useState<File[]>([]);
  const [directions, setDirections] = useState<1 | 4 | 8>(1);
  const [delay, setDelay] = useState(0.1);
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState('');
  const [dragging, setDragging] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [replaceExisting, setReplaceExisting] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const inspection = parseRsiMetadata(metadata, language);
  const collisions = files.map((file) => file.name.replace(/\.png$/i, ''))
    .filter((name) => inspection.states.some((state) => state.name === name));

  function selectFiles(next: File[]) {
    setFailure(null);
    setProgress('');
    setReplaceExisting(false);
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
    const { attempted, outcome } = await importRsiBatch({
      projectRoot, path, revision, inspection, files, directions, delay, replaceExisting,
      language, readPng: (file) => readPngAsDataUrl(file, language), refresh: onBatchRefresh, onProgress: setProgress,
    });
    if (attempted) onBatchOutcome(outcome);
    else if (outcome) setFailure(outcome);
    setImporting(false);
    setProgress('');
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
      {collisions.length > 0 && <label>
        <input type="checkbox" checked={replaceExisting} disabled={importing}
          onChange={(event) => setReplaceExisting(event.target.checked)}/>
        {t('rsi.bulk.confirmReplace', { names: collisions.join(', ') })}
      </label>}
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

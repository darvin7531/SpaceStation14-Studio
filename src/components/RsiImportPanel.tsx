import { useI18n } from '../i18n';
import { useRef, useState, type DragEvent, type FormEvent } from 'react';
import { AlertCircle, ImagePlus } from 'lucide-react';
import { studio, type ImportedRsiState } from '../lib/api';
import { normalizeStudioError, type StudioError } from '../lib/errors';
import { rsiErrorText } from '../lib/rsi-error-text';
import type { RsiState } from '../lib/rsi-layout';
import { toggleRsiImportMode } from '../lib/rsi-import-mode';
import { readPngAsDataUrl } from '../lib/rsi-png-data-url';

interface Props {
  path: string;
  revision: string;
  onImported: (updated: ImportedRsiState) => void;
  replaceState?: RsiState;
  expectedPngRevision?: string;
  attachState?: RsiState;
  projectRoot: string;
  onAttempt: (failure?: unknown) => void;
}

const PNG_LIMIT = 8 * 1024 * 1024;

/** Append a new state or replace an existing PNG through an archived, conflict-aware operation. */
export default function RsiImportPanel({
  path, revision, onImported, replaceState, expectedPngRevision, attachState, projectRoot, onAttempt,
}: Props) {
  const { t, language } = useI18n();
  const attaching = Boolean(attachState);
  const existingState = replaceState ?? attachState;
  const replacing = Boolean(replaceState);
  const [metadataOnly, setMetadataOnly] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState(existingState?.name ?? '');
  const [directions, setDirections] = useState<1 | 4 | 8>(existingState?.directions ?? 1);
  const [frames, setFrames] = useState(existingState?.delays[0]?.length ?? 1);
  const [delay, setDelay] = useState(existingState?.delays[0]?.[0] ?? 0.1);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<StudioError | null>(null);
  const input = useRef<HTMLInputElement>(null);

  function chooseFile(candidate: File | null) {
    setError(null);
    setFile(null);
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
    if (!existingState) {
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
      const data_url = !metadataOnly && file ? await readPngAsDataUrl(file, language) : '';
      const preserveDelays = Boolean(replaceState
        && directions === replaceState.directions
        && replaceState.delays.length === directions
        && replaceState.delays.every((items) => items.length === frames));
      const request = {
        path,
        expected_revision: revision,
        name: existingState?.name ?? name,
        directions,
        frames_per_direction: frames,
        delay_seconds: delay,
        data_url,
        ...(replacing ? { expected_png_revision: expectedPngRevision } : {}),
        ...(preserveDelays && replaceState ? { delays: replaceState.delays } : {}),
      };
      let result: ImportedRsiState;
      try {
        result = attaching ? await studio.attachRsiState(request, projectRoot) : replacing
          ? await studio.replaceRsiState(request, projectRoot)
          : metadataOnly ? await studio.createRsiState(request, projectRoot) : await studio.importRsiState(request, projectRoot);
      } catch (failure) {
        onAttempt(failure);
        throw failure;
      }
      onImported(result);
      onAttempt();
      setFile(null);
      if (input.current) input.current.value = '';
    } catch (failure) {
      setError(normalizeStudioError(failure));
    } finally {
      setUploading(false);
    }
  }

  return <details className="rsi-import-panel" data-testid={attaching ? 'rsi-attach' : replacing ? 'rsi-replace' : 'rsi-import'}>
    <summary><ImagePlus size={15}/>{attaching ? t('rsi.import.attachTitle', { name: attachState?.name }) : replacing
      ? t('rsi.import.replaceTitle', { name: replaceState?.name }) : t('rsi.import.title')}</summary>
    <form onSubmit={(event) => void submit(event)}>
      <p>{t(attaching ? 'rsi.import.attachIntro' : replacing ? 'rsi.import.replaceIntro' : 'rsi.import.intro')}</p>
      {!existingState && <label><input type="checkbox" checked={metadataOnly} disabled={uploading}
        onChange={(event) => { const next = toggleRsiImportMode(event.target.checked); setMetadataOnly(next.metadataOnly); setFile(next.file); if (input.current) input.current.value = ''; }}/> {t('rsi.import.metadataOnly')}</label>}
      {metadataOnly && <p>{t('rsi.import.metadataHint')}</p>}
      {!metadataOnly && <>
      <div className={'rsi-dropzone' + (dragging ? ' dragging' : '')}
        role="group" aria-label={t('rsi.import.dropLabel')}
        onDragOver={(event) => { event.preventDefault(); if (!uploading) setDragging(true); }}
        onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}
        onDrop={onDrop}>
        {t('rsi.import.drop')}
      </div>
      <div className="rsi-import-fields">
        <label>{t('rsi.import.file')}
          <input ref={input} type="file" accept="image/png,.png" disabled={uploading}
            onChange={(event) => chooseFile(event.target.files?.[0] ?? null)}/>
        </label>
      </div></>}
      <div className="rsi-import-fields">
        {existingState
          ? <label>{t('rsi.import.state')}<strong>{existingState.name}</strong></label>
          : <label>{t('rsi.import.name')}
              <input type="text" value={name} required maxLength={128}
                pattern="[a-z0-9_-]+" disabled={uploading}
                onChange={(event) => setName(event.target.value)} placeholder="walk"/>
            </label>}
        <label>{t('rsi.import.directions')}
          <select value={directions} disabled={uploading || attaching}
            onChange={(event) => setDirections(Number(event.target.value) as 1 | 4 | 8)}>
            <option value={1}>{t('rsi.import.one')}</option>
            <option value={4}>{t('rsi.import.four')}</option>
            <option value={8}>{t('rsi.import.eight')}</option>
          </select>
        </label>
        <label>{t('rsi.import.frames')}
          <input type="number" min={1} max={Math.min(128, Math.floor(256 / directions))} step={1}
            value={frames} disabled={uploading || attaching}
            onChange={(event) => setFrames(Number(event.target.value))}/>
        </label>
        <label>{t('rsi.import.delay')}
          <input type="number" min={0.01} max={60} step={0.01}
            value={delay} disabled={uploading || attaching}
            onChange={(event) => setDelay(Number(event.target.value))}/>
        </label>
      </div>
      {!attaching && <p className="rsi-import-hint">
        {t('rsi.import.gridHint')}
      </p>}
      {attaching && <p>{t('rsi.import.attachHint')}</p>}
      {!metadataOnly && file && <small>{t('rsi.import.selected', { name: file.name, size: Math.ceil(file.size / 1024) })}</small>}
      {error && <div className="rsi-error" role="alert"><AlertCircle size={16}/>
        <span>{rsiErrorText(error, language)} <code>{error.code}</code></span>
        {language === 'en' && <details><summary>{t('app.errorDetails')}</summary><pre>{error.message} {error.hint}{error.details && `\n${error.details}`}</pre></details>}
        {language === 'ru' && error.details && <pre>{error.details}</pre>}
      </div>}
      <button type="submit" disabled={uploading || (!metadataOnly && !file) || (!replacing && !name)
          || (!attaching && (!Number.isInteger(frames) || frames < 1 || frames > 128 || frames * directions > 256))
          || (replacing && !expectedPngRevision)}>
        <ImagePlus size={15}/>{uploading
          ? t(replacing ? 'rsi.import.busyReplace' : 'rsi.import.busy')
          : t(attaching ? 'rsi.import.attaching' : replacing ? 'rsi.import.replacing' : metadataOnly ? 'rsi.import.creating' : 'rsi.import.add')}
      </button>
    </form>
  </details>;
}

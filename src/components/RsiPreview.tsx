import { useI18n } from '../i18n';
import { useEffect, useMemo, useState } from 'react';
import { AlertCircle, RefreshCw } from 'lucide-react';
import { studio, type DeletedRsiState, type ImportedRsiState, type RestoredRsiState, type RenamedRsiState, type RsiSheetImage, type RsiSheetList } from '../lib/api';
import { normalizeStudioError, type StudioError } from '../lib/errors';
import { buildRsiFrameLayout, isRsiLayoutError, invalidPresentRsiStateNames, missingRsiStateNames, parseRsiMetadata } from '../lib/rsi-layout';
import RsiStatePlayer from './RsiStatePlayer';
import RsiImportPanel from './RsiImportPanel';
import RsiBulkImportPanel from './RsiBulkImportPanel';
import RsiTimingPanel from './RsiTimingPanel';
import RsiDeletePanel from './RsiDeletePanel';
import RsiRestorePanel from './RsiRestorePanel';
import RsiCreditsPanel from './RsiCreditsPanel';
import RsiSizePanel from './RsiSizePanel';
import RsiRenamePanel from './RsiRenamePanel';

function Failure({ error }: { error: StudioError }) {
  const { t } = useI18n();
  return <div className="rsi-error" role="alert"><AlertCircle size={16}/>
    <span><strong>{error.message}</strong> {error.hint} <code>{error.code}</code></span>
    {error.details && <details><summary>{t('app.errorDetails')}</summary><pre>{error.details}</pre></details>}
  </div>;
}

/** Load one PNG at a time; do not expose project paths to the webview filesystem. */
export default function RsiPreview({
  projectRoot, path, metadata, revision, initialState, onImported, onBatchRefresh, onBatchOutcome, onImportAttempt, onTimingUpdated, onCreditsUpdated, onSizeUpdated, onDeleted, onRestored, onRenamed,
}: {
  projectRoot: string;
  path: string;
  metadata: string;
  revision: string;
  initialState?: string | null;
  onImported: (updated: ImportedRsiState) => void;
  onBatchRefresh: (projectRoot: string) => Promise<void>;
  onBatchOutcome: (message: string) => void;
  onImportAttempt: (failure?: unknown) => void;
  onTimingUpdated: (updated: ImportedRsiState) => void;
  onCreditsUpdated: (updated: ImportedRsiState) => void;
  onSizeUpdated: (updated: ImportedRsiState) => void;
  onDeleted: (result: DeletedRsiState) => void;
  onRestored: (result: RestoredRsiState) => void;
  onRenamed: (result: RenamedRsiState) => void;
}) {
  const { t, language } = useI18n();
  const [refresh, setRefresh] = useState(0);
  const [listing, setListing] = useState(true);
  const [list, setList] = useState<RsiSheetList | null>(null);
  const [listError, setListError] = useState<StudioError | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [image, setImage] = useState<RsiSheetImage | null>(null);
  const [imageError, setImageError] = useState<StudioError | null>(null);
  const [loadingImage, setLoadingImage] = useState(false);
  const [zoom, setZoom] = useState(4);
  const [displayMode, setDisplayMode] = useState<'frames' | 'sheet'>('frames');
  const dimensions = image ? { width: image.width, height: image.height } : null;

  const inspection = useMemo(() => parseRsiMetadata(metadata, language), [metadata, language]);
  const states = inspection.states.map((state) => state.name);
  const selectedState = inspection.states.find((state) => state.name + '.png' === selected) ?? null;
  const layoutResult = inspection.size && selectedState && dimensions
    ? buildRsiFrameLayout(inspection.size, selectedState, dimensions.width, dimensions.height, language)
    : null;
  const frameLayout = layoutResult && !isRsiLayoutError(layoutResult) ? layoutResult : null;

  useEffect(() => {
    let active = true;
    setListing(true);
    setList(null);
    setListError(null);
    setSelected(null);
    const selectionStates = parseRsiMetadata(metadata).states;
    void studio.listRsiSheets(path).then((result) => {
      if (!active) return;
      setList(result);
      setSelected(result.sheets.find((sheet) => sheet.previewable
        && initialState && sheet.name === initialState + '.png')?.name
        ?? result.sheets.find((sheet) =>
        sheet.previewable && selectionStates.some((state) => sheet.name === state.name + '.png'))?.name
        ?? result.sheets.find((sheet) => sheet.previewable)?.name ?? null);
    }).catch((failure: unknown) => {
      if (active) setListError(normalizeStudioError(failure));
    }).finally(() => { if (active) setListing(false); });
    return () => { active = false; };
  }, [path, refresh, metadata, initialState]);

  useEffect(() => {
    let active = true;
    setImage(null);
    setImageError(null);
    if (!selected) {
      setLoadingImage(false);
      return () => { active = false; };
    }
    setLoadingImage(true);
    void studio.readRsiSheet(path, selected).then((result) => {
      if (active) setImage(result);
    }).catch((failure: unknown) => {
      if (active) setImageError(normalizeStudioError(failure));
    }).finally(() => { if (active) setLoadingImage(false); });
    return () => { active = false; };
  }, [path, selected, refresh]);

  return <section className="rsi-viewer" aria-label={t('rsi.preview.label')}>
    <header className="rsi-toolbar">
      <strong>{t('rsi.preview.title')}</strong><span>{list ? t('rsi.preview.count', { sheets: list.sheets.length, states: states.length }) : 'RSI'}</span>
      <label>{t('rsi.preview.image')}
        <select aria-label={t('rsi.preview.sheetLabel')} value={selected ?? ''} disabled={listing || !list?.sheets.length}
          onChange={(event) => setSelected(event.target.value || null)}>
          {!selected && <option value="">{t('rsi.preview.emptyImages')}</option>}
          {list?.sheets.map((sheet) => <option key={sheet.name} value={sheet.name}
            disabled={!sheet.previewable}>
            {t('rsi.preview.fileSize', { name: sheet.name, size: Math.ceil(sheet.bytes / 1024), suffix: !sheet.previewable ? t('rsi.preview.tooLarge') : '' })}
          </option>)}
        </select>
      </label>
      <label>{t('rsi.preview.zoom')}
        <select aria-label={t('rsi.preview.zoomLabel')} value={zoom}
          onChange={(event) => setZoom(Number(event.target.value))}>
          {[1, 2, 4, 8].map((value) => <option key={value} value={value}>{value}×</option>)}
        </select>
      </label>
      <label>{t('rsi.preview.mode')}
        <select aria-label={t('rsi.preview.modeLabel')} value={displayMode}
          onChange={(event) => setDisplayMode(event.target.value as 'frames' | 'sheet')}>
          <option value="frames">{t('rsi.preview.frames')}</option>
          <option value="sheet">{t('rsi.preview.sheet')}</option>
        </select>
      </label>
      <button type="button" disabled={listing} onClick={() => setRefresh((x) => x + 1)}>
        <RefreshCw size={14}/> {t('rsi.preview.refresh')}
      </button>
    </header>
    {listError && <Failure error={listError}/>}
    {list?.warnings.map((warning) => <p key={warning} className="rsi-warning">{warning}</p>)}
    {inspection.errors.map((error, index) => <p key={'metadata-error-' + index}
      className="rsi-warning" role="alert">{error}</p>)}
    {inspection.warnings.map((warning, index) => <p key={'metadata-warning-' + index}
      className="rsi-warning">{warning}</p>)}
    {layoutResult && isRsiLayoutError(layoutResult) && <p className="rsi-warning" role="alert">
      {selectedState?.name}: {layoutResult.error} {t('rsi.preview.unsliced')}
    </p>}
    {frameLayout?.warnings.map((warning, index) =>
      <p className="rsi-warning" key={'layout-' + index}>{warning}</p>)}
    {imageError && <Failure error={imageError}/>}
    <RsiSizePanel key={'size:' + path + ':' + revision}
      path={path} revision={revision} metadata={metadata} onSaved={onSizeUpdated}/>
    <RsiCreditsPanel key={'credits:' + path + ':' + revision}
      path={path} revision={revision} metadata={metadata} onSaved={onCreditsUpdated}/>
    <RsiImportPanel projectRoot={projectRoot} onAttempt={onImportAttempt} path={path} revision={revision} onImported={onImported}/>
    {list && !listing && inspection.states.filter((state) =>
      !list.sheets.some((sheet) => sheet.name === state.name + '.png')).map((state) =>
      <RsiImportPanel key={'attach:' + path + ':' + state.name + ':' + revision}
        projectRoot={projectRoot} onAttempt={onImportAttempt} path={path} revision={revision} attachState={state} onImported={(result) => {
          onImported(result);
          setRefresh((value) => value + 1);
        }}/>)}
    <RsiBulkImportPanel projectRoot={projectRoot} path={path} revision={revision} metadata={metadata}
      onBatchRefresh={onBatchRefresh} onBatchOutcome={onBatchOutcome}/>
    {selectedState && image?.revision && list?.sheets.some((sheet) => sheet.name === selectedState.name + '.png')
      && <RsiImportPanel key={'replace:' + path + ':' + selectedState.name + ':' + revision}
        projectRoot={projectRoot} onAttempt={onImportAttempt} path={path} revision={revision} replaceState={selectedState}
        expectedPngRevision={image.revision} onImported={onImported}/>}

    {selectedState && image?.revision && !loadingImage && !imageError && selected === selectedState.name + '.png'
      && <RsiRenamePanel key={'rename:' + path + ':' + selectedState.name + ':' + revision}
        path={path} revision={revision} name={selectedState.name}
        expectedPngRevision={image.revision} onRenamed={onRenamed}/>}

    {frameLayout && selectedState && image && inspection.size && !loadingImage && !imageError && <RsiTimingPanel
      key={path + ':' + selectedState.name + ':' + revision}
      path={path} revision={revision} state={selectedState} pngRevision={image.revision}
      onUpdated={onTimingUpdated}/>}
    {selectedState && <RsiDeletePanel
      key={'delete:' + path + ':' + selectedState.name + ':' + revision}
      path={path} revision={revision} name={selectedState.name} onDeleted={onDeleted}/>}
    {list && !listing && missingRsiStateNames(metadata, list.sheets.map((sheet) => sheet.name)).map((name) =>
      <RsiDeletePanel key={'delete-missing:' + path + ':' + name + ':' + revision}
        path={path} revision={revision} name={name} expectedMissingPng onDeleted={onDeleted}/>)}
    {list && !listing && invalidPresentRsiStateNames(metadata, list.sheets.map((sheet) => sheet.name)).map((name) =>
      <RsiDeletePanel key={'delete-invalid:' + path + ':' + name + ':' + revision}
        path={path} revision={revision} name={name} expectedMissingPng onDeleted={onDeleted}/>)}
    <RsiRestorePanel path={path} revision={revision} onRestored={onRestored}/>

    <div className="rsi-stage">
      {listing ? <p>{t('rsi.preview.listing')}</p>
        : loadingImage ? <p>{t('rsi.preview.loading')}</p>
          : image ? <>
            <img src={image.data_url} alt={t('rsi.preview.alt', { name: selected })}
              style={{ display: displayMode === 'frames' && frameLayout ? 'none' : 'block' }}
              width={dimensions ? dimensions.width * zoom : undefined}
              height={dimensions ? dimensions.height * zoom : undefined}
              onError={() => setImageError({
                code: 'RSI_DECODE_FAILED', message: t('rsi.preview.decode'),
                hint: t('rsi.preview.decodeHint'),
              })}/>
            {displayMode === 'frames' && frameLayout && dimensions && selectedState &&
              <RsiStatePlayer key={(selected ?? '') + ':' + refresh}
                stateName={selectedState.name} imageUrl={image.data_url}
                imageWidth={dimensions.width} imageHeight={dimensions.height}
                layout={frameLayout} zoom={zoom}/>}
          </>
            : <p>{list?.sheets.length ? t('rsi.preview.choose') : t('rsi.preview.empty')}</p>}
    </div>
    <details className="rsi-metadata">
      <summary>{t('rsi.preview.metadata', { count: states.length })}</summary>
      {states.length > 0 && <p>{states.join(', ')}</p>}
      <pre>{metadata}</pre>
    </details>
    <p className="rsi-caveat">
      {t('rsi.preview.caveat')}
    </p>
  </section>;
}

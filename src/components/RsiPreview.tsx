import { useEffect, useMemo, useState } from 'react';
import { AlertCircle, RefreshCw } from 'lucide-react';
import { studio, type DeletedRsiState, type ImportedRsiState, type RestoredRsiState, type RsiSheetImage, type RsiSheetList } from '../lib/api';
import { normalizeStudioError, type StudioError } from '../lib/errors';
import { buildRsiFrameLayout, isRsiLayoutError, parseRsiMetadata } from '../lib/rsi-layout';
import RsiStatePlayer from './RsiStatePlayer';
import RsiImportPanel from './RsiImportPanel';
import RsiTimingPanel from './RsiTimingPanel';
import RsiDeletePanel from './RsiDeletePanel';
import RsiRestorePanel from './RsiRestorePanel';
import RsiCreditsPanel from './RsiCreditsPanel';

function Failure({ error }: { error: StudioError }) {
  return <div className="rsi-error" role="alert"><AlertCircle size={16}/>
    <span><strong>{error.message}</strong> {error.hint} <code>{error.code}</code></span>
    {error.details && <details><summary>Технические сведения</summary><pre>{error.details}</pre></details>}
  </div>;
}

/** Load one PNG at a time; do not expose project paths to the webview filesystem. */
export default function RsiPreview({
  path, metadata, revision, onImported, onTimingUpdated, onCreditsUpdated, onDeleted, onRestored,
}: {
  path: string;
  metadata: string;
  revision: string;
  onImported: (updated: ImportedRsiState) => void;
  onTimingUpdated: (updated: ImportedRsiState) => void;
  onCreditsUpdated: (updated: ImportedRsiState) => void;
  onDeleted: (result: DeletedRsiState) => void;
  onRestored: (result: RestoredRsiState) => void;
}) {
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

  const inspection = useMemo(() => parseRsiMetadata(metadata), [metadata]);
  const states = inspection.states.map((state) => state.name);
  const selectedState = inspection.states.find((state) => state.name + '.png' === selected) ?? null;
  const layoutResult = inspection.size && selectedState && dimensions
    ? buildRsiFrameLayout(inspection.size, selectedState, dimensions.width, dimensions.height)
    : null;
  const frameLayout = layoutResult && !isRsiLayoutError(layoutResult) ? layoutResult : null;

  useEffect(() => {
    let active = true;
    setListing(true);
    setList(null);
    setListError(null);
    setSelected(null);
    void studio.listRsiSheets(path).then((result) => {
      if (!active) return;
      setList(result);
      setSelected(result.sheets.find((sheet) =>
        sheet.previewable && inspection.states.some((state) => sheet.name === state.name + '.png'))?.name
        ?? result.sheets.find((sheet) => sheet.previewable)?.name ?? null);
    }).catch((failure: unknown) => {
      if (active) setListError(normalizeStudioError(failure));
    }).finally(() => { if (active) setListing(false); });
    return () => { active = false; };
  }, [path, refresh, inspection]);

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

  return <section className="rsi-viewer" aria-label="Просмотр RSI">
    <header className="rsi-toolbar">
      <strong>Листы спрайта</strong><span>{list ? `${list.sheets.length} PNG · ${states.length} состояний` : 'RSI'}</span>
      <label>Изображение
        <select aria-label="PNG лист" value={selected ?? ''} disabled={listing || !list?.sheets.length}
          onChange={(event) => setSelected(event.target.value || null)}>
          {!selected && <option value="">Нет доступных изображений</option>}
          {list?.sheets.map((sheet) => <option key={sheet.name} value={sheet.name}
            disabled={!sheet.previewable}>
            {sheet.name} · {Math.ceil(sheet.bytes / 1024)} КиБ{!sheet.previewable ? ' (слишком большой)' : ''}
          </option>)}
        </select>
      </label>
      <label>Масштаб
        <select aria-label="Масштаб RSI" value={zoom}
          onChange={(event) => setZoom(Number(event.target.value))}>
          {[1, 2, 4, 8].map((value) => <option key={value} value={value}>{value}×</option>)}
        </select>
      </label>
      <label>Просмотр
        <select aria-label="Режим RSI" value={displayMode}
          onChange={(event) => setDisplayMode(event.target.value as 'frames' | 'sheet')}>
          <option value="frames">Кадры и анимация</option>
          <option value="sheet">PNG целиком</option>
        </select>
      </label>
      <button type="button" disabled={listing} onClick={() => setRefresh((x) => x + 1)}>
        <RefreshCw size={14}/> Обновить
      </button>
    </header>
    {listError && <Failure error={listError}/>}
    {list?.warnings.map((warning) => <p key={warning} className="rsi-warning">{warning}</p>)}
    {inspection.errors.map((error, index) => <p key={'metadata-error-' + index}
      className="rsi-warning" role="alert">{error}</p>)}
    {inspection.warnings.map((warning, index) => <p key={'metadata-warning-' + index}
      className="rsi-warning">{warning}</p>)}
    {layoutResult && isRsiLayoutError(layoutResult) && <p className="rsi-warning" role="alert">
      {selectedState?.name}: {layoutResult.error} Показан исходный PNG без нарезки.
    </p>}
    {frameLayout?.warnings.map((warning, index) =>
      <p className="rsi-warning" key={'layout-' + index}>{warning}</p>)}
    {imageError && <Failure error={imageError}/>}
    <RsiCreditsPanel key={'credits:' + path + ':' + revision}
      path={path} revision={revision} metadata={metadata} onSaved={onCreditsUpdated}/>
    <RsiImportPanel path={path} revision={revision} onImported={onImported}/>
    {frameLayout && selectedState && <RsiTimingPanel
      key={path + ':' + selectedState.name + ':' + revision}
      path={path} revision={revision} state={selectedState} onUpdated={onTimingUpdated}/>}
    {selectedState && <RsiDeletePanel
      key={'delete:' + path + ':' + selectedState.name + ':' + revision}
      path={path} revision={revision} name={selectedState.name} onDeleted={onDeleted}/>}
    <RsiRestorePanel path={path} revision={revision} onRestored={onRestored}/>

    <div className="rsi-stage">
      {listing ? <p>Чтение каталога RSI…</p>
        : loadingImage ? <p>Загрузка PNG…</p>
          : image ? <>
            <img src={image.data_url} alt={'Лист RSI: ' + selected}
              style={{ display: displayMode === 'frames' && frameLayout ? 'none' : 'block' }}
              width={dimensions ? dimensions.width * zoom : undefined}
              height={dimensions ? dimensions.height * zoom : undefined}
              onError={() => setImageError({
                code: 'RSI_DECODE_FAILED', message: 'Не удалось отобразить PNG.',
                hint: 'Изображение может быть повреждено или иметь неподдерживаемый формат.',
              })}/>
            {displayMode === 'frames' && frameLayout && dimensions && selectedState &&
              <RsiStatePlayer key={(selected ?? '') + ':' + refresh}
                stateName={selectedState.name} imageUrl={image.data_url}
                imageWidth={dimensions.width} imageHeight={dimensions.height}
                layout={frameLayout} zoom={zoom}/>}
          </>
            : <p>{list?.sheets.length ? 'Выберите доступный PNG.' : 'В этом RSI нет PNG-листов.'}</p>}
    </div>
    <details className="rsi-metadata">
      <summary>Метаданные meta.json · {states.length} состояний</summary>
      {states.length > 0 && <p>{states.join(', ')}</p>}
      <pre>{metadata}</pre>
    </details>
    <p className="rsi-caveat">
      Для корректных RSI v1 доступны направления, кадры и анимация с длительностями из meta.json.
      При повреждённых метаданных сохраняется просмотр PNG целиком. Импорт создаёт только
      новые PNG и требует подтверждения текущей ревизии meta.json.
      Удаление состояния возможно только после сохранения его резервной копии.
      Восстановление из архива не перезаписывает существующие PNG.
    </p>
  </section>;
}

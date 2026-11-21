import { useEffect, useMemo, useState } from 'react';
import { AlertCircle, RefreshCw } from 'lucide-react';
import { studio, type RsiSheetImage, type RsiSheetList } from '../lib/api';
import { normalizeStudioError, type StudioError } from '../lib/errors';

function Failure({ error }: { error: StudioError }) {
  return <div className="rsi-error" role="alert"><AlertCircle size={16}/>
    <span><strong>{error.message}</strong> {error.hint} <code>{error.code}</code></span>
    {error.details && <details><summary>Технические сведения</summary><pre>{error.details}</pre></details>}
  </div>;
}

/** Load one PNG at a time; do not expose project paths to the webview filesystem. */
export default function RsiPreview({ path, metadata }: { path: string; metadata: string }) {
  const [refresh, setRefresh] = useState(0);
  const [listing, setListing] = useState(true);
  const [list, setList] = useState<RsiSheetList | null>(null);
  const [listError, setListError] = useState<StudioError | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [image, setImage] = useState<RsiSheetImage | null>(null);
  const [imageError, setImageError] = useState<StudioError | null>(null);
  const [loadingImage, setLoadingImage] = useState(false);
  const [zoom, setZoom] = useState(4);
  const [dimensions, setDimensions] = useState<{ width: number; height: number } | null>(null);

  const states = useMemo((): string[] => {
    try {
      const parsed: unknown = JSON.parse(metadata);
      if (typeof parsed !== 'object' || parsed === null || !('states' in parsed)) return [];
      if (!Array.isArray(parsed.states)) return [];
      return parsed.states.flatMap((item: unknown) =>
        typeof item === 'object' && item !== null && 'name' in item && typeof item.name === 'string'
          ? [item.name] : []);
    } catch { return []; }
  }, [metadata]);

  useEffect(() => {
    let active = true;
    setListing(true);
    setList(null);
    setListError(null);
    setSelected(null);
    void studio.listRsiSheets(path).then((result) => {
      if (!active) return;
      setList(result);
      setSelected(result.sheets.find((sheet) => sheet.previewable)?.name ?? null);
    }).catch((failure: unknown) => {
      if (active) setListError(normalizeStudioError(failure));
    }).finally(() => { if (active) setListing(false); });
    return () => { active = false; };
  }, [path, refresh]);

  useEffect(() => {
    let active = true;
    setImage(null);
    setImageError(null);
    setDimensions(null);
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
      <button type="button" disabled={listing} onClick={() => setRefresh((x) => x + 1)}>
        <RefreshCw size={14}/> Обновить
      </button>
    </header>
    {listError && <Failure error={listError}/>}
    {list?.warnings.map((warning) => <p key={warning} className="rsi-warning">{warning}</p>)}
    {imageError && <Failure error={imageError}/>}
    <div className="rsi-stage">
      {listing ? <p>Чтение каталога RSI…</p>
        : loadingImage ? <p>Загрузка PNG…</p>
          : image ? <img src={image.data_url} alt={`Лист RSI: ${selected}`}
            width={dimensions ? dimensions.width * zoom : undefined}
            height={dimensions ? dimensions.height * zoom : undefined}
            onLoad={(event) => setDimensions({
              width: event.currentTarget.naturalWidth,
              height: event.currentTarget.naturalHeight,
            })}
            onError={() => setImageError({
              code: 'RSI_DECODE_FAILED', message: 'Не удалось отобразить PNG.',
              hint: 'Изображение может быть повреждено или иметь неподдерживаемый формат.',
            })}/>
            : <p>{list?.sheets.length ? 'Выберите доступный PNG.' : 'В этом RSI нет PNG-листов.'}</p>}
    </div>
    <details className="rsi-metadata">
      <summary>Метаданные meta.json · {states.length} состояний</summary>
      {states.length > 0 && <p>{states.join(', ')}</p>}
      <pre>{metadata}</pre>
    </details>
    <p className="rsi-caveat">Показан исходный PNG-лист без нарезки кадров и воспроизведения анимации. Файлы не изменяются.</p>
  </section>;
}

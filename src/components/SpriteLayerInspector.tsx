import { useEffect, useState } from 'react';
import { AlertCircle, ArrowUpRight, Image as ImageIcon, Layers } from 'lucide-react';
import { studio, type SourceSpriteLayer, type SourceSpriteLink } from '../lib/api';
import { normalizeStudioError } from '../lib/errors';
import {
  buildRsiFrameLayout, isRsiLayoutError, parseRsiMetadata, selectRsiPreviewState, type RsiFrameLayout,
} from '../lib/rsi-layout';
import RsiStatePlayer from './RsiStatePlayer';
import { useI18n } from '../i18n';
import { spriteZoom, SPRITE_DEFAULT_ZOOM } from '../lib/sprite-zoom';

interface Props {
  sprite: SourceSpriteLink | null;
  layers: SourceSpriteLayer[];
  total: number;
  busy: boolean;
  onOpenRsi: (path: string, state: string | null) => void;
}

interface LayerTarget {
  key: string;
  label: string;
  path: string | null;
  state: string | null;
  indexed: boolean;
  visible: boolean | null;
  shader: string | null;
  defaultPath: boolean;
}

interface FramePreview {
  path: string;
  state: string;
  requestedState: string | null;
  dataUrl: string;
  imageWidth: number;
  imageHeight: number;
  layout: RsiFrameLayout;
}

function targetsFor(sprite: SourceSpriteLink | null, layers: SourceSpriteLayer[]): LayerTarget[] {
  const items: LayerTarget[] = [];
  if (sprite) items.push({
    key: 'base', label: 'Sprite.state', path: sprite.path, state: sprite.state,
    indexed: sprite.indexed, visible: true, shader: null, defaultPath: false,
  });
  for (const layer of layers) {
    items.push({
      key: 'layer:' + layer.index, label: 'Слой ' + (layer.index + 1),
      path: layer.path, state: layer.state, indexed: layer.indexed,
      visible: layer.visible, shader: layer.shader, defaultPath: layer.default_path,
    });
  }
  return items;
}

function failureMessage(failure: unknown): string {
  if (failure instanceof Error) return failure.message;
  const normalized = normalizeStudioError(failure);
  return normalized.message + (normalized.hint ? ' ' + normalized.hint : '');
}

/** Source-level Sprite preview: one explicit state at a time, never a guessed
 * runtime composite. The existing bounded Rust RSI reader owns all PNG IO. */
export default function SpriteLayerInspector({ sprite, layers, total, busy, onOpenRsi }: Props) {
  const { t } = useI18n();
  const [zoom, setZoom] = useState(SPRITE_DEFAULT_ZOOM);
  const targets = targetsFor(sprite, layers);
  const [selectedKey, setSelectedKey] = useState(() => {
    const first = targets.find((item) => item.key.startsWith('layer:')
      && item.visible !== false && item.indexed && item.state);
    return first?.key ?? (sprite ? 'base' : targets[0]?.key ?? '');
  });
  const selected = targets.find((target) => target.key === selectedKey) ?? targets[0] ?? null;
  const [preview, setPreview] = useState<FramePreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectedPath = selected?.path ?? null;
  const selectedState = selected?.state ?? null;
  const selectedIndexed = selected?.indexed ?? false;

  useEffect(() => {
    let active = true;
    setPreview(null);
    setError(null);
    if (!selectedPath || !selectedIndexed) {
      setLoading(false);
      return () => { active = false; };
    }
    setLoading(true);
    void (async () => {
      const document = await studio.readResource(selectedPath);
      const parsed = parseRsiMetadata(document.content);
      if (!parsed.size) throw new Error(parsed.errors[0] ?? 'RSI не содержит корректного размера кадра.');
      const state = selectRsiPreviewState(parsed.states, selectedState);
      if (!state) throw new Error(parsed.errors[0] ?? t('sprite.noStates'));
      const sheet = await studio.readRsiSheet(selectedPath, state.name + '.png');
      const layout = buildRsiFrameLayout(parsed.size, state, sheet.width, sheet.height);
      if (isRsiLayoutError(layout)) throw new Error(layout.error);
      if (active) setPreview({
        path: selectedPath, state: state.name, requestedState: selectedState, dataUrl: sheet.data_url,
        imageWidth: sheet.width, imageHeight: sheet.height, layout,
      });
    })().catch((failure: unknown) => {
      if (active) setError(failureMessage(failure));
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [selectedPath, selectedState, selectedIndexed, t]);

  if (!targets.length) return null;
  const matches = preview?.path === selectedPath && preview.requestedState === selectedState;
  const canNavigate = Boolean(selected?.path && selected.indexed);
  return <div className="sprite-layer-inspector" aria-label="Просмотр Sprite и слоёв">
    <div className="sprite-layer-title">
      <strong><Layers size={14}/> Sprite / слои</strong>
      <small>{total} слоёв в исходном YAML</small>
    </div>
    {total > layers.length && <p className="sprite-layer-hint">
      Показаны первые {layers.length} из {total} слоёв; остальные доступны в исходном YAML.
    </p>}
    <div className="sprite-layer-options" role="group" aria-label="Выбор слоя Sprite">
      {targets.map((target) => <button type="button" key={target.key}
        aria-pressed={selected?.key === target.key}
        className={selected?.key === target.key ? 'selected' : ''}
        onClick={() => setSelectedKey(target.key)}>
        {target.label}
        {target.visible === false ? ' · скрыт' : ''}
        {!target.indexed ? ' · нет RSI' : ''}
      </button>)}
    </div>
    {selected && <div className="sprite-layer-detail">
      <div className="sprite-layer-summary">
        <ImageIcon size={14}/>
        <div>
          <strong>{selected.state ?? 'Состояние явно не задано'}</strong>
          <small>{selected.path ?? 'Без прямого пути RSI'}
            {selected.defaultPath ? ' · путь взят из Sprite.sprite' : ''}
            {selected.shader ? ' · shader: ' + selected.shader : ''}
          </small>
        </div>
        {canNavigate && <button type="button" disabled={busy}
          title="Открыть этот RSI в полноценном редакторе"
          onClick={() => onOpenRsi(selected.path!, selected.state)}>
          <ArrowUpRight size={14}/> RSI
        </button>}
      </div>
      {selected.visible === false && <p className="sprite-layer-hint">
        Слой помечен visible: false. Он показан только для изучения источника.
      </p>}
      {!selected.path ? <p className="sprite-layer-hint">
        В исходном YAML нет безопасного прямого пути RSI. Путь может задаваться наследованием или динамически.
      </p> : !selected.indexed ? <p className="sprite-layer-hint">
        RSI не найден в индексе открытого проекта. Проверьте путь Sprite.sprite.
      </p> : loading ? <p role="status" className="sprite-layer-hint">Чтение RSI и PNG…</p>
        : error ? <p role="alert" className="sprite-layer-error"><AlertCircle size={14}/>{error}</p>
          : matches && preview ? <>{preview.state !== selectedState && <p className="sprite-layer-hint">
              {t('sprite.fallback', { state: preview.state })}
            </p>}<div className="sprite-zoom" role="group" aria-label={t('sprite.zoom')}>
              <button type="button" disabled={zoom <= 0.5} aria-label={t('sprite.zoomOut')}
                onClick={() => setZoom((value) => spriteZoom(value, -1))}>−</button>
              <output aria-live="polite">{Math.round(zoom * 100)}%</output>
              <button type="button" onClick={() => setZoom(SPRITE_DEFAULT_ZOOM)}>{t('sprite.zoomReset')}</button>
              <button type="button" disabled={zoom >= 16} aria-label={t('sprite.zoomIn')}
                onClick={() => setZoom((value) => spriteZoom(value, 1))}>+</button>
            </div><RsiStatePlayer
              imageUrl={preview.dataUrl} imageWidth={preview.imageWidth} imageHeight={preview.imageHeight}
              layout={preview.layout} stateName={preview.state} zoom={zoom}
              onZoomWheel={(direction) => setZoom((value) => spriteZoom(value, direction))}/></>
            : <p className="sprite-layer-hint">Выберите состояние для просмотра.</p>}
    </div>}
    <p className="sprite-layer-hint">
      Предпросмотр показывает один исходный слой/состояние, а не итоговую композицию:
      смещения, shader, map и runtime-анимации не вычисляются.
    </p>
  </div>;
}

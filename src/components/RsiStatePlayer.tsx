import { useEffect, useRef, useState } from 'react';
import { Pause, Play, SkipBack, SkipForward } from 'lucide-react';
import {
  RSI_DIRECTIONS, type RsiFrameLayout,
} from '../lib/rsi-layout';

interface Props {
  imageUrl: string;
  imageWidth: number;
  imageHeight: number;
  stateName: string;
  layout: RsiFrameLayout;
  zoom: number;
  onZoomWheel?: (direction: -1 | 1) => void;
}

export default function RsiStatePlayer({
  imageUrl, imageWidth, imageHeight, stateName, layout, zoom, onZoomWheel,
}: Props) {
  const [direction, setDirection] = useState(0);
  const [frameIndex, setFrameIndex] = useState(0);
  const [playing, setPlaying] = useState(true);
  const canvasRef = useRef<HTMLDivElement>(null);
  const zoomWheelRef = useRef(onZoomWheel);
  zoomWheelRef.current = onZoomWheel;
  const frames = layout.directions[direction] ?? [];
  const currentFrame = frames[frameIndex] ?? frames[0] ?? null;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (event: WheelEvent) => {
      if (!zoomWheelRef.current || event.deltaY === 0) return;
      event.preventDefault();
      zoomWheelRef.current(event.deltaY < 0 ? 1 : -1);
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, []);

  useEffect(() => {
    setDirection(0);
    setFrameIndex(0);
    setPlaying(true);
  }, [stateName, imageUrl]);

  useEffect(() => {
    if (!playing || frames.length < 2 || !currentFrame) return;
    const delay = Math.max(40, Math.round(currentFrame.duration * 1000));
    const timer = window.setTimeout(() => {
      setFrameIndex((current) => (current + 1) % frames.length);
    }, delay);
    return () => window.clearTimeout(timer);
  }, [playing, frames.length, currentFrame]);

  const selectDirection = (next: number) => {
    setDirection(next);
    setFrameIndex(0);
  };
  const selectFrame = (next: number) => {
    setPlaying(false);
    setFrameIndex(next);
  };

  return <div className="rsi-player">
    <div className="rsi-player-controls">
      <label>Направление
        <select aria-label="Направление RSI" value={direction}
          onChange={(event) => selectDirection(Number(event.target.value))}>
          {layout.directions.map((_, index) =>
            <option key={index} value={index}>
              {RSI_DIRECTIONS[index]} · {layout.directions[index].length} кадров
            </option>)}
        </select>
      </label>
      <button type="button" disabled={frames.length < 2}
        onClick={() => setPlaying((current) => !current)}>
        {playing ? <Pause size={14}/> : <Play size={14}/>}
        {playing ? 'Пауза' : 'Воспроизвести'}
      </button>
      <button type="button" disabled={frames.length < 2}
        aria-label="Предыдущий кадр"
        onClick={() => selectFrame((frameIndex + frames.length - 1) % frames.length)}>
        <SkipBack size={15}/>
      </button>
      <button type="button" disabled={frames.length < 2}
        aria-label="Следующий кадр"
        onClick={() => selectFrame((frameIndex + 1) % frames.length)}>
        <SkipForward size={15}/>
      </button>
      <span className="rsi-player-counter">Кадр {frameIndex + 1}/{frames.length} ·
        {currentFrame?.duration.toFixed(3) ?? '?'} с</span>
    </div>
    <div ref={canvasRef} className="rsi-player-canvas" aria-label={'Кадр RSI: ' + stateName}>
      {currentFrame && <div className="rsi-frame-viewport"
        style={{ width: layout.width * zoom, height: layout.height * zoom }}>
        <img src={imageUrl} alt={'Состояние ' + stateName + ', '
          + RSI_DIRECTIONS[direction] + ', кадр ' + (frameIndex + 1)}
          draggable={false}
          style={{
            position: 'absolute',
            left: -currentFrame.x * zoom,
            top: -currentFrame.y * zoom,
            width: imageWidth * zoom,
            height: imageHeight * zoom,
          }}/>
      </div>}
    </div>
    {frames.length > 1 && <label className="rsi-player-timeline">
      Кадры
      <input type="range" min={0} max={frames.length - 1} step={1} value={frameIndex}
        onChange={(event) => selectFrame(Number(event.target.value))}
        aria-label="Кадр анимации RSI"/>
      <span>{frameIndex + 1}/{frames.length}</span>
    </label>}
    <p className="rsi-player-description">
      Кадры расположены по направлениям, затем по времени; длительности взяты из meta.json.
      Просмотр не изменяет исходные PNG.
    </p>
  </div>;
}

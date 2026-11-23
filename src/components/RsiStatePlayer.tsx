import { useI18n } from '../i18n';
import { useEffect, useRef, useState } from 'react';
import { Pause, Play, SkipBack, SkipForward } from 'lucide-react';
import {
  type RsiFrameLayout,
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
  const { t } = useI18n();
  const directionNames = [t('rsi.player.south'), t('rsi.player.north'), t('rsi.player.east'), t('rsi.player.west'),
    t('rsi.player.southeast'), t('rsi.player.southwest'), t('rsi.player.northeast'), t('rsi.player.northwest')];
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
      <label>{t('rsi.player.direction')}
        <select aria-label={t('rsi.player.directionLabel')} value={direction}
          onChange={(event) => selectDirection(Number(event.target.value))}>
          {layout.directions.map((_, index) =>
            <option key={index} value={index}>
              {t('rsi.player.option', { direction: directionNames[index], count: layout.directions[index].length })}
            </option>)}
        </select>
      </label>
      <button type="button" disabled={frames.length < 2}
        onClick={() => setPlaying((current) => !current)}>
        {playing ? <Pause size={14}/> : <Play size={14}/>}
        {playing ? t('rsi.player.pause') : t('rsi.player.play')}
      </button>
      <button type="button" disabled={frames.length < 2}
        aria-label={t('rsi.player.previous')}
        onClick={() => selectFrame((frameIndex + frames.length - 1) % frames.length)}>
        <SkipBack size={15}/>
      </button>
      <button type="button" disabled={frames.length < 2}
        aria-label={t('rsi.player.next')}
        onClick={() => selectFrame((frameIndex + 1) % frames.length)}>
        <SkipForward size={15}/>
      </button>
      <span className="rsi-player-counter">{t('rsi.player.counter', { frame: frameIndex + 1, total: frames.length, duration: currentFrame?.duration.toFixed(3) ?? '?' })}</span>
    </div>
    <div ref={canvasRef} className="rsi-player-canvas" aria-label={t('rsi.player.canvas', { name: stateName })}>
      {currentFrame && <div className="rsi-frame-viewport"
        style={{ width: layout.width * zoom, height: layout.height * zoom }}>
        <img src={imageUrl} alt={t('rsi.player.alt', { name: stateName, direction: directionNames[direction], frame: frameIndex + 1 })}
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
      {t('rsi.player.frames')}
      <input type="range" min={0} max={frames.length - 1} step={1} value={frameIndex}
        onChange={(event) => selectFrame(Number(event.target.value))}
        aria-label={t('rsi.player.timeline')}/>
      <span>{frameIndex + 1}/{frames.length}</span>
    </label>}
    <p className="rsi-player-description">
      {t('rsi.player.help')}
    </p>
  </div>;
}

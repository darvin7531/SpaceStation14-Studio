import { useState, type FormEvent } from 'react';
import { AlertCircle, Save } from 'lucide-react';
import type { ImportedRsiState } from '../lib/api';
import { studio } from '../lib/api';
import { normalizeStudioError, type StudioError } from '../lib/errors';
import { RSI_DIRECTIONS, type RsiState } from '../lib/rsi-layout';

interface Props {
  path: string;
  revision: string;
  state: RsiState;
  onUpdated: (result: ImportedRsiState) => void;
}

/**
 * Only edit the existing animation delays. Direction count and number of
 * frames are deliberately immutable because changing either needs a PNG edit.
 */
export default function RsiTimingPanel({ path, revision, state, onUpdated }: Props) {
  const [delays, setDelays] = useState<number[][]>(
    () => state.delays.map((direction) => [...direction]),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<StudioError | null>(null);
  const frameCount = delays.reduce((count, direction) => count + direction.length, 0);
  const supported = frameCount <= 256 && delays.every((direction) => direction.length <= 128);
  const valid = supported && delays.every((direction) => direction.every(
    (seconds) => Number.isFinite(seconds) && seconds >= 0.01 && seconds <= 60,
  ));
  const changed = delays.some((direction, index) => direction.some(
    (seconds, frame) => seconds !== state.delays[index]?.[frame],
  ));

  function edit(direction: number, frame: number, seconds: number) {
    setDelays((before) => before.map((values, dir) => dir === direction
      ? values.map((value, index) => index === frame ? seconds : value)
      : values,
    ));
    setError(null);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!valid || saving || !changed) return;
    setSaving(true);
    setError(null);
    try {
      const updated = await studio.updateRsiTiming({
        path, expected_revision: revision, name: state.name, delays,
      });
      onUpdated(updated);
    } catch (failure) {
      setError(normalizeStudioError(failure));
    } finally {
      setSaving(false);
    }
  }

  return <details className="rsi-timing-panel">
    <summary><Save size={15}/> Задержки кадров: {state.name}</summary>
    <form onSubmit={(event) => void submit(event)}>
      <p>Изменяются только длительности кадров в <code>meta.json</code>.
        Число кадров, направления и сами PNG останутся прежними. Сохранение проверяет ревизию файла.</p>
      {!supported ? <p role="status">
        Для этого состояния более 256 кадров либо более 128 на направление.
        Изменение длительностей в Studio пока недоступно.
      </p> : <div className="rsi-timing-directions">
        {delays.map((values, direction) =>
          <fieldset key={direction} disabled={saving}>
            <legend>{RSI_DIRECTIONS[direction]} · {values.length} кадров</legend>
            <div className="rsi-timing-frame-grid">
              {values.map((seconds, frame) =>
                <label key={frame}>Кадр {frame + 1}
                  <input aria-label={`${RSI_DIRECTIONS[direction]} кадр ${frame + 1} задержка`}
                    type="number" min={0.01} max={60} step="any" required
                    value={Number.isFinite(seconds) ? seconds : ''}
                    onChange={(event) => edit(direction, frame, Number(event.target.value))}/>
                </label>)}
            </div>
          </fieldset>)}
      </div>}
      {error && <div className="rsi-error" role="alert">
        <AlertCircle size={15}/>
        <span>{error.message} {error.hint} <code>{error.code}</code></span>
      </div>}
      <button type="submit" disabled={!valid || !changed || saving}>
        <Save size={15}/>{saving ? 'Сохраняю…' : 'Сохранить задержки'}
      </button>
    </form>
  </details>;
}

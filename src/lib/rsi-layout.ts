/**
 * SS14/Robust RSI v1 sprite-sheet layout.
 * States are separate PNGs, sprites are row-major and grouped by direction
 * (all South frames, then North, East, West, ...). Timings are seconds.
 *
 * Pure helpers deliberately do not rewrite meta.json or any PNG.
 */
export interface RsiSize {
  x: number;
  y: number;
}

export interface RsiState {
  name: string;
  directions: 1 | 4 | 8;
  delays: number[][];
}

export interface RsiMetadata {
  size: RsiSize | null;
  states: RsiState[];
  errors: string[];
  warnings: string[];
}

export interface RsiSpriteFrame {
  x: number;
  y: number;
  duration: number;
  frameIndex: number;
  directionIndex: number;
}

export interface RsiFrameLayout {
  width: number;
  height: number;
  columns: number;
  rows: number;
  directions: RsiSpriteFrame[][];
  warnings: string[];
}

export const RSI_DIRECTIONS = [
  'Юг', 'Север', 'Восток', 'Запад',
  'Юго-восток', 'Юго-запад', 'Северо-восток', 'Северо-запад',
] as const;

const MAX_STATES = 512;
const MAX_FRAMES = 4096;
const MAX_FRAME_SIZE = 4096;
const MAX_PNG_DIMENSION = 16384;
const MAX_PLAYBACK_SECONDS = 3600;

function integer(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
    && value >= minimum && value <= maximum;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Invalid states are skipped individually; the sheet remains viewable. */
export function parseRsiMetadata(text: string): RsiMetadata {
  const errors: string[] = [];
  const warnings: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return {
      size: null, states: [], warnings,
      errors: ['Невозможно разобрать meta.json: ' + (error instanceof Error ? error.message : String(error))],
    };
  }
  if (!record(parsed)) {
    return { size: null, states: [], warnings, errors: ['meta.json должен содержать JSON-объект.'] };
  }
  if (parsed.version !== 1) {
    warnings.push('Версия RSI отличается от 1. Раскладка кадров может отличаться от поддерживаемого формата.');
  }
  let size: RsiSize | null = null;
  if (record(parsed.size)
    && integer(parsed.size.x, 1, MAX_FRAME_SIZE)
    && integer(parsed.size.y, 1, MAX_FRAME_SIZE)) {
    size = { x: parsed.size.x, y: parsed.size.y };
  } else {
    errors.push('meta.json: size.x и size.y должны быть целыми числами от 1 до 4096.');
  }
  const rawStates = parsed.states;
  if (!Array.isArray(rawStates)) {
    errors.push('meta.json: states должен быть массивом.');
    return { size, states: [], errors, warnings };
  }
  if (rawStates.length > MAX_STATES) {
    errors.push('В meta.json слишком много состояний (лимит ' + MAX_STATES + ').');
    return { size, states: [], errors, warnings };
  }
  const states: RsiState[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < rawStates.length; index++) {
    const input: unknown = rawStates[index];
    if (!record(input)) {
      warnings.push('Состояние №' + (index + 1) + ' не является объектом.');
      continue;
    }
    const name = input.name;
    if (typeof name !== 'string' || !/^[a-z0-9_-]{1,128}$/.test(name)) {
      warnings.push('Состояние №' + (index + 1) + ': недопустимое имя для PNG.');
      continue;
    }
    if (seen.has(name)) {
      warnings.push('Повторное объявление состояния «' + name + '» пропущено.');
      continue;
    }
    seen.add(name);
    const dir = input.directions ?? 1;
    if (dir !== 1 && dir !== 4 && dir !== 8) {
      warnings.push('Состояние «' + name + '»: directions должно быть 1, 4 или 8.');
      continue;
    }
    const directions: 1 | 4 | 8 = dir;
    let delays: number[][] = Array.from({ length: directions }, () => [1]);
    if (input.delays !== undefined) {
      if (!Array.isArray(input.delays) || input.delays.length !== directions
        || !input.delays.every((direction: unknown) => Array.isArray(direction)
          && direction.length > 0
          && direction.every((seconds: unknown) =>
            typeof seconds === 'number' && Number.isFinite(seconds)
            && seconds > 0 && seconds <= MAX_PLAYBACK_SECONDS))) {
        warnings.push('Состояние «' + name + '»: delays должен содержать '
          + directions + ' непустых массивов положительных длительностей (секунды).');
        continue;
      }
      delays = input.delays as number[][];
    }
    const count = delays.reduce((sum, direction) => sum + direction.length, 0);
    if (count > MAX_FRAMES) {
      warnings.push('Состояние «' + name + '»: больше ' + MAX_FRAMES + ' кадров.');
      continue;
    }
    states.push({ name, directions, delays });
  }
  return { size, states, errors, warnings };
}

/**
 * A sprite sheet is filled left-to-right, top-to-bottom. Its grid may have
 * trailing empty slots; never silently invent a frame that metadata lacks.
 */
export function buildRsiFrameLayout(
  size: RsiSize,
  state: RsiState,
  pngWidth: number,
  pngHeight: number,
): RsiFrameLayout | { error: string } {
  if (!integer(size.x, 1, MAX_FRAME_SIZE) || !integer(size.y, 1, MAX_FRAME_SIZE)) {
    return { error: 'Недопустимый размер кадра в meta.json.' };
  }
  if (!integer(pngWidth, 1, MAX_PNG_DIMENSION)
    || !integer(pngHeight, 1, MAX_PNG_DIMENSION)) {
    return { error: 'Размер PNG выходит за допустимые пределы предпросмотра.' };
  }
  if (pngWidth % size.x !== 0 || pngHeight % size.y !== 0) {
    return { error: 'Размер PNG не кратен размеру кадра '
      + size.x + '×' + size.y + ' из meta.json.' };
  }
  const columns = pngWidth / size.x;
  const rows = pngHeight / size.y;
  const expected = state.delays.reduce((sum, direction) => sum + direction.length, 0);
  if (expected > columns * rows) {
    return { error: 'PNG содержит ' + (columns * rows) + ' ячеек, а meta.json требует ' + expected + '.' };
  }
  const warnings: string[] = [];
  if (expected < columns * rows) {
    warnings.push('PNG содержит ' + (columns * rows - expected)
      + ' дополнительных ячеек. Они не включены в анимацию.');
  }
  let ordinal = 0;
  const directions: RsiSpriteFrame[][] = state.delays.map((durations, directionIndex) =>
    durations.map((duration, frameIndex) => {
      const x = ordinal % columns * size.x;
      const y = Math.floor(ordinal / columns) * size.y;
      ordinal++;
      return { x, y, duration, frameIndex, directionIndex };
    }),
  );
  return {
    width: size.x, height: size.y, columns, rows, directions, warnings,
  };
}

export function isRsiLayoutError(
  result: RsiFrameLayout | { error: string },
): result is { error: string } {
  return 'error' in result;
}

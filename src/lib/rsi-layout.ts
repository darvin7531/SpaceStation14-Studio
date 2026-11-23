import { uiText, type Language } from './ui-language';

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

export function selectRsiPreviewState(states: RsiState[], requested: string | null): RsiState | undefined {
  return states.find((state) => state.name === requested) ?? states[0];
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

/** Unique safe names eligible for metadata-only deletion. */
function deletableRsiStateNames(text: string): string[] {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return []; }
  if (!record(parsed) || parsed.version !== 1 || !Array.isArray(parsed.states)
    || parsed.states.length > MAX_STATES) return [];
  const names = parsed.states.flatMap((state: unknown) =>
    record(state) && typeof state.name === 'string' ? [state.name] : []);
  return names.filter((name, index) => /^[a-z0-9_-]{1,128}$/.test(name)
    && names.indexOf(name) === index && names.lastIndexOf(name) === index);
}

export function missingRsiStateNames(text: string, sheets: string[]): string[] {
  return deletableRsiStateNames(text).filter((name) => !sheets.includes(name + '.png'));
}

export function invalidPresentRsiStateNames(text: string, sheets: string[]): string[] {
  const playable = parseRsiMetadata(text).states;
  return deletableRsiStateNames(text).filter((name) => sheets.includes(name + '.png')
    && !playable.some((state) => state.name === name));
}

/** Invalid states are skipped individually; the sheet remains viewable. */
export function parseRsiMetadata(text: string, language: Language = 'ru'): RsiMetadata {
  const errors: string[] = [];
  const warnings: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return {
      size: null, states: [], warnings,
      errors: [uiText(language, 'rsi.layout.json', { detail: error instanceof Error ? error.message : String(error) })],
    };
  }
  if (!record(parsed)) {
    return { size: null, states: [], warnings, errors: [uiText(language, 'rsi.layout.object')] };
  }
  if (parsed.version !== 1) {
    warnings.push(uiText(language, 'rsi.layout.version'));
  }
  let size: RsiSize | null = null;
  if (record(parsed.size)
    && integer(parsed.size.x, 1, MAX_FRAME_SIZE)
    && integer(parsed.size.y, 1, MAX_FRAME_SIZE)) {
    size = { x: parsed.size.x, y: parsed.size.y };
  } else {
    errors.push(uiText(language, 'rsi.layout.size'));
  }
  const rawStates = parsed.states;
  if (!Array.isArray(rawStates)) {
    errors.push(uiText(language, 'rsi.layout.states'));
    return { size, states: [], errors, warnings };
  }
  if (rawStates.length > MAX_STATES) {
    errors.push(uiText(language, 'rsi.layout.limit', { count: MAX_STATES }));
    return { size, states: [], errors, warnings };
  }
  const states: RsiState[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < rawStates.length; index++) {
    const input: unknown = rawStates[index];
    if (!record(input)) {
      warnings.push(uiText(language, 'rsi.layout.stateObject', { index: index + 1 }));
      continue;
    }
    const name = input.name;
    if (typeof name !== 'string' || !/^[a-z0-9_-]{1,128}$/.test(name)) {
      warnings.push(uiText(language, 'rsi.layout.stateName', { index: index + 1 }));
      continue;
    }
    if (seen.has(name)) {
      warnings.push(uiText(language, 'rsi.layout.duplicate', { name }));
      continue;
    }
    seen.add(name);
    const dir = input.directions === undefined ? 1 : input.directions;
    if (dir !== 1 && dir !== 4 && dir !== 8) {
      warnings.push(uiText(language, 'rsi.layout.directions', { name }));
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
        warnings.push(uiText(language, 'rsi.layout.delays', { name, count: directions }));
        continue;
      }
      delays = input.delays as number[][];
    }
    const count = delays.reduce((sum, direction) => sum + direction.length, 0);
    if (count > MAX_FRAMES) {
      warnings.push(uiText(language, 'rsi.layout.frames', { name, count: MAX_FRAMES }));
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
  language: Language = 'ru',
): RsiFrameLayout | { error: string } {
  if (!integer(size.x, 1, MAX_FRAME_SIZE) || !integer(size.y, 1, MAX_FRAME_SIZE)) {
    return { error: uiText(language, 'rsi.layout.invalidCell') };
  }
  if (!integer(pngWidth, 1, MAX_PNG_DIMENSION)
    || !integer(pngHeight, 1, MAX_PNG_DIMENSION)) {
    return { error: uiText(language, 'rsi.layout.pngSize') };
  }
  if (pngWidth % size.x !== 0 || pngHeight % size.y !== 0) {
    return { error: uiText(language, 'rsi.layout.multiple', { width: size.x, height: size.y }) };
  }
  const columns = pngWidth / size.x;
  const rows = pngHeight / size.y;
  const expected = state.delays.reduce((sum, direction) => sum + direction.length, 0);
  if (expected > columns * rows) {
    return { error: uiText(language, 'rsi.layout.insufficient', { actual: columns * rows, expected }) };
  }
  const warnings: string[] = [];
  if (expected < columns * rows) {
    warnings.push(uiText(language, 'rsi.layout.extra', { count: columns * rows - expected }));
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

/** Regroup existing frames in sheet order, retaining edits and original row lengths. */
export function regroupRsiDelays(delays: number[][], original: number[][], count: number): number[][] | null {
  const flat = delays.flat();
  const lengths = count === original.length
    ? original.map((row) => row.length)
    : Array.from({ length: count }, () => flat.length / count);
  if (flat.length > 256 || lengths.some((length) => !Number.isInteger(length) || length < 1 || length > 128)
    || lengths.reduce((sum, length) => sum + length, 0) !== flat.length) return null;
  let offset = 0;
  return lengths.map((length) => { const row = flat.slice(offset, offset + length); offset += length; return row; });
}

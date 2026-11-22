export const SPRITE_DEFAULT_ZOOM = 4;

/** Electron inspector uses half-step zoom between 50% and 1600%. */
export function spriteZoom(current: number, direction: -1 | 1): number {
  return Number.isFinite(current)
    ? Math.min(16, Math.max(0.5, current + direction * 0.5))
    : SPRITE_DEFAULT_ZOOM;
}

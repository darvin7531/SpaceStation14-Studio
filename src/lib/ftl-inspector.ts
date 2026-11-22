import { localeFromFtlPath } from './localization-settings';

/** The original Electron FTL inspector reports the selected game's file
 * metadata, not the Studio UI language or a cross-language fallback.
 */
export function ftlInspectorDetails(path: string, text: string, entryCount: number | null) {
  return {
    path,
    locale: localeFromFtlPath(path),
    entries: entryCount !== null && Number.isSafeInteger(entryCount) && entryCount >= 0
      ? entryCount : null,
    characters: text.length,
  };
}

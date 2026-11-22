import type { EntityLocalizationAnalysis } from './api';

/** Electron Inspector parity: only existing FTL files with missing translations.
 * The independent Studio interface language is intentionally not consulted.
 */
export function missingLocaleFiles(analysis: EntityLocalizationAnalysis | null): {
  locale: string;
  path: string;
}[] {
  if (!analysis?.complete) return [];
  const seen = new Set<string>();
  const available: { locale: string; path: string }[] = [];
  for (const diagnostic of analysis.diagnostics) {
    for (const target of diagnostic.targets) {
      if (!diagnostic.missing_locales.includes(target.locale)
        || !target.file_exists
        || !target.path.startsWith('Resources/Locale/')
        || !target.path.toLowerCase().endsWith('.ftl')) continue;
      const key = target.locale + '\u0000' + target.path;
      if (seen.has(key)) continue;
      seen.add(key);
      available.push({ locale: target.locale, path: target.path });
    }
  }
  return available;
}

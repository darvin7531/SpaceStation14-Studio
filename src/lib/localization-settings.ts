/** Project Fluent-locales setting; separate from the UI's ru/en language. */
export interface LocalizationSettings { requiredLocales: string[] }
export const LOCALIZATION_SETTINGS_KEY = 'ss14-studio-localization-settings';
export const DEFAULT_LOCALIZATION_SETTINGS: LocalizationSettings = { requiredLocales: ['ru-RU'] };
const LOCALE = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{2,8}){0,3}$/;

export function sanitizeLocalizationSettings(candidate: unknown): LocalizationSettings {
  const raw = candidate && typeof candidate === 'object' && !Array.isArray(candidate)
    ? (candidate as { requiredLocales?: unknown }).requiredLocales : null;
  const locales: string[] = [];
  const seen = new Set<string>();
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item !== 'string') continue;
      const value = item.trim();
      if (!LOCALE.test(value) || value.length > 48 || seen.has(value.toLowerCase())) continue;
      locales.push(value);
      seen.add(value.toLowerCase());
      if (locales.length >= 24) break;
    }
  }
  return { requiredLocales: locales.length ? locales : [...DEFAULT_LOCALIZATION_SETTINGS.requiredLocales] };
}

export function readLocalizationSettings(storage: Pick<Storage, 'getItem'>): LocalizationSettings {
  try {
    const raw = storage.getItem(LOCALIZATION_SETTINGS_KEY);
    return raw ? sanitizeLocalizationSettings(JSON.parse(raw) as unknown) : sanitizeLocalizationSettings(null);
  } catch { return sanitizeLocalizationSettings(null); }
}

export function localeResourceSearch(locale: string): string {
  return LOCALE.test(locale) ? '/Locale/' + locale + '/' : '';
}

export function localeFromFtlPath(path: string): string | null {
  const parts = path.replace(/\\/g, '/').split('/');
  for (let i = 0; i + 2 < parts.length; i++) {
    if (parts[i].toLowerCase() === 'resources' && parts[i + 1].toLowerCase() === 'locale') {
      return LOCALE.test(parts[i + 2]) ? parts[i + 2] : null;
    }
  }
  return null;
}

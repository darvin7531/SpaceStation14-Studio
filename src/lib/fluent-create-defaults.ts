import type { NewFluentDraft } from './api';
import { localeFromFtlPath } from './localization-settings';

export function suggestedFluentDraft(preferredFile?: string, suggested?: NewFluentDraft): NewFluentDraft {
  const parent = preferredFile?.slice(0, preferredFile.lastIndexOf('/') + 1);
  const directory = parent?.startsWith('Resources/Locale/') ? parent : 'Resources/Locale/en-US/';
  return {
    file: suggested?.file ?? directory + 'StudioNew.ftl',
    starter_key: suggested?.starter_key ?? 'new-message',
    starter_value: suggested?.starter_value ?? 'New message',
    ...(suggested?.starter_description !== undefined
      ? { starter_description: suggested.starter_description } : {}),
    ...(suggested?.starter_suffix !== undefined
      ? { starter_suffix: suggested.starter_suffix } : {}),
  };
}

/** Electron's separate game-locale picker for the new FTL wizard. Never uses UI language. */
export function moveFluentDraftToLocale(path: string, locale: string): string | null {
  if (!/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{2,8}){0,3}$/.test(locale) || locale.length > 48) return null;
  const normalized = path.replace(/\\/g, '/');
  const prior = localeFromFtlPath(normalized);
  if (!prior) return null;
  const prefix = 'Resources/Locale/' + prior + '/';
  const i = normalized.indexOf(prefix);
  if (i < 0) return null;
  return normalized.slice(0, i) + 'Resources/Locale/' + locale + '/' + normalized.slice(i + prefix.length);
}

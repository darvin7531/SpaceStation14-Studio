import { createContext, ReactNode, useContext, useEffect, useMemo, useState } from 'react';

export interface LocalizationSettings {
  requiredLocales: string[];
}

interface LocalizationSettingsValue {
  settings: LocalizationSettings;
  updateSettings: (patch: Partial<LocalizationSettings>) => void;
}

const STORAGE_KEY = 'ss14-studio-localization-settings';

const defaultSettings: LocalizationSettings = {
  requiredLocales: ['ru-RU'],
};

const LocalizationSettingsContext = createContext<LocalizationSettingsValue | null>(null);

export function LocalizationSettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<LocalizationSettings>(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return defaultSettings;
      return sanitizeSettings(JSON.parse(raw) as Partial<LocalizationSettings>);
    } catch {
      return defaultSettings;
    }
  });

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  }, [settings]);

  const value = useMemo<LocalizationSettingsValue>(() => ({
    settings,
    updateSettings: (patch) => setSettings((current) => sanitizeSettings({ ...current, ...patch })),
  }), [settings]);

  return <LocalizationSettingsContext.Provider value={value}>{children}</LocalizationSettingsContext.Provider>;
}

export function useLocalizationSettings() {
  const value = useContext(LocalizationSettingsContext);
  if (!value) throw new Error('useLocalizationSettings must be used inside LocalizationSettingsProvider.');
  return value;
}

function sanitizeSettings(value: Partial<LocalizationSettings>): LocalizationSettings {
  const requiredLocales = Array.from(new Set((Array.isArray(value.requiredLocales) ? value.requiredLocales : [])
    .map((item) => String(item || '').trim())
    .filter(Boolean)));
  return {
    requiredLocales: requiredLocales.length > 0 ? requiredLocales : defaultSettings.requiredLocales,
  };
}

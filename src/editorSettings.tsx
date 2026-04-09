import { createContext, ReactNode, useContext, useEffect, useMemo, useState } from 'react';

export type EditorLineNumbers = 'on' | 'off' | 'relative';
export type EditorWordWrap = 'on' | 'off';

export interface EditorSettings {
  fontSize: number;
  wordWrap: EditorWordWrap;
  minimap: boolean;
  lineNumbers: EditorLineNumbers;
  tabSize: number;
  liveValidation: boolean;
  validationDelay: number;
  ctrlClickNavigation: boolean;
}

interface EditorSettingsValue {
  settings: EditorSettings;
  updateSettings: (patch: Partial<EditorSettings>) => void;
}

const STORAGE_KEY = 'ss14-studio-editor-settings';

const defaultSettings: EditorSettings = {
  fontSize: 13,
  wordWrap: 'on',
  minimap: false,
  lineNumbers: 'on',
  tabSize: 2,
  liveValidation: true,
  validationDelay: 250,
  ctrlClickNavigation: true,
};

const EditorSettingsContext = createContext<EditorSettingsValue | null>(null);

export function EditorSettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<EditorSettings>(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return defaultSettings;
      const parsed = JSON.parse(raw) as Partial<EditorSettings>;
      return sanitizeSettings(parsed);
    } catch {
      return defaultSettings;
    }
  });

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  }, [settings]);

  const value = useMemo<EditorSettingsValue>(() => ({
    settings,
    updateSettings: (patch) => {
      setSettings((current) => sanitizeSettings({ ...current, ...patch }));
    },
  }), [settings]);

  return <EditorSettingsContext.Provider value={value}>{children}</EditorSettingsContext.Provider>;
}

export function useEditorSettings() {
  const value = useContext(EditorSettingsContext);
  if (!value) throw new Error('useEditorSettings must be used inside EditorSettingsProvider.');
  return value;
}

function sanitizeSettings(value: Partial<EditorSettings>): EditorSettings {
  const fontSize = clampNumber(value.fontSize, 10, 28, defaultSettings.fontSize);
  const validationDelay = clampNumber(value.validationDelay, 100, 1500, defaultSettings.validationDelay);
  const tabSize = [2, 4].includes(Number(value.tabSize)) ? Number(value.tabSize) : defaultSettings.tabSize;
  const wordWrap = value.wordWrap === 'off' ? 'off' : 'on';
  const lineNumbers = value.lineNumbers === 'off' || value.lineNumbers === 'relative' ? value.lineNumbers : 'on';

  return {
    fontSize,
    wordWrap,
    minimap: Boolean(value.minimap),
    lineNumbers,
    tabSize,
    liveValidation: value.liveValidation !== false,
    validationDelay,
    ctrlClickNavigation: value.ctrlClickNavigation !== false,
  };
}

function clampNumber(value: unknown, min: number, max: number, fallback: number) {
  const next = Number(value);
  if (Number.isNaN(next)) return fallback;
  return Math.max(min, Math.min(max, next));
}

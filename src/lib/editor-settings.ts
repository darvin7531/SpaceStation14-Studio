export interface EditorSettings {
  fontSize: number;
  tabSize: 2 | 4;
  wordWrap: 'on' | 'off';
  lineNumbers: 'on' | 'off' | 'relative';
  minimap: boolean;
  liveValidation: boolean;
  validationDelay: number;
}
export const SETTINGS_KEY = 'ss14-studio-editor-settings';
export const DEFAULT_EDITOR_SETTINGS: EditorSettings = {
  fontSize: 13, tabSize: 2, wordWrap: 'on', lineNumbers: 'on', minimap: false,
  liveValidation: true, validationDelay: 250,
};
export function sanitizeEditorSettings(candidate: unknown): EditorSettings {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return { ...DEFAULT_EDITOR_SETTINGS };
  const v = candidate as Record<string, unknown>;
  const font = typeof v.fontSize === 'number' && Number.isFinite(v.fontSize) ? Math.round(v.fontSize) : 13;
  return {
    fontSize: Math.min(28, Math.max(10, font)),
    tabSize: v.tabSize === 4 ? 4 : 2,
    wordWrap: v.wordWrap === 'off' ? 'off' : 'on',
    lineNumbers: v.lineNumbers === 'off' || v.lineNumbers === 'relative' ? v.lineNumbers : 'on',
    minimap: v.minimap === true,
    liveValidation: v.liveValidation !== false,
    validationDelay: typeof v.validationDelay === 'number' && Number.isFinite(v.validationDelay)
      ? Math.max(100, Math.min(1500, Math.round(v.validationDelay))) : 250,
  };
}
export function readEditorSettings(storage: Pick<Storage, 'getItem'>): EditorSettings {
  try {
    const raw = storage.getItem(SETTINGS_KEY);
    return raw ? sanitizeEditorSettings(JSON.parse(raw) as unknown) : { ...DEFAULT_EDITOR_SETTINGS };
  } catch { return { ...DEFAULT_EDITOR_SETTINGS }; }
}

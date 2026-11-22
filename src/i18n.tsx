import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { LANGUAGE_STORAGE_KEY, resolveLanguage, uiText, type Language, type UIKey } from './lib/ui-language';

type Context = {
  language: Language;
  setLanguage: (language: Language) => void;
  t: (key: UIKey, params?: Record<string, string | number | null | undefined>) => string;
};
const LanguageContext = createContext<Context | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [language, setLanguage] = useState<Language>(() => {
    try { return resolveLanguage(window.localStorage.getItem(LANGUAGE_STORAGE_KEY)); }
    catch { return 'ru'; }
  });
  useEffect(() => {
    document.documentElement.lang = language;
    try { window.localStorage.setItem(LANGUAGE_STORAGE_KEY, language); }
    catch { /* Storage can be blocked; switching still works. */ }
  }, [language]);
  const value = useMemo<Context>(() => ({
    language,
    setLanguage,
    t: (key, params) => uiText(language, key, params),
  }), [language]);
  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

export function useI18n(): Context {
  const context = useContext(LanguageContext);
  if (!context) throw new Error('useI18n requires I18nProvider.');
  return context;
}

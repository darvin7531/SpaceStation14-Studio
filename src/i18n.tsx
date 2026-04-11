import { createContext, ReactNode, useContext, useEffect, useMemo, useState } from 'react';

type LanguageCode = 'en' | 'ru';
type Dictionary = Record<string, string>;

const modules = import.meta.glob('../languages/*.json', { eager: true, import: 'default' }) as Record<string, Dictionary>;

const dictionaries: Record<LanguageCode, Dictionary> = {
  en: modules['../languages/en.json'] ?? {},
  ru: modules['../languages/ru.json'] ?? {},
};

type I18nValue = {
  language: LanguageCode;
  setLanguage: (language: LanguageCode) => void;
  t: (key: string, params?: Record<string, string | number | null | undefined>) => string;
};

const I18nContext = createContext<I18nValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [language, setLanguageState] = useState<LanguageCode>(() => {
    const stored = localStorage.getItem('ss14-studio-language');
    return stored === 'ru' || stored === 'en' ? stored : 'en';
  });

  useEffect(() => {
    localStorage.setItem('ss14-studio-language', language);
    document.documentElement.lang = language;
  }, [language]);

  const value = useMemo<I18nValue>(() => ({
    language,
    setLanguage: (next) => setLanguageState(next),
    t: (key, params) => translate(language, key, params),
  }), [language]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const value = useContext(I18nContext);
  if (!value) throw new Error('useI18n must be used inside I18nProvider.');
  return value;
}

const TEMPLATE_RE = /\{\{(\w+)\}\}/g;

function translate(language: LanguageCode, key: string, params?: Record<string, string | number | null | undefined>) {
  const dict = dictionaries[language] ?? dictionaries.en;
  const template = dict[key] ?? dictionaries.en[key] ?? key;
  return template.replace(TEMPLATE_RE, (_match, token) => {
    const value = params?.[token];
    return value == null ? '' : String(value);
  });
}

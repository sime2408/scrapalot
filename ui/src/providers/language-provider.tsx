import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import { settings } from '@/lib/storage-utils';

interface LanguageContextType {
  language: string;
  setLanguage: (language: string) => void;
}

const LanguageContext = createContext<LanguageContextType | undefined>(
  undefined
);

// Normalize a raw locale code (e.g. `hr-HR`, `pt-BR`) to the bare code our
// resources are keyed by. Hoisted to module scope so both the mount
// initializer and the i18n `languageChanged` listener use the exact same
// rule — otherwise the listener could store `hr-HR` while the initializer
// stored `hr`, desyncing the Settings dropdown from the live i18n language.
const normalizeLanguageCode = (lang: string): string => {
  const specialCases: Record<string, string> = {
    'zh-CN': 'zh-cn', // Simplified Chinese
    'zh-TW': 'zh-tw', // Traditional Chinese
    'pt-BR': 'pt-br', // Brazilian Portuguese
    'pt-PT': 'pt', // European Portuguese
  };
  if (specialCases[lang]) {
    return specialCases[lang];
  }
  return lang.split('-')[0];
};

// eslint-disable-next-line react-refresh/only-export-components -- co-located with component for cohesion
export const useLanguage = () => {
  const context = useContext(LanguageContext);
  if (!context) {
    throw new Error('useLanguage must be used within a LanguageProvider');
  }
  return context;
};

interface LanguageProviderProps {
  children: ReactNode;
}

export const LanguageProvider: React.FC<LanguageProviderProps> = ({
  children,
}) => {
  const { i18n } = useTranslation();
  const [language, setLanguageState] = useState<string>('en'); // Start with default
  const [isInitialized, setIsInitialized] = useState(false);

  // Initialize language from storage after component mounts.
  //
  // Priority:
  //   1. our settings store (set when the user actively picks a language)
  //   2. i18next LanguageDetector's `i18n.language` (browser detection,
  //      already populated at app load before this useEffect fires)
  //   3. 'en' fallback
  //
  // (1) returning undefined when empty is critical — otherwise a default
  //  'en' silently overrides (2) and forces a Croatian-browser user back
  //  to English on every cold load.
  useEffect(() => {
    const initializeLanguage = () => {
      const i18nLanguage = settings.getI18nLanguage();
      const detected = i18n.language;
      const defaultLang = i18nLanguage || detected || 'en';

      const normalizedLang = normalizeLanguageCode(defaultLang);

      // Ensure we always have a valid language
      const finalLang =
        !normalizedLang || normalizedLang === 'undefined'
          ? 'en'
          : normalizedLang;

      setLanguageState(finalLang);
      setIsInitialized(true);
    };

    initializeLanguage();
  }, [i18n]);

  // Follow i18n whenever its language changes from OUTSIDE this provider —
  // most importantly `auth-context.applyLocaleFromGeneralSettings`, which
  // pulls the user's saved language from the DB and calls
  // `i18n.changeLanguage()` only AFTER the async auth + settings round-trip
  // completes. Without this listener our local `language` state stays stuck
  // on whatever the mount initializer guessed (typically 'en' from the
  // browser on a freshly cleared localStorage), which (a) leaves the Settings
  // language dropdown showing the wrong value and (b) lets the Settings
  // auto-save write that stale 'en' back over the user's 'hr' in the DB.
  useEffect(() => {
    const handleLanguageChanged = (lng: string) => {
      const normalized = normalizeLanguageCode(lng || 'en');
      setLanguageState((prev) => (prev === normalized ? prev : normalized));
    };
    i18n.on('languageChanged', handleLanguageChanged);
    return () => {
      i18n.off('languageChanged', handleLanguageChanged);
    };
  }, [i18n]);

  const setLanguage = (newLanguage: string) => {
    setLanguageState(newLanguage);
    void i18n.changeLanguage(newLanguage);
    settings.setI18nLanguage(newLanguage);

    // Clean up legacy storage key but keep i18nextLng (used by i18next LanguageDetector on reload)
    localStorage.removeItem('language');
  };

  // Initialize i18n language when language state changes
  useEffect(() => {
    if (isInitialized && language) {
      void i18n.changeLanguage(language);
    }
  }, [i18n, language, isInitialized]);

  return (
    <LanguageContext.Provider value={{ language, setLanguage }}>
      {children}
    </LanguageContext.Provider>
  );
};

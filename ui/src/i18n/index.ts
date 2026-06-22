import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';

// Import translations
import enTranslation from './locales/en/translation.json';
import hrTranslation from './locales/hr/translation.json';
import mkTranslation from './locales/mk/translation.json';

// Pre-init sync: if the app has previously stored a language inside our
// nested `scrapalot_settings` blob, surface it on the bare `i18nextLng`
// key that i18next-browser-languagedetector reads at cold start. This
// prevents the 8 s flash of English while /settings/settings_general
// catches up from the backend (auth-context.applyLocaleFromGeneralSettings
// only fires after login completes). Read directly here instead of going
// through storage-utils because that module imports React and we want
// this synchronous before any component mounts.
try {
  const raw = localStorage.getItem('scrapalot_settings');
  if (raw && !localStorage.getItem('i18nextLng')) {
    const parsed = JSON.parse(raw) as { i18nextLng?: unknown };
    if (typeof parsed?.i18nextLng === 'string' && parsed.i18nextLng) {
      localStorage.setItem('i18nextLng', parsed.i18nextLng);
    }
  }
} catch {
  // localStorage may be unavailable or `scrapalot_settings` corrupt;
  // fall through to the detector defaults.
}
// import esTranslation from './locales/es/translation.json';
// import frTranslation from './locales/fr/translation.json';
// import deTranslation from './locales/de/translation.json';

// Initialize i18next
void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      en: {
        translation: enTranslation,
      },
      hr: {
        translation: hrTranslation,
      },
      mk: {
        translation: mkTranslation,
      },
      // es: {
      //   translation: esTranslation
      // },
      // fr: {
      //   translation: frTranslation
      // },
      // de: {
      //   translation: deTranslation
      // }
    },
    fallbackLng: 'en',
    debug: process.env.NODE_ENV === 'development',
    interpolation: {
      escapeValue: false, // React already escapes values
    },
    detection: {
      order: ['localStorage', 'navigator'],
      caches: ['localStorage'],
    },
  });

export default i18n;

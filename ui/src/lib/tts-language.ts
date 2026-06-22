/**
 * TTS language detection + voice picker.
 *
 * Two code paths call in here:
 *
 *  1. **Deep Research markdown viewer** — default voice follows the app's i18n
 *     language (`hr`, `en`, `mk`) so the report is always read back in the UI
 *     language the user just chose.
 *
 *  2. **PDF / EPUB / DOCX viewers** — default voice is English, because these
 *     documents can be in any language. The caller runs `detectLanguage()` on
 *     the first extracted page/section asynchronously and, if it returns a
 *     non-English supported language, swaps the voice for that synthesis.
 *
 * The supported language set matches i18n: `hr`, `en`, `mk`. Any other locale
 * detected in the source text falls back to English.
 */

import i18n from '@/i18n';

export type SupportedLang = 'hr' | 'en' | 'mk';

/** Default voice per supported language. Kept conservative — one female neural
 *  voice per locale, matching the top of `DEFAULT_TTS_VOICES`. Users can still
 *  override via the voice picker; that choice is persisted in `userPrefs` and
 *  the auto-detect path respects it (never overrides a user-chosen voice). */
const VOICE_FOR_LANG: Record<SupportedLang, string> = {
  hr: 'hr-HR-GabrijelaNeural',
  en: 'en-US-AriaNeural',
  mk: 'mk-MK-MarijaNeural',
};

/** Voice to use for a specific language. Unknown → English. */
export function voiceForLanguage(lang: string | null | undefined): string {
  if (lang === 'hr' || lang === 'en' || lang === 'mk') return VOICE_FOR_LANG[lang];
  return VOICE_FOR_LANG.en;
}

/** Default voice derived from the active i18n language (deep research flow). */
export function defaultVoiceForI18n(): string {
  const raw = (i18n.language || '').toLowerCase();
  if (raw.startsWith('hr')) return VOICE_FOR_LANG.hr;
  if (raw.startsWith('mk')) return VOICE_FOR_LANG.mk;
  return VOICE_FOR_LANG.en;
}

/**
 * Fast script-and-diacritic heuristic for `hr` / `en` / `mk`.
 *
 * Why a heuristic rather than a library:
 *   - the three locales are very distinguishable (Cyrillic vs Latin+diacritics
 *     vs bare Latin), so a full ngram model (franc-min ≈ 90 KB) is overkill;
 *   - runs in a few ms on a 5 KB sample — cheap enough to call inline before
 *     synthesis without a worker;
 *   - no network / no dependency churn.
 *
 * Rules (applied in order):
 *   1. Cyrillic share ≥ 10 % of a 5 KB sample → `mk`. Macedonian is the only
 *      supported Cyrillic language, so any notable Cyrillic presence wins.
 *   2. ≥ 5 Croatian diacritics (č ć đ š ž, case-insensitive) in the sample →
 *      `hr`. The 5-char threshold avoids tripping on a single loanword in an
 *      otherwise English document.
 *   3. Otherwise → `en`. Includes empty / whitespace-only text.
 */
export function detectLanguage(text: string): SupportedLang {
  if (!text) return 'en';
  const sample = text.slice(0, 5000);
  const sampleLen = sample.length;

  const cyrillicMatches = sample.match(/[Ѐ-ӿ]/g);
  const cyrillicCount = cyrillicMatches ? cyrillicMatches.length : 0;
  if (sampleLen > 0 && cyrillicCount / sampleLen >= 0.1) {
    return 'mk';
  }

  const croatianDiacritics = sample.match(/[čćđšžČĆĐŠŽ]/g);
  if (croatianDiacritics && croatianDiacritics.length >= 5) {
    return 'hr';
  }

  return 'en';
}

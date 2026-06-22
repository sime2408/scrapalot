import type { TTSVoice, WordBoundary } from '@/lib/api-tts';

export type { TTSVoice, WordBoundary };

/** Default fallback voices shown before remote voices are loaded. */
export const DEFAULT_TTS_VOICES: TTSVoice[] = [
  { name: 'hr-HR-GabrijelaNeural', display_name: 'Gabriela (Croatian)', locale: 'hr-HR', gender: 'Female', language: 'HR' },
  { name: 'hr-HR-SreckoNeural', display_name: 'Srećko (Croatian)', locale: 'hr-HR', gender: 'Male', language: 'HR' },
  { name: 'mk-MK-MarijaNeural', display_name: 'Marija (Macedonian)', locale: 'mk-MK', gender: 'Female', language: 'MK' },
  { name: 'mk-MK-AleksandarNeural', display_name: 'Aleksandar (Macedonian)', locale: 'mk-MK', gender: 'Male', language: 'MK' },
  { name: 'en-US-AriaNeural', display_name: 'Aria (US)', locale: 'en-US', gender: 'Female', language: 'EN' },
  { name: 'en-US-GuyNeural', display_name: 'Guy (US)', locale: 'en-US', gender: 'Male', language: 'EN' },
  { name: 'en-GB-SoniaNeural', display_name: 'Sonia (UK)', locale: 'en-GB', gender: 'Female', language: 'EN' },
  { name: 'en-GB-RyanNeural', display_name: 'Ryan (UK)', locale: 'en-GB', gender: 'Male', language: 'EN' },
  { name: 'en-AU-NatashaNeural', display_name: 'Natasha (AU)', locale: 'en-AU', gender: 'Female', language: 'EN' },
  { name: 'en-AU-WilliamNeural', display_name: 'William (AU)', locale: 'en-AU', gender: 'Male', language: 'EN' },
  { name: 'en-CA-ClaraNeural', display_name: 'Clara (CA)', locale: 'en-CA', gender: 'Female', language: 'EN' },
  { name: 'en-CA-LiamNeural', display_name: 'Liam (CA)', locale: 'en-CA', gender: 'Male', language: 'EN' },
];

/** Locales allowed in the voice list (i18n-supported languages only). */
export const ALLOWED_ENGLISH_LOCALES = ['en-US', 'en-GB', 'en-AU', 'en-CA'] as const;

/**
 * Finds which text block corresponds to the current audio playback position.
 * Pure function — identical logic shared between PDF and EPUB TTS engines.
 *
 * @param currentTimeMs  Current audio time in milliseconds
 * @param wordBoundaries Word-timing boundaries from the TTS backend
 * @param wordToBlockMap Pre-built mapping of word index → block index
 * @param offsetToMs     Converts a backend offset value to milliseconds
 */
export function findBlockForTime(
  currentTimeMs: number,
  wordBoundaries: WordBoundary[],
  wordToBlockMap: number[],
  offsetToMs: (offset: number) => number
): number {
  if (wordToBlockMap.length === 0) return 0;

  let currentWordIndex = 0;
  for (let i = 0; i < wordBoundaries.length; i++) {
    const wordTimeMs = offsetToMs(wordBoundaries[i].offset);
    if (wordTimeMs <= currentTimeMs) {
      currentWordIndex = i;
    } else {
      break;
    }
  }

  return wordToBlockMap[currentWordIndex] ?? 0;
}

/**
 * Filters and sorts voices from the API into display order:
 * Croatian first, then Macedonian, then allowed English locales, alphabetically
 * within each group. Matches the i18n languages the app supports (hr, en, mk).
 */
export function filterAndSortVoices(voices: TTSVoice[]): TTSVoice[] {
  const filtered = voices.filter(
    (v) =>
      v.locale.startsWith('hr-') ||
      v.locale.startsWith('mk-') ||
      (ALLOWED_ENGLISH_LOCALES as readonly string[]).includes(v.locale)
  );
  const rank = (locale: string): number => {
    if (locale.startsWith('hr-')) return 0;
    if (locale.startsWith('mk-')) return 1;
    return 2;
  };
  filtered.sort((a, b) => {
    const r = rank(a.locale) - rank(b.locale);
    if (r !== 0) return r;
    return a.display_name.localeCompare(b.display_name);
  });
  return filtered;
}

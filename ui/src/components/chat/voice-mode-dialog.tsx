/**
 * VoiceModeDialog — hands-free voice conversation with browser-side VAD.
 *
 * Flow:
 *
 *   user taps orb → MicVAD spins up (Silero VAD WASM, 16 kHz capture)
 *   VAD onSpeechStart → orb pulses, transcript clears
 *   VAD onSpeechEnd → segmented Float32Array → WAV → POST /voice/transcribe
 *   transcript → POST /voice/chat (low-latency direct LLM, optional
 *       search_collection tool when collections are selected)
 *   reply → POST /voice/synthesize → MP3 plays through hidden <audio>
 *   playback ended → VAD resumes; user can speak again without tapping
 *   user taps orb again → conversation ends, VAD destroyed
 *
 * The conversation is transient — last 10 turns kept in component memory,
 * not persisted in the chat session.
 *
 * VAD is paused while the assistant speaks so TTS audio bleeding back through
 * the mic does not retrigger speech detection. Browser AEC
 * (``echoCancellation: true``) is requested by MicVAD's getUserMedia, but is
 * a best-effort hint — wired headsets are recommended.
 */

import { ChevronLeft, ChevronRight, Gauge, X } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast as sonnerToast } from 'sonner';

import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Slider } from '@/components/ui/slider';
import { useAuth } from '@/hooks/use-auth';
import { useWorkspace } from '@/hooks/use-workspace';
import { api } from '@/lib/api';
import {
  generateBookSummary,
  getBookSummary,
  translateBookSummary,
} from '@/lib/api-documents';
import { getUserSettings, saveGeneralSettings } from '@/lib/api-settings';
import { judgeTurnComplete, synthesizeVoice, transcribeVoiceClip, voiceChatReplyStream } from '@/lib/api-voice';
import type { VoiceChatFinal, VoiceChatPhase } from '@/lib/api-voice';
import { encodePcm16Wav } from '@/lib/audio-utils';
import { cn } from '@/lib/utils';

type VoiceState =
  | 'idle' // VAD off, awaiting user gesture
  | 'listening' // VAD running, no speech detected
  | 'recording' // VAD detected speech start, still capturing
  | 'transcribing' // VAD ended, sent to Whisper
  | 'awaiting_response' // LLM is generating
  | 'speaking' // TTS playing (VAD paused)
  | 'error';

/**
 * Description of a book the user wants to talk to. Rendered as a thumbnail
 * panel above the orb so the user has visual confirmation of what the agent
 * is grounded on, and forwarded to the backend ``/voice/chat`` endpoint as
 * ``document_ids`` so it can register the lexical tools
 * (``grep_search`` + ``cat_document``).
 */
export interface VoiceModeDocument {
  id: string;
  title: string;
}

interface VoiceModeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Currently selected collection IDs in the chat toolbar. Passed to the
   *  ``search_collection`` tool on the server so the agent can consult the
   *  user's library when it genuinely needs to. */
  collectionIds?: string[];
  /** Books the user @-tagged for this voice conversation. When non-empty,
   *  the server registers ``grep_search`` + ``cat_document`` against
   *  ``documents.content`` instead of the slower similarity-only
   *  ``search_collection`` tool. */
  documents?: VoiceModeDocument[];
}

// MicVAD has a strict-ish runtime API; importing the type lazily keeps the
// initial bundle slim and avoids loading onnxruntime-web until the user
// actually opens voice mode.
type MicVADInstance = {
  start: () => Promise<void> | void;
  pause: () => Promise<void> | void;
  destroy: () => Promise<void> | void;
};

/**
 * Map a backend voice-error code (or raw httpx message) to a localised
 * user-facing sentence. `error` state holds the raw code so admins can
 * still inspect; this helper runs at render time so a locale change
 * mid-conversation re-renders the message correctly.
 */
function formatVoiceError(
  code: string | undefined | null,
  t: (key: string, fallback?: string) => string,
): string {
  if (!code) return t('voiceMode.error.generic', 'Voice service hit an error. Try again in a moment.');
  const norm = code.trim();
  if (norm === 'errorQuotaExhausted') {
    return t(
      'voiceMode.error.quotaExhausted',
      'Voice service is temporarily unavailable — the LLM quota has been reached. Contact the administrator or try again later.',
    );
  }
  if (norm === 'empty_transcription' || norm === 'emptyTranscription') {
    return t('voiceMode.error.emptyTranscription', "I didn't catch that — could you try again a bit louder?");
  }
  if (norm === 'empty_reply' || norm === 'emptyReply') {
    return t('voiceMode.error.emptyReply', 'Sorry, I had nothing to say to that. Try rephrasing the question.');
  }
  // Unknown / raw httpx message — fall back to generic with a short raw
  // suffix so an admin reading over the user's shoulder can still triage.
  const tail = norm.length > 80 ? `${norm.slice(0, 77)}…` : norm;
  return `${t('voiceMode.error.generic', 'Voice service hit an error. Try again in a moment.')} (${tail})`;
}

/**
 * Lowercase + strip Croatian / European diacritics + collapse whitespace so
 * "Scrapalot, …" / "Šcrapalot." / "scrapalot " all match the same key. We
 * only care about the leading wake word, so the helper is cheap enough to
 * call per turn.
 */
function normaliseWakeWord(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Levenshtein edit distance between two strings. Used by `stripWakeWord` to
 * tolerate Whisper transcription drift on foreign names ("scrapcrapalot" /
 * "skra plot" / "skraplot" all need to count as "scrapalot"). Iterative
 * two-row implementation — O(|a|·|b|) time, O(min(|a|,|b|)) space.
 */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const prev = new Array<number>(a.length + 1);
  const curr = new Array<number>(a.length + 1);
  for (let i = 0; i <= a.length; i++) prev[i] = i;
  for (let j = 1; j <= b.length; j++) {
    curr[0] = j;
    for (let i = 1; i <= a.length; i++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[i] = Math.min(curr[i - 1] + 1, prev[i] + 1, prev[i - 1] + cost);
    }
    for (let i = 0; i <= a.length; i++) prev[i] = curr[i];
  }
  return prev[a.length];
}

/**
 * If `transcript` starts with `wakeName`, return the rest of the transcript
 * with the wake word stripped (and any leading "," / "." / "—" removed).
 * Returns `null` when the wake word isn't at the start.
 *
 * Whisper mangles foreign names heavily on Croatian audio — "Scrapalot" comes
 * back as "scrapcrapalot" / "skraplot" / "skra plot" / "škrapalot". A strict
 * `startsWith` would drop all of those turns silently. We therefore accept
 * either a fast strict prefix match, or a fuzzy Levenshtein match on the
 * first 1–3 tokens joined (no spaces) against `wakeName`. Budget scales with
 * name length so short names ("Aria") aren't matched by random 4-letter
 * words.
 */
function stripWakeWord(transcript: string, wakeName: string): string | null {
  if (!wakeName) return null;
  const norm = normaliseWakeWord(transcript);
  if (!norm) return null;

  if (norm.startsWith(wakeName)) {
    return norm.slice(wakeName.length).replace(/^[\s,.;:!?\-—]+/, '');
  }

  const tokens = norm.split(' ').filter(Boolean);
  if (!tokens.length) return null;
  const budget = Math.max(2, Math.ceil(wakeName.length / 3));

  for (let n = 1; n <= Math.min(3, tokens.length); n++) {
    const head = tokens.slice(0, n).join('');
    if (Math.abs(head.length - wakeName.length) <= budget * 2) {
      if (levenshtein(head, wakeName) <= budget) {
        return tokens.slice(n).join(' ').replace(/^[\s,.;:!?\-—]+/, '');
      }
    }
    if (head.length > wakeName.length + budget) {
      const truncated = head.slice(0, wakeName.length + budget);
      if (levenshtein(truncated, wakeName) <= budget) {
        return tokens.slice(n).join(' ').replace(/^[\s,.;:!?\-—]+/, '');
      }
    }
  }

  return null;
}

/**
 * Build a locale-aware "would you like a description?" greeting for the
 * intro flow. We keep it short because TTS has to read it aloud before
 * the user can answer — 1-2 sentences max.
 */
function introGreeting(lang: string, title: string): string {
  const code = (lang || 'en').toLowerCase().split('-')[0];
  const short = title.length > 80 ? `${title.slice(0, 77)}…` : title;
  switch (code) {
    case 'hr':
    case 'bs':
    case 'sr':
      return `Imam sažetak knjige "${short}". Želiš li da ti ukratko opišem o čemu se radi?`;
    case 'de':
      return `Ich habe eine Zusammenfassung des Buches „${short}". Möchtest du eine kurze Beschreibung?`;
    case 'fr':
      return `J'ai un résumé du livre « ${short} ». Veux-tu une brève description ?`;
    case 'es':
      return `Tengo un resumen del libro «${short}». ¿Quieres que te lo describa brevemente?`;
    case 'it':
      return `Ho un riassunto del libro "${short}". Vuoi una breve descrizione?`;
    case 'pt':
      return `Tenho um resumo do livro "${short}". Queres uma breve descrição?`;
    case 'ru':
      return `У меня есть краткое содержание книги «${short}». Хочешь, я расскажу вкратце?`;
    default:
      return `I have a summary of "${short}" ready. Would you like a quick description?`;
  }
}

/**
 * Locale-aware "no summary yet — want me to generate one?" prompt. Used when
 * the book has no cached summary; the answer routes into the on-demand
 * generate flow (~30-90 s of LLM work) instead of silent fallback.
 */
function introGenerateGreeting(lang: string, title: string): string {
  const code = (lang || 'en').toLowerCase().split('-')[0];
  const short = title.length > 60 ? `${title.slice(0, 57)}…` : title;
  switch (code) {
    case 'hr':
    case 'bs':
    case 'sr':
      return `Knjiga "${short}" još nema sažetak. Želiš li da ga sada generiram pa ti ukratko opišem?`;
    case 'de':
      return `Das Buch „${short}" hat noch keine Zusammenfassung. Soll ich sie jetzt erstellen und kurz beschreiben?`;
    case 'fr':
      return `Le livre « ${short} » n'a pas encore de résumé. Veux-tu que j'en génère un et te le décrive ?`;
    case 'es':
      return `El libro «${short}» aún no tiene resumen. ¿Quieres que lo genere ahora y te lo describa?`;
    case 'it':
      return `Il libro "${short}" non ha ancora un riassunto. Vuoi che lo generi ora e te lo descriva?`;
    case 'pt':
      return `O livro "${short}" ainda não tem resumo. Queres que o gere agora e te descreva?`;
    case 'ru':
      return `У книги «${short}» пока нет краткого содержания. Сгенерировать его сейчас и рассказать?`;
    default:
      return `The book "${short}" has no summary yet. Would you like me to generate one and describe it?`;
  }
}

/**
 * Locale-aware "okay, generating — please wait" filler spoken right after
 * the user agrees to on-demand summary generation. Keeps the user oriented
 * during the LLM round-trip (no UI progress in voice mode).
 */
function introGeneratingNotice(lang: string): string {
  const code = (lang || 'en').toLowerCase().split('-')[0];
  switch (code) {
    case 'hr':
    case 'bs':
    case 'sr':
      return 'U redu, generiram sažetak. Ovo može potrajati minutu ili dvije.';
    case 'de':
      return 'In Ordnung, ich erstelle die Zusammenfassung. Das kann ein bis zwei Minuten dauern.';
    case 'fr':
      return "D'accord, je génère le résumé. Cela peut prendre une à deux minutes.";
    case 'es':
      return 'De acuerdo, estoy generando el resumen. Puede tardar uno o dos minutos.';
    case 'it':
      return 'Va bene, sto generando il riassunto. Potrebbe richiedere uno o due minuti.';
    case 'pt':
      return 'Está bem, estou a gerar o resumo. Pode demorar um ou dois minutos.';
    case 'ru':
      return 'Хорошо, я создаю краткое содержание. Это может занять одну-две минуты.';
    default:
      return 'Okay, generating the summary. This may take a minute or two.';
  }
}

/**
 * Locale-aware "couldn't generate the summary" apology spoken if the
 * on-demand generate call fails. Lets the user move on to a real question
 * instead of waiting silently.
 */
function introGenerateFailedNotice(lang: string): string {
  const code = (lang || 'en').toLowerCase().split('-')[0];
  switch (code) {
    case 'hr':
    case 'bs':
    case 'sr':
      return 'Žao mi je, nisam uspjela generirati sažetak. Što te zanima u vezi knjige?';
    case 'de':
      return 'Tut mir leid, ich konnte die Zusammenfassung nicht erstellen. Was möchtest du über das Buch wissen?';
    case 'fr':
      return "Désolé, je n'ai pas pu générer le résumé. Que veux-tu savoir sur ce livre ?";
    case 'es':
      return 'Lo siento, no pude generar el resumen. ¿Qué te gustaría saber del libro?';
    case 'it':
      return 'Mi dispiace, non sono riuscita a generare il riassunto. Cosa vuoi sapere sul libro?';
    case 'pt':
      return 'Desculpa, não consegui gerar o resumo. O que queres saber sobre o livro?';
    case 'ru':
      return 'Извините, не удалось создать краткое содержание. Что тебя интересует в книге?';
    default:
      return "Sorry, I couldn't generate the summary. What would you like to know about the book?";
  }
}

/**
 * Detect an affirmative answer in the user's spoken reply. Covers
 * Croatian and English common forms; falls back to a permissive check
 * for other locales so a clear "yes" / "sí" / "ja" / "oui" still works.
 * Returns null when the answer is clearly negative; ``undefined`` is
 * never returned — callers treat anything not-affirmative-and-not-
 * negative as "user already asked their first question, proceed normally".
 */
function classifyIntroReply(text: string): 'yes' | 'no' | 'other' {
  const t = text
    .toLowerCase()
    .replace(/[čć]/g, 'c')
    .replace(/š/g, 's')
    .replace(/ž/g, 'z')
    .replace(/đ/g, 'd')
    .trim();
  if (!t) return 'other';
  const yesPatterns = [
    /\b(da|jasno|naravno|svakako|aha|moze|hocu|reci|opisi|reci mi|kaze|kazi)\b/,
    /\b(yes|yeah|yep|sure|please|go ahead|tell me|describe|of course|absolutely|ok|okay)\b/,
    /\b(ja|gerne|bitte)\b/,
    /\b(oui|d'accord|s'il)\b/,
    /\b(si|sí|claro|por favor)\b/,
    /\b(да|конечно|пожалуйста|расскажи)\b/,
  ];
  const noPatterns = [
    /\b(ne|nemoj|preskoci|preskoči|kasnije|nije potrebno|necu)\b/,
    /\b(no|nope|skip|later|not now|don't|dont)\b/,
    /\b(nein|nicht)\b/,
    /\b(non|pas)\b/,
    /\b(нет|не надо|потом)\b/,
  ];
  for (const re of yesPatterns) if (re.test(t)) return 'yes';
  for (const re of noPatterns) if (re.test(t)) return 'no';
  return 'other';
}

/**
 * Compact book cover for the voice dialog. Fetches the document thumbnail
 * via authenticated axios (the JWT header doesn't ride on plain ``<img>``),
 * caches the blob URL for the dialog's lifetime, and falls back to a
 * stylised "title card" when there's no cover image — same fallback shape
 * the chat-mention popover uses, just smaller and read-only (no upload /
 * download / context-menu — we just want to show the user what they're
 * talking to).
 */
function BookThumbCard({ documentId, title }: { documentId: string; title: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    (async () => {
      try {
        const resp = await api.get(`/documents/${documentId}/thumbnail?size=large`, {
          responseType: 'blob',
          validateStatus: (s) => s < 500,
        });
        if (cancelled) return;
        const blob = resp.data as Blob;
        if (resp.status !== 200 || !blob || blob.size === 0) {
          setFailed(true);
          return;
        }
        objectUrl = URL.createObjectURL(blob);
        setSrc(objectUrl);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [documentId]);

  const shortTitle = title.length > 60 ? `${title.slice(0, 57)}…` : title;

  return (
    <div
      data-testid='voice-mode-book-thumb'
      className={cn(
        'shrink-0 w-20 h-28 sm:w-24 sm:h-32 md:w-28 md:h-36',
        'border border-border bg-card overflow-hidden relative',
      )}
      title={title}
    >
      {src && !failed ? (
        <img
          src={src}
          alt={title}
          className='w-full h-full object-cover'
          onError={() => setFailed(true)}
        />
      ) : (
        <div className='w-full h-full flex items-center justify-center px-2 py-3 text-[9px] sm:text-[10px] leading-tight text-center text-muted-foreground'>
          {shortTitle}
        </div>
      )}
    </div>
  );
}

/**
 * BookSlider — the focused-books strip. A single book is centred; multiple
 * books become a horizontal snap carousel with prev/next affordances that
 * appear only when there is more to scroll in that direction. Touch/trackpad
 * swipe works natively; the arrows are for mouse users. Scrollbar hidden so
 * the strip stays clean.
 */
function BookSlider({ books }: { books: { id: string; title: string }[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const [canLeft, setCanLeft] = useState(false);
  const [canRight, setCanRight] = useState(false);

  const update = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    setCanLeft(el.scrollLeft > 4);
    setCanRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 4);
  }, []);

  useEffect(() => {
    update();
    const el = ref.current;
    if (!el) return;
    el.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    return () => {
      el.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  }, [update, books.length]);

  const scrollBy = (dir: -1 | 1) => {
    const el = ref.current;
    if (!el) return;
    el.scrollBy({ left: dir * Math.max(el.clientWidth * 0.8, 160), behavior: 'smooth' });
  };

  const single = books.length <= 1;

  return (
    <div className='shrink-0 relative border-b border-border/40'>
      {!single && canLeft && (
        <button
          type='button'
          aria-label='Previous book'
          onClick={() => scrollBy(-1)}
          className='absolute left-1 top-1/2 -translate-y-1/2 z-10 w-8 h-8 flex items-center justify-center text-foreground/80 hover:text-foreground bg-background/70 backdrop-blur-sm transition-colors'
        >
          <ChevronLeft className='h-4 w-4' strokeWidth={1.5} />
        </button>
      )}
      <div
        ref={ref}
        data-testid='voice-mode-book-thumbnails'
        className={cn(
          'overflow-x-auto py-2 px-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
          single ? 'flex justify-center' : 'flex gap-2 snap-x snap-mandatory',
        )}
      >
        {books.map((b) => (
          <div key={b.id} className='snap-start shrink-0'>
            <BookThumbCard documentId={b.id} title={b.title} />
          </div>
        ))}
      </div>
      {!single && canRight && (
        <button
          type='button'
          aria-label='Next book'
          onClick={() => scrollBy(1)}
          className='absolute right-1 top-1/2 -translate-y-1/2 z-10 w-8 h-8 flex items-center justify-center text-foreground/80 hover:text-foreground bg-background/70 backdrop-blur-sm transition-colors'
        >
          <ChevronRight className='h-4 w-4' strokeWidth={1.5} />
        </button>
      )}
    </div>
  );
}

/**
 * CentralMetronome — the hero element of the voice dialog (replaces the old
 * circular orb). A row of vertical bars that REACT TO REAL AUDIO:
 *  - while `speaking`, the bars follow the assistant's voice via an
 *    AnalyserNode tapped off the TTS playback (`analyserRef`);
 *  - while `listening` / `recording`, they follow the live mic RMS
 *    (`micLevelRef`, set from the VAD's per-frame callback);
 *  - while idle / thinking, they breathe gently.
 * Heights are written straight to each bar's `transform: scaleY()` inside a
 * single requestAnimationFrame loop — no React re-render per frame. Colour is
 * state-driven (the only thing that re-renders). prefers-reduced-motion drops
 * to calm static bars. Sharp, borderless, on-brand.
 */
const CentralMetronome: React.FC<{
  state: VoiceState;
  analyserRef: React.MutableRefObject<AnalyserNode | null>;
  micLevelRef: React.MutableRefObject<number>;
}> = ({ state, analyserRef, micLevelRef }) => {
  const BAR_COUNT = 7;
  const barsRef = useRef<Array<HTMLSpanElement | null>>([]);
  const liveState = useRef<VoiceState>(state);
  liveState.current = state;

  const colour =
    state === 'recording' ? 'text-rose-600 dark:text-rose-300'
    : state === 'speaking' ? 'text-emerald-600 dark:text-emerald-300'
    : state === 'transcribing' ? 'text-amber-600 dark:text-amber-300'
    : state === 'awaiting_response' ? 'text-primary'
    : state === 'listening' ? 'text-primary'
    : state === 'error' ? 'text-destructive'
    : 'text-muted-foreground';

  useEffect(() => {
    const reduce =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const freq = new Uint8Array(32);
    let raf = 0;
    let t = 0;
    const apply = (i: number, h: number) => {
      const el = barsRef.current[i];
      if (el) el.style.transform = `scaleY(${Math.max(0.1, Math.min(1, h))})`;
    };
    const loop = () => {
      const s = liveState.current;
      const analyser = analyserRef.current;
      if (reduce) {
        for (let i = 0; i < BAR_COUNT; i++) apply(i, s === 'idle' ? 0.22 : 0.5);
      } else if (s === 'speaking' && analyser) {
        analyser.getByteFrequencyData(freq);
        for (let i = 0; i < BAR_COUNT; i++) {
          const v = (freq[2 + i * 3] || 0) / 255;
          apply(i, 0.14 + v * 0.86);
        }
      } else if (s === 'recording' || s === 'listening') {
        const lvl = Math.min(1, micLevelRef.current * 8);
        for (let i = 0; i < BAR_COUNT; i++) {
          // Gentle baseline so the metronome stays alive while listening in
          // silence, then jumps with the mic amplitude when the user speaks.
          const idle = 0.07 * (0.5 + 0.5 * Math.sin(t * 0.09 + i * 0.5));
          const wave = 0.5 + 0.5 * Math.sin(t * 0.16 + i * 0.8);
          apply(i, 0.14 + idle + lvl * (0.35 + 0.65 * wave));
        }
      } else {
        // idle / transcribing / awaiting_response → gentle breathing
        const base = s === 'idle' ? 0.18 : 0.42;
        const amp = s === 'idle' ? 0.06 : 0.28;
        for (let i = 0; i < BAR_COUNT; i++) {
          const wave = 0.5 + 0.5 * Math.sin(t * 0.07 + i * 0.6);
          apply(i, base + wave * amp);
        }
      }
      t += 1;
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [analyserRef, micLevelRef]);

  return (
    <div
      className={cn('relative flex items-end justify-center gap-2.5 md:gap-3 h-24 md:h-32', colour)}
      aria-hidden='true'
    >
      {/* Soft state-coloured halo behind the bars — purely decorative depth,
          tracks the state colour via bg-current. */}
      <span className='pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 h-36 w-48 md:h-48 md:w-64 rounded-full bg-current opacity-[0.10] blur-3xl' />
      {Array.from({ length: BAR_COUNT }).map((_, i) => (
        <span
          key={i}
          ref={(el) => {
            barsRef.current[i] = el;
          }}
          className='relative block w-2.5 md:w-3 bg-current origin-bottom'
          style={{ height: '100%', transform: 'scaleY(0.14)', transition: 'transform 70ms ease-out' }}
        />
      ))}
    </div>
  );
};


export function VoiceModeDialog({
  open,
  onOpenChange,
  collectionIds,
  documents,
}: VoiceModeDialogProps) {
  const documentIds = useMemo(
    () => (documents ?? []).map((d) => d.id).filter(Boolean),
    [documents],
  );
  // Tool-set conversation focus from previous turn(s) — populated when the
  // server's voice/chat response carries `focused_books` (the agent called
  // set_book_focus). Stored as state (not a ref) so the thumbnail list
  // above the orb re-renders the moment the agent puts a new book in focus.
  // Replayed as document_ids on the next request so the phase-1 grep/cat
  // tools stay armed for the same books across turns. Cleared on close.
  const [focusedBooks, setFocusedBooks] = useState<Array<{ id: string; title: string }>>([]);
  // Voice playback speed slider state (separate from voiceSpeedRef so the
  // UI re-renders on change). Mirror persists through speakText's stable
  // closure; state drives the slider's controlled value.
  const [voiceSpeed, setVoiceSpeed] = useState<number>(1.0);
  // Debounce timer for persisting voice_speed to settings_general so a
  // drag of the slider doesn't fire 30 POSTs.
  const voiceSpeedSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleVoiceSpeedChange = useCallback((nextValue: number) => {
    const clamped = Math.max(0.5, Math.min(1.5, nextValue));
    voiceSpeedRef.current = clamped;
    setVoiceSpeed(clamped);
    if (voiceSpeedSaveTimerRef.current) {
      clearTimeout(voiceSpeedSaveTimerRef.current);
    }
    voiceSpeedSaveTimerRef.current = setTimeout(() => {
      voiceSpeedSaveTimerRef.current = null;
      void saveGeneralSettings({ voice_speed: clamped }).catch(() => {
        // Best-effort persistence — the next session pulls fresh, the
        // user can re-drag. No toast for a settings hiccup.
      });
    }, 600);
  }, []);
  // Human-readable label the server emits via SSE `phase` events for each
  // tool call (e.g. "Pretražujem biblioteku po temi…"). Rendered under the
  // orb while the agent is multi-tooling, cleared when the stream finishes
  // or the dialog closes. Empty string = idle / no current tool.
  const [agentPhase, setAgentPhase] = useState<string>('');
  const { t, i18n } = useTranslation();
  const { user } = useAuth();
  const { currentWorkspace } = useWorkspace();
  // In-memory conversation history for the LLM (last few turns). Not persisted
  // to the session DB on purpose — voice mode is a transient, low-latency path.
  const historyRef = useRef<Array<{ role: 'user' | 'assistant'; content: string }>>([]);

  const [state, setState] = useState<VoiceState>('idle');
  const [transcript, setTranscript] = useState<string>('');
  const [response, setResponse] = useState<string>('');
  const [error, setError] = useState<string>('');
  const [byokUsed, setByokUsed] = useState<boolean>(false);
  const [usedRag, setUsedRag] = useState<boolean>(false);
  // Intro Q&A for the single tagged document. `ready` — cached summary
  // available, just translate and offer to read it. `absent` — no summary
  // yet; we offer to generate one on demand instead of silently doing it
  // in the background (~30-90 s of LLM work the user did not ask for).
  // Null while loading or when multi-book / no-book scopes don't qualify.
  const [introSummary, setIntroSummary] = useState<
    | { kind: 'ready'; text: string; title: string }
    | { kind: 'absent'; docId: string; title: string }
    | null
  >(null);
  // Locks the intro Q&A to the first user utterance only. Once the user
  // has answered (yes / no / something else), we never re-prompt.
  const introHandledRef = useRef<boolean>(false);
  const introPendingRef = useRef<boolean>(false);
  // Mirrors `introSummary` synchronously so `startConversation` can read
  // the latest value after awaiting `introReadyPromiseRef` — React state
  // updates batch and may not be visible to the same async task.
  const introSummaryRef = useRef<
    | { kind: 'ready'; text: string; title: string }
    | { kind: 'absent'; docId: string; title: string }
    | null
  >(null);
  // Promise that resolves when the prefetch effect finishes (success,
  // miss, or abort). `startConversation` awaits this with a soft timeout
  // so the very first orb tap doesn't race past a slow `getBookSummary`
  // and skip the intro greeting.
  const introReadyResolveRef = useRef<(() => void) | null>(null);
  const introReadyPromiseRef = useRef<Promise<void> | null>(null);
  // Counts barge-ins so the user can see they actually interrupted the
  // assistant (visual confirmation that voice mode picked it up).
  const [bargeInCount, setBargeInCount] = useState(0);

  const vadRef = useRef<MicVADInstance | null>(null);
  // Hard safety timer: if VAD detects speech-start but no speech-end fires
  // within 15 s (background noise keeps the probability above the negative
  // threshold, model fails to "see" silence, etc.), call vad.pause() so
  // submitUserSpeechOnPause flushes whatever was buffered as onSpeechEnd
  // instead of letting the turn hang forever.
  const speechMaxTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // When the current recording segment started, and when we last saw a frame
  // loud enough to count as real voice. The recording monitor uses both: it
  // force-flushes the VAD only after the user has gone genuinely quiet (so a
  // stuck VAD that never fires onSpeechEnd still ends), without chopping a
  // long-but-continuous utterance mid-sentence the way a fixed timeout did.
  const speechStartedAtRef = useRef<number>(0);
  const lastVoiceAtRef = useRef<number>(0);
  // Semantic endpointing buffer: a transcript the completeness judge flagged as
  // unfinished ("što znaš o…") is held here and stitched onto the next segment.
  // pendingFlushTimerRef sends the held fragment anyway if the user never
  // resumes, so a trailed-off thought is still answered.
  const pendingTranscriptRef = useRef<string>('');
  const pendingFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  // Web Audio API path — the primary TTS playback channel. We decode the
  // Edge-TTS MP3 into an AudioBuffer, prepend ~150ms of silent samples
  // directly into the buffer (sample-accurate, no decoder priming), then
  // play through an AudioBufferSourceNode. This is what fixed the
  // chronic "first syllable clipped" problem the audioElRef/HTMLAudioElement
  // path had — three palliative layers (". " prefix, canplaythrough wait,
  // currentTime=0.05 seek) couldn't cover Chrome's MP3 decoder priming
  // and blob URL init lag in production.
  const audioContextRef = useRef<AudioContext | null>(null);
  // Tracks the currently-playing AudioBufferSourceNode so cancellation
  // paths (resetSpeechQueue, dialog close, barge-in) can stop() it.
  const currentSourceRef = useRef<AudioBufferSourceNode | null>(null);
  // Audio-reactive metronome wiring. `analyserRef` taps the TTS playback
  // chain so the central bars move with the assistant's ACTUAL voice;
  // `micLevelRef` holds the live RMS of the microphone frames (set in the
  // VAD `onFrameProcessed` callback) so the bars react to the user's voice
  // while listening / recording. Both are read by CentralMetronome's rAF
  // loop — no React state churn at 60 fps.
  const analyserRef = useRef<AnalyserNode | null>(null);
  const micLevelRef = useRef<number>(0);
  // Streaming-TTS queue. As the SSE `text` deltas arrive, we accumulate
  // them in `ttsTextBufferRef`, flush completed sentences into
  // `ttsQueueRef`, and let `ttsDrainerRef` drive the actual synthesise +
  // play loop sequentially. The drainer runs concurrently with the LLM
  // still generating later sentences — the first sentence is already
  // being read aloud while the model writes the third.
  const ttsTextBufferRef = useRef<string>('');
  const ttsQueueRef = useRef<string[]>([]);
  const ttsActiveRef = useRef<boolean>(false);
  const ttsTurnRef = useRef<number>(0);
  // Tracks whether the user explicitly ended the conversation; consulted by
  // long-running async callbacks so they don't transition state on a closed
  // dialog.
  const cancelledRef = useRef<boolean>(false);
  // Timestamp (ms epoch) of the most recent transition INTO 'speaking'.
  // The barge-in branch consults this to enforce a short grace window
  // during which the user's own breath / lip noise / mouse click cannot
  // interrupt the assistant. Without the grace window every TTS clip
  // was getting cut at "hello" because VAD picks up the user's intake
  // breath. 0 = no active speech.
  const speakingStartedAtRef = useRef<number>(0);
  // User-set TTS speed multiplier. 1.0 = normal, 0.5..1.5 the clamped
  // range Edge-TTS handles without sounding chipmunk or drunk. Read
  // from settings_general.voice_speed on dialog open + bound to the
  // inline slider in the dialog header. We mirror in a ref so the
  // speakText callback (memoised on i18n.language only) always sees
  // the latest value without re-creating the streaming pipeline.
  const voiceSpeedRef = useRef<number>(1.0);
  // Mirrors ``state`` for VAD callbacks that close over the initial value
  // — without this the barge-in branch never sees ``state === 'speaking'``
  // because the callback's closure was captured before any state change.
  const stateRef = useRef<VoiceState>('idle');
  // Counts in-flight LLM/TTS requests so a barge-in can declare every
  // currently running async chain "stale" and reject its eventual results
  // without nuking the whole conversation. Each new turn increments.
  const turnSeqRef = useRef<number>(0);
  // Snapshot of turnSeqRef captured at the start of an async chain — when
  // the chain finishes it compares its captured value against the live one
  // to decide whether its result is still wanted.
  const inFlightTurnRef = useRef<number>(0);

  // Wake-word config loaded from settings_general when the dialog opens.
  // `name` is the normalised lower-case prefix we match against transcripts.
  // `enabled=false` keeps the current always-respond behaviour.
  const wakeWordRef = useRef<{ enabled: boolean; name: string }>({ enabled: false, name: '' });
  // User's UI language as stored in settings_general — used as the Whisper
  // language hint. We prefer this over `i18n.language` because the i18next
  // detector can fall back to `en` on a fresh tab even when the user has
  // already saved `hr` in their settings, and a mis-hinted Whisper transcribes
  // foreign-name wake words much worse (e.g. "Scrapalot" → "scrapcrapalot").
  const settingsLanguageRef = useRef<string>('');
  // `true` once the user has said the wake word in this dialog session;
  // subsequent turns skip the wake-word check until silence reset.
  const wakeOpenRef = useRef<boolean>(false);
  const wakeOpenTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    stateRef.current = state;
    // Stamp when we enter 'speaking' so the VAD barge-in branch can honour
    // a grace window. Reset to 0 when leaving so the next clip starts a
    // fresh count.
    if (state === 'speaking') {
      speakingStartedAtRef.current = Date.now();
    } else {
      speakingStartedAtRef.current = 0;
    }
  }, [state]);

  // Pull wake-word settings on dialog open. Best-effort: a failed fetch
  // falls back to "no wake word" (current behaviour) rather than blocking
  // the user from talking.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      try {
        // getUserSettings() unwraps the array → returns the settings_general
        // setting_value directly (not a { general: … } wrapper). The fields
        // we care about live on that top-level object.
        const general = ((await getUserSettings()) ?? {}) as Record<string, unknown>;
        if (cancelled) return;
        const enabled = general.voice_wake_word_enabled === true;
        const rawName = typeof general.voice_wake_word === 'string' ? general.voice_wake_word : '';
        wakeWordRef.current = { enabled, name: normaliseWakeWord(rawName) };
        const lang = typeof general.language === 'string' ? general.language.trim().toLowerCase() : '';
        settingsLanguageRef.current = lang;
        // Voice playback speed. Clamp to the same range the backend
        // enforces — bogus values from a stale write are silently
        // bounded into the comfortable region.
        const rawSpeed = typeof general.voice_speed === 'number' ? general.voice_speed : 1.0;
        const clampedSpeed = Math.max(0.5, Math.min(1.5, rawSpeed));
        voiceSpeedRef.current = clampedSpeed;
        setVoiceSpeed(clampedSpeed);
      } catch {
        wakeWordRef.current = { enabled: false, name: '' };
        settingsLanguageRef.current = '';
        voiceSpeedRef.current = 1.0;
        setVoiceSpeed(1.0);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  // Pre-warm the AudioContext on dialog open. The dialog open click IS the
  // browser-required user gesture, so the context can resume here and stay
  // warm for the first TTS clip. Without this pre-warm the first
  // AudioContext.resume() of a session takes 50-100 ms after speakText is
  // already running — that delay lands ON the silent prepend and
  // effectively eats half of it, chopping the first syllable. Pre-warming
  // here gives the first clip the full silent-head budget.
  useEffect(() => {
    if (!open) return;
    if (!audioContextRef.current) {
      const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (Ctx) {
        audioContextRef.current = new Ctx();
      }
    }
    const ctx = audioContextRef.current;
    if (!ctx) return;
    if (ctx.state === 'suspended') {
      void ctx.resume().catch(() => {
        // browser may reject without a fresher gesture; the lazy path in
        // speakText will retry on the actual play call
      });
    }
  }, [open]);

  // --- Intro summary prefetch (single-book scope only) -------------------
  //
  // When the dialog opens scoped to exactly one book we probe for a cached
  // summary in the background. If present, we translate into the user's
  // UI locale and stash it as `ready`; the first orb tap reads the
  // "want a description?" greeting and (on yes) reads the summary aloud.
  // If the cached row is missing we stash `absent` so the orb tap can
  // instead offer "no summary yet — generate one?". We never trigger
  // generation silently here — it's a ~30-90 s LLM round-trip and the
  // user must opt in.
  useEffect(() => {
    if (!open || !documents || documents.length !== 1) {
      setIntroSummary(null);
      introSummaryRef.current = null;
      introHandledRef.current = false;
      introPendingRef.current = false;
      // Resolve any in-flight ready promise so startConversation isn't
      // stuck waiting forever after the dialog closes / scope changes.
      introReadyResolveRef.current?.();
      introReadyResolveRef.current = null;
      introReadyPromiseRef.current = null;
      return;
    }
    const doc = documents[0];
    let cancelled = false;
    introHandledRef.current = false;
    introPendingRef.current = false;
    introSummaryRef.current = null;
    // Wire up the ready promise BEFORE we kick off the async work so
    // `startConversation` can await it the moment the user taps the orb.
    introReadyPromiseRef.current = new Promise<void>((resolve) => {
      introReadyResolveRef.current = resolve;
    });
    const markReady = () => {
      introReadyResolveRef.current?.();
      introReadyResolveRef.current = null;
    };
    (async () => {
      let summary: string | null = null;
      try {
        const got = await getBookSummary(doc.id);
        if (got.found && got.summary_text) summary = got.summary_text;
      } catch {
        // ignore — treat as no-summary so we still offer generation
      }
      if (cancelled) {
        markReady();
        return;
      }
      if (!summary) {
        const absent = { kind: 'absent' as const, docId: doc.id, title: doc.title };
        introSummaryRef.current = absent;
        setIntroSummary(absent);
        introPendingRef.current = true;
        markReady();
        return;
      }
      // Translate into the user's UI locale if it isn't English. The
      // backend caches translations so this is fast on repeat opens.
      const lang = (i18n.language || 'en').toLowerCase().split('-')[0];
      if (lang && lang !== 'en') {
        const translated = await new Promise<string | null>((resolve) => {
          translateBookSummary(
            doc.id,
            lang,
            () => {
              /* streaming deltas ignored — we wait for the full text */
            },
            (full) => resolve(full),
            () => resolve(null),
          ).catch(() => resolve(null));
        });
        if (cancelled) {
          markReady();
          return;
        }
        if (translated) summary = translated;
      }
      if (!summary || cancelled) {
        markReady();
        return;
      }
      const ready = { kind: 'ready' as const, text: summary, title: doc.title };
      introSummaryRef.current = ready;
      setIntroSummary(ready);
      introPendingRef.current = true;
      markReady();
    })();
    return () => {
      cancelled = true;
      // Don't leave startConversation hanging if the user closes before
      // prefetch finishes.
      introReadyResolveRef.current?.();
      introReadyResolveRef.current = null;
    };
  }, [open, documents, i18n.language]);

  const teardownVad = useCallback(async () => {
    if (speechMaxTimerRef.current) {
      clearInterval(speechMaxTimerRef.current);
      speechMaxTimerRef.current = null;
    }
    if (pendingFlushTimerRef.current) {
      clearTimeout(pendingFlushTimerRef.current);
      pendingFlushTimerRef.current = null;
    }
    pendingTranscriptRef.current = '';
    const vad = vadRef.current;
    vadRef.current = null;
    if (vad) {
      try {
        await vad.pause();
        await vad.destroy();
      } catch {
        // Destroy on a half-initialised VAD can throw — swallow, the GC
        // and the AudioContext close still happen.
      }
    }
  }, []);

  // 30 s silence reset for the wake-word "open session". Called on every
  // successful turn so an active conversation never times out; only true
  // silence between turns reverts to "must say the wake word again".
  const scheduleWakeReset = useCallback(() => {
    if (wakeOpenTimerRef.current) clearTimeout(wakeOpenTimerRef.current);
    wakeOpenTimerRef.current = setTimeout(() => {
      wakeOpenRef.current = false;
      wakeOpenTimerRef.current = null;
    }, 30_000);
  }, []);

  // Speak an arbitrary text via Edge-TTS and return when playback ends.
  // Used by the intro flow (greeting + optional summary read-aloud) so
  // we don't have to duplicate the URL.createObjectURL / onended dance
  // already in handleSpeechEnd.
  const speakText = useCallback(
    async (text: string): Promise<void> => {
      if (!text.trim()) return;
      try {
        // The real silent prefix now lives inside the MP3 byte stream
        // itself — the backend `/voice/synthesize` endpoint prepends a
        // 300 ms silent MP3 segment via pydub before yielding the
        // Edge-TTS audio. That's the only fix that's invariant to
        // Chrome's AudioContext + MP3 decoder + 24→48 kHz resampler
        // priming windows (cumulative 100-300 ms cold start), which
        // four client-side palliatives in a row could not mask.
        //
        // Web Audio path is kept because it is the cleanest playback
        // route + supports sample-accurate barge-in stop(). The small
        // 50 ms silent prepend below stays as cheap insurance for any
        // edge case where the backend prefix is missing (encoder fault
        // → empty bytes, degraded mode).
        const audioBlob = await synthesizeVoice(text, i18n.language, voiceSpeedRef.current);
        if (cancelledRef.current) return;

        // Lazy-init AudioContext (browsers require a user gesture; the
        // voice dialog itself was opened by one, so the context resumes
        // cleanly).
        if (!audioContextRef.current) {
          const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
          if (Ctx) {
            audioContextRef.current = new Ctx();
          }
        }
        const audioCtx = audioContextRef.current;
        if (!audioCtx) return;
        if (audioCtx.state === 'suspended') {
          try {
            await audioCtx.resume();
          } catch {
            // older browsers may reject resume without a fresh gesture;
            // best-effort, fall through
          }
        }

        const arrayBuffer = await audioBlob.arrayBuffer();
        // decodeAudioData copies the data, so we can hand it the buffer
        // directly without worrying about its lifetime.
        const decoded = await audioCtx.decodeAudioData(arrayBuffer.slice(0));
        if (cancelledRef.current) return;

        // No client-side leading-silence pad: the real first-syllable cut was a
        // dropped first token in the /voice/chat SSE stream (fixed server-side),
        // not an audio-start clip. Play the decoded buffer directly.
        await new Promise<void>((resolve) => {
          const source = audioCtx.createBufferSource();
          source.buffer = decoded;
          // Route playback through a shared analyser so the central
          // metronome reacts to the assistant's real voice. The analyser is
          // a transparent pass-through (source → analyser → destination);
          // it stays wired to the destination for the AudioContext lifetime
          // and each new sentence source connects to it.
          let analyser = analyserRef.current;
          if (!analyser) {
            analyser = audioCtx.createAnalyser();
            analyser.fftSize = 64;
            analyser.smoothingTimeConstant = 0.75;
            analyser.connect(audioCtx.destination);
            analyserRef.current = analyser;
          }
          source.connect(analyser);
          currentSourceRef.current = source;

          const safetyTimer = setTimeout(() => {
            // eslint-disable-next-line no-console
            console.warn('voice tts: AudioBufferSource onended timeout, force resolve');
            try {
              source.stop();
            } catch {
              // already stopped
            }
            cleanup();
            resolve();
          }, 30_000);

          const cleanup = () => {
            clearTimeout(safetyTimer);
            source.onended = null;
            try {
              source.disconnect();
            } catch {
              // already disconnected
            }
            if (currentSourceRef.current === source) {
              currentSourceRef.current = null;
            }
          };

          source.onended = () => {
            cleanup();
            resolve();
          };

          source.start(0);
        });
      } catch {
        // best-effort; silence is acceptable
      }
    },
    [i18n.language],
  );

  // Pull every COMPLETE sentence (ending in . ! ? …) off the front of the
  // buffer and return them. The remaining tail (a partial sentence still
  // being written by the LLM) stays in the buffer for the next delta.
  // Sentence-boundary detection is intentionally cheap: a `.` immediately
  // followed by whitespace, end-of-buffer, or another punctuation mark
  // counts as a boundary. This misses "Dr." abbreviations and decimals
  // (we read "Dr Smith" as two sentences) — acceptable for a TTS prefetch:
  // worst case we synthesise one extra short clip.
  const flushSentencesFromBuffer = useCallback((): string[] => {
    const buf = ttsTextBufferRef.current;
    if (!buf) return [];
    const sentences: string[] = [];
    let lastBreak = 0;
    for (let i = 0; i < buf.length; i++) {
      const ch = buf[i];
      if (ch !== '.' && ch !== '!' && ch !== '?' && ch !== '…') continue;
      const next = buf[i + 1] ?? '';
      // boundary if followed by whitespace / nothing yet
      if (next === '' || next === ' ' || next === '\n' || next === '\t') {
        const slice = buf.slice(lastBreak, i + 1).trim();
        if (slice.length >= 2) sentences.push(slice);
        lastBreak = i + 1;
      }
    }
    ttsTextBufferRef.current = buf.slice(lastBreak);
    return sentences;
  }, []);

  const drainSpeechQueue = useCallback(
    async (turn: number): Promise<void> => {
      // Re-entrance guard: a fresh enqueue can land mid-iteration, but
      // the running drainer is already pulling from the queue so we
      // don't need a second one. The `finally` below will kick the
      // next drainer once this loop has exited.
      if (ttsActiveRef.current) return;
      ttsActiveRef.current = true;
      try {
        while (
          !cancelledRef.current &&
          ttsTurnRef.current === turn &&
          ttsQueueRef.current.length > 0
        ) {
          const next = ttsQueueRef.current.shift();
          if (!next) continue;
          // speakText awaits onended, so this drains one sentence at a
          // time. While we're inside this await, new sentences can land
          // on the queue from later deltas — they get picked up on the
          // next iteration.
          await speakText(next);
        }
      } finally {
        ttsActiveRef.current = false;
        // If a NEWER turn enqueued sentences while we were finishing
        // this one, our re-entrance guard above blocked their drainer
        // call. Kick one now under the current turn id, so the audio
        // pipeline doesn't freeze with text-only output the user can
        // see but not hear.
        if (
          !cancelledRef.current &&
          ttsQueueRef.current.length > 0
        ) {
          void drainSpeechQueue(ttsTurnRef.current);
        }
      }
    },
    [speakText],
  );

  const enqueueSpeech = useCallback(
    (sentence: string, turn: number): void => {
      if (!sentence || cancelledRef.current || ttsTurnRef.current !== turn) return;
      ttsQueueRef.current.push(sentence);
      // Always poke the drainer — its own re-entrance guard makes the
      // call cheap when one is already running. The previous "skip if
      // active" check at the call site silently dropped the kick when
      // a stale drainer was still finishing the last sentence of a
      // previous turn.
      void drainSpeechQueue(turn);
    },
    [drainSpeechQueue],
  );

  const resetSpeechQueue = useCallback(() => {
    ttsQueueRef.current = [];
    ttsTextBufferRef.current = '';
    ttsTurnRef.current += 1;
    // Hard-stop any AudioBufferSourceNode that is mid-clip. Without
    // this a barge-in or dialog close lets the current TTS sentence
    // finish playing while the next turn is already starting.
    if (currentSourceRef.current) {
      try {
        currentSourceRef.current.stop();
      } catch {
        // already stopped / not started
      }
      currentSourceRef.current = null;
    }
  }, []);

  const handleSpeechEnd = useCallback(
    async (audio: Float32Array) => {
      if (cancelledRef.current) return;
      // Skip very short utterances — VAD sometimes triggers on a single cough.
      if (audio.length < 16_000 * 0.3) {
        setState('listening');
        return;
      }
      // RMS energy guard — secondary filter for the cases Silero VAD
      // still misfires on (key clicks, distant TV chatter). Real speech
      // sits around 0.05-0.2 RMS; ambient noise under 0.01. Drop quiet
      // segments before paying a Whisper round-trip + uploading 2 MB
      // of WAV that would transcribe to "" anyway.
      let sumSq = 0;
      for (let i = 0; i < audio.length; i++) {
        sumSq += audio[i] * audio[i];
      }
      const rms = Math.sqrt(sumSq / audio.length);
      if (rms < 0.01) {
        setState('listening');
        return;
      }

      // Stamp a turn id at the start of this chain. Every async resume
      // checks ``inFlightTurnRef.current === thisTurn`` before transitioning
      // state so a barge-in mid-turn doesn't have its discarded LLM/TTS
      // response land on top of the next turn the user already started.
      turnSeqRef.current += 1;
      const thisTurn = turnSeqRef.current;
      inFlightTurnRef.current = thisTurn;

      const isStillCurrent = () => !cancelledRef.current && inFlightTurnRef.current === thisTurn;

      setState('transcribing');
      const blob = encodePcm16Wav(audio, 16_000);
      try {
        // Pin the Whisper language hint to the UI locale ONLY when the
        // user is on a non-English UI. For the default-English case we
        // pass undefined so Whisper auto-detects the spoken language —
        // otherwise a Croatian speaker on a fresh browser (locale 'en'
        // fallback) gets `language=en` forced on their Croatian audio
        // and Whisper returns empty_transcription.
        // Prefer the saved settings_general language over i18n.language: the
        // i18next detector can resolve to "en" on a fresh tab even when the
        // user has "hr" saved. A wrong hint costs us heavily on Whisper for
        // Croatian audio with foreign-name wake words.
        const settingsLang = settingsLanguageRef.current;
        const i18nLang = i18n.language;
        const effectiveLang = (settingsLang || i18nLang || '').toLowerCase();
        const sttLanguageHint = effectiveLang && effectiveLang !== 'en' ? effectiveLang : undefined;
        // Bias Whisper toward the focused book's proper nouns — only when
        // exactly one book is focused, so the hint stays precise (the backend
        // builds it from that book's title + graph entities).
        const focusHintDocId =
          focusedBooks.length === 1 ? focusedBooks[0].id : undefined;
        const result = await transcribeVoiceClip(
          blob,
          user?.id || '',
          sttLanguageHint,
          focusHintDocId
        );
        if (!isStillCurrent()) return;
        setByokUsed(Boolean(result.byok_used));

        const rawText = (result.text || '').trim();
        // Backend noise / hallucination gate — driven by Whisper's own
        // no_speech_prob / compression_ratio confidence outputs, not a
        // keyword list. When the gate fires there was no real user input,
        // so the right UX is to silently return to listening; surfacing
        // an error toast every time a fan or distant cough fired the VAD
        // would be more annoying than the underlying noise.
        if (result.error === 'noise_filtered' || result.error === 'repetitive_hallucination') {
          setState('listening');
          return;
        }
        if (result.error || !rawText) {
          setError(result.error || 'empty_transcription');
          setState('error');
          return;
        }
        setTranscript(rawText);

        // Wake-word gate. When enabled, the dialog only forwards transcripts
        // whose first words match the configured name. Intro Q&A bypasses
        // this (the user is just answering "yes/no" to a greeting we
        // initiated), and once they've said the wake word once the rest of
        // the conversation flows without it until 30 s of silence.
        let text = rawText;
        const wake = wakeWordRef.current;
        const introInFlight = introPendingRef.current && !introHandledRef.current && introSummaryRef.current !== null;
        if (wake.enabled && wake.name && !introInFlight) {
          if (!wakeOpenRef.current) {
            const stripped = stripWakeWord(rawText, wake.name);
            if (stripped === null) {
              // Not addressed to us. We used to silently drop the turn,
              // which left the user staring at the orb wondering why the
              // assistant ignored a perfectly clear question. Surface
              // a short toast naming the wake word so the next attempt
              // includes it, then go back to listening.
              const displayName = wake.name.charAt(0).toUpperCase() + wake.name.slice(1);
              sonnerToast.info(
                t('voiceMode.wakeWordMiss', {
                  name: displayName,
                  defaultValue: 'Reci "{{name}}" prije pitanja da bot odgovori.',
                }),
                { duration: 3500 },
              );
              setState('listening');
              return;
            }
            if (!stripped) {
              // User said only the wake word with no question. Acknowledge
              // by opening the session and waiting for the real prompt.
              wakeOpenRef.current = true;
              scheduleWakeReset();
              setState('listening');
              return;
            }
            text = stripped;
            wakeOpenRef.current = true;
            scheduleWakeReset();
          } else {
            scheduleWakeReset();
          }
        }

        // Intro Q&A — if we asked "want a description?" / "want me to
        // generate one?" and this is the user's first reply, handle it
        // inline (yes → read summary or generate-then-read, no →
        // acknowledge, other → fall through into the regular flow with
        // the user's actual question). Read intro from the ref so we
        // never race against batched React state updates.
        const introNow = introSummaryRef.current;
        if (introPendingRef.current && !introHandledRef.current && introNow) {
          introHandledRef.current = true;
          introPendingRef.current = false;
          const verdict = classifyIntroReply(text);
          if (verdict === 'yes' && introNow.kind === 'ready') {
            setState('speaking');
            await speakText(introNow.text);
            if (!isStillCurrent()) return;
            historyRef.current = [
              ...historyRef.current.slice(-10),
              { role: 'user', content: text },
              { role: 'assistant', content: introNow.text },
            ];
            setState('listening');
            return;
          }
          if (verdict === 'yes' && introNow.kind === 'absent') {
            // User opted in to on-demand generation. Speak the filler
            // ("generating, please wait") first so they know we heard
            // them, then run generate + optional translate, then speak
            // the result. On failure, apologise and drop into listening.
            const docId = introNow.docId;
            setState('speaking');
            await speakText(introGeneratingNotice(i18n.language));
            if (!isStillCurrent()) return;
            setState('awaiting_response');
            let generated: string | null = await new Promise<string | null>((resolve) => {
              generateBookSummary(
                docId,
                () => {
                  /* progress — silent in voice mode */
                },
                (full) => resolve(full),
                () => resolve(null),
              ).catch(() => resolve(null));
            });
            if (!isStillCurrent()) return;
            const lang = (i18n.language || 'en').toLowerCase().split('-')[0];
            if (generated && lang && lang !== 'en') {
              const translated = await new Promise<string | null>((resolve) => {
                translateBookSummary(
                  docId,
                  lang,
                  () => {
                    /* streaming deltas ignored */
                  },
                  (full) => resolve(full),
                  () => resolve(null),
                ).catch(() => resolve(null));
              });
              if (!isStillCurrent()) return;
              if (translated) generated = translated;
            }
            if (!generated) {
              setState('speaking');
              await speakText(introGenerateFailedNotice(i18n.language));
              if (!isStillCurrent()) return;
              setState('listening');
              return;
            }
            setState('speaking');
            await speakText(generated);
            if (!isStillCurrent()) return;
            historyRef.current = [
              ...historyRef.current.slice(-10),
              { role: 'user', content: text },
              { role: 'assistant', content: generated },
            ];
            setState('listening');
            return;
          }
          if (verdict === 'no') {
            // Brief polite ack so the user knows we heard them.
            const code = (i18n.language || 'en').toLowerCase().split('-')[0];
            const ack =
              code === 'hr' || code === 'bs' || code === 'sr'
                ? 'U redu. Što te zanima?'
                : code === 'de'
                  ? 'Verstanden. Was möchtest du wissen?'
                  : code === 'fr'
                    ? "D'accord. Que veux-tu savoir ?"
                    : code === 'es'
                      ? 'De acuerdo. ¿Qué quieres saber?'
                      : code === 'it'
                        ? "D'accordo. Cosa vuoi sapere?"
                        : code === 'pt'
                          ? 'Está bem. O que queres saber?'
                          : code === 'ru'
                            ? 'Хорошо. Что ты хочешь узнать?'
                            : "Got it. What would you like to know?";
            setState('speaking');
            await speakText(ack);
            if (!isStillCurrent()) return;
            setState('listening');
            return;
          }
          // 'other' → user asked a real question already. Drop into the
          // normal turn pipeline with `text` as the prompt.
        }

        // One user turn (LLM stream + TTS), wrapped so the semantic-endpointing
        // fallback can replay a held fragment through the exact same pipeline.
        const dispatchTurn = async (promptText: string) => {
        setState('awaiting_response');
        setAgentPhase('');
        // Merge @-tagged docs with the tool-set focus from previous turns,
        // dedup, so the server's phase-1 grep/cat tools see the union. The
        // prop wins if the same ID is both — explicit user gesture trumps
        // agent-inferred focus.
        const mergedDocIds = Array.from(
          new Set([...documentIds, ...focusedBooks.map((b) => b.id)]),
        );
        // Reset and claim the streaming-TTS pipeline for this turn. Any
        // queued speech from the previous turn is dropped, and the bumped
        // turn id makes late deltas / drainer iterations no-ops.
        resetSpeechQueue();
        const myTtsTurn = ttsTurnRef.current;
        let accumulatedText = '';
        let speakingStarted = false;
        let chatResponse: VoiceChatFinal = { text: '' };
        try {
          await voiceChatReplyStream(
            promptText,
            i18n.language,
            historyRef.current,
            {
              collectionIds: collectionIds || [],
              documentIds: mergedDocIds,
              userId: user?.id || '',
              // workspace_id unlocks the workspace-introspection tools on
              // the server (list_workspace_collections /
              // get_workspace_overview / search_documents_by_metadata) so
              // the agent can answer library-state questions without an
              // @-tag.
              workspaceId: currentWorkspace?.id || '',
            },
            {
              onPhase: (phase: VoiceChatPhase) => {
                if (!isStillCurrent()) return;
                if (phase.stage === 'start' && phase.label) {
                  setAgentPhase(phase.label);
                }
                // 'done' stages are mostly noise for the UI; leave the
                // last label up so the user sees the thread of activity.
              },
              onText: (delta: string) => {
                if (!isStillCurrent() || ttsTurnRef.current !== myTtsTurn) return;
                if (!delta) return;
                accumulatedText += delta;
                setResponse(accumulatedText);
                ttsTextBufferRef.current += delta;
                const sentences = flushSentencesFromBuffer();
                for (const s of sentences) {
                  if (!speakingStarted) {
                    speakingStarted = true;
                    setAgentPhase('');
                    setState('speaking');
                  }
                  enqueueSpeech(s, myTtsTurn);
                }
              },
              onFinal: (final: VoiceChatFinal) => {
                chatResponse = final;
              },
              onError: (err: string) => {
                chatResponse = { text: '', error: err };
                throw new Error(err || 'stream_error');
              },
            },
          );
        } catch (streamErr) {
          // Stream-level failure → fall through to the existing
          // error-state handling below by leaving chatResponse.text
          // empty. (Network drop, server 5xx before SSE even started,
          // etc.)
          // eslint-disable-next-line no-console
          console.warn('voice stream failed:', streamErr);
        }
        if (!isStillCurrent()) return;
        // Flush any trailing partial sentence the LLM ended without a
        // terminal `.` — TTS still wants to read it.
        if (ttsTextBufferRef.current.trim()) {
          const tail = ttsTextBufferRef.current.trim();
          ttsTextBufferRef.current = '';
          if (!speakingStarted) {
            speakingStarted = true;
            setAgentPhase('');
            setState('speaking');
          }
          enqueueSpeech(tail, myTtsTurn);
        }
        setAgentPhase('');
        if (!chatResponse.text && accumulatedText) {
          chatResponse = { ...chatResponse, text: accumulatedText };
        }

        // Sync the agent-set book focus from the server. The response always
        // carries the CURRENT focus state, so we mirror it exactly: a
        // non-empty list sets the focused-book thumbnails, an empty list means
        // the agent RELEASED focus (the user switched to a topic the books
        // don't cover, via set_book_focus([])) and we drop the thumbnails.
        // `focused_books` is the {id, title} companion to focused_document_ids.
        if (Array.isArray(chatResponse.focused_books)) {
          setFocusedBooks(
            chatResponse.focused_books
              .filter((b) => b && typeof b.document_id === 'string' && b.document_id.length > 0)
              .map((b) => ({ id: b.document_id, title: b.title || 'Untitled' })),
          );
        } else if (Array.isArray(chatResponse.focused_document_ids)) {
          // Fallback when only IDs land (older server) — use the UUID prefix
          // as the visible label rather than dropping the chip entirely.
          setFocusedBooks(
            chatResponse.focused_document_ids
              .filter((id) => typeof id === 'string' && id.length > 0)
              .map((id) => ({ id, title: id.slice(0, 8) })),
          );
        }

        setUsedRag(Boolean(chatResponse.used_rag));
        const replyText = (chatResponse.text || '').trim();
        if (chatResponse.error || !replyText) {
          setError(chatResponse.error || 'empty_reply');
          setState('error');
          return;
        }
        setResponse(replyText);
        historyRef.current = [
          ...historyRef.current.slice(-10),
          { role: 'user', content: promptText },
          { role: 'assistant', content: replyText },
        ];

        // Wait for the streaming-TTS drainer to finish — by now every
        // sentence is on the queue (deltas + tail), so the drainer just
        // needs to finish synthesising and playing them. VAD stays on
        // so onSpeechStart can fire mid-playback for barge-in; the
        // ``barged_in`` branch cancels this turn before setting up the
        // new one.
        if (!speakingStarted && replyText) {
          // Stream produced no deltas (older server, or the agent
          // returned a single non-text payload). Fall back to a
          // one-shot synthesise + play of the final text.
          setState('speaking');
          await speakText(replyText);
          if (!isStillCurrent()) return;
          setState('listening');
        } else {
          // Drainer is running concurrently. Poll for it to finish
          // (queue empty AND not in-flight) before flipping back to
          // listening. The wait is cheap because each iteration is a
          // 30 ms timer, and once the drainer falls off speakText's
          // onended the loop ends within a tick.
          while (
            !cancelledRef.current
            && ttsTurnRef.current === myTtsTurn
            && (ttsActiveRef.current || ttsQueueRef.current.length > 0)
          ) {
            await new Promise<void>((resolve) => setTimeout(resolve, 60));
          }
          if (!isStillCurrent()) return;
          setState('listening');
        }
        }; // end dispatchTurn

        // ── Semantic endpointing ───────────────────────────────────────────
        // Stitch a thought the user paused mid-way through. Prepend any held
        // fragment, then ask the backend whether the combined utterance is a
        // finished thought. If not, hold it and keep listening; a fallback
        // timer sends the held fragment anyway if the user never resumes, so a
        // trailed-off thought is still answered.
        const stitched = pendingTranscriptRef.current
          ? `${pendingTranscriptRef.current} ${text}`.trim()
          : text;
        let turnComplete = true;
        try {
          turnComplete = await judgeTurnComplete(stitched);
        } catch {
          turnComplete = true;
        }
        if (!isStillCurrent()) return;
        if (!turnComplete) {
          pendingTranscriptRef.current = stitched;
          setTranscript(stitched);
          setState('listening');
          if (pendingFlushTimerRef.current) clearTimeout(pendingFlushTimerRef.current);
          pendingFlushTimerRef.current = setTimeout(() => {
            pendingFlushTimerRef.current = null;
            const held = pendingTranscriptRef.current;
            pendingTranscriptRef.current = '';
            if (held && isStillCurrent()) void dispatchTurn(held).catch(() => {});
          }, 4500);
          return;
        }
        // Complete → clear the buffer and run the (possibly stitched) turn.
        pendingTranscriptRef.current = '';
        if (pendingFlushTimerRef.current) {
          clearTimeout(pendingFlushTimerRef.current);
          pendingFlushTimerRef.current = null;
        }
        setTranscript(stitched);
        await dispatchTurn(stitched);
      } catch (e) {
        if (!isStillCurrent()) return;
        setError(String(e instanceof Error ? e.message : e));
        setState('error');
      }
    },
    [collectionIds, documentIds, i18n.language, user?.id, introSummary, speakText],
  );

  const startConversation = useCallback(async () => {
    setError('');
    setTranscript('');
    setResponse('');
    setUsedRag(false);
    cancelledRef.current = false;

    try {
      // Lazy-load MicVAD only when the user actually starts a conversation
      // — the WASM bundle + ONNX model is ~3 MB combined.
      const { MicVAD } = await import('@ricky0123/vad-web');
      if (cancelledRef.current) return;

      const vad = (await MicVAD.new({
        // Both paths are populated by the `scrapalot-copy-voice-assets`
        // Vite plugin (see vite.config.ts). Without these the library
        // tries to fetch `/assets/ort-wasm-simd-threaded.mjs` which Vite
        // does NOT auto-copy out of node_modules — voice mode then fails
        // with "no available backend found" + WASM init error.
        baseAssetPath: '/vad/',
        onnxWASMBasePath: '/ort/',
        // Silero VAD thresholds. Library defaults are 0.3/0.25 which fire
        // onSpeechStart on any cough or keyboard click — we tighten the
        // POSITIVE side to 0.5 so a clear human-voice signal is required.
        // Critically: the timing knobs are *Ms (milliseconds), not
        // *Frames — an older copy of this code used minSpeechFrames /
        // redemptionFrames, names the library silently ignores, so the
        // built-in 1.4 s redemption applied and segments dangled forever
        // when background noise kept the model above the negative
        // threshold. `submitUserSpeechOnPause: true` is a safety net:
        // calling vad.pause() (e.g. on a 15 s hard timeout) will flush
        // the in-progress segment as onSpeechEnd instead of dropping it.
        // Tightened in two passes. 1st pass (0.5→0.75) was prompted by
        // user complaint "every noise interrupts the assistant". 2nd pass
        // (0.75→0.80, minSpeechMs 300→500) was prompted by the chapter-
        // skip bug where short background noise during book reading was
        // VAD-detected, Whisper hallucinated a prompt, and the agent
        // skipped chapters when the user said "nastavi" next. Defense in
        // depth: backend voice_mode_service.py now also gates on Whisper
        // confidence (no_speech_prob, compression_ratio), so this VAD bump
        // does not have to single-handedly hold the noise out.
        positiveSpeechThreshold: 0.8,
        negativeSpeechThreshold: 0.55,
        minSpeechMs: 500,
        // Silence (ms) the VAD waits AFTER you stop before it ends the
        // segment and sends it. 900 ms cut users off mid-thought; 1400 ms
        // felt sluggish; 1100 ms is the sweet spot — room for a natural pause
        // inside one utterance without a long wait before the reply. (The
        // 12 s hard cap in onSpeechStart still bounds a runaway segment.)
        redemptionMs: 1100,
        // 800 ms is the library default; we keep it because the wake word
        // ("Scrapalot", "Aria", …) typically lives in the first 500-700 ms
        // of the user's utterance. A shorter pad clips the leading
        // syllable, Whisper transcribes "dobar dan" instead of "Scrapalot
        // dobar dan", and the wake-word filter then silently drops the
        // turn.
        preSpeechPadMs: 800,
        submitUserSpeechOnPause: true,
        // Per-frame mic amplitude (RMS of the raw 16 kHz frame) feeds the
        // audio-reactive central metronome while the user is being listened
        // to / is speaking. Cheap (one pass over a ~512-sample frame) and
        // fires on every VAD frame regardless of speech detection.
        onFrameProcessed: (_probabilities: unknown, frame: Float32Array) => {
          // The VAD library calls this with `void onFrameProcessed(...)` and
          // NO try/catch, and it runs BEFORE the redemption/SpeechEnd block in
          // the same frameProcessor.process() call. A throw here would abort
          // that call and silently skip SpeechEnd → the segment never ends and
          // recording sticks forever. This is cosmetic (metronome amplitude),
          // so it must never be able to break speech detection.
          try {
            if (!frame || frame.length === 0) return;
            let sum = 0;
            for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
            const rms = Math.sqrt(sum / frame.length);
            micLevelRef.current = rms;
            // Track the last moment the mic carried real voice energy. 0.012
            // sits just above ambient room noise (real speech is 0.05-0.2),
            // and matches the silence floor handleSpeechEnd already drops on.
            // The recording monitor uses this to tell "still talking" from
            // "stopped but the VAD didn't notice".
            if (rms > 0.012) lastVoiceAtRef.current = Date.now();
          } catch {
            /* never let metronome amplitude break the VAD frame loop */
          }
        },
        onSpeechStart: () => {
          if (cancelledRef.current) return;
          // Barge-in: user started speaking while the assistant is still
          // talking. Cancel the in-flight TTS, invalidate any in-flight
          // LLM response (its result will be dropped on landing), and
          // reuse the same speech segment as the next turn's input.
          if (stateRef.current === 'speaking') {
            // Grace window: ignore VAD fires in the first 1500 ms of an
            // assistant turn. This window matches the time during which
            // (a) the user is still inhaling / settling after asking the
            // question, (b) the listener's own keyboard click / cup
            // placement is most likely to misfire VAD, and (c) Edge-TTS
            // is just kicking in so any half-second early-cut is the
            // most visible failure mode. After 1500 ms genuine
            // interrupts (the user actually saying something) still
            // take over.
            const elapsedSpeaking = Date.now() - speakingStartedAtRef.current;
            if (speakingStartedAtRef.current > 0 && elapsedSpeaking < 1500) {
              return;
            }
            if (audioElRef.current) {
              audioElRef.current.pause();
              audioElRef.current.src = '';
            }
            // Drop every queued sentence + reset the sentence buffer
            // and bump the TTS turn so any in-flight drainer iteration
            // stops on its next loop check.
            resetSpeechQueue();
            // Bump turn so the captured ``thisTurn`` of any in-flight
            // chain compares unequal and silently drops its result.
            inFlightTurnRef.current = turnSeqRef.current + 1;
            setBargeInCount((n) => n + 1);
          }
          setState('recording');
          const now = Date.now();
          speechStartedAtRef.current = now;
          lastVoiceAtRef.current = now;
          // Recording safety monitor. The model can stick above
          // negativeSpeechThreshold (continuous background noise) so its
          // redemption counter never trips and onSpeechEnd never fires — the
          // user sees "recording" forever. A FIXED timeout fixed that but also
          // chopped a long-but-continuous answer mid-sentence and then
          // restarted mid-word, which felt like a freeze. Instead poll: only
          // force-flush once the user has actually gone quiet
          // (SILENCE_FLUSH_MS of sub-voice frames — longer than redemptionMs so
          // the VAD's own end-detection always gets first crack), or at a hard
          // ceiling no real single utterance reaches. We do NOT gate on
          // stateRef === 'recording' — a stale ref would silently disable the
          // only backstop.
          const SILENCE_FLUSH_MS = 1600;
          const HARD_CAP_MS = 30_000;
          if (speechMaxTimerRef.current) clearInterval(speechMaxTimerRef.current);
          speechMaxTimerRef.current = setInterval(() => {
            if (cancelledRef.current) {
              if (speechMaxTimerRef.current) clearInterval(speechMaxTimerRef.current);
              speechMaxTimerRef.current = null;
              return;
            }
            const t = Date.now();
            const silentFor = t - lastVoiceAtRef.current;
            const recordingFor = t - speechStartedAtRef.current;
            if (silentFor < SILENCE_FLUSH_MS && recordingFor < HARD_CAP_MS) return;
            // Conditions met → flush once. pause() with
            // submitUserSpeechOnPause=true emits the buffered audio as a
            // SpeechEnd (or VADMisfire if too little speech); both re-arm the
            // pipeline, then we restart listening.
            if (speechMaxTimerRef.current) clearInterval(speechMaxTimerRef.current);
            speechMaxTimerRef.current = null;
            const v = vadRef.current;
            if (!v) return;
            void Promise.resolve(v.pause()).then(() => {
              if (cancelledRef.current) return;
              void Promise.resolve(v.start());
            });
          }, 400);
        },
        onSpeechEnd: (audio: Float32Array) => {
          if (speechMaxTimerRef.current) {
            clearInterval(speechMaxTimerRef.current);
            speechMaxTimerRef.current = null;
          }
          if (cancelledRef.current) return;
          void handleSpeechEnd(audio);
        },
        onVADMisfire: () => {
          if (speechMaxTimerRef.current) {
            clearInterval(speechMaxTimerRef.current);
            speechMaxTimerRef.current = null;
          }
          if (cancelledRef.current) return;
          // Rapid speech-start followed by no speech-end — return to listening.
          setState('listening');
        },
      })) as unknown as MicVADInstance;

      vadRef.current = vad;
      await vad.start();
      if (cancelledRef.current) {
        await teardownVad();
        return;
      }

      // Single-book intro: wait for the prefetch effect to finish (or
      // a soft 7 s ceiling so a slow getBookSummary doesn't strand the
      // user). Reading from the ref is safe — it's updated synchronously
      // inside the effect before the promise resolves, so React's batched
      // state update doesn't matter here.
      if (introReadyPromiseRef.current && !introHandledRef.current) {
        await Promise.race([
          introReadyPromiseRef.current,
          new Promise<void>((resolve) => setTimeout(resolve, 7000)),
        ]);
        if (cancelledRef.current) return;
      }
      const intro = introSummaryRef.current;
      // Speak the appropriate locale-aware greeting NOW (browser allows
      // audio after the orb tap = user gesture). VAD is already running
      // so the user's reply gets captured as the first utterance and
      // intercepted in handleSpeechEnd.
      //   ready  → "I have a summary, want a description?"
      //   absent → "no summary yet, generate one?"
      if (intro && !introHandledRef.current) {
        introPendingRef.current = true;
        const greeting =
          intro.kind === 'ready'
            ? introGreeting(i18n.language, intro.title)
            : introGenerateGreeting(i18n.language, intro.title);
        setState('speaking');
        await speakText(greeting);
        if (cancelledRef.current) return;
      }
      setState('listening');
    } catch (e) {
      sonnerToast.error(t('voiceMode.micPermissionDenied'));
      setError(String(e instanceof Error ? e.message : e));
      setState('error');
    }
  }, [handleSpeechEnd, i18n.language, introSummary, speakText, t, teardownVad]);

  const endConversation = useCallback(async () => {
    cancelledRef.current = true;
    // Clear the streaming-TTS queue and bump the TTS turn so the drainer
    // stops on its next check. Without this, sentences already queued keep
    // playing after the user taps stop — the "doesn't stop immediately" bug.
    resetSpeechQueue();
    if (audioElRef.current) {
      audioElRef.current.pause();
      audioElRef.current.src = '';
    }
    // Hard-stop the Web Audio path too. Without this an in-flight
    // sentence keeps playing after the user closes the dialog.
    if (currentSourceRef.current) {
      try {
        currentSourceRef.current.stop();
      } catch {
        // already stopped
      }
      currentSourceRef.current = null;
    }
    await teardownVad();
    setState('idle');
  }, [teardownVad, resetSpeechQueue]);

  // Teardown on dialog close: stop VAD, audio playback so the tab does not
  // keep the mic light on after the user dismissed the dialog.
  useEffect(() => {
    if (!open) {
      void endConversation();
      setTranscript('');
      setResponse('');
      setError('');
      setByokUsed(false);
      setUsedRag(false);
      setBargeInCount(0);
      historyRef.current = [];
      turnSeqRef.current = 0;
      inFlightTurnRef.current = 0;
      wakeOpenRef.current = false;
      if (wakeOpenTimerRef.current) {
        clearTimeout(wakeOpenTimerRef.current);
        wakeOpenTimerRef.current = null;
      }
      setFocusedBooks([]);
      setAgentPhase('');
      resetSpeechQueue();
    }
    // endConversation captures stable refs only — exhaustive deps would force
    // a teardown loop on every state change which is exactly what we don't want.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Auto-start VAD as soon as the dialog opens. The mic icon click in the
  // toolbar is the browser-required user gesture, so getUserMedia can spin
  // up here without a second tap. The orb then acts purely as a stop/restart
  // control — if the user ends the conversation by tapping it, we leave
  // ``state === 'idle'`` and do NOT auto-restart (that would defeat the tap).
  useEffect(() => {
    if (open && stateRef.current === 'idle') {
      void startConversation();
    }
    // Intentionally depending only on `open`: state transitions during the
    // session must not retrigger startConversation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Android / mobile hardware back button support. Push a sentinel state
  // when the dialog opens so the device back gesture pops it instead of
  // navigating the underlying page; the popstate handler closes voice
  // mode. The sentinel is identified by a `voiceMode: true` flag in
  // history.state so we don't accidentally trap unrelated back navigation.
  useEffect(() => {
    if (!open || typeof window === 'undefined') return;
    const sentinel = { voiceMode: true, ts: Date.now() };
    window.history.pushState(sentinel, '');
    const onPop = () => {
      onOpenChange(false);
    };
    window.addEventListener('popstate', onPop);
    return () => {
      window.removeEventListener('popstate', onPop);
      // If the dialog was closed via X / Escape (not back gesture), the
      // sentinel is still on top of the stack — pop it so the user's
      // history isn't littered. Guarded so we only pop our own entry.
      if (window.history.state && (window.history.state as { voiceMode?: boolean }).voiceMode) {
        window.history.back();
      }
    };
  }, [open, onOpenChange]);

  const onOrbClick = useCallback(() => {
    switch (state) {
      case 'idle':
        void startConversation();
        break;
      case 'error':
        setState('idle');
        setError('');
        break;
      default:
        // Any ACTIVE state (listening / recording / speaking / transcribing /
        // awaiting_response) → a tap is a hard STOP. endConversation cancels
        // the in-flight request, clears the TTS queue + stops playback, tears
        // down the VAD, and returns to idle. Crucially it does NOT resume
        // listening, so a sound made right after the tap is not captured and
        // auto-replayed. To talk again, tap once more (idle → start).
        // (Barge-in while the assistant speaks still works by just speaking —
        // the VAD interrupts on a real voice signal; the tap is for stopping.)
        void endConversation();
        break;
    }
  }, [state, startConversation, endConversation]);

  const statusLabel = useMemo(() => {
    switch (state) {
      case 'idle':
        return t('voiceMode.status.idle');
      case 'listening':
        return t('voiceMode.status.listening', 'Listening…');
      case 'recording':
        return t('voiceMode.status.recording');
      case 'transcribing':
        return t('voiceMode.status.transcribing');
      case 'awaiting_response':
        return t('voiceMode.status.awaitingResponse');
      case 'speaking':
        return t('voiceMode.status.speaking');
      case 'error':
        return t('voiceMode.status.error');
    }
  }, [state, t]);

  const hint = useMemo(() => {
    switch (state) {
      case 'idle':
        return t('voiceMode.hint.tapToStart');
      case 'listening':
        return t('voiceMode.hint.listening', 'Speak — I will detect when you are done');
      case 'recording':
        return t('voiceMode.hint.recording', 'Listening to you');
      case 'speaking':
        return t('voiceMode.hint.tapToInterrupt');
      default:
        return '';
    }
  }, [state, t]);

  // The global tool-dock rail renders at the maximum z-index, so it sits above
  // even this fullscreen dialog and its icons overlap the conversation. Tag
  // <body> while the dialog is open; a global CSS rule hides the dock for the
  // duration (see index.css `body.voice-mode-active [data-tool-dock]`).
  useEffect(() => {
    document.body.classList.toggle('voice-mode-active', open);
    return () => document.body.classList.remove('voice-mode-active');
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/*
        Forced full-viewport layout on every breakpoint. The base Dialog CSS
        applies `inset-x-2 inset-y-0 p-4 overflow-y-auto` on mobile and a
        centred modal on desktop; the `!`-prefixed overrides below win over
        both so the voice orb + transcripts fill the screen edge-to-edge.
      */}
      <DialogContent
        hideCloseButton
        // Voice mode must sit above the PDF/EPUB viewer drawer (zIndex
        // 1700 default → 9999 when focused → 1_000_000 inner stage in
        // EPUB) and above any floating window or knowledge-stacks dialog.
        // The user opened a hands-free conversation — that wins.
        style={{ zIndex: 1_000_010 }}
        overlayZIndex='1000009'
        className='!p-0 !m-0 !inset-0 !w-screen !h-screen !max-w-none !max-h-none !translate-x-0 !translate-y-0 !left-0 !top-0 flex flex-col'
      >
        {/* Header — consistent with the app's other dialogs: title on the
            left, controls on the right, one border-b. Every control is a plain
            borderless icon button: no background, no border, no box — only an
            icon-colour change on hover and a thin focus-visible ring. */}
        <div className='shrink-0 z-20 flex items-center justify-between gap-2 px-4 pt-[max(0.75rem,env(safe-area-inset-top))] pb-3 border-b border-border'>
          <div className='flex items-center gap-2 min-w-0 pointer-events-auto'>
            <DialogTitle className='text-base font-semibold text-foreground truncate'>
              {t('voiceMode.title', 'Voice conversation')}
            </DialogTitle>
            {byokUsed && (
              <span className='shrink-0 px-1.5 py-0.5 text-[10px] uppercase tracking-wider bg-primary/10 text-primary animate-fade-in'>
                {t('voiceMode.byok', 'Your key')}
              </span>
            )}
          </div>

          <div className='flex items-center gap-1 shrink-0 pointer-events-auto'>
            <Popover>
              <PopoverTrigger asChild>
                <button
                  type='button'
                  data-testid='voice-mode-speed-button'
                  aria-label={t('voiceMode.speed.button', 'Voice speed')}
                  title={t('voiceMode.speed.button', 'Voice speed')}
                  className='w-11 h-11 lg:w-9 lg:h-9 flex flex-col items-center justify-center text-muted-foreground hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring'
                >
                  <Gauge className='h-4 w-4' strokeWidth={1.5} />
                  <span className='text-[9px] font-medium leading-none mt-0.5 tabular-nums'>
                    {voiceSpeed.toFixed(1)}×
                  </span>
                </button>
              </PopoverTrigger>
              <PopoverContent
                sideOffset={8}
                align='end'
                className='w-64 p-4 space-y-3'
                style={{ zIndex: 1_000_011 }}
              >
                <div className='flex items-center justify-between text-sm'>
                  <span className='font-medium'>{t('voiceMode.speed.label', 'Voice speed')}</span>
                  <span className='font-mono tabular-nums text-muted-foreground'>
                    {voiceSpeed.toFixed(2)}×
                  </span>
                </div>
                <Slider
                  value={[voiceSpeed]}
                  min={0.5}
                  max={1.5}
                  step={0.05}
                  onValueChange={(v) => handleVoiceSpeedChange(v[0] ?? 1.0)}
                  aria-label={t('voiceMode.speed.label', 'Voice speed')}
                />
                <div className='flex items-center justify-between text-[10px] text-muted-foreground'>
                  <span>0.50×</span>
                  <button
                    type='button'
                    onClick={() => handleVoiceSpeedChange(1.0)}
                    className='underline hover:text-foreground transition-colors'
                  >
                    {t('voiceMode.speed.reset', 'Reset')}
                  </button>
                  <span>1.50×</span>
                </div>
              </PopoverContent>
            </Popover>

            <button
              type='button'
              data-testid='voice-mode-close-button'
              onClick={() => onOpenChange(false)}
              aria-label={t('voiceMode.close', 'Close voice mode')}
              className='w-11 h-11 lg:w-9 lg:h-9 flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring'
            >
              <X className='h-5 w-5' strokeWidth={1.5} />
            </button>
          </div>
        </div>

        {/* Focused-books slider — a single book is centred; multiple books
            become a snap carousel with prev/next affordances. */}
        {(() => {
          const tagged = documents ?? [];
          const taggedIds = new Set(tagged.map((d) => d.id));
          const focusOnly = focusedBooks.filter((b) => !taggedIds.has(b.id));
          const all = [
            ...tagged.map((d) => ({ id: d.id, title: d.title })),
            ...focusOnly,
          ];
          if (all.length === 0) return null;
          return <BookSlider books={all} />;
        })()}

        {/* Central metronome — the hero element (replaces the old circular orb).
            It is ABSOLUTELY centred in the available space so it stays put when
            the status / phase labels appear below it (those used to push it up).
            The whole metronome is the tap target: tap to start when idle, tap
            to STOP when active. */}
        <div className='flex-1 relative min-h-0'>
          <div className='absolute inset-0 flex items-center justify-center pointer-events-none'>
            <button
              type='button'
              data-testid='voice-mode-orb'
              onClick={onOrbClick}
              aria-label={statusLabel || t('voiceMode.title', 'Voice conversation')}
              className='pointer-events-auto flex items-center justify-center px-12 py-10 transition-transform active:scale-[0.97] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring'
            >
              <CentralMetronome state={state} analyserRef={analyserRef} micLevelRef={micLevelRef} />
            </button>
          </div>

          {/* Status + labels — anchored toward the bottom of the area so they
              never move the metronome. pointer-events-none keeps the tap target
              clean. */}
          <div className='absolute inset-x-0 bottom-4 flex flex-col items-center gap-2 px-4 pointer-events-none'>
            {statusLabel && (
              <div className='text-sm text-muted-foreground text-center'>{statusLabel}</div>
            )}
            {bargeInCount > 0 && (
              <div
                data-testid='voice-mode-barge-in-count'
                className='px-2 py-0.5 text-[10px] uppercase tracking-wider bg-amber-500/10 text-amber-700 dark:text-amber-300'
              >
                {t('voiceMode.bargeInCount', { count: bargeInCount, defaultValue: 'Barge-ins: {{count}}' })}
              </div>
            )}
            {agentPhase && (
              <div
                data-testid='voice-mode-agent-phase'
                className='text-xs text-muted-foreground/70 italic text-center animate-pulse'
              >
                {agentPhase}
              </div>
            )}
          </div>
        </div>

        {/* Transcript section — subtitle-style, fully scrollable, no truncation.
            shrink-0 with a max-height cap so it never squeezes the orb area above. */}
        {(transcript || response || error) && (
          <div className='shrink-0 w-full max-w-lg mx-auto px-4 pb-3 max-h-[40vh] overflow-y-auto space-y-3'>
            {transcript && (
              <div
                key={`u:${transcript.slice(0, 24)}`}
                className='motion-safe:animate-voice-card-up'
              >
                <div className='text-[10px] uppercase tracking-wider text-muted-foreground mb-1'>
                  {t('voiceMode.youSaid', 'You said')}
                </div>
                <p className='text-sm text-foreground/80 leading-relaxed'>{transcript}</p>
              </div>
            )}
            {response && (
              <div
                key={`a:${response.slice(0, 24)}`}
                className='motion-safe:animate-voice-card-up'
              >
                <div className='flex items-center justify-between mb-1'>
                  <div className='text-[10px] uppercase tracking-wider text-primary'>
                    {t('voiceMode.assistant', 'Assistant')}
                  </div>
                  {usedRag && (
                    <span className='text-[9px] uppercase tracking-wider px-1.5 py-0.5 bg-primary/10 text-primary border border-primary/30'>
                      {t('voiceMode.usedLibrary', 'Library')}
                    </span>
                  )}
                </div>
                <p className='text-sm leading-relaxed whitespace-pre-wrap text-foreground/90'>{response}</p>
              </div>
            )}
            {error && (
              <div
                data-testid='voice-mode-error'
                data-error-code={error}
                className='border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive break-words motion-safe:animate-voice-card-up'
              >
                {formatVoiceError(error, t)}
              </div>
            )}
          </div>
        )}

        {/* Hint row — only rendered when there's something to say, so
            it doesn't leave an empty bordered strip at the bottom. */}
        {hint && (
          <div className='shrink-0 border-t border-border px-6 py-3 text-center text-xs text-muted-foreground'>
            {hint}
          </div>
        )}

        {/* Hidden audio element for TTS playback */}
        <audio
          ref={audioElRef}
          data-testid='voice-mode-audio'
          className='hidden'
          preload='auto'
        />
      </DialogContent>
    </Dialog>
  );
}

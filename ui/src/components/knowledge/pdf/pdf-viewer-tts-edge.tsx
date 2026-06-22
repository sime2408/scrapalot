/**
 * PDF Viewer TTS with edge-tts Backend
 *
 * Uses edge-tts backend for high-quality speech synthesis with word-level timestamps.
 * Highlighting is done sequentially based on character offsets, not word matching.
 */

import React, { useRef, useCallback, useState, useEffect } from 'react';
import { synthesizeSpeech, listTTSVoices, base64ToAudioBlob, offsetToMs, splitTextForTTS, type WordBoundary, type TTSVoice } from '@/lib/api-tts';

// Backend /tts/synthesize hard-limits a single request to 50 000 chars.
// Markdown viewer (Deep Research "View Full Report") reuses this PDF TTS
// and can hand us a single "page" with 50-100 KB of text. Chunk anything
// over this threshold and synthesize only the first chunk — matches the
// EPUB TTS behaviour (CHUNK_SIZE = 10000), prevents the 400 Bad Request.
const TTS_MAX_SYNTH_CHARS = 10000;

// Split a page into a small first chunk (one sentence → playback starts in
// ~1.5s instead of waiting for the whole page) followed by larger chunks that
// synthesize while the previous one plays. Each chunk stays under the backend's
// hard limit. Previously only the first 10k chars of a long page were ever
// read; chunking the remainder fixes that silent truncation too.
const TTS_FOLLOWUP_CHUNK_CHARS = 1200;
function splitPageIntoTtsChunks(pageText: string): string[] {
  const text = pageText.trim();
  if (!text) return [];
  const sentences = text.match(/[^.!?]+[.!?]+\s*/g) || [text];
  const first = (sentences[0] || text).slice(0, TTS_MAX_SYNTH_CHARS).trim();
  const rest = text.slice(first.length).trim();
  const restChunks = rest ? splitTextForTTS(rest, TTS_FOLLOWUP_CHUNK_CHARS) : [];
  return [first, ...restChunks].filter(Boolean);
}
import { DEFAULT_TTS_VOICES, filterAndSortVoices, findBlockForTime as findBlockForTimeFn } from '@/lib/tts-defaults';
import { userPrefs } from '@/lib/storage-utils';
import i18n from '@/i18n';
import { defaultVoiceForI18n, detectLanguage, voiceForLanguage } from '@/lib/tts-language';

/**
 * How to pick the initial voice when the user has no saved preference.
 *
 *  - `'i18n'`       — follow `i18next.language` (deep research markdown viewer).
 *                     Also keeps the voice in sync if the user switches UI
 *                     language while the hook is mounted.
 *  - `'auto-detect'` — default to English and, on first synthesis, run
 *                      `detectLanguage()` on the extracted text. If the text
 *                      turns out to be Croatian or Macedonian, swap the voice
 *                      before that synthesis goes out. PDF / EPUB / DOCX
 *                      documents can be in any language, so this gives the
 *                      right voice without forcing the user to touch the
 *                      picker.
 *
 * A voice the user explicitly chose through `updateSelectedVoice` is never
 * auto-overridden in either mode — that flip is tracked by
 * `voiceWasUserChosenRef`.
 */
export type TTSVoiceMode = 'i18n' | 'auto-detect';

interface TTSPage {
  pageIndex: number;
  text: string;
  audio: Blob;
  wordBoundaries: WordBoundary[];
  durationMs: number;
  voice: string;
  // Intra-page chunking: playback starts on a small first chunk (~1.5s) and the
  // rest streams while it plays, instead of synthesizing the whole page first.
  charOffset?: number;       // this chunk's start offset within fullPageText (highlight stitching)
  fullPageText?: string;     // whole page text — used to build blocks + map; falls back to `text`
  restChunks?: string[];     // remaining chunk texts to synthesize + play after this one
}

/**
 * Represents a highlightable block (paragraph, heading, bullet, etc.)
 */
interface TextBlock {
  spans: Element[];
  text: string;
  charStart: number;  // Character offset in page text where this block starts
  charEnd: number;    // Character offset where this block ends
  type: 'h1' | 'h2' | 'h3' | 'paragraph' | 'bullet' | 'numbered' | 'table';
}

// Default voices - Croatian + EN (US, UK, CA, AU only)
const DEFAULT_VOICES = DEFAULT_TTS_VOICES;

export function useEdgeTTS(
  textLayerRef: React.RefObject<Element | null>,
  theme: 'light' | 'dark' = 'light',
  voiceMode: TTSVoiceMode = 'auto-detect'
) {
  // Tracks whether `selectedVoice` is an auto-chosen default (false) or one
  // the user explicitly picked (true). When true, neither the i18n sync effect
  // nor the first-synthesis auto-detect will override it.
  const voiceWasUserChosenRef = useRef(false);
  // State
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [speechRate, setSpeechRate] = useState(() => {
    const saved = userPrefs.get('tts_speech_rate');
    if (saved) {
      const parsed = parseFloat(saved);
      if (!isNaN(parsed) && parsed > 0 && parsed <= 3) {
        return parsed;
      }
    }
    return 1.0;
  });

  // Voice selection state
  const [availableVoices, setAvailableVoices] = useState<TTSVoice[]>(DEFAULT_VOICES);
  const [selectedVoice, setSelectedVoice] = useState<string>(() => {
    const saved = userPrefs.get('tts_selected_voice');
    if (saved && typeof saved === 'object' && 'name' in saved) {
      voiceWasUserChosenRef.current = true;
      return saved.name as string;
    }
    if (typeof saved === 'string' && saved) {
      voiceWasUserChosenRef.current = true;
      return saved;
    }
    // No saved preference — default per mode. `voiceWasUserChosenRef` stays
    // false so auto-detect / i18n sync can adjust later.
    return voiceMode === 'i18n' ? defaultVoiceForI18n() : 'en-US-AriaNeural';
  });
  const [isLoadingVoices, setIsLoadingVoices] = useState(false);

  // Refs
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const currentPageCacheRef = useRef<TTSPage | null>(null);
  const currentPageIndexRef = useRef<number>(0);
  const highlightIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const intentionalStopRef = useRef(false);
  const textBlocksRef = useRef<TextBlock[]>([]);
  const currentBlockIndexRef = useRef(0);
  const pageTextRef = useRef<string>('');
  // Map word index to block index for fast lookup during playback
  const wordToBlockMapRef = useRef<number[]>([]);

  // Scroll detection refs for TTS auto-follow
  const scrollDetectionIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const isAutoScrollingRef = useRef<boolean>(false);
  const lastDetectedPageRef = useRef<number>(0);

  // Ref to hold startTTSForPage to avoid circular dependency in useCallback
  const startTTSForPageRef = useRef<((pageIndex: number) => Promise<void>) | null>(null);
  // Ref to playAudioForPage so its own onended can play the next intra-page
  // chunk recursively without a circular useCallback dependency.
  const playAudioForPageRef = useRef<((pageData: TTSPage, textLayer: Element) => void) | null>(null);

  // Voice and rate refs for callbacks
  const selectedVoiceRef = useRef(selectedVoice);
  useEffect(() => {
    selectedVoiceRef.current = selectedVoice;
  }, [selectedVoice]);

  const speechRateRef = useRef(speechRate);
  useEffect(() => {
    speechRateRef.current = speechRate;
    if (audioRef.current && !audioRef.current.paused) {
      audioRef.current.playbackRate = speechRate;
    }
  }, [speechRate]);

  // Next page preload cache
  const nextPageCacheRef = useRef<TTSPage | null>(null);
  const isPreloadingRef = useRef(false);
  // In-flight synthesis of the NEXT intra-page chunk, started while the current
  // chunk plays so the follow-up is ready (or nearly) by the time it ends.
  const nextChunkSynthRef = useRef<Promise<{ audio: Blob; wordBoundaries: WordBoundary[]; durationMs: number }> | null>(null);

  /**
   * Fetch available voices from backend
   */
  useEffect(() => {
    const fetchVoices = async () => {
      setIsLoadingVoices(true);
      try {
        const voices = await listTTSVoices();
        const filteredVoices = filterAndSortVoices(voices);
        setAvailableVoices(filteredVoices.length > 0 ? filteredVoices : DEFAULT_VOICES);
        console.log(`🎤 TTS: Loaded ${filteredVoices.length} voices`);
      } catch (error) {
        console.error('❌ TTS: Failed to fetch voices', error);
        setAvailableVoices(DEFAULT_VOICES);
      } finally {
        setIsLoadingVoices(false);
      }
    };
    void fetchVoices();
  }, []);

  /**
   * Update selected voice
   */
  const updateSelectedVoice = useCallback((voiceNameOrObject: string | TTSVoice) => {
    const voiceName = typeof voiceNameOrObject === 'string'
      ? voiceNameOrObject
      : voiceNameOrObject?.name || 'en-US-AriaNeural';
    // Picking from the voice dropdown is an explicit user choice — stop
    // auto-detect / i18n sync from overwriting it for the rest of the session.
    voiceWasUserChosenRef.current = true;
    setSelectedVoice(voiceName);
    userPrefs.set('tts_selected_voice', voiceName);
    currentPageCacheRef.current = null;
  }, []);

  // i18n-mode only: keep the default voice aligned with the UI language.
  // Fires when the user switches app language (en/hr/mk) while the hook is
  // mounted — e.g. the deep research drawer stays open and they toggle the
  // language from the sidebar. Respects user-chosen voice.
  useEffect(() => {
    if (voiceMode !== 'i18n') return;
    if (voiceWasUserChosenRef.current) return;

    const apply = () => {
      const next = defaultVoiceForI18n();
      setSelectedVoice((prev) => (prev === next ? prev : next));
    };

    apply();
    i18n.on('languageChanged', apply);
    return () => {
      i18n.off('languageChanged', apply);
    };
  }, [voiceMode]);

  /**
   * Clean up TTS resources
   */
  const cleanupTTS = useCallback(() => {
    console.log('🧹 TTS: Cleanup');

    // Set intentional stop flag before clearing audio (to prevent onerror)
    intentionalStopRef.current = true;

    // Drop any in-flight intra-page chunk prefetch so it can't resume playback.
    nextChunkSynthRef.current = null;

    // Stop scroll detection
    if (scrollDetectionIntervalRef.current) {
      clearInterval(scrollDetectionIntervalRef.current);
      scrollDetectionIntervalRef.current = null;
    }
    isAutoScrollingRef.current = false;

    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.src = '';
      audioRef.current = null;
    }

    if (highlightIntervalRef.current) {
      clearInterval(highlightIntervalRef.current);
      highlightIntervalRef.current = null;
    }

    // Clear all highlights from document
    document.querySelectorAll('.tts-highlight').forEach(el => {
      el.classList.remove('tts-highlight');
      (el as HTMLElement).style.backgroundColor = '';
      (el as HTMLElement).style.outline = '';
      (el as HTMLElement).style.outlineOffset = '';
      (el as HTMLElement).style.boxShadow = '';
      (el as HTMLElement).style.filter = '';
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TTS overlay global singleton
    (window as any).ttsOverlay?.hide();

    setIsSpeaking(false);
    setIsPaused(false);
    currentPageCacheRef.current = null;
    nextPageCacheRef.current = null;
    isPreloadingRef.current = false;
    textBlocksRef.current = [];
    currentBlockIndexRef.current = 0;
    pageTextRef.current = '';
    wordToBlockMapRef.current = [];
  }, []);

  /**
   * Get the most visible page index by checking viewport intersection
   */
  const getMostVisiblePage = useCallback((): number => {
    const pageContainers = document.querySelectorAll('.rpv-core__page-layer');
    if (!pageContainers || pageContainers.length === 0) return 0;

    let mostVisiblePageIndex = 0;
    let maxVisibility = 0;

    pageContainers.forEach((page, domIndex) => {
      const rect = page.getBoundingClientRect();
      const windowHeight = window.innerHeight;
      const visibleTop = Math.max(0, rect.top);
      const visibleBottom = Math.min(windowHeight, rect.bottom);
      const visibleHeight = Math.max(0, visibleBottom - visibleTop);
      const visibility = visibleHeight / rect.height;

      if (visibility > maxVisibility) {
        maxVisibility = visibility;
        // Try to use data-page-number attribute (1-indexed) and convert to 0-indexed
        const pageNum = page.getAttribute('data-page-number');
        if (pageNum) {
          mostVisiblePageIndex = parseInt(pageNum, 10) - 1;
        } else {
          // Fallback to DOM index when data-page-number is not available
          mostVisiblePageIndex = domIndex;
        }
      }
    });

    return mostVisiblePageIndex;
  }, []);

  /**
   * Start scroll detection to auto-follow user scrolling during TTS playback
   * When user manually scrolls to a different page, TTS restarts on that page
   */
  const startScrollDetection = useCallback(() => {
    // Don't start if already running
    if (scrollDetectionIntervalRef.current) return;

    // Initialize with current page
    lastDetectedPageRef.current = currentPageIndexRef.current;

    // Poll every 500ms
    scrollDetectionIntervalRef.current = setInterval(() => {
      // Skip if audio is not playing or if we're auto-scrolling (page advance)
      if (!audioRef.current || audioRef.current.paused || intentionalStopRef.current) {
        return;
      }

      if (isAutoScrollingRef.current) {
        // Update last detected page during auto-scroll to prevent false triggers
        lastDetectedPageRef.current = currentPageIndexRef.current;
        return;
      }

      const mostVisiblePage = getMostVisiblePage();

      // If user scrolled to a different page, restart TTS there
      if (mostVisiblePage !== lastDetectedPageRef.current && mostVisiblePage !== currentPageIndexRef.current) {
        console.log(`📜 TTS: User scrolled from page ${lastDetectedPageRef.current} to ${mostVisiblePage}, restarting TTS`);

        // Set intentional stop flag BEFORE clearing audio to prevent onerror from triggering cleanup
        intentionalStopRef.current = true;

        // Stop current audio
        if (audioRef.current) {
          audioRef.current.pause();
          audioRef.current.src = '';
        }

        if (highlightIntervalRef.current) {
          clearInterval(highlightIntervalRef.current);
          highlightIntervalRef.current = null;
        }

        document.querySelectorAll('.tts-highlight').forEach(el => {
          el.classList.remove('tts-highlight');
          (el as HTMLElement).style.backgroundColor = '';
          (el as HTMLElement).style.outline = '';
          (el as HTMLElement).style.outlineOffset = '';
          (el as HTMLElement).style.boxShadow = '';
          (el as HTMLElement).style.filter = '';
        });

        // Update page reference
        lastDetectedPageRef.current = mostVisiblePage;

        // Restart TTS on new page after a short delay (allow scroll to settle)
        // Note: startTTSForPage will reset intentionalStopRef to false
        setTimeout(() => {
          if (startTTSForPageRef.current) {
            void startTTSForPageRef.current(mostVisiblePage);
          }
        }, 300);
      }
    }, 500);
  }, [getMostVisiblePage]);

  /**
   * Check if text starts with a bullet or list marker
   */
  const isBulletOrListItem = useCallback((text: string): 'bullet' | 'numbered' | null => {
    const trimmed = text.trim();
    if (/^\d+[.)]\s/.test(trimmed) || /^[a-zA-Z][.)]\s/.test(trimmed) || /^[([]?\d+[)\]]/.test(trimmed)) {
      return 'numbered';
    }
    if (/^[•\-*●○■□►▸]/.test(trimmed)) {
      return 'bullet';
    }
    return null;
  }, []);

  /**
   * Detect heading type based on font size
   */
  const detectHeadingType = useCallback((fontSize: number, isBold: boolean, lineCount: number): 'h1' | 'h2' | 'h3' | null => {
    if (fontSize >= 20 && lineCount <= 2) return 'h1';
    if (fontSize >= 16 && lineCount <= 2 && (isBold || fontSize >= 18)) return 'h2';
    if (fontSize >= 13 && isBold && lineCount <= 2) return 'h3';
    return null;
  }, []);

  /**
   * Build text blocks from PDF text layer spans
   * Maps each block to its character position in the full page text
   */
  const buildTextBlocks = useCallback((textLayer: Element, pageText: string): TextBlock[] => {
    // Non-PDF mode (markdown, EPUB text): use semantic HTML block elements directly
    const isPdfTextLayer = textLayer.classList.contains('rpv-core__text-layer') ||
                           textLayer.querySelector('.rpv-core__text-layer') !== null;
    if (!isPdfTextLayer) {
      const blockElements = Array.from(textLayer.querySelectorAll('h1, h2, h3, h4, p, li, blockquote, td, pre'));
      if (blockElements.length === 0) return [];

      const blocks: TextBlock[] = [];
      // Use indexOf on the trimmed pageText to compute charStart/charEnd
      // This ensures positions match the text sent to edge-tts (which is also trimmed)
      let searchPos = 0;

      for (const el of blockElements) {
        // Skip nested duplicates (e.g. li inside another li)
        if (el.parentElement && blockElements.includes(el.parentElement)) continue;

        const text = (el.textContent || '').trim();
        if (!text || text.length < 3) continue;

        const tag = el.tagName.toLowerCase();
        const type: TextBlock['type'] = tag.startsWith('h') ? (tag as 'h1' | 'h2' | 'h3')
          : tag === 'li' ? 'bullet'
          : tag === 'td' ? 'table'
          : 'paragraph';

        // Find charStart/charEnd relative to trimmed pageText using indexOf
        const idx = pageText.indexOf(text, searchPos);
        const charStart = idx >= 0 ? idx : searchPos;
        const charEnd = charStart + text.length;
        if (idx >= 0) {
          searchPos = charEnd;
        }

        blocks.push({ spans: [el], text, charStart, charEnd, type });
      }
      console.log(`📋 TTS: Built ${blocks.length} text blocks from semantic HTML (pageText length: ${pageText.length})`);
      return blocks;
    }

    // PDF mode: original span-based grouping
    const spans = Array.from(textLayer.querySelectorAll('span'));
    if (spans.length === 0) return [];

    const LINE_THRESHOLD = 15; // pixels - spans within this vertical distance are same line
    const PARAGRAPH_GAP = 12; // pixels - gap that indicates new paragraph

    // Group spans into lines based on vertical position
    interface Line {
      spans: Element[];
      top: number;
      bottom: number;
      left: number;
      text: string;
      fontSize: number;
      isBold: boolean;
    }

    const lines: Line[] = [];

    // Sort spans by vertical position
    const sortedSpans = [...spans].sort((a, b) => {
      const rectA = a.getBoundingClientRect();
      const rectB = b.getBoundingClientRect();
      if (Math.abs(rectA.top - rectB.top) < LINE_THRESHOLD) {
        return rectA.left - rectB.left;
      }
      return rectA.top - rectB.top;
    });

    sortedSpans.forEach(span => {
      const rect = span.getBoundingClientRect();
      const style = window.getComputedStyle(span as HTMLElement);
      const fontSize = parseFloat(style.fontSize) || 12;
      const fontWeight = style.fontWeight;
      const isBold = fontWeight === 'bold' || fontWeight === '700' || parseInt(fontWeight) >= 600;
      const text = span.textContent || '';

      // Try to add to existing line
      let addedToLine = false;
      for (const line of lines) {
        if (Math.abs(rect.top - line.top) < LINE_THRESHOLD) {
          line.spans.push(span);
          line.bottom = Math.max(line.bottom, rect.bottom);
          line.text += text;
          line.fontSize = Math.max(line.fontSize, fontSize);
          line.isBold = line.isBold || isBold;
          addedToLine = true;
          break;
        }
      }

      if (!addedToLine) {
        lines.push({
          spans: [span],
          top: rect.top,
          bottom: rect.bottom,
          left: rect.left,
          text: text,
          fontSize: fontSize,
          isBold: isBold,
        });
      }
    });

    // Sort lines by vertical position
    lines.sort((a, b) => a.top - b.top);

    // Now group lines into blocks
    const blocks: TextBlock[] = [];
    let charPos = 0;
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];
      const lineText = line.text.trim();

      // Detect block type
      const bulletType = isBulletOrListItem(lineText);
      const headingType = detectHeadingType(line.fontSize, line.isBold, 1);

      if (bulletType) {
        // Single bullet/numbered item as one block
        const blockText = line.text;
        const charStart = pageText.indexOf(blockText.trim(), charPos);
        const actualStart = charStart >= 0 ? charStart : charPos;

        blocks.push({
          spans: [...line.spans],
          text: blockText,
          charStart: actualStart,
          charEnd: actualStart + blockText.length,
          type: bulletType,
        });

        charPos = actualStart + blockText.length;
        i++;
        continue;
      }

      if (headingType) {
        // Heading as one block (might span 2 lines if wrapped)
        const headingSpans = [...line.spans];
        let headingText = line.text;
        let lineCount = 1;
        let j = i + 1;

        // Check for wrapped heading continuation
        while (j < lines.length && lineCount < 2) {
          const nextLine = lines[j];
          const gap = nextLine.top - lines[j - 1].bottom;
          const sameFontSize = Math.abs(nextLine.fontSize - line.fontSize) < 2;

          if (gap < PARAGRAPH_GAP && gap >= 0 && sameFontSize && !isBulletOrListItem(nextLine.text.trim())) {
            headingSpans.push(...nextLine.spans);
            headingText += nextLine.text;
            lineCount++;
            j++;
          } else {
            break;
          }
        }

        const charStart = pageText.indexOf(headingText.trim(), charPos);
        const actualStart = charStart >= 0 ? charStart : charPos;

        blocks.push({
          spans: headingSpans,
          text: headingText,
          charStart: actualStart,
          charEnd: actualStart + headingText.length,
          type: headingType,
        });

        console.log(`📝 TTS: ${headingType.toUpperCase()} "${headingText.substring(0, 40)}..."`);
        charPos = actualStart + headingText.length;
        i = j;
        continue;
      }

      // Regular paragraph - group 1-3 consecutive lines
      const paragraphSpans = [...line.spans];
      let paragraphText = line.text;
      let j = i + 1;
      let linesInParagraph = 1;
      const maxLines = 3;

      while (j < lines.length && linesInParagraph < maxLines) {
        const nextLine = lines[j];
        const gap = nextLine.top - lines[j - 1].bottom;
        const nextBullet = isBulletOrListItem(nextLine.text.trim());
        const nextHeading = detectHeadingType(nextLine.fontSize, nextLine.isBold, 1);

        // Stop if: larger gap, bullet, heading, or significantly different font
        if (gap >= PARAGRAPH_GAP || nextBullet || nextHeading || nextLine.fontSize > line.fontSize + 3) {
          break;
        }

        if (gap >= 0) {
          paragraphSpans.push(...nextLine.spans);
          paragraphText += ' ' + nextLine.text;
          linesInParagraph++;
          j++;
        } else {
          break;
        }
      }

      const charStart = pageText.indexOf(paragraphText.trim().substring(0, 20), charPos);
      const actualStart = charStart >= 0 ? charStart : charPos;

      blocks.push({
        spans: paragraphSpans,
        text: paragraphText,
        charStart: actualStart,
        charEnd: actualStart + paragraphText.length,
        type: 'paragraph',
      });

      charPos = actualStart + paragraphText.length;
      i = j;
    }

    // Log summary
    const typeCounts: Record<string, number> = {};
    blocks.forEach(b => { typeCounts[b.type] = (typeCounts[b.type] || 0) + 1; });
    const summary = Object.entries(typeCounts).map(([t, c]) => `${t}:${c}`).join(', ');
    console.log(`📚 TTS: ${blocks.length} blocks (${summary})`);

    return blocks;
  }, [isBulletOrListItem, detectHeadingType]);

  /**
   * Highlight a specific block and scroll it into view
   */
  const highlightBlock = useCallback((blockIndex: number, scroll = true) => {
    const blocks = textBlocksRef.current;
    if (blockIndex < 0 || blockIndex >= blocks.length) return;

    // Clear all highlights first
    document.querySelectorAll('.tts-highlight').forEach(el => {
      el.classList.remove('tts-highlight');
      const h = el as HTMLElement;
      h.style.backgroundColor = '';
      h.style.outline = '';
      h.style.outlineOffset = '';
      h.style.boxShadow = '';
      h.style.filter = '';
      h.style.borderLeft = '';
      h.style.paddingLeft = '';
      h.style.transition = '';
    });

    const block = blocks[blockIndex];

    // Get current theme for styling
    const isDarkMode = document.documentElement.classList.contains('dark');

    // Highlight styling — adapt for PDF vs semantic HTML
    block.spans.forEach(span => {
      span.classList.add('tts-highlight');
      const el = span as HTMLElement;
      const isInPdf = el.closest('.rpv-core__page-layer') !== null;

      if (isInPdf) {
        // PDF mode: strong highlight on small spans
        el.style.backgroundColor = isDarkMode ? 'rgba(59, 130, 246, 0.6)' : 'rgba(59, 130, 246, 0.4)';
        el.style.outline = isDarkMode ? '3px solid rgba(59, 130, 246, 0.9)' : '3px solid rgba(59, 130, 246, 0.6)';
        el.style.outlineOffset = '1px';
        el.style.boxShadow = isDarkMode ? '0 0 16px rgba(59, 130, 246, 0.8)' : '0 0 10px rgba(59, 130, 246, 0.5)';
        el.style.filter = isDarkMode ? 'invert(1) hue-rotate(180deg)' : 'none';
      } else {
        // Semantic HTML mode: subtle left border + faint bg
        el.style.backgroundColor = isDarkMode ? 'rgba(100, 160, 255, 0.1)' : 'rgba(59, 130, 246, 0.08)';
        el.style.borderLeft = isDarkMode ? '2px solid rgba(100, 160, 255, 0.6)' : '2px solid rgba(59, 130, 246, 0.5)';
        el.style.paddingLeft = '8px';
        el.style.transition = 'background-color 0.3s, border-left 0.3s';
      }
    });

    // Scroll into view (skipped on self-heal re-apply of the same block)
    if (scroll && block.spans.length > 0) {
      const firstSpan = block.spans[0] as HTMLElement;
      const isInPdf = firstSpan.closest('.rpv-core__page-layer') !== null;

      if (isInPdf) {
        // PDF: use custom scroll within PDF viewer container
        const rect = firstSpan.getBoundingClientRect();
        const container = firstSpan.closest('.rpv-core__inner-pages');
        if (container instanceof HTMLElement) {
          const containerRect = container.getBoundingClientRect();
          if (rect.top < containerRect.top + 50 || rect.bottom > containerRect.bottom - 50) {
            const targetScroll = container.scrollTop + (rect.top - containerRect.top) - 80;
            container.scrollTo({ top: targetScroll, behavior: 'smooth' });
          }
        }
      } else {
        // Non-PDF (markdown, etc.): always use scrollIntoView on the element
        firstSpan.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }

    currentBlockIndexRef.current = blockIndex;
  }, []);

  /**
   * Build a mapping from word index to block index
   * This pre-computes which block each word belongs to based on text matching
   */
  const buildWordToBlockMap = useCallback((wordBoundaries: WordBoundary[], blocks: TextBlock[], pageText: string, startCharPos = 0): number[] => {
    // Earlier version used a fuzzy strip-non-alphanumeric search with manual
    // charPosition advancement by word.text.length. That drifted over any
    // punctuation, double spaces or repeated words, so the highlight fell
    // out of sync with the voice. edge-tts emits word boundaries in reading
    // order, so a simple forward-scanning indexOf on the original text is
    // both faster (no O(N²) per-char probe) and correct.
    const map: number[] = new Array(wordBoundaries.length).fill(0);
    if (blocks.length === 0 || wordBoundaries.length === 0) return map;

    const haystack = pageText.toLowerCase();
    // Chunked playback: a chunk's word boundaries are matched against the FULL
    // page text starting at the chunk's page offset, so block indices stay
    // correct across chunk boundaries (highlight stitches seamlessly).
    let textPos = startCharPos;
    let blockIdx = 0;
    while (blockIdx < blocks.length - 1 && startCharPos > blocks[blockIdx].charEnd) {
      blockIdx++;
    }

    for (let i = 0; i < wordBoundaries.length; i++) {
      const raw = wordBoundaries[i].text;
      const needle = raw.toLowerCase();
      // Exact forward-scan for the word starting at our current pointer.
      // indexOf respects punctuation and spacing, so we stay aligned even
      // when the same word repeats multiple times on the page.
      const idx = haystack.indexOf(needle, textPos);
      if (idx >= 0) {
        textPos = idx + raw.length;
      }
      // Still advance blockIdx even when the word wasn't found — the next
      // successful match will pull us back in line without resetting.

      while (blockIdx < blocks.length - 1 && textPos > blocks[blockIdx].charEnd) {
        blockIdx++;
      }
      map[i] = blockIdx;
    }

    console.log(`📊 TTS: Mapped ${wordBoundaries.length} words to ${blocks.length} blocks`);
    return map;
  }, []);

  const findBlockForTime = useCallback(
    (currentTimeMs: number, wordBoundaries: WordBoundary[]) =>
      findBlockForTimeFn(currentTimeMs, wordBoundaries, wordToBlockMapRef.current, offsetToMs),
    []
  );

  /**
   * Start real-time highlighting based on audio position
   */
  const startHighlightTracking = useCallback((audio: HTMLAudioElement, wordBoundaries: WordBoundary[]) => {
    // Clear any existing interval
    if (highlightIntervalRef.current) {
      clearInterval(highlightIntervalRef.current);
    }

    // Initial highlight — start on THIS chunk's first block (rest chunks begin mid-page),
    // not block 0, so we don't flash/scroll back to the top between sentences.
    highlightBlock(wordToBlockMapRef.current[0] ?? 0);

    // Update highlight every 100ms based on audio position
    highlightIntervalRef.current = setInterval(() => {
      if (!audio || audio.paused || intentionalStopRef.current) return;

      const currentTimeMs = audio.currentTime * 1000;
      const targetBlock = findBlockForTime(currentTimeMs, wordBoundaries);

      const domHi = document.querySelectorAll('.tts-highlight').length;
      const blockChanged = targetBlock !== currentBlockIndexRef.current;
      // Self-heal: React replaces the <article> element between chunks, so the highlight
      // applied in the previous chunk ends up on a now-detached node (domHi 0) and, because
      // the block index didn't change, was never re-applied — the highlight vanished after
      // the first sentence. When nothing is highlighted, rebuild blocks from the LIVE layer
      // ref and re-apply onto the current DOM (no scroll unless the block actually changed).
      if (blockChanged || domHi === 0) {
        if (domHi === 0 && textLayerRef.current && pageTextRef.current) {
          textBlocksRef.current = buildTextBlocks(textLayerRef.current, pageTextRef.current);
        }
        highlightBlock(targetBlock, blockChanged);
      }
    }, 100);
  }, [highlightBlock, findBlockForTime, buildTextBlocks, textLayerRef]);

  /**
   * Synthesize a single chunk of text at the current rate. Shared by the
   * page-preload path and the intra-page chunk pipeline.
   */
  const synthesizeChunk = useCallback(
    async (text: string, voice: string): Promise<{ audio: Blob; wordBoundaries: WordBoundary[]; durationMs: number }> => {
      const currentRate = speechRateRef.current;
      const validRate = typeof currentRate === 'number' && !isNaN(currentRate) && currentRate > 0 ? currentRate : 1.0;
      const ratePercent = Math.round((validRate - 1.0) * 100);
      const rateString = ratePercent >= 0 ? `+${ratePercent}%` : `${ratePercent}%`;
      const response = await synthesizeSpeech(text, voice, rateString, '+0Hz');
      return {
        audio: base64ToAudioBlob(response.audio),
        wordBoundaries: response.word_boundaries,
        durationMs: response.duration_ms,
      };
    },
    []
  );

  /**
   * Preload audio for a specific page
   */
  const preloadPageAudio = useCallback(async (pageIndex: number): Promise<TTSPage | null> => {
    try {
      const pageElements = document.querySelectorAll('.rpv-core__page-layer');

      if (pageElements.length === 0) return null;

      // Try to find page by data-page-number attribute (1-indexed) first
      const targetPageNumber = pageIndex + 1;  // Convert 0-indexed to 1-indexed
      let page: Element | null = null;

      for (const el of Array.from(pageElements)) {
        const pageNum = el.getAttribute('data-page-number');
        if (pageNum && parseInt(pageNum, 10) === targetPageNumber) {
          page = el;
          break;
        }
      }

      // Fallback: if data-page-number not found, use DOM index
      if (!page && pageIndex >= 0 && pageIndex < pageElements.length) {
        page = pageElements[pageIndex];
      }

      if (!page) {
        console.warn(`TTS: Preload - Page ${pageIndex} not found in DOM`);
        return null;
      }

      const textLayer = page.querySelector('.rpv-core__text-layer');
      if (!textLayer) return null;

      const pageText = textLayer.textContent?.trim() || '';
      if (!pageText) return null;

      let currentVoice = selectedVoiceRef.current;
      if (typeof currentVoice !== 'string') {
        currentVoice = (currentVoice as TTSVoice)?.name || 'en-US-AriaNeural';
      }

      console.log(`📦 TTS: Preloading page ${pageIndex}`);

      // Split into a small first chunk + follow-ups. Preload synthesizes only
      // the first chunk so the next page starts instantly; the remaining chunk
      // texts ride along so the rest of the page still gets read (and aren't
      // silently dropped, as the old first-chunk-only path did for long pages).
      const chunks = splitPageIntoTtsChunks(pageText);
      const firstChunk = chunks[0] || pageText;
      const seg = await synthesizeChunk(firstChunk, currentVoice);

      return {
        pageIndex,
        text: firstChunk,
        audio: seg.audio,
        wordBoundaries: seg.wordBoundaries,
        durationMs: seg.durationMs,
        voice: currentVoice,
        charOffset: 0,
        fullPageText: pageText,
        restChunks: chunks.slice(1),
      };
    } catch (error) {
      console.error(`❌ TTS: Failed to preload page ${pageIndex}`, error);
      return null;
    }
  }, [synthesizeChunk]);

  /**
   * Preload next page in background
   */
  const preloadNextPage = useCallback(async (currentPageIndex: number) => {
    const nextPageIndex = currentPageIndex + 1;
    const totalPages = document.querySelectorAll('.rpv-core__page-layer').length;

    if (nextPageIndex >= totalPages || isPreloadingRef.current) return;
    if (nextPageCacheRef.current?.pageIndex === nextPageIndex) return;

    isPreloadingRef.current = true;
    const preloaded = await preloadPageAudio(nextPageIndex);
    if (preloaded) {
      nextPageCacheRef.current = preloaded;
      console.log(`TTS: Preloaded page ${nextPageIndex}`);
    }
    isPreloadingRef.current = false;
  }, [preloadPageAudio]);

  /**
   * Play audio for a page
   */
  const playAudioForPage = useCallback((pageData: TTSPage, textLayer: Element) => {
    try {
      // Blocks/highlighting are page-level. For chunk 0 (charOffset 0) build the
      // blocks from the FULL page text; reuse them for later chunks so highlight
      // mapping stays consistent across the whole page.
      const fullText = pageData.fullPageText ?? pageData.text;
      const charOffset = pageData.charOffset ?? 0;
      // Rebuild blocks for EVERY chunk, not just chunk 0. The structure is identical for the
      // same page text (so the word→block map stays consistent), but re-querying yields FRESH
      // span references. The report markdown re-renders (React) between chunks, detaching the
      // cached chunk-0 spans — highlightBlock then styled detached nodes (invisible), which is
      // exactly why the highlight vanished after the first sentence (confirmed: domHi=0 on the
      // rest chunk despite a correct target block).
      // Build from the LIVE layer ref, not the textLayer captured when TTS started: in the
      // markdown viewer React can replace the <article> element between chunks, leaving the
      // passed-in textLayer detached. Rebuilding from the detached node produced detached
      // block spans, so highlightBlock styled nodes that aren't in the document (domHi=0) —
      // the highlight vanished after the first chunk. textLayerRef always points at the live
      // element.
      const liveLayer = textLayerRef.current ?? textLayer;
      textBlocksRef.current = buildTextBlocks(liveLayer, fullText);
      pageTextRef.current = fullText;
      currentBlockIndexRef.current = 0;

      const blocks = textBlocksRef.current;
      const words = pageData.wordBoundaries;
      console.log(`📊 TTS: ${blocks.length} blocks, chunk len: ${pageData.text.length}, offset: ${charOffset}, words: ${words.length}`);

      // Map this chunk's word boundaries against the full page text starting at
      // the chunk's offset, so block highlighting continues seamlessly.
      wordToBlockMapRef.current = buildWordToBlockMap(words, blocks, fullText, charOffset);

      // Create audio element
      if (!audioRef.current) {
        audioRef.current = new Audio();
      }

      const audio = audioRef.current;
      audio.src = URL.createObjectURL(pageData.audio);
      audio.playbackRate = speechRateRef.current;

      // Prefetch the next intra-page chunk while this one plays, so the
      // follow-up is ready (or nearly) the moment this chunk ends.
      if (pageData.restChunks && pageData.restChunks.length > 0) {
        nextChunkSynthRef.current = synthesizeChunk(pageData.restChunks[0], pageData.voice);
      } else {
        nextChunkSynthRef.current = null;
      }

      // Event handlers
      audio.onplay = () => {
        console.log('▶️ TTS: Playing');
        setIsSpeaking(true);
        setIsPaused(false);
        startHighlightTracking(audio, pageData.wordBoundaries);
        // Start scroll detection to auto-follow user scrolling
        startScrollDetection();
        // Clear auto-scroll flag after playback starts
        isAutoScrollingRef.current = false;
      };

      audio.onpause = () => {
        setIsPaused(true);
      };

      audio.onended = () => {
        console.log(`🏁 TTS: Page audio ended (current page: ${currentPageIndexRef.current})`);

        if (highlightIntervalRef.current) {
          clearInterval(highlightIntervalRef.current);
          highlightIntervalRef.current = null;
        }

        if (intentionalStopRef.current) {
          cleanupTTS();
          return;
        }

        // Intra-page: if this page has more chunks, play the next one (already
        // prefetched) before advancing to the next page.
        if (pageData.restChunks && pageData.restChunks.length > 0) {
          const [nextText, ...rest] = pageData.restChunks;
          const nextOffset = (pageData.charOffset ?? 0) + pageData.text.length;
          const pending = nextChunkSynthRef.current ?? synthesizeChunk(nextText, pageData.voice);
          nextChunkSynthRef.current = null;
          void pending
            .then(seg => {
              if (intentionalStopRef.current) return;
              playAudioForPageRef.current?.(
                {
                  pageIndex: pageData.pageIndex,
                  text: nextText,
                  audio: seg.audio,
                  wordBoundaries: seg.wordBoundaries,
                  durationMs: seg.durationMs,
                  voice: pageData.voice,
                  charOffset: nextOffset,
                  fullPageText: pageData.fullPageText ?? pageData.text,
                  restChunks: rest,
                },
                textLayer
              );
            })
            .catch(err => {
              console.error('❌ TTS: Next-chunk synth failed', err);
              cleanupTTS();
            });
          return;
        }

        // Auto-advance to next page
        const nextPageIndex = currentPageIndexRef.current + 1;
        const pageElements = document.querySelectorAll('.rpv-core__page-layer');
        // Non-PDF mode: single page, no auto-advance
        if (pageElements.length === 0) {
          console.log('TTS: Finished (single-page mode)');
          cleanupTTS();
          return;
        }

        // Find total pages by checking highest data-page-number
        let totalPages = 0;
        pageElements.forEach(el => {
          const pageNum = el.getAttribute('data-page-number');
          if (pageNum) {
            totalPages = Math.max(totalPages, parseInt(pageNum, 10));
          }
        });

        // Fallback: if no data-page-number found, use DOM length
        if (totalPages === 0) {
          totalPages = pageElements.length;
        }

        console.log(`➡️ TTS: Advancing from page ${currentPageIndexRef.current} to ${nextPageIndex} (total: ${totalPages})`);

        if (nextPageIndex < totalPages) {
          // Set auto-scroll flag to prevent false scroll detection triggers
          isAutoScrollingRef.current = true;

          // Scroll to next page first (find by data-page-number, with fallback to DOM index)
          const targetPageNumber = nextPageIndex + 1;
          let nextPage = Array.from(pageElements).find(el =>
            el.getAttribute('data-page-number') === String(targetPageNumber)
          );

          // Fallback to DOM index if data-page-number not found
          if (!nextPage && nextPageIndex < pageElements.length) {
            console.warn(`TTS: data-page-number=${targetPageNumber} not found, using DOM index ${nextPageIndex}`);
            nextPage = pageElements[nextPageIndex];
          }

          if (nextPage) {
            const foundPageNum = nextPage.getAttribute('data-page-number');
            console.log(`📜 TTS: Scrolling to page element (data-page-number=${foundPageNum || 'none'})`);
            nextPage.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }

          setTimeout(() => {
            void startTTSForPage(nextPageIndex);
          }, 600);
        } else {
          console.log('📖 TTS: End of document');
          cleanupTTS();
        }
      };

      audio.onerror = (e) => {
        // Ignore errors from intentional cleanup (setting src='')
        if (intentionalStopRef.current) return;
        console.error('❌ TTS: Audio error', e);
        cleanupTTS();
      };

      // Start playback
      audio.play().catch(error => {
        console.error('❌ TTS: Play failed', error);
        cleanupTTS();
      });

    } catch (error) {
      console.error('❌ TTS: Playback setup failed', error);
      cleanupTTS();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are intentionally limited
  }, [buildTextBlocks, buildWordToBlockMap, startHighlightTracking, cleanupTTS, synthesizeChunk]);

  /**
   * Start TTS for a specific page
   */
  const startTTSForPage = useCallback(async (pageIndex: number) => {
    try {
      console.log(`🎵 TTS: Starting page ${pageIndex}`);
      intentionalStopRef.current = false;

      // Give PDF viewer a moment to render pages if needed
      await new Promise(resolve => setTimeout(resolve, 100));

      let pageElements = document.querySelectorAll('.rpv-core__page-layer');

      // Fallback: if no PDF pages, use the textLayerRef as a single page (markdown viewer, etc.)
      if (pageElements.length === 0 && textLayerRef.current) {
        pageElements = textLayerRef.current.querySelectorAll(':scope') as unknown as NodeListOf<Element>;
        if (pageElements.length === 0) {
          // Treat the entire ref as one page
          pageElements = [textLayerRef.current] as unknown as NodeListOf<Element>;
        }
        console.log('📋 TTS: Using textLayerRef as single page (non-PDF mode)');
      }

      if (pageElements.length === 0) {
        console.error('TTS: No pages found in DOM');
        return;
      }

      console.log(`📋 TTS: Found ${pageElements.length} pages in DOM`);

      // Debug: List all available data-page-number attributes
      const availablePages = Array.from(pageElements)
        .map(el => el.getAttribute('data-page-number'))
        .filter(Boolean);
      if (availablePages.length > 0) {
        console.log(`🔍 TTS: Available data-page-numbers: [${availablePages.join(', ')}]`);
      }

      // Try to find page by data-page-number attribute (1-indexed) first
      const targetPageNumber = pageIndex + 1;  // Convert 0-indexed to 1-indexed
      let page: Element | null = null;

      for (const el of Array.from(pageElements)) {
        const pageNum = el.getAttribute('data-page-number');
        if (pageNum && parseInt(pageNum, 10) === targetPageNumber) {
          page = el;
          console.log(`✓ TTS: Found page by data-page-number=${pageNum}`);
          break;
        }
      }

      // Fallback: if data-page-number not found, use DOM index
      if (!page) {
        console.warn(`TTS: data-page-number=${targetPageNumber} not found, falling back to DOM index`);
        if (pageIndex >= 0 && pageIndex < pageElements.length) {
          page = pageElements[pageIndex];
          console.log(`TTS: Using DOM index ${pageIndex} as fallback`);
        }
      }

      if (!page) {
        console.error(`TTS: Page ${pageIndex} not found (tried data-page-number=${targetPageNumber} and DOM index)`);
        return;
      }

      // For PDF: find text layer inside page. For non-PDF: the page IS the text layer.
      const textLayer = page.querySelector('.rpv-core__text-layer') || page;
      if (!textLayer) {
        console.error('TTS: Text layer not found');
        return;
      }

      // Verify which page we actually got (in case of fallback)
      const actualPageNum = page.getAttribute('data-page-number');
      if (actualPageNum) {
        const actualPageIndex = parseInt(actualPageNum, 10) - 1;
        if (actualPageIndex !== pageIndex) {
          console.warn(`TTS: Requested page ${pageIndex} but got page ${actualPageIndex} (data-page-number=${actualPageNum})`);
        }
        currentPageIndexRef.current = actualPageIndex; // Use actual page number
        console.log(`TTS: Locked to page ${actualPageIndex} (data-page-number=${actualPageNum})`);
      } else {
        // If no data-page-number, trust the requested pageIndex
        currentPageIndexRef.current = pageIndex;
        console.log(`TTS: Locked to page ${pageIndex} (no data-page-number, using request)`);
      }

      // For non-PDF (markdown, etc.): build pageText from block elements joined with newlines
      // This prevents textContent from merging words across element boundaries
      // (e.g., "Research TitleIntroduction" → "Research Title\nIntroduction")
      const isPdfMode = !!page.querySelector('.rpv-core__text-layer');
      let pageText: string;

      if (isPdfMode) {
        pageText = textLayer.textContent?.trim() || '';
      } else {
        const blockEls = Array.from(textLayer.querySelectorAll('h1, h2, h3, h4, p, li, blockquote, td, pre'));
        const blockTexts: string[] = [];
        for (const el of blockEls) {
          // Skip nested duplicates (e.g., li inside another li, p inside blockquote)
          if (el.parentElement && blockEls.includes(el.parentElement)) continue;
          const text = (el.textContent || '').trim();
          if (text && text.length >= 3) blockTexts.push(text);
        }
        pageText = blockTexts.join('\n');
      }

      if (!pageText) {
        console.warn(`TTS: No text on page ${pageIndex}, skipping to next page`);

        // Find total pages
        const allPageElements = document.querySelectorAll('.rpv-core__page-layer');
        let totalPages = 0;
        allPageElements.forEach(el => {
          const pageNum = el.getAttribute('data-page-number');
          if (pageNum) {
            totalPages = Math.max(totalPages, parseInt(pageNum, 10));
          }
        });
        if (totalPages === 0) {
          totalPages = allPageElements.length;
        }

        // Skip to next page if available
        const nextPageIndex = pageIndex + 1;
        if (nextPageIndex < totalPages) {
          console.log(`TTS: Advancing to page ${nextPageIndex}`);
          setTimeout(() => {
            if (!intentionalStopRef.current) {
              startTTSForPage(nextPageIndex);
            }
          }, 100);
        } else {
          console.log('TTS: No more pages with text');
          cleanupTTS();
        }
        return;
      }

      let currentVoice = selectedVoiceRef.current;
      if (typeof currentVoice !== 'string') {
        currentVoice = (currentVoice as TTSVoice)?.name || 'en-US-AriaNeural';
      }

      // Auto-detect mode: look at the first page's text to decide if we
      // should swap away from the English default. Runs only if the user
      // hasn't picked a voice explicitly (`voiceWasUserChosenRef`). We only
      // look at the very first page so subsequent pages don't flip the voice
      // mid-book on a stray bilingual page.
      if (voiceMode === 'auto-detect' &&
          !voiceWasUserChosenRef.current &&
          currentPageIndexRef.current === 0) {
        const detected = detectLanguage(pageText);
        const target = voiceForLanguage(detected);
        if (target !== currentVoice) {
          console.log(`🌐 TTS: Detected lang=${detected}, switching voice ${currentVoice} → ${target}`);
          currentVoice = target;
          selectedVoiceRef.current = target;
          setSelectedVoice(target);
          // Drop any cached audio synthesized under the old voice.
          currentPageCacheRef.current = null;
          nextPageCacheRef.current = null;
        }
      }

      // Check preloaded cache
      if (nextPageCacheRef.current?.pageIndex === pageIndex &&
          nextPageCacheRef.current?.voice === currentVoice) {
        console.log('TTS: Using preloaded audio');
        const pageData = nextPageCacheRef.current;
        nextPageCacheRef.current = null;
        currentPageCacheRef.current = pageData;
        playAudioForPage(pageData, textLayer);
        void preloadNextPage(pageIndex);
        return;
      }

      // Check current cache
      if (currentPageCacheRef.current?.pageIndex === pageIndex &&
          currentPageCacheRef.current?.voice === currentVoice) {
        console.log('TTS: Using cached audio');
        playAudioForPage(currentPageCacheRef.current, textLayer);
        void preloadNextPage(pageIndex);
        return;
      }

      // Show loading
      setIsSpeaking(true);
      // Find the viewer container for overlay positioning — works for PDF, EPUB, markdown, etc.
      const viewerContainer = textLayerRef.current?.closest('[data-testid]') as HTMLElement
                           || document.querySelector('.pdf-viewer-drawer') as HTMLElement;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TTS overlay global singleton
    (window as any).ttsOverlay?.show(theme === 'dark', viewerContainer);

      console.log(`🔊 TTS: Synthesizing (voice: ${currentVoice})`);

      // Split into a small first chunk + follow-ups; synthesize only the first
      // so playback starts in ~1.5s. The rest stream while it plays (and are no
      // longer silently dropped on long pages).
      const chunks = splitPageIntoTtsChunks(pageText);
      const firstChunk = chunks[0] || pageText;
      const seg = await synthesizeChunk(firstChunk, currentVoice);
      console.log(`TTS: ${seg.wordBoundaries.length} words, ${seg.durationMs}ms (chunk 1/${chunks.length})`);

      const pageData: TTSPage = {
        pageIndex,
        text: firstChunk,
        audio: seg.audio,
        wordBoundaries: seg.wordBoundaries,
        durationMs: seg.durationMs,
        voice: currentVoice,
        charOffset: 0,
        fullPageText: pageText,
        restChunks: chunks.slice(1),
      };

      currentPageCacheRef.current = pageData;
      playAudioForPage(pageData, textLayer);
      void preloadNextPage(pageIndex);

    } catch (error) {
      console.error('❌ TTS: Synthesis failed', error);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TTS overlay global singleton
    (window as any).ttsOverlay?.hide();
      cleanupTTS();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- textLayerRef is a stable ref; .current is read at call time
  }, [theme, cleanupTTS, playAudioForPage, preloadNextPage, synthesizeChunk]);

  // Update ref for scroll detection to avoid circular dependency
  useEffect(() => {
    startTTSForPageRef.current = startTTSForPage;
  }, [startTTSForPage]);

  useEffect(() => {
    playAudioForPageRef.current = playAudioForPage;
  }, [playAudioForPage]);

  /**
   * Start TTS from a page
   */
  const startTTS = useCallback((startPageIndex: number = 0) => {
    console.log(`🚀 TTS: Start from page ${startPageIndex}`);
    intentionalStopRef.current = false;
    currentPageIndexRef.current = startPageIndex;
    void startTTSForPage(startPageIndex);
  }, [startTTSForPage]);

  /**
   * Stop TTS
   */
  const stopTTS = useCallback(() => {
    console.log('🛑 TTS: Stop');
    intentionalStopRef.current = true;
    cleanupTTS();
  }, [cleanupTTS]);

  /**
   * Previous block (paragraph) - navigate by text block instead of page
   * If at first block on page, go to previous page
   */
  const speakPrevBlock = useCallback(() => {
    const blocks = textBlocksRef.current;
    const currentBlockIdx = currentBlockIndexRef.current;

    console.log(`⏮️ TTS: Previous block (current: ${currentBlockIdx}, total: ${blocks.length})`);

    // If we have blocks and not at the first one, navigate to previous block
    if (blocks.length > 0 && currentBlockIdx > 0) {
      const prevBlockIdx = currentBlockIdx - 1;
      console.log(`⏮️ TTS: Moving to block ${prevBlockIdx}`);

      // Highlight the previous block
      highlightBlock(prevBlockIdx);

      // If TTS is playing, seek to the start of this block's audio position
      if (audioRef.current && !audioRef.current.paused && currentPageCacheRef.current) {
        const wordBoundaries = currentPageCacheRef.current.wordBoundaries;
        const wordToBlockMap = wordToBlockMapRef.current;

        // Find the first word that belongs to this block
        let targetWordIdx = -1;
        for (let i = 0; i < wordToBlockMap.length; i++) {
          if (wordToBlockMap[i] === prevBlockIdx) {
            targetWordIdx = i;
            break;
          }
        }

        // Only seek if we found a word for this block
        if (targetWordIdx >= 0 && targetWordIdx < wordBoundaries.length) {
          const targetTimeMs = offsetToMs(wordBoundaries[targetWordIdx].offset);
          audioRef.current.currentTime = targetTimeMs / 1000;
          console.log(`⏮️ TTS: Seeking to ${targetTimeMs}ms for block ${prevBlockIdx}`);
        } else {
          console.log(`⏮️ TTS: No word found for block ${prevBlockIdx}, not seeking`);
        }
      }
    } else if (currentPageIndexRef.current > 0) {
      // At first block or no blocks - go to previous page
      const prevPage = currentPageIndexRef.current - 1;
      console.log(`⏮️ TTS: At first block, going to previous page ${prevPage}`);

      if (highlightIntervalRef.current) {
        clearInterval(highlightIntervalRef.current);
        highlightIntervalRef.current = null;
      }

      intentionalStopRef.current = true;
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.src = '';
      }

      document.querySelectorAll('.tts-highlight').forEach(el => el.classList.remove('tts-highlight'));

      // Scroll to previous page
      const targetPageNumber = prevPage + 1;
      const pageElements = document.querySelectorAll('.rpv-core__page-layer');
      let pageEl = Array.from(pageElements).find(el =>
        el.getAttribute('data-page-number') === String(targetPageNumber)
      );

      if (!pageEl && prevPage >= 0 && prevPage < pageElements.length) {
        pageEl = pageElements[prevPage];
      }

      if (pageEl) {
        pageEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }

      // Start TTS on previous page - it will start from the beginning
      // For "previous" we want to go to the LAST block of the previous page
      setTimeout(() => {
        void startTTSForPage(prevPage);
      }, 400);
    }
  }, [highlightBlock, startTTSForPage]);

  /**
   * Next block (paragraph) - navigate by text block instead of page
   * If at last block on page, go to next page
   */
  const speakNextBlock = useCallback(() => {
    const blocks = textBlocksRef.current;
    const currentBlockIdx = currentBlockIndexRef.current;

    console.log(`⏭️ TTS: Next block (current: ${currentBlockIdx}, total: ${blocks.length})`);

    // If we have blocks and not at the last one, navigate to next block
    if (blocks.length > 0 && currentBlockIdx < blocks.length - 1) {
      const nextBlockIdx = currentBlockIdx + 1;
      console.log(`⏭️ TTS: Moving to block ${nextBlockIdx}`);

      // Highlight the next block
      highlightBlock(nextBlockIdx);

      // If TTS is playing, seek to the start of this block's audio position
      if (audioRef.current && !audioRef.current.paused && currentPageCacheRef.current) {
        const wordBoundaries = currentPageCacheRef.current.wordBoundaries;
        const wordToBlockMap = wordToBlockMapRef.current;

        // Find the first word that belongs to this block
        let targetWordIdx = -1;
        for (let i = 0; i < wordToBlockMap.length; i++) {
          if (wordToBlockMap[i] === nextBlockIdx) {
            targetWordIdx = i;
            break;
          }
        }

        // Only seek if we found a word for this block
        if (targetWordIdx >= 0 && targetWordIdx < wordBoundaries.length) {
          const targetTimeMs = offsetToMs(wordBoundaries[targetWordIdx].offset);
          audioRef.current.currentTime = targetTimeMs / 1000;
          console.log(`⏭️ TTS: Seeking to ${targetTimeMs}ms for block ${nextBlockIdx}`);
        } else {
          console.log(`⏭️ TTS: No word found for block ${nextBlockIdx}, not seeking`);
        }
      }
    } else {
      // At last block or no blocks - go to next page
      const pageElements = document.querySelectorAll('.rpv-core__page-layer');

      let totalPages = 0;
      pageElements.forEach(el => {
        const pageNum = el.getAttribute('data-page-number');
        if (pageNum) {
          totalPages = Math.max(totalPages, parseInt(pageNum, 10));
        }
      });

      if (totalPages === 0) {
        totalPages = pageElements.length;
      }

      if (currentPageIndexRef.current < totalPages - 1) {
        const nextPage = currentPageIndexRef.current + 1;
        console.log(`⏭️ TTS: At last block, going to next page ${nextPage}`);

        if (highlightIntervalRef.current) {
          clearInterval(highlightIntervalRef.current);
          highlightIntervalRef.current = null;
        }

        intentionalStopRef.current = true;
        if (audioRef.current) {
          audioRef.current.pause();
          audioRef.current.src = '';
        }

        document.querySelectorAll('.tts-highlight').forEach(el => el.classList.remove('tts-highlight'));

        // Scroll to next page
        const targetPageNumber = nextPage + 1;
        let pageEl = Array.from(pageElements).find(el =>
          el.getAttribute('data-page-number') === String(targetPageNumber)
        );

        if (!pageEl && nextPage >= 0 && nextPage < pageElements.length) {
          pageEl = pageElements[nextPage];
        }

        if (pageEl) {
          pageEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }

        setTimeout(() => {
          void startTTSForPage(nextPage);
        }, 400);
      } else {
        console.log('⏭️ TTS: Already at last block of last page');
      }
    }
  }, [highlightBlock, startTTSForPage]);

  /**
   * Toggle pause
   */
  const togglePause = useCallback(() => {
    if (!audioRef.current) return;

    if (audioRef.current.paused) {
      void audioRef.current.play();
      setIsPaused(false);
    } else {
      audioRef.current.pause();
      setIsPaused(true);
    }
  }, []);

  /**
   * Update speech rate
   */
  const updateSpeechRate = useCallback((rate: number) => {
    setSpeechRate(rate);
    userPrefs.set('tts_speech_rate', rate.toString());
    if (audioRef.current) {
      audioRef.current.playbackRate = rate;
    }
  }, []);

  /**
   * Cleanup on unmount
   */
  useEffect(() => {
    return () => {
      cleanupTTS();
    };
  }, [cleanupTTS]);

  return {
    isSpeaking,
    isPaused,
    speechRate,
    availableVoices,
    selectedVoice,
    isLoadingVoices,
    startTTS,
    stopTTS,
    speakPrevBlock,
    speakNextBlock,
    togglePause,
    updateSpeechRate,
    updateSelectedVoice,
    cleanupTTS,
  };
}

/**
 * EPUB Viewer TTS with edge-tts Backend
 *
 * Uses edge-tts backend for high-quality speech synthesis with word-level timestamps.
 * Highlighting is done sequentially based on character offsets for EPUB content.
 */

import React, { useRef, useCallback, useState, useEffect } from 'react';
import { synthesizeSpeech, listTTSVoices, base64ToAudioBlob, offsetToMs, splitTextForTTS, type WordBoundary, type TTSVoice } from '@/lib/api-tts';
import { DEFAULT_TTS_VOICES, filterAndSortVoices, findBlockForTime as findBlockForTimeFn } from '@/lib/tts-defaults';
import { saveReadingPosition } from '@/lib/api-documents';
import { userPrefs } from '@/lib/storage-utils';
import { useAuth } from '@/hooks/use-auth';
import type { Rendition } from 'epubjs';
import { detectLanguage, voiceForLanguage } from '@/lib/tts-language';

// epub.js DisplayedLocation type (not exported, so we define it)
interface DisplayedLocation {
  cfi?: string;
  href?: string;
  index?: number;
  displayed?: {
    page?: number;
    total?: number;
  };
  start?: {
    index?: number;
    href?: string;
    cfi?: string;
  };
}

interface TTSSection {
  sectionIndex: number;
  text: string;
  audio: Blob;
  wordBoundaries: WordBoundary[];
  durationMs: number;
  voice: string;
}

/**
 * Represents a highlightable block (paragraph, heading, etc.) in EPUB content
 */
interface TextBlock {
  elements: Element[];
  text: string;
  charStart: number;  // Character offset in section text where this block starts
  charEnd: number;    // Character offset where this block ends
  type: 'h1' | 'h2' | 'h3' | 'paragraph' | 'list-item';
}

const DEFAULT_VOICES = DEFAULT_TTS_VOICES;

export function useEpubTTS(
  renditionRef: React.RefObject<Rendition | null>,
  theme: 'light' | 'dark' = 'light',
  documentId?: string,
  _expectedLocation?: string | number,
  userNavRef?: React.MutableRefObject<number>
) {
  // Auth state - check if user is authenticated to avoid API calls on public pages
  const authState = useAuth();

  // State
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [speechRate, setSpeechRate] = useState(() => {
    return userPrefs.getTTSRate();
  });

  // Voice selection state. EPUB documents can be in any language — we default
  // to English and run `detectLanguage()` on the first section before
  // synthesis to swap to hr / mk when appropriate. A voice the user picked
  // from the dropdown is never auto-overridden (see `voiceWasUserChosenRef`).
  const voiceWasUserChosenRef = useRef(false);
  const [availableVoices, setAvailableVoices] = useState<TTSVoice[]>(DEFAULT_VOICES);
  const [selectedVoice, setSelectedVoice] = useState<string>(() => {
    const saved = userPrefs.get().ttsVoiceName;
    if (saved) {
      voiceWasUserChosenRef.current = true;
      return saved;
    }
    return 'en-US-AriaNeural';
  });
  const [isLoadingVoices, setIsLoadingVoices] = useState(false);

  // Refs
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const currentSectionCacheRef = useRef<TTSSection | null>(null);
  const intentionalStopRef = useRef(false);
  const skipAttemptsRef = useRef(0); // Track attempts to skip empty sections
  const isAutoNavigatingRef = useRef(false); // Track automatic navigation to prevent double-start
  // True while we're tearing down the old page's audio and synthesising the
  // next one (user clicked next, or audio ended naturally). Prevents the
  // transient audio.pause from leaking into the UI as "paused" — otherwise
  // the user sees a Resume button during the 1–2 s synthesis gap even though
  // TTS will resume on its own.
  const isRestartingRef = useRef(false);
  const lastRelocatedTimeRef = useRef<number>(0); // Track last relocated event time to debounce
  const ttsCharIndexRef = useRef<number>(0); // Track current character index for TTS position
  const ttsSaveTimeoutRef = useRef<NodeJS.Timeout | null>(null); // Debounced save timeout
  const ttsStartCfiRef = useRef<string | null>(null); // CFI when TTS started (to detect if user navigated away)
  const wasChunkedRef = useRef(false); // Track if section was chunked (to prevent incorrect auto-advance)

  // Text highlighting refs
  const textBlocksRef = useRef<TextBlock[]>([]);
  const currentBlockIndexRef = useRef(0);
  const sectionTextRef = useRef<string>('');
  const wordToBlockMapRef = useRef<number[]>([]);
  const highlightIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const iframeDocRef = useRef<Document | null>(null);
  const visibleElementsRef = useRef<Element[]>([]); // Store visible elements from text extraction
  const iframeElementRef = useRef<HTMLIFrameElement | null>(null); // Store iframe element

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

  /**
   * Fetch available voices from backend
   * Only fetch if user is authenticated to avoid 401 errors on public pages
   */
  useEffect(() => {
    const fetchVoices = async () => {
      // Skip if not authenticated (avoid 401 errors on public pages)
      if (!authState.authReady || !authState.user) {
        setAvailableVoices(DEFAULT_VOICES);
        return;
      }

      setIsLoadingVoices(true);
      try {
        const voices = await listTTSVoices();
        const filteredVoices = filterAndSortVoices(voices);
        setAvailableVoices(filteredVoices.length > 0 ? filteredVoices : DEFAULT_VOICES);
        console.log(`🎤 EPUB TTS: Loaded ${filteredVoices.length} voices`);
      } catch (error) {
        console.error('❌ EPUB TTS: Failed to fetch voices', error);
        setAvailableVoices(DEFAULT_VOICES);
      } finally {
        setIsLoadingVoices(false);
      }
    };
    void fetchVoices();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are intentionally limited
  }, []);

  /**
   * Update selected voice
   */
  const updateSelectedVoice = useCallback((voiceNameOrObject: string | TTSVoice) => {
    const voiceName = typeof voiceNameOrObject === 'string'
      ? voiceNameOrObject
      : voiceNameOrObject?.name || 'en-US-AriaNeural';
    // Explicit dropdown selection — auto-detect must not overwrite this.
    voiceWasUserChosenRef.current = true;
    setSelectedVoice(voiceName);
    userPrefs.set({ ttsVoiceName: voiceName });
    currentSectionCacheRef.current = null;
  }, []);

  /**
   * Clean up TTS resources
   */
  const cleanupTTS = useCallback(() => {
    console.log('🧹 EPUB TTS: Cleanup');

    // Save TTS position immediately before cleanup
    if (documentId && ttsCharIndexRef.current > 0) {
      if (ttsSaveTimeoutRef.current) {
        clearTimeout(ttsSaveTimeoutRef.current);
        ttsSaveTimeoutRef.current = null;
      }

      console.log('📖 EPUB TTS: Saving position on cleanup:', ttsCharIndexRef.current);
      saveReadingPosition(documentId, {
        page_number: 0, // Section index (TODO: get actual section index)
        last_tts_char_index: ttsCharIndexRef.current,
      }).catch((error) => {
        console.warn('📖 EPUB TTS: Failed to save TTS position on cleanup:', error);
      });
    }

    // Set intentional stop flag before clearing audio
    intentionalStopRef.current = true;

    if (audioRef.current) {
      audioRef.current.pause();

      // Remove relocated handler if it was registered
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- custom property stored on audio element for cleanup
      const relocatedHandler = (audioRef.current as any).relocatedHandler;
      if (relocatedHandler && renditionRef.current) {
        renditionRef.current.off('relocated', relocatedHandler);
      }

      audioRef.current.src = '';
      audioRef.current = null;
    }

    // Clear highlight interval
    if (highlightIntervalRef.current) {
      clearInterval(highlightIntervalRef.current);
      highlightIntervalRef.current = null;
    }

    // Clear all highlights from EPUB iframe
    if (iframeDocRef.current) {
      iframeDocRef.current.querySelectorAll('.tts-highlight').forEach(el => {
        el.classList.remove('tts-highlight');
        (el as HTMLElement).style.backgroundColor = '';
        (el as HTMLElement).style.outline = '';
        (el as HTMLElement).style.outlineOffset = '';
        (el as HTMLElement).style.boxShadow = '';
      });
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TTS overlay global singleton
    (window as any).ttsOverlay?.hide();

    setIsSpeaking(false);
    setIsPaused(false);
    currentSectionCacheRef.current = null;
    skipAttemptsRef.current = 0; // Reset skip counter
    textBlocksRef.current = [];
    currentBlockIndexRef.current = 0;
    ttsCharIndexRef.current = 0; // Reset TTS position
    sectionTextRef.current = '';
    wordToBlockMapRef.current = [];
    iframeDocRef.current = null;
    ttsStartCfiRef.current = null; // Reset start CFI
    visibleElementsRef.current = []; // Reset visible elements
    iframeElementRef.current = null; // Reset iframe element
    wasChunkedRef.current = false; // Reset chunking flag
    isRestartingRef.current = false; // Reset restart-in-progress flag
    isAutoNavigatingRef.current = false; // Reset auto-navigation flag
  // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are intentionally limited
  }, [documentId]);

  /**
   * Get current VISIBLE PAGE text from EPUB rendition
   *
   * STRATEGY: Extract only the VISIBLE PAGE text using CSS column detection:
   * 1. epub.js uses CSS columns for pagination
   * 2. Get the container's scroll position to determine which column is visible
   * 3. Filter elements whose position falls within the visible column
   * This makes TTS much faster by only synthesizing the current page, not entire chapter
   */
  const getCurrentSectionText = useCallback(async (): Promise<string | null> => {
    console.log('🚀 EPUB TTS: getCurrentSectionText() CALLED - START');
    try {
      const rendition = renditionRef.current;
      if (!rendition) {
        console.error('❌ EPUB TTS: No rendition available');
        return null;
      }
      console.log('EPUB TTS: Rendition available, proceeding...');

      // Get current location for logging
      let currentLocation = rendition.currentLocation();

      // If currentLocation is not available, wait a bit for it to become ready
      if (!currentLocation || !currentLocation.cfi) {
        console.log('⚠️ EPUB TTS: currentLocation() not ready, waiting...');

        let attempts = 0;
        const maxAttempts = 10;
        while (attempts < maxAttempts) {
          await new Promise(resolve => setTimeout(resolve, 100));
          currentLocation = rendition.currentLocation();
          if (currentLocation?.cfi) {
            console.log('EPUB TTS: currentLocation() became ready after', (attempts + 1) * 100, 'ms');
            break;
          }
          attempts++;
        }
      }

      if (currentLocation?.cfi) {
        console.log('📍 EPUB TTS: Current location - index:', currentLocation.index, 'href:', currentLocation.href);
      }

      // Find iframe containing EPUB content
      let iframe: HTMLIFrameElement | null = null;

      // Try manager.container first (most reliable)
      try {
        // @ts-expect-error - epub.js manager property is not in public type definitions
        const manager = rendition.manager;
        if (manager?.container) {
          iframe = manager.container.querySelector('iframe') as HTMLIFrameElement;
          console.log('🔍 EPUB TTS: Found iframe through manager.container:', !!iframe);
        }
      } catch (e) {
        console.warn('⚠️ EPUB TTS: Could not access rendition manager', e);
      }

      // Fallback: search in epub containers
      if (!iframe) {
        const epubContainers = document.querySelectorAll('[class*="epub"], [id*="epub"]');
        for (let i = 0; i < epubContainers.length; i++) {
          const containerIframe = epubContainers[i].querySelector('iframe') as HTMLIFrameElement;
          if (containerIframe) {
            iframe = containerIframe;
            console.log('EPUB TTS: Found iframe in epub container');
            break;
          }
        }
      }

      // Last fallback: search all iframes
      if (!iframe) {
        const iframes = document.querySelectorAll('iframe');
        for (let i = 0; i < iframes.length; i++) {
          const testFrame = iframes[i] as HTMLIFrameElement;
          try {
            const doc = testFrame.contentDocument || testFrame.contentWindow?.document;
            if (doc && doc.body && doc.body.textContent && doc.body.textContent.trim().length > 50) {
              iframe = testFrame;
              console.log('EPUB TTS: Found iframe with content at index', i);
              break;
            }
          } catch (e) {
            // Cross-origin iframe — skip and try the next one
          }
        }
      }

      if (!iframe) {
        console.error('❌ EPUB TTS: No iframe found');
        return null;
      }

      const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
      if (!iframeDoc || !iframeDoc.body) {
        console.error('❌ EPUB TTS: No iframeDoc.body');
        return null;
      }

      // VIEWPORT-BASED EXTRACTION using epub.js layout information
      // CRITICAL: epub.js uses CSS columns, and the iframe expands to fit ALL content (can be 40000+ px)
      // We MUST calculate the CURRENT PAGE OFFSET to determine which elements are visible
      console.log('📖 EPUB TTS: Extracting VISIBLE PAGE text (epub.js layout-aware)');

      // Get the actual page/column width from epub.js layout
      // This is the width of ONE PAGE, not the entire iframe
      // @ts-expect-error - epub.js _layout is a private property not in type definitions
      const layout = rendition._layout;
      const columnWidth = layout?.columnWidth || 600;
      const gap = layout?.gap || 0;
      const pageWidth = columnWidth; // The actual visible page width

      // Log layout and iframe information for debugging
      const iframeFullWidth = iframe.clientWidth || 0;
      console.log(`📐 EPUB TTS: Layout columnWidth: ${columnWidth}px, gap: ${gap}px`);
      console.log(`📐 EPUB TTS: iframe.clientWidth: ${iframeFullWidth}px (FULL content width)`);

      // CRITICAL: Calculate the current page offset
      // epub.js positions all content in a wide iframe and "scrolls" via transform or scrollLeft
      // getBoundingClientRect() returns positions relative to the FULL iframe (46032px)
      // We need to find WHERE in that 46032px the current page is located

      let scrollOffset = 0;

      // Method 1: Get scrollLeft from manager container (most direct)
      try {
        // @ts-expect-error - epub.js manager property is not in public type definitions
        const manager = rendition.manager;
        if (manager) {
          // Try manager.scrollLeft directly
          if (typeof manager.scrollLeft === 'number' && manager.scrollLeft > 0) {
            scrollOffset = manager.scrollLeft;
            console.log(`📐 EPUB TTS: Got offset from manager.scrollLeft: ${scrollOffset}px`);
          }
          // Try manager.container.scrollLeft
          if (scrollOffset === 0 && manager.container) {
            const containerScrollLeft = manager.container.scrollLeft;
            if (containerScrollLeft > 0) {
              scrollOffset = containerScrollLeft;
              console.log(`📐 EPUB TTS: Got offset from manager.container.scrollLeft: ${scrollOffset}px`);
            }
          }
        }
      } catch (e) {
        console.warn('⚠️ EPUB TTS: Could not access manager:', e);
      }

      // Method 2: Walk up DOM tree from iframe to find scrollable container
      if (scrollOffset === 0) {
        let parent = iframe.parentElement as HTMLElement | null;
        let depth = 0;
        while (parent && depth < 5 && scrollOffset === 0) {
          // Check scrollLeft on this element
          if (parent.scrollLeft > 0) {
            scrollOffset = parent.scrollLeft;
            console.log(`📐 EPUB TTS: Got offset from parent[${depth}].scrollLeft: ${scrollOffset}px (class: ${parent.className})`);
            break;
          }
          // Check transform on this element
          const transform = window.getComputedStyle(parent).transform;
          if (transform && transform !== 'none') {
            // Parse transform matrix: matrix(a, b, c, d, tx, ty) or matrix3d(...)
            const match = transform.match(/matrix(?:3d)?\([^,]+,[^,]+,[^,]+,[^,]+,\s*([^,)]+)/);
            if (match) {
              const translateX = parseFloat(match[1]);
              if (Math.abs(translateX) > 0) {
                scrollOffset = Math.abs(translateX);
                console.log(`📐 EPUB TTS: Got offset from parent[${depth}] transform: ${scrollOffset}px (class: ${parent.className})`);
                break;
              }
            }
          }
          parent = parent.parentElement as HTMLElement | null;
          depth++;
        }
      }

      // Method 3: Search for epub containers by class name in main document
      if (scrollOffset === 0) {
        const containers = document.querySelectorAll('.epub-container, .epub-view, [class*="epub"]');
        for (let i = 0; i < containers.length && scrollOffset === 0; i++) {
          const el = containers[i] as HTMLElement;
          if (el.scrollLeft > 0) {
            scrollOffset = el.scrollLeft;
            console.log(`📐 EPUB TTS: Got offset from ${el.className}.scrollLeft: ${scrollOffset}px`);
          }
        }
      }

      // Method 4: Check scrollLeft inside the iframe document (body, html, wrappers)
      if (scrollOffset === 0) {
        // Check body and html scrollLeft
        const iframeBody = iframeDoc.body;
        const iframeHtml = iframeDoc.documentElement;

        if (iframeBody?.scrollLeft > 0) {
          scrollOffset = iframeBody.scrollLeft;
          console.log(`📐 EPUB TTS: Got offset from iframe body.scrollLeft: ${scrollOffset}px`);
        } else if (iframeHtml?.scrollLeft > 0) {
          scrollOffset = iframeHtml.scrollLeft;
          console.log(`📐 EPUB TTS: Got offset from iframe html.scrollLeft: ${scrollOffset}px`);
        }

        // Check first-level wrappers inside body
        if (scrollOffset === 0 && iframeBody) {
          const firstChildren = iframeBody.children;
          for (let i = 0; i < firstChildren.length && scrollOffset === 0; i++) {
            const child = firstChildren[i] as HTMLElement;
            if (child.scrollLeft > 0) {
              scrollOffset = child.scrollLeft;
              console.log(`📐 EPUB TTS: Got offset from iframe child[${i}].scrollLeft: ${scrollOffset}px (tag: ${child.tagName})`);
            }
          }
        }
      }

      // Method 5: Calculate from displayed.page (fallback)
      if (scrollOffset === 0) {
        const currentDisplayed = currentLocation?.displayed;
        if (currentDisplayed && typeof currentDisplayed.page === 'number' && currentDisplayed.page > 1) {
          // displayed.page is typically 1-indexed (page 1, 2, 3...)
          // The offset is (page - 1) * (columnWidth + gap)
          const pageIndex = currentDisplayed.page - 1;
          scrollOffset = pageIndex * (columnWidth + gap);
          console.log(`📐 EPUB TTS: Calculated offset from page ${currentDisplayed.page}/${currentDisplayed.total || '?'}: ${scrollOffset}px`);
        }
      }

      // Log final offset determination and debug info
      console.log(`📐 EPUB TTS: Final scrollOffset: ${scrollOffset}px`);
      if (scrollOffset === 0) {
        console.log(`⚠️ EPUB TTS: No scroll offset detected - will use visible range [0, pageWidth=${pageWidth}]`);
        // Log debug info about all potential scroll sources
        console.log(`📐 DEBUG: iframe.parentElement.scrollLeft: ${iframe.parentElement?.scrollLeft || 0}`);
        console.log(`📐 DEBUG: iframeDoc.body.scrollLeft: ${iframeDoc.body?.scrollLeft || 0}`);
        console.log(`📐 DEBUG: currentLocation.displayed:`, currentLocation?.displayed);
      }

      // METHOD A: Use iframe position from MAIN document for accurate visibility detection
      // The iframe's getBoundingClientRect() from the main document reflects parent scroll/transform
      // This is more reliable than trying to find scrollOffset values

      // Get iframe's position from main document
      const iframeRectFromMain = iframe.getBoundingClientRect();
      console.log(`📐 EPUB TTS: iframe position from main document: left=${Math.round(iframeRectFromMain.left)}, width=${Math.round(iframeRectFromMain.width)}`);

      // Find the visible container (epub-container) dimensions
      let visibleContainerWidth = pageWidth; // default to calculated column width
      const epubContainer = document.querySelector('.epub-container') as HTMLElement;
      if (epubContainer) {
        const containerRect = epubContainer.getBoundingClientRect();
        visibleContainerWidth = containerRect.width;
        console.log(`📐 EPUB TTS: epub-container visible width: ${Math.round(visibleContainerWidth)}px`);
      }

      console.log(`📐 EPUB TTS: Screen visible range: [0, ${Math.round(visibleContainerWidth)}] (using container width)`);
      console.log(`📐 EPUB TTS: Scroll offset for reference: ${scrollOffset}px`);

      // Calculate visibility range for filtering elements
      // This needs to be at outer scope for both filtering AND debug logging
      const visibleLeft = scrollOffset > 0 ? scrollOffset : 0;
      const visibleRight = scrollOffset > 0 ? scrollOffset + pageWidth : visibleContainerWidth;

      console.log(`📐 EPUB TTS: Visibility range: [${visibleLeft}, ${visibleRight}]`);

      const allElements = iframeDoc.body.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li');
      const visibleElements: Element[] = [];

      allElements.forEach((el) => {
        const text = el.textContent?.trim() || '';
        if (text.length <= 5) return; // Skip empty/tiny elements

        const rect = (el as HTMLElement).getBoundingClientRect();

        // Element position in iframe coordinates
        const elemLeft = rect.left;
        const elemRight = rect.right;

        // For visibility detection:
        // If scrollOffset was detected, use offset-based check
        // Otherwise, use screen-based check (elements with rect.left in [0, containerWidth] are visible)
        const isInCurrentColumn = elemRight > visibleLeft && elemLeft < visibleRight;

        // Element must have some actual area
        const hasVisibleArea = rect.width > 0 && rect.height > 0;

        if (isInCurrentColumn && hasVisibleArea) {
          visibleElements.push(el);
        }
      });

      console.log(`📖 EPUB TTS: Found ${visibleElements.length} visible elements on current page (out of ${allElements.length} total)`);

      // Debug: Log first and last visible elements
      if (visibleElements.length > 0) {
        const firstEl = visibleElements[0] as HTMLElement;
        const lastEl = visibleElements[visibleElements.length - 1] as HTMLElement;
        const firstRect = firstEl.getBoundingClientRect();
        const lastRect = lastEl.getBoundingClientRect();
        console.log(`📍 First visible: left=${Math.round(firstRect.left)}, top=${Math.round(firstRect.top)}, "${firstEl.textContent?.substring(0, 30)}..."`);
        console.log(`📍 Last visible: left=${Math.round(lastRect.left)}, top=${Math.round(lastRect.top)}, bottom=${Math.round(lastRect.bottom)}, "${lastEl.textContent?.substring(0, 30)}..."`);
      }

      // Debug: Log elements that were SKIPPED (on other pages/columns)
      const skippedElements: { text: string; rect: DOMRect }[] = [];
      allElements.forEach((el) => {
        const text = el.textContent?.trim() || '';
        if (text.length <= 5) return;
        const rect = (el as HTMLElement).getBoundingClientRect();
        const isInCurrentColumn = rect.right > visibleLeft && rect.left < visibleRight;
        const hasVisibleArea = rect.width > 0 && rect.height > 0;
        if (!(isInCurrentColumn && hasVisibleArea)) {
          skippedElements.push({ text: text.substring(0, 50), rect });
        }
      });
      if (skippedElements.length > 0) {
        console.log(`📄 EPUB TTS: ${skippedElements.length} elements on other pages (not in [${visibleLeft}, ${visibleRight}])`);
        // Log a few examples of skipped elements for debugging
        if (skippedElements.length <= 5) {
          skippedElements.forEach((el, i) => {
            console.log(`   Skipped[${i}]: rect.left=${Math.round(el.rect.left)}, "${el.text.substring(0, 30)}..."`);
          });
        } else {
          // Log first 2 and last 2
          console.log(`   Skipped[0]: rect.left=${Math.round(skippedElements[0].rect.left)}, "${skippedElements[0].text.substring(0, 30)}..."`);
          console.log(`   Skipped[1]: rect.left=${Math.round(skippedElements[1].rect.left)}, "${skippedElements[1].text.substring(0, 30)}..."`);
          const lastIdx = skippedElements.length - 1;
          console.log(`   Skipped[${lastIdx-1}]: rect.left=${Math.round(skippedElements[lastIdx-1].rect.left)}, "${skippedElements[lastIdx-1].text.substring(0, 30)}..."`);
          console.log(`   Skipped[${lastIdx}]: rect.left=${Math.round(skippedElements[lastIdx].rect.left)}, "${skippedElements[lastIdx].text.substring(0, 30)}..."`);
        }
      }

      if (visibleElements.length === 0) {
        console.warn('⚠️ EPUB TTS: No visible elements found on current page');
        visibleElementsRef.current = [];
        return null;
      }

      // Store visible elements for buildTextBlocks to use
      visibleElementsRef.current = visibleElements;
      iframeElementRef.current = iframe;
      console.log(`📦 EPUB TTS: Stored ${visibleElements.length} visible elements in ref for buildTextBlocks`);

      // Build text from visible elements only
      const text = visibleElements
        .map(el => el.textContent?.trim() || '')
        .filter(t => t.length > 0)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();

      console.log(`📖 EPUB TTS: Extracted ${text.length} chars from visible page`);
      if (text.length > 0) {
        console.log('📖 EPUB TTS: First 100 chars:', text.substring(0, 100));
      }

      return text.length > 0 ? text : null;
    } catch (error) {
      console.error('❌ EPUB TTS: Failed to get section text', error);
      return null;
    }
  }, [renditionRef]);

  /**
   * Build text blocks from EPUB iframe content for highlighting
   * CRITICAL: Uses visibleElementsRef which was populated by getCurrentSectionText()
   * This ensures text extraction and block building use the EXACT SAME elements
   */
  const buildTextBlocks = useCallback((sectionText: string): TextBlock[] => {
    const blocks: TextBlock[] = [];

    // Use the SAME visible elements that getCurrentSectionText() found
    // This guarantees the blocks match the synthesized text
    const textElements = visibleElementsRef.current;

    if (textElements.length === 0) {
      console.warn('⚠️ EPUB TTS buildTextBlocks: No visible elements stored from getCurrentSectionText()');
      return blocks;
    }

    console.log(`📚 EPUB TTS buildTextBlocks: Using ${textElements.length} stored visible elements`);

    let charPos = 0;

    textElements.forEach((element) => {
      const text = element.textContent?.trim() || '';
      if (text.length < 5) return; // Skip very short elements

      // Determine block type
      const tagName = element.tagName.toLowerCase();
      let type: TextBlock['type'] = 'paragraph';
      if (tagName === 'h1') type = 'h1';
      else if (tagName === 'h2') type = 'h2';
      else if (tagName === 'h3' || tagName === 'h4' || tagName === 'h5' || tagName === 'h6') type = 'h3';
      else if (tagName === 'li') type = 'list-item';

      // Find this text in the section text
      const cleanText = text.replace(/\s+/g, ' ');
      const searchText = sectionText.replace(/\s+/g, ' ');
      const charStart = searchText.indexOf(cleanText.substring(0, Math.min(20, cleanText.length)), charPos);
      const actualStart = charStart >= 0 ? charStart : charPos;

      blocks.push({
        elements: [element],
        text: cleanText,
        charStart: actualStart,
        charEnd: actualStart + cleanText.length,
        type,
      });

      charPos = actualStart + cleanText.length;
    });

    // Log summary
    const typeCounts: Record<string, number> = {};
    blocks.forEach(b => { typeCounts[b.type] = (typeCounts[b.type] || 0) + 1; });
    const summary = Object.entries(typeCounts).map(([t, c]) => `${t}:${c}`).join(', ');
    console.log(`📚 EPUB TTS: ${blocks.length} blocks (${summary})`);

    return blocks;
  }, []);

  /**
   * Highlight a specific block and scroll it into view
   */
  const highlightBlock = useCallback((blockIndex: number) => {
    const blocks = textBlocksRef.current;
    const iframeDoc = iframeDocRef.current;
    if (blockIndex < 0 || blockIndex >= blocks.length || !iframeDoc) return;

    // Get theme for styling
    const isDarkMode = document.documentElement.classList.contains('dark');

    // Clear all previous highlights
    iframeDoc.querySelectorAll('.tts-highlight').forEach(el => {
      el.classList.remove('tts-highlight');
      (el as HTMLElement).style.backgroundColor = '';
      (el as HTMLElement).style.outline = '';
      (el as HTMLElement).style.outlineOffset = '';
      (el as HTMLElement).style.boxShadow = '';
    });

    const block = blocks[blockIndex];

    // Add highlight to all elements in this block
    block.elements.forEach(element => {
      element.classList.add('tts-highlight');
      // Strong highlight for TTS reading
      (element as HTMLElement).style.backgroundColor = isDarkMode
        ? 'rgba(59, 130, 246, 0.5)'  // Blue with opacity for dark mode
        : 'rgba(59, 130, 246, 0.3)'; // Blue for light mode
      (element as HTMLElement).style.outline = isDarkMode
        ? '2px solid rgba(59, 130, 246, 0.8)'
        : '2px solid rgba(59, 130, 246, 0.5)';
      (element as HTMLElement).style.outlineOffset = '2px';
      (element as HTMLElement).style.boxShadow = isDarkMode
        ? '0 0 12px rgba(59, 130, 246, 0.6)'
        : '0 0 8px rgba(59, 130, 246, 0.4)';
    });

    // Scroll into view
    if (block.elements.length > 0) {
      const firstElement = block.elements[0];
      firstElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    currentBlockIndexRef.current = blockIndex;

    // Update TTS character index for position tracking
    if (block) {
      ttsCharIndexRef.current = block.charStart;

      // Debounced save to backend (every 5 seconds)
      if (documentId && ttsSaveTimeoutRef.current) {
        clearTimeout(ttsSaveTimeoutRef.current);
      }

      if (documentId) {
        ttsSaveTimeoutRef.current = setTimeout(() => {
          saveReadingPosition(documentId, {
            page_number: 0, // Section index (TODO: get actual section index)
            last_tts_char_index: ttsCharIndexRef.current,
          }).catch((error) => {
            console.warn('📖 EPUB TTS: Failed to save TTS position:', error);
          });
        }, 5000); // Save every 5 seconds
      }
    }
  }, [documentId]);

  /**
   * Build a mapping from word index to block index
   * Uses direct block lookup instead of incremental tracking to avoid drift
   */
  const buildWordToBlockMap = useCallback((wordBoundaries: WordBoundary[], blocks: TextBlock[], sectionText: string): number[] => {
    const map: number[] = [];
    let charPosition = 0;
    const searchText = sectionText.toLowerCase();

    // Track which blocks have words mapped to them (for debugging)
    const blockWordCounts: number[] = new Array(blocks.length).fill(0);

    for (let wordIdx = 0; wordIdx < wordBoundaries.length; wordIdx++) {
      const word = wordBoundaries[wordIdx];
      const wordText = word.text.toLowerCase().replace(/[^a-z0-9]/g, '');

      // Find this word in the section text
      let foundPos = -1;

      for (let searchStart = charPosition; searchStart < searchText.length; searchStart++) {
        const remaining = searchText.substring(searchStart);
        const cleanRemaining = remaining.replace(/[^a-z0-9]/g, '');
        if (cleanRemaining.startsWith(wordText)) {
          foundPos = searchStart;
          break;
        }
      }

      if (foundPos >= 0) {
        charPosition = foundPos + word.text.length;
      } else {
        charPosition += word.text.length;
      }

      // Find which block contains this character position using direct lookup
      // This prevents drift from accumulating errors
      let blockIndex = 0;
      for (let i = 0; i < blocks.length; i++) {
        // Word belongs to this block if its position falls within block boundaries
        // or if we've passed this block's start (for words between blocks)
        if (charPosition <= blocks[i].charEnd) {
          blockIndex = i;
          break;
        }
        // If we're past this block, try the next one
        if (i === blocks.length - 1) {
          // Last block - assign to it
          blockIndex = i;
        }
      }

      map.push(blockIndex);
      blockWordCounts[blockIndex]++;
    }

    // Log mapping summary
    const blocksWithWords = blockWordCounts.filter(c => c > 0).length;
    const emptyBlocks = blocks.length - blocksWithWords;
    console.log(`📊 EPUB TTS: Mapped ${wordBoundaries.length} words to ${blocksWithWords}/${blocks.length} blocks (${emptyBlocks} blocks have no words)`);

    // Debug: log first few blocks without words
    if (emptyBlocks > 0) {
      const emptyBlockIndices: number[] = [];
      for (let i = 0; i < Math.min(blocks.length, 10); i++) {
        if (blockWordCounts[i] === 0) {
          emptyBlockIndices.push(i);
        }
      }
      if (emptyBlockIndices.length > 0) {
        console.log(`⚠️ EPUB TTS: First blocks without words: [${emptyBlockIndices.join(', ')}]`);
      }
    }

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

    // Initial highlight
    highlightBlock(0);

    // Update highlight every 100ms
    highlightIntervalRef.current = setInterval(() => {
      if (!audio || audio.paused || intentionalStopRef.current) return;

      const currentTimeMs = audio.currentTime * 1000;
      const targetBlock = findBlockForTime(currentTimeMs, wordBoundaries);

      // Only update if block changed
      if (targetBlock !== currentBlockIndexRef.current) {
        console.log(`🎯 EPUB TTS: Highlighting block ${targetBlock} at ${Math.round(currentTimeMs)}ms`);
        highlightBlock(targetBlock);
      }
    }, 100);
  }, [highlightBlock, findBlockForTime]);

  /**
   * Start TTS for current section
   * @param allowSkip - If false, read current page even if it has little text (used for manual navigation)
   */
  const startTTS = useCallback(async (allowSkip: boolean = true, retryCount: number = 0) => {
    try {
      console.log(`🎵 EPUB TTS: Starting (allowSkip=${allowSkip}, retryCount=${retryCount})`);
      intentionalStopRef.current = false;

      // DON'T reset lastRelocatedTimeRef here - it blocks manual navigation detection
      // Only reset it AFTER relocated handler is registered and initial synthesis completes

      // TTS reads from CURRENT position, not from saved expectedLocation
      // The user may have navigated to a different page - respect their choice
      // expectedLocation is only used for initial EPUB load, not for TTS
      const currentLoc = renditionRef.current?.currentLocation();
      const currentCfi = currentLoc?.cfi;
      const currentHref = currentLoc?.href;
      const currentIndex = currentLoc?.index;

      console.log(`📍 EPUB TTS: currentLocation() returned:`);
      console.log(`   CFI:   ${currentCfi || 'null'}`);
      console.log(`   HREF:  ${currentHref || 'null'}`);
      console.log(`   INDEX: ${currentIndex ?? 'null'}`);
      console.log(`📍 EPUB TTS: Will read from this position`);

      // Save starting CFI to detect user navigation
      ttsStartCfiRef.current = currentCfi || null;

      const sectionText = await getCurrentSectionText();

      // Retry if location not ready (max 3 attempts with 300ms delay)
      if (!sectionText && retryCount < 3) {
        console.log(`⏳ EPUB TTS: Location not ready, retrying in 300ms (attempt ${retryCount + 1}/3)`);
        await new Promise(resolve => setTimeout(resolve, 300));
        return startTTS(allowSkip, retryCount + 1);
      }

      // If no text found, try to skip to next section (cover pages, images, etc.)
      if (!sectionText) {
        console.log('📖 EPUB TTS: No text on current page (likely cover/image), trying next section...');
        const rendition = renditionRef.current;
        if (rendition && allowSkip && skipAttemptsRef.current < 5) {
          try {
            // Get current location before navigation
            const locationBefore = rendition.currentLocation()?.cfi;

            await rendition.next();
            console.log('📖 EPUB TTS: Called rendition.next()');

            // Wait for relocated event by polling location change
            let waitAttempts = 0;
            const maxWaitAttempts = 20; // 2 seconds max
            while (waitAttempts < maxWaitAttempts) {
              await new Promise(resolve => setTimeout(resolve, 100));
              const locationAfter = rendition.currentLocation()?.cfi;
              if (locationAfter && locationAfter !== locationBefore) {
                console.log('📖 EPUB TTS: Location changed from', locationBefore, 'to', locationAfter);
                break;
              }
              waitAttempts++;
            }

            if (waitAttempts >= maxWaitAttempts) {
              console.warn('⚠️ EPUB TTS: Location did not change after navigation');
            }

            // Additional delay for content to render
            await new Promise(resolve => setTimeout(resolve, 300));

            skipAttemptsRef.current++;
            console.log(`📖 EPUB TTS: Retrying TTS after skip (attempt ${skipAttemptsRef.current}/5)`);
            return startTTS(true, 0);
          } catch (navError) {
            console.error('❌ EPUB TTS: Failed to navigate to next section:', navError);
            cleanupTTS();
            return;
          }
        } else if (skipAttemptsRef.current >= 5) {
          console.error('❌ EPUB TTS: Skipped 5 sections without finding text, giving up');
          skipAttemptsRef.current = 0;
          cleanupTTS();
          return;
        } else {
          console.error('❌ EPUB TTS: No text found and cannot skip, giving up');
          cleanupTTS();
          return;
        }
      }

      // Check if section has enough text (minimum 100 characters)
      const MIN_TEXT_LENGTH = 100;
      if (allowSkip && (!sectionText || sectionText.length < MIN_TEXT_LENGTH)) {
        console.warn(`⚠️ EPUB TTS: Section has insufficient text (${sectionText?.length || 0} chars, need ${MIN_TEXT_LENGTH})`);

        // Try to skip to next section (max 5 attempts)
        const MAX_SKIP_ATTEMPTS = 5;
        if (skipAttemptsRef.current < MAX_SKIP_ATTEMPTS) {
          skipAttemptsRef.current += 1;
          console.log(`⏭️ EPUB TTS: Skipping to next section (attempt ${skipAttemptsRef.current}/${MAX_SKIP_ATTEMPTS})`);

          const rendition = renditionRef.current;
          if (rendition) {
            try {
              isAutoNavigatingRef.current = true; // Mark as programmatic navigation
              lastRelocatedTimeRef.current = Date.now(); // Reset debounce timer
              await rendition.next();
              setTimeout(() => {
                isAutoNavigatingRef.current = false;
                startTTS(allowSkip);
              }, 400);
              return;
            } catch (e) {
              console.log('📖 EPUB TTS: End of book while skipping');
              cleanupTTS();
              return;
            }
          } else {
            // No rendition available, cannot skip - stop TTS
            console.error('❌ EPUB TTS: No rendition available to skip section');
            cleanupTTS();
            return;
          }
        } else {
          console.error('❌ EPUB TTS: Too many sections without text, stopping');
          cleanupTTS();
          return;
        }
      }

      // Double-check we have valid text before synthesis (TypeScript safety)
      if (!sectionText || sectionText.trim().length === 0) {
        console.error('❌ EPUB TTS: No valid text for synthesis');
        cleanupTTS();
        return;
      }

      // Reset skip attempts when we find valid text
      skipAttemptsRef.current = 0;
      console.log(`📖 EPUB TTS: Section text length: ${sectionText.length}`);
      sectionTextRef.current = sectionText;

      // Get iframe document reference for highlighting
      let iframeDoc: Document | null = null;
      const rendition = renditionRef.current;
      if (rendition) {
        // Try to get document from EPUB.js Contents API first
        try {
          // @ts-expect-error - epub.js getContents is not in public type definitions
          const contents = rendition.getContents();
          if (contents) {
            // contents might be a single Contents object or an array
            // Handle both cases
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- epub.js Contents type not fully typed
            const contentsList: any[] = Array.isArray(contents) ? contents : [contents];

            for (const content of contentsList) {
              try {
                // Contents object has document property
                const doc = content.document || content.content?.document;
                if (doc && doc.body) {
                  iframeDoc = doc;
                  console.log('EPUB TTS: Got iframeDoc from Contents API');
                  break;
                }
              } catch (e) {
                // Skip this content entry and try the next one
              }
            }
          }
        } catch (e) {
          console.warn('⚠️ EPUB TTS: Could not get iframeDoc from Contents API', e);
        }

        // Fallback: try manager.container
        if (!iframeDoc) {
          try {
            // @ts-expect-error - epub.js manager property is not in public type definitions
            const manager = rendition.manager;
            if (manager?.container) {
              const iframe = manager.container.querySelector('iframe') as HTMLIFrameElement;
              if (iframe) {
                iframeDoc = iframe.contentDocument || iframe.contentWindow?.document || null;
              }
            }
          } catch (e) {
            console.warn('⚠️ EPUB TTS: Could not get iframe document from manager', e);
          }
        }

        // Last fallback: search for iframe in document
        if (!iframeDoc) {
          const epubContainers = document.querySelectorAll('[class*="epub"], [id*="epub"]');
          for (let i = 0; i < epubContainers.length; i++) {
            const containerIframe = epubContainers[i].querySelector('iframe') as HTMLIFrameElement;
            if (containerIframe) {
              const doc = containerIframe.contentDocument || containerIframe.contentWindow?.document;
              if (doc && doc.body) {
                iframeDoc = doc;
                break;
              }
            }
          }
        }
      }
      iframeDocRef.current = iframeDoc;

      // Build text blocks for highlighting
      // Uses visibleElementsRef which was populated by getCurrentSectionText()
      // This ensures blocks match the synthesized text exactly
      textBlocksRef.current = buildTextBlocks(sectionText);

      let currentVoice = selectedVoiceRef.current;
      if (typeof currentVoice !== 'string') {
        currentVoice = (currentVoice as TTSVoice)?.name || 'en-US-AriaNeural';
      }

      // Language auto-detection: EPUBs can be in any language, so we default
      // to English and check the first section's text to pick a better voice
      // (Croatian or Macedonian) when it's obvious. Only runs if the user
      // hasn't picked a voice explicitly. We only detect on the initial
      // section so the voice doesn't flap mid-book on a stray bilingual page.
      if (!voiceWasUserChosenRef.current && !currentSectionCacheRef.current) {
        const detected = detectLanguage(sectionText);
        const target = voiceForLanguage(detected);
        if (target !== currentVoice) {
          console.log(`🌐 EPUB TTS: Detected lang=${detected}, switching voice ${currentVoice} → ${target}`);
          currentVoice = target;
          selectedVoiceRef.current = target;
          setSelectedVoice(target);
        }
      }

      // Show loading
      setIsSpeaking(true);
      // Get the drawer element to position TTS controls in its center
      const drawerElement = document.querySelector('.epub-viewer-drawer') as HTMLElement;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TTS overlay global singleton
    (window as any).ttsOverlay?.show(theme === 'dark', drawerElement);

      // Synthesize audio with chunking for long texts
      const currentRate = speechRateRef.current;
      const validRate = typeof currentRate === 'number' && !isNaN(currentRate) && currentRate > 0 ? currentRate : 1.0;
      const ratePercent = Math.round((validRate - 1.0) * 100);
      const rateString = ratePercent >= 0 ? `+${ratePercent}%` : `${ratePercent}%`;

      // EPUB sections are chapter-sized - synthesize the entire section
      // This ensures word-to-block mapping covers ALL blocks for proper navigation
      // Backend limit: 50,000 chars, Edge TTS: ~10,000
      // Use 10,000 chars to match Edge TTS limit - larger sections will chunk
      const CHUNK_SIZE = 10000;
      const needsChunking = sectionText.length > CHUNK_SIZE;

      let audioBlob: Blob;
      let allWordBoundaries: WordBoundary[];
      let totalDurationMs: number;

      // Text used for synthesis (may be first chunk only if section is large)
      let synthesizedText = sectionText;
      wasChunkedRef.current = false; // Reset chunking flag

      if (needsChunking) {
        wasChunkedRef.current = true; // Mark that we chunked this section
        const textChunks = splitTextForTTS(sectionText, CHUNK_SIZE);
        console.log(`🔊 EPUB TTS: Section too large (${sectionText.length} chars), splitting into ${textChunks.length} chunks`);
        console.log(`⚠️  EPUB TTS: Large sections will take ~${Math.round(textChunks.length * 25 / 60)} minutes to fully synthesize`);

        // Synthesize ONLY first chunk, play immediately for better UX
        const firstChunk = textChunks[0];
        synthesizedText = firstChunk; // Track what we actually synthesized
        console.log(`📝 EPUB TTS: Synthesizing first chunk (${firstChunk.length} chars)`);
        const firstResponse = await synthesizeSpeech(firstChunk, currentVoice, rateString, '+0Hz');

        audioBlob = base64ToAudioBlob(firstResponse.audio);
        allWordBoundaries = firstResponse.word_boundaries;
        totalDurationMs = firstResponse.duration_ms;

        // CRITICAL: When chunking, limit blocks to only those in the synthesized portion
        // This prevents "No word found for block N" errors
        const originalBlocks = textBlocksRef.current;
        const limitedBlocks = originalBlocks.filter(block => block.charEnd <= firstChunk.length + 50); // +50 for tolerance
        console.log(`📊 EPUB TTS: Limiting blocks from ${originalBlocks.length} to ${limitedBlocks.length} for first chunk`);
        textBlocksRef.current = limitedBlocks;

        // Also limit visibleElementsRef to match
        if (visibleElementsRef.current.length > limitedBlocks.length) {
          visibleElementsRef.current = visibleElementsRef.current.slice(0, limitedBlocks.length);
        }

        console.log(`EPUB TTS: First chunk ready (${allWordBoundaries.length} words, ${Math.round(totalDurationMs)}ms)`);
        console.log(`📢 EPUB TTS: Playing first chunk. Navigate to next section for remaining content.`);
      } else {
        // Section small enough - synthesize in one request (like PDF pages)
        console.log(`🔊 EPUB TTS: Synthesizing section (${sectionText.length} chars, voice: ${currentVoice}, rate: ${rateString})`);

        const response = await synthesizeSpeech(sectionText, currentVoice, rateString, '+0Hz');
        console.log(`EPUB TTS: ${response.word_boundaries.length} words, ${response.duration_ms}ms`);

        audioBlob = base64ToAudioBlob(response.audio);
        allWordBoundaries = response.word_boundaries;
        totalDurationMs = response.duration_ms;
      }

      // Build word-to-block mapping for time-based highlighting
      // Use synthesizedText (may be first chunk) to ensure mapping matches audio
      if (textBlocksRef.current.length > 0) {
        wordToBlockMapRef.current = buildWordToBlockMap(
          allWordBoundaries,
          textBlocksRef.current,
          synthesizedText
        );
      }

      currentSectionCacheRef.current = {
        sectionIndex: 0, // TODO: Track actual section index
        text: sectionText,
        audio: audioBlob,
        wordBoundaries: allWordBoundaries,
        durationMs: totalDurationMs,
        voice: currentVoice,
      };

      // Create audio element and play
      if (!audioRef.current) {
        audioRef.current = new Audio();
      }

      const audio = audioRef.current;
      audio.src = URL.createObjectURL(audioBlob);
      audio.playbackRate = speechRateRef.current;

      // Register relocated handler BEFORE playback starts
      // This ensures handler is active even if synthesis timeouts or playback fails
      // Note: rendition already declared earlier in function (line 731)
      if (rendition) {
        // Remove old handler if it exists
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- custom property stored on audio element
        const oldHandler = (audio as any).relocatedHandler;
        if (oldHandler) {
          rendition.off('relocated', oldHandler);
        }

        // Store starting href to detect section changes (not just CFI changes)
        const startHref = rendition.currentLocation()?.href;

        const handleRelocated = (location?: DisplayedLocation) => {
          // Ignore if this was programmatic navigation (TTS controls or auto-advance)
          if (isAutoNavigatingRef.current) {
            console.log('📍 EPUB TTS: Relocated (auto-navigation, skipping restart)');
            return;
          }

          // Get location info from event or current location
          const currentLoc = rendition.currentLocation() as DisplayedLocation | null;
          const newCfi = location?.cfi || currentLoc?.cfi;
          const newHref = location?.href || currentLoc?.href;

          // Did the user just click the page-turn arrow / arrow key? Then a
          // same-href relocated IS a real page change and we must follow it.
          // Window: 2s after the click, which comfortably covers the gap
          // between `rendition.next()` and the relocated event landing.
          const now = Date.now();
          const userJustNavigated = !!userNavRef && now - userNavRef.current < 2000;

          // Only ignore same-href relocated events when the user didn't ask
          // for them — those are epub.js's internal CSS-column events on
          // initial layout. A user-clicked page-turn stays within a section
          // but is still real navigation.
          if (!userJustNavigated && startHref && newHref && startHref === newHref) {
            console.log('📍 EPUB TTS: Relocated (same section, ignoring internal pagination)');
            return;
          }

          // Check if same CFI (initial render)
          const startCfi = ttsStartCfiRef.current;
          if (!userJustNavigated && startCfi && newCfi && startCfi === newCfi) {
            console.log('📍 EPUB TTS: Relocated (same CFI, ignoring)');
            lastRelocatedTimeRef.current = now;
            return;
          }

          // Debounce relocated events - ignore if less than 500ms since last
          const timeSinceLastRelocated = now - lastRelocatedTimeRef.current;
          if (timeSinceLastRelocated < 500) {
            console.log(`📍 EPUB TTS: Relocated too soon (${timeSinceLastRelocated}ms), skipping`);
            return;
          }

          lastRelocatedTimeRef.current = now;

          // User navigated (page within section, or section/chapter change)
          const sameSection = startHref && newHref && startHref === newHref;
          console.log(
            `📍 EPUB TTS: ${sameSection ? 'Page' : 'Section'} changed (manual navigation detected!)`
          );
          console.log('   Start href:', startHref);
          console.log('   New href:  ', newHref);

          // The old page's highlight + interval are stale the moment the
          // user clicks; tear them down immediately so the reader doesn't
          // see a glowing paragraph from the previous page during the
          // 1–2 s of new-page synthesis.
          const wasPlaying = !!audioRef.current && !audioRef.current.paused;
          if (wasPlaying) {
            // Mark restart-in-progress BEFORE pausing so audio.onpause skips
            // the UI "paused" flicker and stays in playing/loading state.
            isRestartingRef.current = true;
            audioRef.current!.pause();
          }
          if (highlightIntervalRef.current) {
            clearInterval(highlightIntervalRef.current);
            highlightIntervalRef.current = null;
          }
          if (iframeDocRef.current) {
            iframeDocRef.current.querySelectorAll('.tts-highlight').forEach((el) => {
              el.classList.remove('tts-highlight');
              (el as HTMLElement).style.backgroundColor = '';
              (el as HTMLElement).style.outline = '';
              (el as HTMLElement).style.outlineOffset = '';
              (el as HTMLElement).style.boxShadow = '';
            });
          }

          // Small delay to ensure new page is rendered before extracting text
          setTimeout(() => {
            if (!intentionalStopRef.current && wasPlaying) {
              startTTS(false);
            } else {
              isRestartingRef.current = false;
            }
          }, 300);
        };

        rendition.on('relocated', handleRelocated);

        // Store handler for cleanup
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- storing handler on audio element for cleanup
        (audio as any).relocatedHandler = handleRelocated;

        // Set initial timestamp to enable debounce
        lastRelocatedTimeRef.current = Date.now();
        console.log('EPUB TTS: relocated handler registered, tracking CFI changes');
      }

      // Event handlers
      audio.onplay = () => {
        console.log('▶️ EPUB TTS: Playing');
        setIsSpeaking(true);
        setIsPaused(false);
        // New page audio is playing — restart sequence completed.
        isRestartingRef.current = false;
        // Start highlight tracking when audio plays
        if (textBlocksRef.current.length > 0) {
          startHighlightTracking(audio, allWordBoundaries);
        }
      };

      audio.onpause = () => {
        // The browser fires `pause` whenever playback stops, including at
        // natural end-of-track (followed by `ended`) and any time we pause
        // programmatically as part of restart/auto-advance. Treat those as
        // transitions, not user pauses — otherwise the UI flickers to the
        // "Resume" button during the synthesis gap and the user can click
        // it to replay the previous page's audio.
        if (audio.ended) return;
        if (isRestartingRef.current) return;
        if (isAutoNavigatingRef.current) return;
        setIsPaused(true);
      };

      audio.onended = async () => {
        console.log('🏁 EPUB TTS: Page audio ended');
        if (intentionalStopRef.current) {
          cleanupTTS();
          return;
        }

        // With viewport-based extraction, auto-advance to NEXT PAGE within same section
        // Only advance to next spine section when we reach the end of current section
        const rendition = renditionRef.current;
        if (rendition) {
          try {
            // Get current location before navigation
            const beforeLocation = rendition.currentLocation() as DisplayedLocation | null;
            const beforeHref = beforeLocation?.href;

            console.log(`➡️ EPUB TTS: Trying next page within section (current href: ${beforeHref})`);

            // Set auto-navigating flag to prevent relocated handler from triggering
            isAutoNavigatingRef.current = true;
            lastRelocatedTimeRef.current = Date.now();

            // Create a Promise that resolves when relocated event fires
            // This is more reliable than setTimeout because epub.js may take time to update currentLocation()
            let relocatedResolve: ((value: boolean) => void) | null = null;
            const relocatedPromise = new Promise<boolean>((resolve) => {
              relocatedResolve = resolve;
            });

            // Temporary relocated handler to detect navigation success
            const tempRelocatedHandler = (_location?: DisplayedLocation) => {
              console.log('📍 EPUB TTS: Relocated event during auto-navigation');
              if (relocatedResolve) {
                relocatedResolve(true); // Signal that navigation succeeded
                relocatedResolve = null;
              }
            };

            rendition.on('relocated', tempRelocatedHandler);

            // Try to go to next page within the section
            await rendition.next();

            // Wait for relocated event OR timeout (2 seconds)
            // Relocated event = navigation succeeded (new page/section)
            // Timeout = no relocated event = end of book
            const navigationSucceeded = await Promise.race([
              relocatedPromise,
              new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2000)),
            ]);

            // Remove temporary handler
            rendition.off('relocated', tempRelocatedHandler);

            if (navigationSucceeded) {
              // Wait a bit more for currentLocation() to be ready
              await new Promise(resolve => setTimeout(resolve, 200));

              // Successfully moved - restart TTS for the new page
              const afterLocation = rendition.currentLocation() as DisplayedLocation | null;
              const afterHref = afterLocation?.href;
              const movedToNewSection = beforeHref !== afterHref;

              console.log(`➡️ EPUB TTS: Moved to new ${movedToNewSection ? 'section' : 'page'}, restarting TTS`);
              setTimeout(() => {
                isAutoNavigatingRef.current = false;
                startTTS();
              }, 100);
            } else {
              // Didn't move - we're at the end of the book
              console.log('📖 EPUB TTS: End of book (no relocated event after 2s)');
              isAutoNavigatingRef.current = false;
              cleanupTTS();
            }
          } catch (error) {
            console.error('➡️ EPUB TTS: Failed to auto-advance:', error);
            isAutoNavigatingRef.current = false;
            cleanupTTS();
          }
        } else {
          cleanupTTS();
        }
      };

      audio.onerror = (e) => {
        if (intentionalStopRef.current) return;
        console.error('❌ EPUB TTS: Audio error', e);
        cleanupTTS();
      };

      // Start playback (check if user didn't stop during synthesis)
      if (!intentionalStopRef.current) {
        console.log('▶️ EPUB TTS: Playing');
        audio.play().catch(error => {
          console.error('❌ EPUB TTS: Play failed', error);
          cleanupTTS();
        });
      } else {
        console.log('🛑 EPUB TTS: User stopped during synthesis, skipping play');
        cleanupTTS();
      }

    } catch (error) {
      console.error('❌ EPUB TTS: Synthesis failed', error);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TTS overlay global singleton
    (window as any).ttsOverlay?.hide();
      cleanupTTS();
    }
  }, [renditionRef, getCurrentSectionText, theme, cleanupTTS, buildTextBlocks, buildWordToBlockMap, startHighlightTracking]); // expectedLocation removed - TTS reads from current position

  /**
   * Stop TTS
   */
  const stopTTS = useCallback(() => {
    console.log('🛑 EPUB TTS: Stop');
    intentionalStopRef.current = true;
    cleanupTTS();
  }, [cleanupTTS]);

  /**
   * Navigate to previous block (paragraph) - navigate by text block instead of section
   * If at first block on current page, go to previous page within section
   * If at first page of section, go to previous spine section
   */
  const speakPrevBlock = useCallback(async () => {
    const blocks = textBlocksRef.current;
    const currentBlockIdx = currentBlockIndexRef.current;

    console.log(`⏮️ EPUB TTS: Previous block (current: ${currentBlockIdx}, total: ${blocks.length})`);

    // If we have blocks and not at the first one, navigate to previous block
    if (blocks.length > 0 && currentBlockIdx > 0) {
      const prevBlockIdx = currentBlockIdx - 1;
      console.log(`⏮️ EPUB TTS: Moving to block ${prevBlockIdx}`);

      // Highlight the previous block
      highlightBlock(prevBlockIdx);

      // If TTS is playing, seek to the start of this block's audio position
      if (audioRef.current && !audioRef.current.paused && currentSectionCacheRef.current) {
        const wordBoundaries = currentSectionCacheRef.current.wordBoundaries;
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
          console.log(`⏮️ EPUB TTS: Seeking to ${targetTimeMs}ms for block ${prevBlockIdx}`);
        } else {
          console.log(`⏮️ EPUB TTS: No word found for block ${prevBlockIdx}, not seeking`);
        }
      }
    } else {
      // At first block on current page - first try to go to previous page within same section
      console.log('⏮️ EPUB TTS: At first block on page, trying previous page within section');

      const rendition = renditionRef.current;
      if (!rendition) return;

      // Get current location before navigation
      const locationBefore = rendition.currentLocation() as DisplayedLocation | null;
      const cfiBefore = locationBefore?.cfi;

      // Clear current TTS state
      if (highlightIntervalRef.current) {
        clearInterval(highlightIntervalRef.current);
        highlightIntervalRef.current = null;
      }

      if (iframeDocRef.current) {
        iframeDocRef.current.querySelectorAll('.tts-highlight').forEach(el => {
          el.classList.remove('tts-highlight');
          (el as HTMLElement).style.backgroundColor = '';
          (el as HTMLElement).style.outline = '';
          (el as HTMLElement).style.outlineOffset = '';
          (el as HTMLElement).style.boxShadow = '';
        });
      }

      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.src = '';
      }

      isAutoNavigatingRef.current = true;
      lastRelocatedTimeRef.current = Date.now();

      try {
        // Try to go to previous page within the same section
        await rendition.prev();

        // Wait for navigation to complete
        await new Promise(resolve => setTimeout(resolve, 400));

        // Check if location actually changed
        const locationAfter = rendition.currentLocation() as DisplayedLocation | null;
        const cfiAfter = locationAfter?.cfi;

        if (cfiAfter && cfiAfter !== cfiBefore) {
          // Location changed - we successfully moved to previous page within section
          console.log('⏮️ EPUB TTS: Moved to previous page within section');
          isAutoNavigatingRef.current = false;
          void startTTS();
        } else {
          // Location didn't change - we're at the beginning of this section, go to previous spine section
          console.log('⏮️ EPUB TTS: At beginning of section, going to previous spine section');

          // @ts-expect-error - epub.js book property is not in public type definitions
          const book = rendition.book;
          const currentLocation = rendition.currentLocation() as DisplayedLocation | null;
          const currentIndex = currentLocation?.index;

          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- epubjs spine types are incomplete
          const spineItems = (book?.spine as any)?.spineItems as { href: string }[] | undefined;
          let effectiveIndex = currentIndex ?? 0;
          if (currentIndex === undefined && spineItems) {
            const currentHref = currentLocation?.href;
            if (currentHref) {
              const foundIndex = spineItems.findIndex((item) =>
                item.href === currentHref || item.href.endsWith(currentHref) || currentHref.endsWith(item.href)
              );
              if (foundIndex >= 0) {
                effectiveIndex = foundIndex;
              }
            }
          }

          const prevIndex = effectiveIndex - 1;
          if (prevIndex >= 0 && spineItems?.[prevIndex]) {
            const prevSection = spineItems[prevIndex];
            console.log(`⏮️ EPUB TTS: Navigating to previous section ${prevIndex}: ${prevSection.href}`);
            await rendition.display(prevSection.href);

            setTimeout(() => {
              isAutoNavigatingRef.current = false;
              void startTTS();
            }, 600);
          } else {
            console.log('⏮️ EPUB TTS: Already at first section');
            isAutoNavigatingRef.current = false;
            // Restart TTS on current page
            void startTTS();
          }
        }
      } catch (error) {
        console.error('⏮️ EPUB TTS: Failed to navigate:', error);
        isAutoNavigatingRef.current = false;
      }
    }
  }, [renditionRef, startTTS, highlightBlock]);

  /**
   * Navigate to next block (paragraph) - navigate by text block instead of section
   * If at last block on current page, go to next page within section
   * If at last page of section, go to next spine section
   */
  const speakNextBlock = useCallback(async () => {
    const blocks = textBlocksRef.current;
    const currentBlockIdx = currentBlockIndexRef.current;

    console.log(`⏭️ EPUB TTS: Next block (current: ${currentBlockIdx}, total: ${blocks.length})`);

    // If we have blocks and not at the last one, navigate to next block
    if (blocks.length > 0 && currentBlockIdx < blocks.length - 1) {
      const nextBlockIdx = currentBlockIdx + 1;
      console.log(`⏭️ EPUB TTS: Moving to block ${nextBlockIdx}`);

      // Highlight the next block
      highlightBlock(nextBlockIdx);

      // If TTS is playing, seek to the start of this block's audio position
      if (audioRef.current && !audioRef.current.paused && currentSectionCacheRef.current) {
        const wordBoundaries = currentSectionCacheRef.current.wordBoundaries;
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
          console.log(`⏭️ EPUB TTS: Seeking to ${targetTimeMs}ms for block ${nextBlockIdx}`);
        } else {
          console.log(`⏭️ EPUB TTS: No word found for block ${nextBlockIdx}, not seeking`);
        }
      }
    } else {
      // At last block on current page - first try to go to next page within same section
      console.log('⏭️ EPUB TTS: At last block on page, trying next page within section');

      const rendition = renditionRef.current;
      if (!rendition) return;

      // Get current location before navigation
      const locationBefore = rendition.currentLocation() as DisplayedLocation | null;
      const cfiBefore = locationBefore?.cfi;
      const hrefBefore = locationBefore?.href;
      const pageBefore = locationBefore?.displayed?.page;
      const totalPages = locationBefore?.displayed?.total;

      console.log('⏭️ EPUB TTS: Before navigation:', { cfiBefore, hrefBefore, pageBefore, totalPages });

      // Check if we're already at the last page of the section
      if (pageBefore && totalPages && pageBefore >= totalPages) {
        console.log('⏭️ EPUB TTS: Already at last page of section, going to next spine section');
        // Skip rendition.next() and go directly to next spine section
      } else {
        // Clear current TTS state
        if (highlightIntervalRef.current) {
          clearInterval(highlightIntervalRef.current);
          highlightIntervalRef.current = null;
        }

        if (iframeDocRef.current) {
          iframeDocRef.current.querySelectorAll('.tts-highlight').forEach(el => {
            el.classList.remove('tts-highlight');
            (el as HTMLElement).style.backgroundColor = '';
            (el as HTMLElement).style.outline = '';
            (el as HTMLElement).style.outlineOffset = '';
            (el as HTMLElement).style.boxShadow = '';
          });
        }

        if (audioRef.current) {
          audioRef.current.pause();
          audioRef.current.src = '';
        }

        isAutoNavigatingRef.current = true;
        lastRelocatedTimeRef.current = Date.now();

        try {
          // Try to go to next page within the same section
          await rendition.next();

          // Wait for navigation to complete
          await new Promise(resolve => setTimeout(resolve, 400));

          // Check if location actually changed and we moved FORWARD (not back to beginning)
          const locationAfter = rendition.currentLocation() as DisplayedLocation | null;
          const cfiAfter = locationAfter?.cfi;
          const hrefAfter = locationAfter?.href;
          const pageAfter = locationAfter?.displayed?.page;

          console.log('⏭️ EPUB TTS: After navigation:', { cfiAfter, hrefAfter, pageAfter });

          // Check if we actually moved forward:
          // 1. Different href = moved to different section (epub.js auto-advanced)
          // 2. Same href, higher page number = moved forward within section
          // 3. Same href, same/lower page = we cycled back or didn't move (at end)
          const movedToNextSection = hrefAfter && hrefBefore && hrefAfter !== hrefBefore;
          const movedForwardInSection = hrefAfter === hrefBefore && pageAfter && pageBefore && pageAfter > pageBefore;
          const cfiChanged = cfiAfter && cfiAfter !== cfiBefore;

          if (movedToNextSection) {
            // epub.js automatically moved us to next section - that's fine, start TTS there
            console.log('⏭️ EPUB TTS: Moved to next section automatically');
            isAutoNavigatingRef.current = false;
            void startTTS();
            return;
          } else if (movedForwardInSection || (cfiChanged && !pageBefore)) {
            // Moved forward within same section
            console.log('⏭️ EPUB TTS: Moved to next page within section');
            isAutoNavigatingRef.current = false;
            void startTTS();
            return;
          } else {
            // Didn't move forward - we're at the end of this section
            console.log('⏭️ EPUB TTS: Did not move forward, at end of section');
          }
        } catch (error) {
          console.error('⏭️ EPUB TTS: Failed to navigate with rendition.next():', error);
        }
      }

      // If we get here, we need to navigate to the next spine section
      console.log('⏭️ EPUB TTS: Going to next spine section');

      // Clear TTS state if not already cleared
      if (highlightIntervalRef.current) {
        clearInterval(highlightIntervalRef.current);
        highlightIntervalRef.current = null;
      }

      if (iframeDocRef.current) {
        iframeDocRef.current.querySelectorAll('.tts-highlight').forEach(el => {
          el.classList.remove('tts-highlight');
          (el as HTMLElement).style.backgroundColor = '';
          (el as HTMLElement).style.outline = '';
          (el as HTMLElement).style.outlineOffset = '';
          (el as HTMLElement).style.boxShadow = '';
        });
      }

      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.src = '';
      }

      isAutoNavigatingRef.current = true;
      lastRelocatedTimeRef.current = Date.now();

      try {
        // @ts-expect-error - epub.js book property is not in public type definitions
        const book = rendition.book;
        const currentLocation = rendition.currentLocation() as DisplayedLocation | null;
        const currentIndex = currentLocation?.index;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- epubjs spine types are incomplete
        const spineItems = (book?.spine as any)?.spineItems as { href: string }[] | undefined;
        const spineLength = spineItems?.length ?? 0;

        let effectiveIndex = currentIndex ?? 0;
        if (currentIndex === undefined && spineItems) {
          const currentHref = currentLocation?.href;
          if (currentHref) {
            const foundIndex = spineItems.findIndex((item) =>
              item.href === currentHref || item.href.endsWith(currentHref) || currentHref.endsWith(item.href)
            );
            if (foundIndex >= 0) {
              effectiveIndex = foundIndex;
            }
          }
        }

        const nextIndex = effectiveIndex + 1;
        if (nextIndex < spineLength && spineItems?.[nextIndex]) {
          const nextSection = spineItems[nextIndex];
          console.log(`⏭️ EPUB TTS: Navigating to next section ${nextIndex}: ${nextSection.href}`);
          await rendition.display(nextSection.href);

          setTimeout(() => {
            isAutoNavigatingRef.current = false;
            startTTS();
          }, 600);
        } else {
          console.log(`📖 EPUB TTS: End of book`);
          isAutoNavigatingRef.current = false;
          cleanupTTS();
        }
      } catch (error) {
        console.error('⏭️ EPUB TTS: Failed to navigate:', error);
        isAutoNavigatingRef.current = false;
        cleanupTTS();
      }
    }
  }, [renditionRef, startTTS, cleanupTTS, highlightBlock]);

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
    userPrefs.setTTSRate(rate);
    if (audioRef.current) {
      audioRef.current.playbackRate = rate;
    }
  }, []);

  // Note: Relocated handler is now registered in audio.onplay (after synthesis completes)
  // This prevents false triggers during initial load or synthesis phase

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

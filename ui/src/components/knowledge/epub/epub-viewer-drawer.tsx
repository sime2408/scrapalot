import React, { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import { createTtsOverlay } from '@/lib/tts-overlay';
import { Headphones, Maximize, Minimize, MessageSquare, Play, Square, X } from 'lucide-react';
import { WindowPinMenu } from '@/components/ui/window-pin-menu';
import { useFloatingWindowManager } from '@/contexts/floating-window-context';
import { useFloatingWindow } from '@/hooks/use-floating-window';
import { makeFloatingWindowStorage } from '@/lib/floating-window-storage';
import type { WindowMode } from '@/types/floating-window';
import { openChatWithDocument } from '@/lib/chat-with-document';
import { openVoiceWithDocument } from '@/lib/voice-with-document';
import { Button } from '@/components/ui/button.tsx';
import { EpubViewer } from './epub-viewer.tsx';
import { useEpubTTS } from './epub-viewer-tts-edge.tsx';
import { PDFReaderSettings } from '../pdf/pdf-reader-settings.tsx';
import { useIsNarrowScreen } from '@/hooks/use-mobile.tsx';
import { useSidebar } from '@/contexts/sidebar-context.tsx';
import { useEpubViewer } from '@/contexts/epub-viewer-context.tsx';
import { useDeepResearchPanel } from '@/contexts/deep-research-context';
import { useTheme } from '@/providers/theme-provider';
import { useTranslation } from 'react-i18next';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip.tsx';
import { epubPositions } from '@/lib/storage-utils';
import { getReadingPosition, saveReadingPosition } from '@/lib/api-documents';
import type { Rendition } from 'epubjs';
import { EpubAnnotationLayer } from '@/components/annotations/epub-annotation-layer';
import { useAnnotations } from '@/hooks/use-annotations';
import { useResolvedCollectionId } from '@/hooks/use-resolved-collection-id';

// Define the SidebarQuickTools width as a constant for consistent use
const ICON_SIDEBAR_WIDTH = 70; // SidebarQuickTools is w-[70px]

interface EpubViewerDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  epubUrl: string;
  documentId?: string; // Document ID for reading position tracking
  documentTitle?: string; // Document title for display in header
  initialLocation?: string | number;
  citationId?: number;
  isNotesOpen?: boolean; // Track if Notes is also open for side-by-side layout
  isPdfOpen?: boolean; // Track if PDF is also open for side-by-side layout
}

export const EpubViewerDrawer: React.FC<EpubViewerDrawerProps> = ({
  isOpen,
  onClose,
  epubUrl,
  documentId,
  documentTitle: propDocumentTitle,
  initialLocation, // Don't default to 0 - undefined means load from database
  citationId: _citationId = -1,
  isNotesOpen = false,
  isPdfOpen = false,
}) => {
  const { t } = useTranslation();
  const isNarrowScreen = useIsNarrowScreen();
  const { isSidebarOpen: _isSidebarOpen } = useSidebar();
  const { state: epubState, dispatch: epubDispatch } = useEpubViewer();
  const deepResearchPanel = useDeepResearchPanel();
  const { theme } = useTheme();
  const floatingMgr = useFloatingWindowManager();
  const epubStorage = useMemo(() => makeFloatingWindowStorage('epub-viewer'), []);
  const fw = useFloatingWindow({
    id: 'epub-viewer',
    initialMode: 'pinned-right',
    storage: epubStorage,
    forceMaximized: isNarrowScreen,
    defaultFloatingSize: { width: 720, height: 720 },
  });

  const [viewerWidth, setViewerWidth] = useState<string>('50');
  const [documentTitle, setDocumentTitle] = useState<string>(t('epubViewer.documentViewer', 'ePub Viewer'));

  // Annotations
  const {
    annotations,
    activeTool,
    activeColor,
    setActiveTool,
    setActiveColor: _setActiveColor,
    createHighlight,
    updateComment,
    removeAnnotation,
  } = useAnnotations({
    documentId: documentId || null,
    collectionId: useResolvedCollectionId(epubState.collectionId, documentId, isOpen),
    viewerType: 'epub',
    enabled: isOpen && !!documentId,
  });

  // IMPORTANT: Load saved position from localStorage BEFORE initializing currentLocation
  // This prevents epub.js from displaying first page before we can load saved position
  const getInitialLocation = (): string | number | undefined => {
    // Priority 1: Use explicitly provided initialLocation (e.g., from citation)
    if (initialLocation !== undefined) {
      console.log('📖 EPUB: Using provided initialLocation:', initialLocation);
      return initialLocation;
    }

    // Priority 2: Load from localStorage cache (instant, no API call)
    if (documentId) {
      const cachedPosition = epubPositions.getPosition(documentId);
      if (cachedPosition && cachedPosition.cfi) {
        console.log('📖 EPUB: Using cached position from localStorage:', cachedPosition.cfi);
        return cachedPosition.cfi;
      }
    }

    // Priority 3: No saved position, will load from database in background
    console.log('📖 EPUB: No cached position, will load from database');
    return undefined;
  };

  const [currentLocation, setCurrentLocation] = useState<string | number | undefined>(getInitialLocation());
  const [isRenditionReady, setIsRenditionReady] = useState(false);
  const [ttsReadyTimeout, setTtsReadyTimeout] = useState<NodeJS.Timeout | null>(null);
  const hasRelocatedRef = useRef(false); // Track if relocated event fired at least once
  const [_savedPosition, setSavedPosition] = useState<string | null>(null);
  const [hasLoadedSavedPosition, setHasLoadedSavedPosition] = useState(false);
  const [_isLoadingPosition, setIsLoadingPosition] = useState(false);
  const [_positionLoadError, setPositionLoadError] = useState(false);
  const [isInverted, setIsInverted] = useState(false);
  const prevIsOpenRef = useRef<boolean>(false);
  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const isSavingRef = useRef<boolean>(false); // Track if save request is in progress
  const positionLoadStartedRef = useRef<boolean>(false); // Prevent re-triggering position load
  const currentLocationRef = useRef<string | number | undefined>(getInitialLocation());

  const viewerRef = useRef<HTMLDivElement>(null);
  const renditionRef = useRef<Rendition | null>(null);
  // Timestamp the EPUB viewer stamps when the user clicks next/prev page.
  // The TTS hook uses it to tell a real page-turn from epub.js's internal
  // CSS-column relocated events (same href, no user intent).
  const userNavRef = useRef<number>(0);

  // Text-to-speech using edge-tts backend
  const {
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
  } = useEpubTTS(renditionRef, theme === 'dark' ? 'dark' : 'light', documentId, currentLocation, userNavRef);

  // Get position from context (like PDF viewer does)
  // Deep Research panel always occupies the right 50vw — force EPUB to the
  // left whenever it is open, regardless of the captured side.
  const isOnLeft = deepResearchPanel.isOpen ? true : epubState.isOnLeft;

  // Calculate the position based on sidebar state, screen size, Notes and PDF state
  const calculatePosition = () => {
    // On narrow screens (< 992px), make it truly full screen (cover entire viewport)
    if (isNarrowScreen) {
      return {
        width: '100vw',
        height: '100vh',
        right: '0',
        left: '0',
        top: '0',
        bottom: '0',
      };
    }

    // Use isOnLeft from context (like PDF viewer does)
    if (isOnLeft) {
      // ePub on LEFT side - must account for sidebar (70px)
      // At 50%: width = calc(50vw - 70px), positioned after sidebar
      // At 100%: width = calc(100vw - 70px), full width minus sidebar
      const leftSideWidth = viewerWidth === '100'
        ? `calc(100vw - ${ICON_SIDEBAR_WIDTH}px)`
        : `calc(50vw - ${ICON_SIDEBAR_WIDTH}px)`;

      return {
        width: leftSideWidth,
        left: `${ICON_SIDEBAR_WIDTH}px`, // LEFT side after SidebarQuickTools
        right: 'auto',
      };
    }

    // ePub on RIGHT side (default)
    // At 50%: width = 50vw (half viewport, anchored to right)
    // At 100%: width = calc(100vw - 70px) (full width minus sidebar)
    const rightWidth = viewerWidth === '100'
      ? `calc(100vw - ${ICON_SIDEBAR_WIDTH}px)`
      : '50vw';

    return {
      width: rightWidth,
      right: '0',
      left: 'auto',
    };
  };

  // Auto @-mention the opened ePub in the chat input. Same pattern as the
  // PDF drawer — useChatMentions' listener on `scrapalot:chat-with-document`
  // dedup's incoming mentions, so re-firing on title resolution is safe.
  // We wait for both documentId and a resolved name to avoid chipping the
  // generic placeholder ("ePub Viewer").
  const lastAutoMentionedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!isOpen || !documentId) {
      lastAutoMentionedRef.current = null;
      return;
    }
    const name = propDocumentTitle || documentTitle;
    if (!name || name === t('epubViewer.documentViewer', 'ePub Viewer')) return;
    if (lastAutoMentionedRef.current === documentId) return;
    lastAutoMentionedRef.current = documentId;
    openChatWithDocument({
      documentId,
      documentName: name,
      collectionId: epubState.collectionId || undefined,
      silent: true,
    });
  }, [isOpen, documentId, propDocumentTitle, documentTitle, epubState.collectionId, t]);

  // Track opening position (first come, first served) - dispatch to context
  useEffect(() => {
    const wasOpen = prevIsOpenRef.current;

    if (!wasOpen && isOpen) {
      // ePub is opening now
      // Capture the position: if Notes or PDF is already open, we go LEFT, otherwise RIGHT
      const opensOnRight = !(isNotesOpen || isPdfOpen);
      epubDispatch({ type: 'SET_EPUB_POSITION', payload: { isOnLeft: !opensOnRight } });
    }
    // Note: Position reset happens in context reducer on CLOSE_EPUB_VIEWER

    prevIsOpenRef.current = isOpen;
  }, [isOpen, isNotesOpen, isPdfOpen, epubDispatch]);

  const position = calculatePosition();

  // TTS event handlers
  const handleSpeakText = () => {
    console.log('🎯 EPUB TTS: handleSpeakText called', {
      isPaused,
      isSpeaking,
      hasRendition: !!renditionRef.current,
    });

    if (isPaused) {
      console.log('▶️ EPUB TTS: Resuming from pause');
      togglePause();
      return;
    }
    if (isSpeaking) {
      console.log('⏹️ EPUB TTS: Stopping');
      stopTTS();
      return;
    }

    console.log('🎬 EPUB TTS: Starting TTS...');
    if (!renditionRef.current) {
      console.error('❌ EPUB TTS: No rendition available when Play clicked!');
      console.error('❌ EPUB TTS: EPUB must be fully loaded before TTS can start');
      return;
    }

    void startTTS();
  };

  const handleStopText = () => {
    stopTTS();
  };

  // Handle location changes - memoized to prevent EPUB reinitialization on re-renders
  const handleLocationChange = useCallback((location: string) => {
    console.log('📍 EPUB DRAWER: handleLocationChange called with CFI:', location);
    setCurrentLocation(location);
    // Mark that relocated event has fired at least once
    hasRelocatedRef.current = true;
    console.log('📍 EPUB DRAWER: currentLocation state will update to:', location);
  }, []);

  // When the user switches to a different document while the drawer stays
  // mounted (it's a long-lived portal), reset everything that's keyed to the
  // previous document so the new one doesn't inherit its CFI / "already
  // loaded" flags. Also seed currentLocation from the local cache so the new
  // EPUB opens on the saved page even before the DB round-trip lands.
  const lastDocumentIdRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    const prevId = lastDocumentIdRef.current;
    if (prevId === documentId) return;
    lastDocumentIdRef.current = documentId;

    if (prevId !== undefined) {
      console.log('📖 EPUB: Document changed', prevId, '→', documentId, ', resetting position state');
      positionLoadStartedRef.current = false;
      setHasLoadedSavedPosition(false);
      setSavedPosition(null);
      if (userNavRef) userNavRef.current = 0;
    }

    if (documentId) {
      const cached = epubPositions.getPosition(documentId);
      if (cached?.cfi) {
        console.log('📖 EPUB: Seeded currentLocation from cache for', documentId, ':', cached.cfi);
        setCurrentLocation(cached.cfi);
      } else if (prevId !== undefined) {
        // Switched to a doc that has no cached position — clear the stale
        // CFI from the previous doc so EpubViewer doesn't try to apply it.
        setCurrentLocation(undefined);
      }
    }
  }, [documentId]);

  // Load saved reading position when drawer opens (database + localStorage cache)
  // NOTE: Position loads in background, EPUB renders immediately
  useEffect(() => {
    console.log('📖 EPUB: Position loading useEffect triggered', {
      isOpen,
      documentId: !!documentId,
      hasLoadedSavedPosition,
      initialLocation,
      isSpeaking,
      positionLoadStarted: positionLoadStartedRef.current,
    });

    if (!isOpen || !documentId || hasLoadedSavedPosition) {
      console.log('📖 EPUB: Position load skipped - isOpen:', isOpen, 'documentId:', !!documentId, 'hasLoadedSavedPosition:', hasLoadedSavedPosition);
      return;
    }

    // Only run position loading ONCE per drawer open (prevent re-triggering during TTS)
    if (positionLoadStartedRef.current) {
      console.log('📖 EPUB: Position load already started, skipping re-trigger');
      return;
    }
    console.log('📖 EPUB: Starting position load process...');
    positionLoadStartedRef.current = true;

    // ALWAYS load from database for cross-device sync
    // Even if localStorage had a position, backend might have a newer one
    console.log('📖 EPUB: Proceeding with position load from database (cross-device sync)');
    setHasLoadedSavedPosition(true);

    // Always fetch from database first for cross-device sync
    console.log('📖 EPUB: Fetching position from database for document:', documentId);

    // Timeout to ensure EPUB loads even if API is slow (1 second max wait)
    const loadingTimeout = setTimeout(() => {
      console.log('📖 EPUB: Position fetch timeout (1s), using cached position');

      // Check if user has already navigated or started TTS while we were loading
      const currentLoc = currentLocationRef.current;
      const userAlreadyNavigated = typeof currentLoc === 'string' && currentLoc.startsWith('epubcfi');

      if (userAlreadyNavigated || isSpeaking) {
        console.log('📖 EPUB: Timeout - user already navigated or TTS active - skipping update');
        return;
      }

      const cachedPosition = epubPositions.getPosition(documentId);
      if (cachedPosition && cachedPosition.cfi) {
        console.log('📖 EPUB: Using cache:', cachedPosition.cfi);
        setSavedPosition(cachedPosition.cfi);
        setCurrentLocation(cachedPosition.cfi);
      }
    }, 1000); // Reduced from 2s to 1s

    getReadingPosition(documentId)
      .then(position => {
        clearTimeout(loadingTimeout);

        // Check if user has already navigated or started TTS while we were loading
        // If so, don't override their current position!
        const currentLoc = currentLocationRef.current;
        const userAlreadyNavigated = typeof currentLoc === 'string' && currentLoc.startsWith('epubcfi');

        if (userAlreadyNavigated || isSpeaking) {
          console.log('📖 EPUB: Position loaded from DB, but user already navigated or TTS active - skipping update');
          return;
        }

        if (position && position.epub_cfi) {
          // Use epub_cfi field for EPUB CFI
          const cfi = position.epub_cfi;
          console.log('📖 EPUB: Database position (CFI):', cfi);

          // Update localStorage cache
          epubPositions.setPosition(
            documentId,
            cfi,
            position.page_number, // Use page_number as sectionIndex
            position.last_tts_char_index
          );

          setSavedPosition(cfi);
          setCurrentLocation(cfi);
        } else {
          // No database position - check localStorage as fallback
          const cachedPosition = epubPositions.getPosition(documentId);
          if (cachedPosition && cachedPosition.cfi) {
            console.log('📖 EPUB: No database position, using cache:', cachedPosition.cfi);
            setSavedPosition(cachedPosition.cfi);
            setCurrentLocation(cachedPosition.cfi);
          }
        }
      })
      .catch(err => {
        clearTimeout(loadingTimeout);
        console.warn('📖 EPUB: Failed to load from database, using localStorage fallback:', err);
        setPositionLoadError(true);

        // Check if user has already navigated or started TTS while we were loading
        const currentLoc = currentLocationRef.current;
        const userAlreadyNavigated = typeof currentLoc === 'string' && currentLoc.startsWith('epubcfi');

        if (userAlreadyNavigated || isSpeaking) {
          console.log('📖 EPUB: Error fallback - user already navigated or TTS active - skipping update');
          return;
        }

        // Fallback to localStorage on error
        const cachedPosition = epubPositions.getPosition(documentId);
        if (cachedPosition && cachedPosition.cfi) {
          setSavedPosition(cachedPosition.cfi);
          setCurrentLocation(cachedPosition.cfi);
        }
      });
  }, [isOpen, documentId, hasLoadedSavedPosition, initialLocation, isSpeaking]);
  // NOTE: isSpeaking is now in dependencies to properly handle TTS state

  // Debounced save of reading position on location change (backend + localStorage cache)
  useEffect(() => {
    if (!documentId || !isOpen || !currentLocation) {
      console.log('📖 EPUB: Position save skipped - documentId:', !!documentId, 'isOpen:', isOpen, 'currentLocation:', !!currentLocation);
      return;
    }

    console.log('📖 EPUB: Position changed, preparing to save:', { currentLocation, hasLoadedSavedPosition });
    // Don't save during initial load
    if (!hasLoadedSavedPosition) return;

    // Instant save to localStorage (cache)
    try {
      if (typeof currentLocation === 'string') {
        epubPositions.setPosition(documentId, currentLocation);
        console.log('📖 EPUB: Saved CFI to localStorage cache:', currentLocation);
      } else if (typeof currentLocation === 'number') {
        epubPositions.setPosition(documentId, '', currentLocation);
        console.log('📖 EPUB: Saved section index to localStorage cache:', currentLocation);
      }
    } catch (error) {
      console.warn('📖 EPUB: Failed to save to localStorage:', error);
    }

    // Clear previous timeout
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }

    // Debounce API save by 2 seconds
    saveTimeoutRef.current = setTimeout(async () => {
      // Skip if another save request is already in progress (race condition prevention)
      if (isSavingRef.current) {
        console.log('📖 EPUB: Save already in progress, skipping duplicate request');
        return;
      }

      try {
        isSavingRef.current = true;
        console.log('📖 EPUB: Saving position to backend...');

        // Backend API: Use epub_cfi for EPUB CFI string
        const payload: {
          page_number: number;
          epub_cfi?: string;
        } = {
          page_number: typeof currentLocation === 'number' ? currentLocation : 0,
          epub_cfi: typeof currentLocation === 'string' ? currentLocation : undefined,
        };

        await saveReadingPosition(documentId, payload);
        console.log('📖 EPUB: Saved to backend:', payload);
      } catch (error) {
        console.warn('📖 EPUB: Failed to save to backend:', error);
      } finally {
        isSavingRef.current = false;
      }
    }, 2000);

    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
    };
  }, [documentId, currentLocation, isOpen, hasLoadedSavedPosition]);

  // Update ref when location changes
  useEffect(() => {
    currentLocationRef.current = currentLocation;
  }, [currentLocation]);

  // Custom close handler with immediate position save (backend + localStorage)
  const handleCloseWithSave = useCallback(() => {
    if (documentId && currentLocationRef.current) {
      // Cancel any pending debounced save
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
        saveTimeoutRef.current = null;
      }

      const location = currentLocationRef.current;

      // Instant save to localStorage
      try {
        if (typeof location === 'string') {
          epubPositions.setPosition(documentId, location);
          console.log('📖 EPUB: Saved CFI on close (localStorage):', location);
        } else if (typeof location === 'number') {
          epubPositions.setPosition(documentId, '', location);
          console.log('📖 EPUB: Saved section index on close (localStorage):', location);
        }
      } catch (error) {
        console.warn('📖 EPUB: Failed to save to localStorage on close:', error);
      }

      // Immediate backend save (skip if already saving)
      if (!isSavingRef.current) {
        const payload: {
          page_number: number;
          epub_cfi?: string;
        } = {
          page_number: typeof location === 'number' ? location : 0,
          epub_cfi: typeof location === 'string' ? location : undefined,
        };

        isSavingRef.current = true;
        saveReadingPosition(documentId, payload)
          .then(() => {
            console.log('📖 EPUB: Saved to backend on close:', payload);
          })
          .catch((error) => {
            console.warn('📖 EPUB: Failed to save to backend on close:', error);
          })
          .finally(() => {
            isSavingRef.current = false;
          });
      } else {
        console.log('📖 EPUB: Save already in progress on close, skipping');
      }
    }

    // Reset state for next open
    setHasLoadedSavedPosition(false);
    setSavedPosition(null);
    setIsLoadingPosition(false);
    setPositionLoadError(false);
    setCurrentLocation(initialLocation); // Reset to initial value to prevent stale position
    positionLoadStartedRef.current = false; // Allow position loading on next open

    // Close the drawer
    onClose();
  }, [documentId, onClose, initialLocation]);

  // Always-fresh ref to handleCloseWithSave so the history/keydown effect
  // below doesn't have to depend on it. Depending on it caused the effect
  // to tear down + remount every time the callback rebuilt (e.g. when
  // parent <GlobalEpubViewer> rerendered with a new `onClose` reference),
  // and the cleanup branch fires `history.back()` which then triggered
  // the drawer's own popstate handler and closed the viewer milliseconds
  // after open. The effect now keys only on `isOpen`.
  const handleCloseWithSaveRef = useRef(handleCloseWithSave);
  handleCloseWithSaveRef.current = handleCloseWithSave;

  // Escape (desktop) + mobile back gesture close the viewer.
  // Push a synthetic history entry on open so Android back / iOS swipe-back
  // pops it instead of leaving the app.
  useEffect(() => {
    if (!isOpen) return;

    let closedViaHistory = false;
    window.history.pushState({ epubViewer: true }, '');

    const onPopState = () => {
      closedViaHistory = true;
      handleCloseWithSaveRef.current();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (document.querySelector('[data-radix-popper-content-wrapper], [data-state="open"][role="dialog"], [data-state="open"][role="menu"], [data-state="open"][role="listbox"]')) {
        return;
      }
      e.preventDefault();
      handleCloseWithSaveRef.current();
    };

    window.addEventListener('popstate', onPopState);
    window.addEventListener('keydown', onKeyDown);

    // epub.js renders book content inside iframes. Keydown events fired
    // there never bubble to the parent window — attach the same Escape
    // handler to each iframe's contentDocument so Esc works while the
    // reader has focus. A MutationObserver picks up iframes added after
    // initial render (pagination, section navigation).
    const drawer = document.querySelector('[data-testid="epub-viewer-drawer"]');
    const iframeListeners = new Map<HTMLIFrameElement, (e: KeyboardEvent) => void>();

    const attachToIframe = (iframe: HTMLIFrameElement) => {
      if (iframeListeners.has(iframe)) return;
      const handler = (e: KeyboardEvent) => {
        if (e.key !== 'Escape') return;
        if (document.querySelector('[data-radix-popper-content-wrapper], [data-state="open"][role="dialog"], [data-state="open"][role="menu"], [data-state="open"][role="listbox"]')) {
          return;
        }
        e.preventDefault();
        handleCloseWithSave();
      };
      const tryAttach = () => {
        try {
          const doc = iframe.contentDocument;
          if (!doc) return false;
          doc.addEventListener('keydown', handler);
          iframeListeners.set(iframe, handler);
          return true;
        } catch {
          return false;
        }
      };
      if (!tryAttach()) {
        iframe.addEventListener('load', () => { tryAttach(); }, { once: true });
      }
    };

    let observer: MutationObserver | null = null;
    if (drawer) {
      drawer.querySelectorAll('iframe').forEach(attachToIframe);
      observer = new MutationObserver((mutations) => {
        for (const m of mutations) {
          for (const node of m.addedNodes) {
            if (node instanceof HTMLIFrameElement) {
              attachToIframe(node);
            } else if (node instanceof HTMLElement) {
              node.querySelectorAll('iframe').forEach(attachToIframe);
            }
          }
        }
      });
      observer.observe(drawer, { childList: true, subtree: true });
    }

    return () => {
      window.removeEventListener('popstate', onPopState);
      window.removeEventListener('keydown', onKeyDown);
      observer?.disconnect();
      iframeListeners.forEach((listener, iframe) => {
        try { iframe.contentDocument?.removeEventListener('keydown', listener); } catch { /* noop */ }
      });
      iframeListeners.clear();
      if (!closedViaHistory && window.history.state?.epubViewer) {
        window.history.back();
      }
    };
    // Only `isOpen` — see handleCloseWithSaveRef above. Adding the
    // callback to deps would tear this effect down on every parent
    // rerender and pop our own history entry, closing the viewer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  // Toggle viewer width between 50% and 100%
  const toggleWidth = () => {
    setViewerWidth(prev => (prev === '50' ? '100' : '50'));
  };

  // Resize epub.js rendition when drawer width changes
  useEffect(() => {
    if (!isOpen || !renditionRef.current) return;

    // Wait for CSS transition to complete (300ms as defined in drawer transition)
    const resizeTimeout = setTimeout(() => {
      if (renditionRef.current) {
        // Get the container dimensions from the manager
        // @ts-expect-error - epub.js manager property is not in public type definitions
        const manager = renditionRef.current.manager;
        if (manager?.container) {
          const width = manager.container.clientWidth;
          const height = manager.container.clientHeight;
          console.log('📐 EPUB: Resizing rendition for new width:', viewerWidth, `(${width}x${height})`);
          renditionRef.current.resize(width, height);
        }
      }
    }, 350); // Slightly longer than the 300ms transition

    return () => clearTimeout(resizeTimeout);
  }, [viewerWidth, isOpen]);

  // Use passed document title or extract from URL as fallback
  useEffect(() => {
    if (propDocumentTitle) {
      // Use the passed document title, removing file extension if present
      const cleanTitle = propDocumentTitle.replace(/\.(epub|mobi)$/i, '');
      setDocumentTitle(cleanTitle);
    } else if (epubUrl) {
      // Fallback: try to extract from URL (won't work for /documents/{id}/file URLs)
      const urlParts = epubUrl.split('/');
      const filename = urlParts[urlParts.length - 1];
      const title = decodeURIComponent(filename).replace(/\.(epub|mobi)$/i, '');
      setDocumentTitle(title || t('epubViewer.documentViewer', 'ePub Viewer'));
    }
  }, [propDocumentTitle, epubUrl, t]);

  // Note: initialLocation is set via useState(initialLocation) on mount
  // User navigation updates via handleLocationChange
  // Saved position loads via separate useEffect
  // No need to sync with initialLocation prop changes (prevents position resets)

  // Create TTS overlay with floating controls
  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TTS overlay is a global singleton attached to window
    (window as any).ttsOverlay = createTtsOverlay({
      containerStyle: `
        position: absolute;
        bottom: 20px;
        left: 50%;
        transform: translateX(-50%);
        z-index: 1800;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 8px;
        transition: opacity 0.3s ease;
        pointer-events: auto !important;
      `,
      prevLabel: 'Previous section',
      nextLabel: 'Next section',
    });

    return () => {
      if (// eslint-disable-next-line @typescript-eslint/no-explicit-any -- TTS overlay is a global singleton attached to window
    (window as any).ttsOverlay) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TTS overlay is a global singleton attached to window
    (window as any).ttsOverlay.remove();
      }
    };
  }, []);

  // Set up TTS overlay callbacks
  useEffect(() => {
    if (isSpeaking && // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TTS overlay is a global singleton attached to window
    (window as any).ttsOverlay) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TTS overlay is a global singleton attached to window
    (window as any).ttsOverlay.setCallbacks({
        onPrev: speakPrevBlock,
        onStop: stopTTS,
        onNext: speakNextBlock,
        onSpeedDecrease: () => {
          const newRate = Math.max(0.5, speechRate - 0.25);
          updateSpeechRate(newRate);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TTS overlay is a global singleton attached to window
    (window as any).ttsOverlay?.updateSpeed(newRate, theme === 'dark');
        },
        onSpeedIncrease: () => {
          const newRate = Math.min(2.0, speechRate + 0.25);
          updateSpeechRate(newRate);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TTS overlay is a global singleton attached to window
    (window as any).ttsOverlay?.updateSpeed(newRate, theme === 'dark');
        },
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TTS overlay is a global singleton attached to window
    (window as any).ttsOverlay.updateSpeed(speechRate, theme === 'dark');
    }
  }, [isSpeaking, speakPrevBlock, stopTTS, speakNextBlock, speechRate, updateSpeechRate, theme]);

  // Cleanup TTS when drawer closes
  useEffect(() => {
    if (!isOpen) {
      cleanupTTS();
      setIsRenditionReady(false);
      hasRelocatedRef.current = false; // Reset relocated tracking

      // Clear TTS ready timeout
      if (ttsReadyTimeout) {
        clearTimeout(ttsReadyTimeout);
        setTtsReadyTimeout(null);
      }
    }
  }, [isOpen, cleanupTTS, ttsReadyTimeout]);

  if (!isOpen) return null;

  return (
    <>
      {/* Overlay for mobile/narrow screens */}
      {isNarrowScreen && (
        <div
          className="fixed inset-0 bg-black/80 backdrop-blur-sm transition-opacity duration-300"
          style={{ zIndex: 1699 }} // Just below the drawer (1700)
          onClick={handleCloseWithSave}
        />
      )}

      {/* Drawer */}
      <div
        ref={(node: HTMLDivElement | null) => {
          // @ts-expect-error -- viewerRef and fw.panelRef both want this node
          viewerRef.current = node;
          fw.panelRef(node);
        }}
        data-testid='epub-viewer-drawer'
        {...fw.focusProps}
        className={`fixed epub-viewer-drawer bg-background border-l border-border shadow-xl ${fw.isFloating ? '' : 'transition-all duration-300 ease-in-out'} ${
          isOpen && !fw.isFloating ? 'translate-x-0' : !fw.isFloating ? 'translate-x-full' : ''
        }`}
        style={{
          ...(fw.isFloating
            ? fw.floatingStyle
            : { ...position, height: isNarrowScreen ? '100vh' : 'calc(100vh - 0px)', top: isNarrowScreen ? '0' : '0' }),
          zIndex: floatingMgr.isTopFocused('epub-viewer') ? 9999 : 1700 + Math.max(0, floatingMgr.getOrder('epub-viewer')), // Above knowledge-stacks-dialog (z-1450), boosts to global top when focused
          isolation: 'isolate', // Create a new stacking context
          pointerEvents: 'auto', // Override Radix Dialog modal behavior that blocks interactions
          overflow: 'clip', // Clip the epub.js 46000px iframe at drawer boundary
          clipPath: 'inset(0)', // Force hard clip
        }}
      >
        {fw.resizeHandles}
        {/* Header */}
        <div
          {...(fw.isFloating ? fw.headerDragProps : {})}
          className={`flex items-center justify-between px-4 py-3 border-b border-border bg-muted/50 ${fw.isFloating ? fw.headerDragProps.className : ''}`}
          style={{ pointerEvents: 'auto', position: 'relative', zIndex: 1000000 }}
        >
          <div className="flex items-center gap-3 flex-1 min-w-0">
            <h2 data-testid='epub-viewer-title' className="text-sm font-semibold truncate text-foreground">
              {documentTitle}
            </h2>
          </div>

          {/* Controls */}
          <div className="flex items-center gap-2">
            {/* Text-to-speech buttons */}
            <div className="flex space-x-1 mr-2" style={{ pointerEvents: 'auto' }}>
              <TooltipProvider delayDuration={300} skipDelayDuration={200}>
                {!isSpeaking && !isPaused ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        onClick={handleSpeakText}
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        disabled={!isRenditionReady}
                      >
                        <Play size={16} className={!isRenditionReady ? "text-muted-foreground" : "text-foreground"} />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>{!isRenditionReady ? t('epubViewer.waitingForBook', 'Waiting for book to load...') : t('epubViewer.readAloud', 'Read aloud')}</p>
                    </TooltipContent>
                  </Tooltip>
                ) : null}

                {isPaused ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        onClick={handleSpeakText}
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                      >
                        <Play size={16} className="text-foreground" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>{t('epubViewer.resume', 'Resume')}</p>
                    </TooltipContent>
                  </Tooltip>
                ) : null}

                {isSpeaking || isPaused ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        onClick={handleStopText}
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                      >
                        <Square size={16} className="text-foreground" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>{t('epubViewer.stop', 'Stop')}</p>
                    </TooltipContent>
                  </Tooltip>
                ) : null}

                {/* Voice-mode trigger — hands-free chat scoped to this EPUB.
                    See PDF viewer for the same pattern. */}
                {documentId && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        data-testid='epub-viewer-voice-mode-trigger'
                        variant='ghost'
                        size='icon'
                        className='h-8 w-8'
                        aria-label={t('voiceMode.triggerLabel', 'Open voice mode')}
                        onClick={() => {
                          openVoiceWithDocument({
                            documentId,
                            documentName: documentTitle || '',
                          });
                        }}
                      >
                        <Headphones size={16} className='text-foreground' />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>{t('voiceMode.triggerLabel', 'Talk to this book')}</p>
                    </TooltipContent>
                  </Tooltip>
                )}

                {documentId && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        data-testid='epub-viewer-chat-about-button'
                        variant='ghost'
                        size='icon'
                        className='h-8 w-8'
                        aria-label={t('epubViewer.chatAbout', 'Chat with this document')}
                        onClick={() => {
                          openChatWithDocument({
                            documentId,
                            documentName: propDocumentTitle || documentTitle,
                            collectionId: epubState.collectionId || undefined,
                          });
                        }}
                      >
                        <MessageSquare size={16} className='text-foreground' />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>{t('epubViewer.chatAbout', 'Chat with this document')}</p>
                    </TooltipContent>
                  </Tooltip>
                )}

                {/* Reader settings (voice, speed, ambient) */}
                <PDFReaderSettings
                  availableVoices={availableVoices}
                  selectedVoice={selectedVoice}
                  isLoadingVoices={isLoadingVoices}
                  onVoiceChange={updateSelectedVoice}
                  speechRate={speechRate}
                  onSpeechRateChange={updateSpeechRate}
                  isInverted={isInverted}
                  onInvertChange={setIsInverted}
                  theme={theme === 'dark' ? 'dark' : 'light'}
                />
              </TooltipProvider>
            </div>

            {/* Toggle Width Button (desktop only) */}
            {!isNarrowScreen && (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      data-testid="epub-viewer-maximize-button"
                      variant="ghost"
                      size="icon"
                      onClick={toggleWidth}
                      className="h-8 w-8 hover:bg-accent transition-colors"
                    >
                      {viewerWidth === '50' ? (
                        <Maximize className="h-4 w-4" />
                      ) : (
                        <Minimize className="h-4 w-4" />
                      )}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    <p className="text-xs">
                      {viewerWidth === '50'
                        ? t('epubViewer.expandWidth', 'Expand width')
                        : t('epubViewer.reduceWidth', 'Reduce width')}
                    </p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}

            {!isNarrowScreen && (
              <WindowPinMenu
                mode={fw.isFloating ? 'floating' : (isOnLeft ? 'pinned-left' : 'pinned-right')}
                onSetMode={(m: WindowMode) => {
                  fw.setMode(m);
                  if (m === 'pinned-left' || m === 'pinned-right') {
                    epubDispatch({ type: 'SET_EPUB_POSITION', payload: { isOnLeft: m === 'pinned-left' } });
                  }
                }}
                showFloating={true}
                showMaximize={false}
                testId="epub-viewer-pin-menu"
                className="h-8 w-8"
              />
            )}

            {/* Close button — always visible (also on md/lg). Mobile already
                had `handleCloseWithSave` wired to the overlay backdrop, but
                desktop had no surface to dismiss the viewer except Esc /
                back-gesture. */}
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    data-testid='epub-viewer-close-button'
                    variant="ghost"
                    size="icon"
                    onClick={handleCloseWithSave}
                    onMouseDown={(e) => e.preventDefault()}
                    className="h-8 w-8 hover:bg-accent transition-colors"
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  <p className="text-xs">{t('common.close', 'Close')}</p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>

          </div>
        </div>

        {/* ePub Viewer Content */}
        <div
          className="h-[calc(100%-57px)]"
          style={{
            width: '100%',
            maxWidth: '100%',
            pointerEvents: 'auto',
            touchAction: 'pan-x pan-y pinch-zoom',
            position: 'relative',
            overflow: 'hidden',
          }}
        >
          {/* Clipping wrapper - forces all children to be clipped regardless of their position */}
          <style>{`
            .epub-viewer-drawer iframe {
              position: absolute !important;
            }
          `}</style>
          {epubUrl && (
            <EpubViewer
              key={epubUrl} // Stable key prevents unmount on prop changes
              url={epubUrl}
              initialLocation={currentLocation}
              onLocationChange={handleLocationChange}
              renditionRef={renditionRef}
              userNavRef={userNavRef}
              isInverted={isInverted}
              onRenditionReady={async () => {
                console.log('🎉 EPUB DRAWER: Received rendition ready signal');

                // Wait for relocated event to fire at least once
                // This ensures currentLocation() is available before enabling TTS
                let attempts = 0;
                const maxAttempts = 20; // 2 seconds max
                while (!hasRelocatedRef.current && attempts < maxAttempts) {
                  await new Promise(resolve => setTimeout(resolve, 100));
                  attempts++;
                }

                if (hasRelocatedRef.current) {
                  console.log('EPUB DRAWER: relocated event fired, enabling TTS after', attempts * 100, 'ms');
                } else {
                  console.warn('⚠️ EPUB DRAWER: relocated timeout after 2s, enabling TTS anyway');
                }

                // Small additional delay to ensure currentLocation() is stable
                const timeout = setTimeout(() => {
                  console.log('EPUB DRAWER: TTS ready');
                  setIsRenditionReady(true);
                }, 200); // 200ms additional stability delay

                setTtsReadyTimeout(timeout);
              }}
            />
          )}
          {/* EPUB Annotation Layer */}
          {documentId && (
            <EpubAnnotationLayer
              annotations={annotations}
              activeTool={activeTool}
              activeColor={activeColor}
              onActiveToolChange={setActiveTool}
              onCreateAnnotation={async (text, position, pageLabel, color, comment, toolOverride) => {
                await createHighlight(text, position, pageLabel, color, comment, toolOverride);
              }}
              onDeleteAnnotation={removeAnnotation}
              onUpdateComment={updateComment}
              rendition={isRenditionReady ? renditionRef.current : null}
              documentId={documentId}
              documentTitle={documentTitle}
            />
          )}
        </div>
      </div>
    </>
  );
};

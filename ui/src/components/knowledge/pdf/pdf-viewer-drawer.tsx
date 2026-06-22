import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createTtsOverlay } from '@/lib/tts-overlay';
import {
  Maximize,
  Minimize,
  MessageSquare,
  Play,
  Square,
  FileText,
  Headphones,
} from 'lucide-react';
import { WindowPinMenu } from '@/components/ui/window-pin-menu';
import { useFloatingWindowManager } from '@/contexts/floating-window-context';
import { useFloatingWindow } from '@/hooks/use-floating-window';
import { makeFloatingWindowStorage } from '@/lib/floating-window-storage';
import type { WindowMode } from '@/types/floating-window';
import { openChatWithDocument } from '@/lib/chat-with-document';
import { openVoiceWithDocument } from '@/lib/voice-with-document';
import { AnimatedTitle } from '@/components/ui/animated-title';
import { Button } from '@/components/ui/button.tsx';
import { PDFViewer } from './pdf-viewer.tsx';
import { useEdgeTTS } from './pdf-viewer-tts-edge.tsx';
import { PDFReaderSettings } from './pdf-reader-settings.tsx';
import { useIsNarrowScreen } from '@/hooks/use-mobile.tsx';
import { useSidebar } from '@/contexts/sidebar-context.tsx';
import { useTheme } from '@/providers/theme-provider';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { usePDFViewer } from '@/contexts/pdf-viewer-context';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select.tsx';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip.tsx';
import { pdfPositions, userPrefs } from '@/lib/storage-utils';
import { getReadingPosition, saveReadingPosition, getDocumentById } from '@/lib/api-documents';

import { PdfAnnotationLayer } from '@/components/annotations/pdf-annotation-layer';
import { AnnotationCommentSearch } from '@/components/annotations/annotation-comment-search';
import { PdfDocumentNotes } from './pdf-document-notes';
const PdfMultimodalPanel = (_props: any) => null;  // (CE) multimodal panel is hosted-only
import { useAnnotations } from '@/hooks/use-annotations';
import { useResolvedCollectionId } from '@/hooks/use-resolved-collection-id';
import { useNotesDrawer } from '@/hooks/use-notes-drawer';
import { useDeepResearchPanel } from '@/contexts/deep-research-context';
import { StickyNote, Image as ImageIcon, X } from 'lucide-react';

// Define the SidebarQuickTools width as a constant for consistent use
const ICON_SIDEBAR_WIDTH = 56; // w-14 = 3.5rem = 56px
const CONVERSATIONS_SIDEBAR_WIDTH = 335;

interface PDFViewerDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  pdfUrl: string;
  documentId?: string; // Document UUID for reading position tracking
  documentTitle?: string; // The actual document title/filename
  citationPage?: number;
  highlightLineStart?: number; // Deprecated: Use highlightText instead
  highlightLineEnd?: number; // Deprecated: Use highlightText instead
  highlightText?: string; // The actual citation text to highlight
  citationId?: number;
  isNotesOpen?: boolean; // Track if Notes is also open for side-by-side layout
}

export const PDFViewerDrawer = ({
  isOpen,
  onClose,
  pdfUrl,
  documentId,
  documentTitle,
  citationPage,
  highlightLineStart,
  highlightLineEnd,
  highlightText,
  citationId = -1,
  isNotesOpen = false,
}: PDFViewerDrawerProps) => {
  const { t } = useTranslation();
  const isNarrowScreen = useIsNarrowScreen(); // Below 992px (mobile + tablet) for full-screen behavior
  const { isSidebarOpen, toggleSidebar } = useSidebar();
  const { theme } = useTheme();
  const { state: pdfState, dispatch: pdfDispatch } = usePDFViewer();
  // PDF positioning: RIGHT when alone, LEFT when Notes is already open
  const [viewerWidth, setViewerWidth] = useState<string>('50');
  const [internalDocumentTitle, setInternalDocumentTitle] = useState<string>(t('pdfViewer.documentViewer'));

  // Reading position tracking
  const hasLoadedPosition = useRef(false);
  const shouldFetchPosition = useRef(false);

  // Resolve collection_id lazily when the viewer was opened from a
  // surface that doesn't have it (sidebar). See `useResolvedCollectionId`
  // for the full rationale.
  const resolvedCollectionId = useResolvedCollectionId(
    pdfState.collectionId,
    documentId,
    isOpen,
  );

  // Annotations
  const {
    annotations,
    activeTool,
    activeColor,
    setActiveTool,
    createHighlight,
    updateComment,
    removeAnnotation,
  } = useAnnotations({
    documentId: documentId || null,
    collectionId: resolvedCollectionId,
    viewerType: 'pdf',
    enabled: isOpen && !!documentId,
  });

  // Document notes sidebar
  const [showNotesPanel, setShowNotesPanel] = useState(false);
  const [showMultimodalPanel, setShowMultimodalPanel] = useState(false);
  const notesDrawer = useNotesDrawer();
  const deepResearchPanel = useDeepResearchPanel();

  // Database-fetched initial page (primary source for cross-device sync)
  const [dbInitialPage, setDbInitialPage] = useState<number | undefined>(undefined);

  // The actual initial page to use - citationPage > database > localStorage cache > 1
  // Database is primary source for cross-device sync
  const effectiveInitialPage = useMemo(() => {
    if (typeof citationPage === 'number') {
      console.log('PDF: Using citationPage:', citationPage);
      return citationPage;
    }
    if (dbInitialPage) {
      console.log('PDF: Using database page:', dbInitialPage);
      return dbInitialPage;
    }
    // Fallback to localStorage only while loading or if API fails
    if (documentId) {
      const cached = pdfPositions.getPosition(documentId);
      if (cached) {
        console.log('PDF: Fallback to cached page:', cached.pageNumber);
        return cached.pageNumber;
      }
    }
    return 1;
  }, [citationPage, dbInitialPage, documentId]);
  console.log('PDF: effectiveInitialPage:', effectiveInitialPage);

  // Use provided documentTitle prop, or fall back to internal state
  const displayTitle = documentTitle || internalDocumentTitle;
  const [wasSidebarOpen, setWasSidebarOpen] = useState(false);
  const [isInitialOpen, setIsInitialOpen] = useState(false);
  const [openedOnRight, setOpenedOnRight] = useState<boolean | null>(null);
  const [isManuallyPositioned, setIsManuallyPositioned] = useState(false); // Track manual position swaps
  const prevIsOpenRef = useRef<boolean>(false);

  const pdfStorage = useMemo(() => makeFloatingWindowStorage('pdf-viewer'), []);
  const fw = useFloatingWindow({
    id: 'pdf-viewer',
    initialMode: 'pinned-right',
    storage: pdfStorage,
    forceMaximized: isNarrowScreen,
    defaultFloatingSize: { width: 720, height: 720 },
  });
  const floatingMgr = useFloatingWindowManager();

  const effectiveOnRight = openedOnRight !== null ? openedOnRight : !isNotesOpen;
  const setPinMode = (m: WindowMode) => {
    fw.setMode(m);
    if (m === 'pinned-left' || m === 'pinned-right') {
      const onRight = m === 'pinned-right';
      setIsManuallyPositioned(true);
      setOpenedOnRight(onRight);
      pdfDispatch({ type: 'SET_PDF_POSITION', payload: { isOnLeft: !onRight } });
    }
  };

  // Refs for PDF viewer
  const viewerRef = useRef<HTMLDivElement>(null);
  const textLayerRef = useRef<Element | null>(null);

  // PDF color inversion — derived from global theme, session-local toggle only.
  // Why: persisting it as a separate user pref entangles paper color with global
  // theme and can leak stale state (e.g. paper stays inverted after theme resets).
  const [isColorInverted, setIsColorInverted] = useState(() => theme === 'dark');

  // Resync invert with theme on refresh / theme change; user toggle stays temporary.
  useEffect(() => {
    setIsColorInverted(theme === 'dark');
  }, [theme]);

  const handleInvertChange = (inverted: boolean) => {
    setIsColorInverted(inverted);
  };

  // Text-to-speech using edge-tts backend (no browser Speech Synthesis API bugs)
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
  } = useEdgeTTS(textLayerRef, theme === 'dark' ? 'dark' : 'light');

  // Helper function to calculate width value considering the SidebarQuickTools
  const calculateWidth = (widthValue: string): string => {
    // On narrow screens (< 992px), always use full width
    if (isNarrowScreen) {
      return '100%';
    }

    return widthValue === '100'
      ? `calc(100% - ${ICON_SIDEBAR_WIDTH}px)`
      : `${widthValue}%`;
  };

  // Position is now automatically determined by isNotesOpen state
  // No need to track position separately

  // Calculate the position based on sidebar state, screen size, and Notes state
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
        transform: 'translateX(0px)',
      };
    }

    // Use the captured opening position (first come, first served).
    // Deep Research panel always occupies the right 50vw — when it's open,
    // force PDF to the left regardless of the earlier captured side.
    const shouldBeOnRight = deepResearchPanel.isOpen
      ? false
      : (openedOnRight !== null ? openedOnRight : !isNotesOpen);

    if (!shouldBeOnRight && !isNarrowScreen) {
      // PDF on LEFT side
      // Account for sidebar: if open, use CONVERSATIONS_SIDEBAR_WIDTH, otherwise use ICON_SIDEBAR_WIDTH
      const sidebarWidth = isSidebarOpen ? CONVERSATIONS_SIDEBAR_WIDTH : ICON_SIDEBAR_WIDTH;
      return {
        width: `calc(50vw - ${sidebarWidth}px)`, // Half-viewport minus actual sidebar width
        left: `${sidebarWidth}px`, // LEFT side after sidebar (full or icon-only)
        right: 'auto',
        transform: 'translateX(0px)',
      };
    }

    // PDF on RIGHT side (default)
    const width = (isNotesOpen || deepResearchPanel.isOpen) ? 'calc(50vw)' : calculateWidth(viewerWidth);
    return {
      width,
      right: '0',
      left: 'auto',
      transform: isSidebarOpen
        ? `translateX(-${CONVERSATIONS_SIDEBAR_WIDTH - ICON_SIDEBAR_WIDTH}px)`
        : 'translateX(0px)',
    };
  };

  // Create a global TTS overlay with controls to avoid React re-renders
  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TTS overlay global singleton
    const overlay = createTtsOverlay({
      containerStyle: `
        position: fixed;
        bottom: 20px;
        left: 50%;
        transform: translateX(-50%);
        z-index: 999999;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 8px;
        transition: opacity 0.3s ease, left 0.3s ease;
        pointer-events: auto !important;
      `,
      prevLabel: 'Previous page',
      nextLabel: 'Next page',
    });
    // PDF-specific: re-centre overlay on the PDF viewport element
    (overlay as any).updatePosition = function(pdfViewerRect: DOMRect) {
      if (!this.container) return;
      const pdfCenterX = pdfViewerRect.left + pdfViewerRect.width / 2;
      this.container.style.left = `${pdfCenterX}px`;
      this.container.style.transform = 'translateX(-50%)';
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TTS overlay global singleton
    (window as any).ttsOverlay = overlay;

    // Add TTS highlight CSS and PDF inversion styles
    const styleId = 'tts-highlight-styles';
    if (!document.getElementById(styleId)) {
      const style = document.createElement('style');
      style.id = styleId;
      style.textContent = `
        .tts-highlight {
          background-color: rgba(37, 99, 235, 0.55) !important;
          border-radius: 3px;
          transition: background-color 0.2s ease;
          box-shadow: 0 1px 3px rgba(37, 99, 235, 0.3);
        }
        .dark .tts-highlight,
        [data-theme="dark"] .tts-highlight {
          background-color: rgba(59, 130, 246, 0.6) !important;
          box-shadow: 0 1px 3px rgba(59, 130, 246, 0.4);
        }
        /* PDF color inversion - only invert the actual page content, not the container */
        .pdf-inverted .rpv-core__canvas-layer canvas,
        .pdf-inverted .rpv-core__text-layer,
        .pdf-inverted .rpv-core__annotation-layer {
          filter: invert(1) hue-rotate(180deg);
        }
        /* Keep the container background dark */
        .pdf-inverted .rpv-core__inner-pages,
        .pdf-inverted .rpv-core__viewer {
          background-color: #1a1a1a !important;
        }
        /* Page wrapper should also stay dark */
        .pdf-inverted .rpv-core__page-layer {
          background-color: transparent !important;
        }
      `;
      document.head.appendChild(style);
    }

    // Cleanup on unmounting
    return () => {
      if (// eslint-disable-next-line @typescript-eslint/no-explicit-any -- TTS overlay global singleton
    (window as any).ttsOverlay) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TTS overlay global singleton
    (window as any).ttsOverlay.remove();
      }
      const existingStyle = document.getElementById(styleId);
      if (existingStyle) {
        existingStyle.remove();
      }
    };
  }, []);

  // Set up TTS overlay callbacks when speaking state changes
  useEffect(() => {
    if (isSpeaking && // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TTS overlay global singleton
    (window as any).ttsOverlay) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TTS overlay global singleton
    (window as any).ttsOverlay.setCallbacks({
        onPrev: speakPrevBlock,
        onStop: stopTTS,
        onNext: speakNextBlock,
        onSpeedDecrease: () => {
          const newRate = Math.max(0.5, speechRate - 0.25);
          updateSpeechRate(newRate);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TTS overlay global singleton
    (window as any).ttsOverlay?.updateSpeed(newRate, theme === 'dark');
        },
        onSpeedIncrease: () => {
          const newRate = Math.min(2.0, speechRate + 0.25);
          updateSpeechRate(newRate);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TTS overlay global singleton
    (window as any).ttsOverlay?.updateSpeed(newRate, theme === 'dark');
        },
      });
      // Update initial speed display
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TTS overlay global singleton
    (window as any).ttsOverlay.updateSpeed(speechRate, theme === 'dark');
    }
  }, [isSpeaking, speakPrevBlock, stopTTS, speakNextBlock, speechRate, updateSpeechRate, theme]);

  // Clean up TTS when PDF changes or drawer closes
  useEffect(() => {
    if (!isOpen) {
      cleanupTTS();
    }
    return () => {
      cleanupTTS();
    };
  }, [isOpen, pdfUrl, cleanupTTS]);

  // Handle TTS start - find the most visible page and start reading
  const handleSpeakText = () => {
    if (isPaused) {
      togglePause();
      return;
    }
    if (isSpeaking) {
      stopTTS();
      return;
    }
    // Find the most visible page index using data-page-number attribute
    const pageContainers = document.querySelectorAll('.rpv-core__page-layer');
    if (!pageContainers || pageContainers.length === 0) return;

    let mostVisiblePageIndex = 0;
    let mostVisibleDomIndex = 0;
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
        mostVisibleDomIndex = domIndex;
        // Try to use data-page-number attribute (1-indexed) and convert to 0-indexed
        const pageNum = page.getAttribute('data-page-number');
        if (pageNum) {
          mostVisiblePageIndex = parseInt(pageNum, 10) - 1;
        } else {
          // Fallback: use DOM index if data-page-number not available
          mostVisiblePageIndex = domIndex;
        }
      }
    });

    if (maxVisibility < 0.3) return;

    console.log(`🎤 TTS: Starting from most visible page (index: ${mostVisiblePageIndex})`);

    // Start TTS from the most visible page (0-indexed)
    startTTS(mostVisiblePageIndex);
  };

  const handleStopText = () => {
    stopTTS();
  };

  // Set up default widths based on screen size
  useEffect(() => {
    function setupResponsiveWidth() {
      // Get screen width to determine default width
      const screenWidth = window.innerWidth;
      let width: string;

      if (screenWidth < 768) {
        // Mobile
        width = '100';
      } else if (screenWidth < 1280) {
        // Medium screens
        width = '45';
      } else {
        // Large screens
        width = '50';
      }

      setViewerWidth(width);

      // Apply the calculated width to a CSS variable
      document.documentElement.style.setProperty(
        '--pdf-viewer-width',
        calculateWidth(width)
      );
    }

    if (isOpen) {
      setupResponsiveWidth();
      window.addEventListener('resize', setupResponsiveWidth);
    }

    return () => {
      window.removeEventListener('resize', setupResponsiveWidth);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are intentionally limited
  }, [isOpen]);

  // Handle initial open animation flag and capture opening position
  useEffect(() => {
    const wasOpen = prevIsOpenRef.current;
    const justOpened = !wasOpen && isOpen;

    if (justOpened) {
      // Drawer just opened - capture position and trigger animation
      // If manually positioned, keep the previous position; otherwise use default logic
      if (!isManuallyPositioned) {
        const opensOnRight = !isNotesOpen; // If Notes not open, we get right side
        setOpenedOnRight(opensOnRight);
        // Update global context with position
        pdfDispatch({ type: 'SET_PDF_POSITION', payload: { isOnLeft: !opensOnRight } });
      }
      setIsInitialOpen(true);

      // Remove animation class after animation completes
      const timer = setTimeout(() => {
        setIsInitialOpen(false);
      }, 500); // Match animation duration

      prevIsOpenRef.current = true;
      return () => clearTimeout(timer);
    } else if (!isOpen && wasOpen) {
      // Drawer just closed - reset for next open
      setOpenedOnRight(null);
      setIsManuallyPositioned(false); // Reset manual positioning flag
      prevIsOpenRef.current = false;
    } else if (isOpen && !isNotesOpen && openedOnRight === false && !isManuallyPositioned) {
      // Drawer is open and alone (was on left, now should move to right)
      // BUT only if it wasn't manually positioned by the user
      setOpenedOnRight(true);
      // Update global context with position
      pdfDispatch({ type: 'SET_PDF_POSITION', payload: { isOnLeft: false } });
    }
    // If isOpen hasn't changed, do nothing (prevents re-animation when isNotesOpen changes)
  }, [isOpen, isNotesOpen, openedOnRight, isManuallyPositioned, pdfDispatch]);

  // Manage sidebar state when the PDF viewer opens/closes
  useEffect(() => {
    if (isOpen) {
      // Remember the sidebar state before closing it
      setWasSidebarOpen(isSidebarOpen);

      // Automatically close the sidebar when the PDF viewer opens
      if (isSidebarOpen) {
        toggleSidebar();
      }
    } else if (wasSidebarOpen && !isSidebarOpen) {
      // Restore sidebar when PDF viewer closes (if it was open before)
      toggleSidebar();
    }
  }, [isOpen, isSidebarOpen, toggleSidebar, wasSidebarOpen]);


  // Track current page for saving - use ref to avoid re-render issues
  const currentPageRef = useRef<number>(1);
  const totalPagesRef = useRef<number | undefined>(undefined);
  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const isInitializingRef = useRef<boolean>(false);

  // Auto @-mention the opened PDF in the chat input. The chat-toolbar's
  // useChatMentions hook already listens for `scrapalot:chat-with-document`
  // and dedup's incoming mentions, so firing once per document open is safe
  // even if the user already had this book chipped in. Fires only when both
  // documentId and a usable title are available — name "document" would
  // look broken in the chip.
  const lastAutoMentionedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!isOpen || !documentId) {
      lastAutoMentionedRef.current = null;
      return;
    }
    const name = documentTitle || internalDocumentTitle;
    if (!name) return;
    if (lastAutoMentionedRef.current === documentId) return;
    lastAutoMentionedRef.current = documentId;
    openChatWithDocument({
      documentId,
      documentName: name,
      collectionId: pdfState.collectionId || undefined,
      silent: true,
    });
  }, [isOpen, documentId, documentTitle, internalDocumentTitle, pdfState.collectionId]);

  // Sync reading position with API when drawer opens
  // Note: Initial position is loaded synchronously from cache in useState
  useEffect(() => {
    if (isOpen && documentId && typeof citationPage !== 'number' && !hasLoadedPosition.current) {
      hasLoadedPosition.current = true;
      shouldFetchPosition.current = true;
      // Set loading state to prevent PDFViewer from rendering with wrong page
      // Set initializing flag to prevent saving initial page load event
      isInitializingRef.current = true;
      // Clear flag after 1 second to allow normal page change saves
      setTimeout(() => {
        isInitializingRef.current = false;
        console.log('PDF: Initialization complete, page changes will now be saved');
      }, 1000);

      // Always fetch from database first for cross-device sync
      console.log('PDF: Fetching position from database...');

      // Timeout to ensure PDF loads even if API is slow (2 seconds max wait)
      const loadingTimeout = setTimeout(() => {
        if (shouldFetchPosition.current) {
          console.log('PDF: Position fetch timeout, using cached position');
          shouldFetchPosition.current = false;
          const cachedPosition = pdfPositions.getPosition(documentId);
          if (cachedPosition) {
            setDbInitialPage(cachedPosition.pageNumber);
            currentPageRef.current = cachedPosition.pageNumber;
          }
        }
      }, 2000);

      getReadingPosition(documentId)
        .then(position => {
          clearTimeout(loadingTimeout);
          if (!shouldFetchPosition.current) return; // Already timed out

          if (position) {
            console.log('PDF: Database position:', position.page_number);
            // Update database-fetched page (triggers re-render with correct page)
            setDbInitialPage(position.page_number);
            // Also update localStorage cache
            pdfPositions.setPosition(documentId, position.page_number, position.total_pages);
            currentPageRef.current = position.page_number;
            if (position.total_pages) {
              totalPagesRef.current = position.total_pages;
            }
          } else {
            // No database position - check localStorage as fallback
            const cachedPosition = pdfPositions.getPosition(documentId);
            if (cachedPosition) {
              console.log('PDF: No database position, using cache:', cachedPosition.pageNumber);
              setDbInitialPage(cachedPosition.pageNumber);
              currentPageRef.current = cachedPosition.pageNumber;
              if (cachedPosition.totalPages) {
                totalPagesRef.current = cachedPosition.totalPages;
              }
            }
          }
        })
        .catch(err => {
          clearTimeout(loadingTimeout);
          console.warn('PDF: Failed to load from database, using localStorage fallback:', err);
          // Fallback to localStorage on error
          const cachedPosition = pdfPositions.getPosition(documentId);
          if (cachedPosition) {
            setDbInitialPage(cachedPosition.pageNumber);
            currentPageRef.current = cachedPosition.pageNumber;
          }
        })
        .finally(() => {
          shouldFetchPosition.current = false;
        });
    }

    // Reset when drawer closes
    if (!isOpen) {
      hasLoadedPosition.current = false;
      shouldFetchPosition.current = false;
      // Reset dbInitialPage so we fetch fresh from database next time
      setDbInitialPage(undefined);
    }
  }, [isOpen, documentId, citationPage]);

  // Handle page change events from PDF viewer with debounced save
  // Save to localStorage immediately, debounce API call to 2 seconds
  useEffect(() => {
    const handlePageChange = (event: CustomEvent<{ pageNumber: number; totalPages?: number }>) => {
      const { pageNumber, totalPages: total } = event.detail;
      currentPageRef.current = pageNumber;
      if (total) {
        totalPagesRef.current = total;
      }

      // Skip saving during initialization to avoid overwriting cached position
      if (isInitializingRef.current) {
        console.log('PDF: Skipping save during initialization, page:', pageNumber);
        return;
      }

      if (documentId && pageNumber > 0) {
        // Save to localStorage immediately (instant cache)
        console.log('PDF: Saving position to cache:', documentId, 'page:', pageNumber);
        pdfPositions.setPosition(documentId, pageNumber, total);

        // Debounce API save to 2 seconds
        if (saveTimeoutRef.current) {
          clearTimeout(saveTimeoutRef.current);
        }
        saveTimeoutRef.current = setTimeout(() => {
          saveReadingPosition(documentId, {
            page_number: pageNumber,
            total_pages: total,
          }).catch(err => {
            console.warn('Failed to save reading position to API:', err);
          });
        }, 2000); // Save to API after 2 seconds on the same page
      }
    };

    // Listen for custom page change events from the PDF viewer
    window.addEventListener('pdfPageChange', handlePageChange as EventListener);

    return () => {
      window.removeEventListener('pdfPageChange', handlePageChange as EventListener);
      // Clear any pending save timeout
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
    };
  }, [documentId]);

  // Save position when drawer is about to close
  const handleCloseWithSave = () => {
    // Save position before closing
    if (documentId && currentPageRef.current > 0) {
      // Clear any pending debounced save
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
      // Save to localStorage immediately
      pdfPositions.setPosition(documentId, currentPageRef.current, totalPagesRef.current);
      // Fire and forget API save - don't block closing
      saveReadingPosition(documentId, {
        page_number: currentPageRef.current,
        total_pages: totalPagesRef.current,
      }).catch(err => {
        console.warn('Failed to save reading position on close:', err);
      });
    }
    onClose();
  };

  // Escape (desktop) + mobile back gesture close the viewer.
  // Push a synthetic history entry on open so Android back / iOS swipe-back
  // pops it instead of leaving the app. Track who initiated the close so the
  // cleanup branch doesn't double-pop.
  const closeRef = useRef(handleCloseWithSave);
  closeRef.current = handleCloseWithSave;
  useEffect(() => {
    if (!isOpen) return;

    let closedViaHistory = false;
    window.history.pushState({ pdfViewer: true }, '');

    const onPopState = () => {
      closedViaHistory = true;
      closeRef.current();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // If a Radix overlay (popover, dialog, dropdown) is open on top of the
      // viewer, let it handle Escape first — closing it should not also
      // dismiss the viewer underneath.
      if (document.querySelector('[data-radix-popper-content-wrapper], [data-state="open"][role="dialog"], [data-state="open"][role="menu"], [data-state="open"][role="listbox"]')) {
        return;
      }
      e.preventDefault();
      closeRef.current();
    };

    window.addEventListener('popstate', onPopState);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('popstate', onPopState);
      window.removeEventListener('keydown', onKeyDown);
      if (!closedViaHistory && window.history.state?.pdfViewer) {
        window.history.back();
      }
    };
  }, [isOpen]);

  // Handle PDF viewer setup
  useEffect(() => {
    // The body class signals "PDF occupies side space" — used by CSS to
    // collapse the chat when PDF + Notes are pinned side by side. Floating
    // PDF doesn't take side space, so we must NOT add the class then or
    // the chat ends up `display: none` while only Notes is actually
    // alongside it.
    if (isOpen && !fw.isFloating) {
      // Add class to body for styling
      document.body.classList.add('pdf-drawer-open');

      // Apply CSS variable for width
      document.documentElement.style.setProperty(
        '--pdf-viewer-width',
        calculateWidth(viewerWidth)
      );

      // Add a class to the main content for shifting
      const mainContent = document.querySelector('main');
      if (mainContent) {
        mainContent.classList.add('shift-for-pdf');
      }

      // Set a document title based on URL (only if not provided via prop).
      // The async fetch below upgrades this to the real filename whenever
      // a documentId is available — this branch only handles legacy demo
      // URLs and the placeholder shown while the fetch is in flight.
      if (!documentTitle) {
        if (pdfUrl && pdfUrl.includes('research-paper')) {
          setInternalDocumentTitle(
            'Advances in Natural Language Processing: A Comprehensive Review'
          );
        } else if (pdfUrl && pdfUrl.includes('sample-research-document')) {
          setInternalDocumentTitle('Encounters: Fictional Case Studies in Business');
        } else {
          setInternalDocumentTitle(t('pdfViewer.documentViewer'));
        }
      }

      // Citation page is available but no additional action needed here
      // Navigation to the citation page is handled by the PDF renderer
    } else {
      // Remove the class when the drawer is closed
      document.body.classList.remove('pdf-drawer-open');

      // Remove shift class from the main content
      const mainContent = document.querySelector('main');
      if (mainContent) {
        mainContent.classList.remove('shift-for-pdf');
      }
    }

    // Clean up
    return () => {
      document.body.classList.remove('pdf-drawer-open');

      // Remove shift class from the main content
      const mainContent = document.querySelector('main');
      if (mainContent) {
        mainContent.classList.remove('shift-for-pdf');
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are intentionally limited
  }, [isOpen, pdfUrl, viewerWidth, isSidebarOpen, fw.isFloating]);

  // Hydrate the header title from the documents API whenever a documentId
  // is known and the caller did not pass an explicit documentTitle. The
  // 60 s axios response cache shares this lookup with the Command Palette
  // and the sidebar Recent strip, so re-opens are instant. The .pdf
  // extension is stripped for stems long enough that the suffix is just
  // noise; very short names keep it because the extension is the only
  // useful context.
  useEffect(() => {
    if (!isOpen || !documentId || documentTitle) return;
    let cancelled = false;
    void (async () => {
      try {
        const doc = await getDocumentById(documentId);
        if (cancelled) return;
        const raw =
          (typeof doc.file_name === 'string' && doc.file_name.trim()) ||
          (typeof doc.filename === 'string' && doc.filename.trim()) ||
          (typeof doc.title === 'string' && doc.title.trim()) ||
          null;
        if (!raw) return;
        const stem = raw.length > 12 && /\.pdf$/i.test(raw) ? raw.slice(0, -4) : raw;
        setInternalDocumentTitle(stem);
      } catch {
        // Leave the placeholder title in place; not worth a toast.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isOpen, documentId, documentTitle]);

  const handleWidthChange = (value: string) => {
    setViewerWidth(value);
    document.documentElement.style.setProperty(
      '--pdf-viewer-width',
      calculateWidth(value)
    );
  };

  // Toggle full width and adjust the zoom level with CSS transform
  const toggleFullWidth = () => {
    const newWidth = viewerWidth === '100' ? '50' : '100';
    setViewerWidth(newWidth);

    document.documentElement.style.setProperty(
      '--pdf-viewer-width',
      calculateWidth(newWidth)
    );

    // The CSS class added in the useEffect will handle the zoom transforms
  };

  // Add CSS styles for PDF scaling
  useEffect(() => {
    // Create a style element
    const style = document.createElement('style');
    style.innerHTML = `
      /* Only apply zoom to the document content, not the toolbar */
      .pdf-viewer-container.full-width .rpv-core__viewer-container,
      .pdf-viewer-container.full-width .rpv-core__pages-container {
        transform: scale(1.5);
        transform-origin: top center;
      }
      /* Ensure toolbar remains at normal size */
      .pdf-viewer-container.full-width .rpv-default-layout__toolbar {
        transform: none;
      }
    `;
    document.head.appendChild(style);

    // Apply class to container based on width
    if (viewerRef.current) {
      if (viewerWidth === '100') {
        viewerRef.current.classList.add('full-width');
      } else {
        viewerRef.current.classList.remove('full-width');
      }
    }

    return () => {
      // Safely remove the style element if it still exists
      if (style && style.parentNode === document.head) {
        document.head.removeChild(style);
      }
    };
  }, [viewerWidth]);

  if (!isOpen) return null;

  return (
    <div
      ref={fw.panelRef}
      data-testid='pdf-viewer-drawer'
      {...fw.focusProps}
      className={`fixed pdf-viewer-drawer ${isNarrowScreen || fw.isMaximized
        ? 'inset-0'
        : fw.isFloating
          ? '' // Floating mode uses inline left/top from hook
          : isInitialOpen
            ? (openedOnRight !== null ? !openedOnRight : isNotesOpen)
              ? 'top-0 bottom-0 animate-slide-in-from-left'
              : 'top-0 bottom-0 animate-slide-in-from-right'
            : 'top-0 bottom-0'
        } bg-background/100 ${isInitialOpen && !fw.isFloating ? 'transition-all duration-500 ease-in-out' : ''} ${theme}-theme`}
      style={{
        ...(fw.isFloating ? fw.floatingStyle : (fw.isMaximized ? {} : calculatePosition())),
        zIndex: floatingMgr.isTopFocused('pdf-viewer') ? 9999 : 1700 + Math.max(0, floatingMgr.getOrder('pdf-viewer')), // Above knowledge-stacks-dialog (z-1450), boosts to global top when focused
        isolation: 'isolate', // Create a new stacking context
        pointerEvents: 'auto', // Override Radix Dialog modal behavior that blocks interactions
        borderLeft: !isNarrowScreen && (openedOnRight !== null ? openedOnRight : !isNotesOpen)
          ? `1px solid ${theme === 'light' ? 'var(--pdf-light-border)' : 'var(--pdf-dark-border)'}`
          : 'none', // Left border when on RIGHT
        borderRight: !isNarrowScreen && (openedOnRight !== null ? !openedOnRight : isNotesOpen)
          ? `1px solid ${theme === 'light' ? 'var(--pdf-light-border)' : 'var(--pdf-dark-border)'}`
          : 'none', // Right border when on LEFT
        backgroundColor:
          theme === 'light'
            ? 'var(--pdf-light-background)'
            : 'var(--pdf-dark-background)',
        transition: isInitialOpen ? undefined : 'none', // Explicitly no transitions after initial open
      }}
    >
      {fw.resizeHandles}
      <div className='h-full flex flex-col' style={{ pointerEvents: 'auto' }}>
        <div
          {...(fw.isFloating ? fw.headerDragProps : {})}
          className={cn(
            "flex items-center justify-between h-14 px-4 border-b border-border bg-background/95 backdrop-blur-sm relative z-10",
            fw.isFloating && fw.headerDragProps.className,
          )}
          style={{ pointerEvents: 'auto' }}
        >
          <div className="flex items-center gap-3 min-w-0 flex-1 overflow-hidden">
            <div className="w-8 h-8 flex items-center justify-center flex-shrink-0">
              <FileText className="h-4 w-4 text-foreground" />
            </div>
            <div data-testid='pdf-viewer-title' className="min-w-0 flex-1 overflow-hidden">
              <AnimatedTitle
                title={displayTitle}
                className="font-semibold text-sm text-foreground text-left"
                maxAnimations={3}
                animationDuration={2500}
                pauseDuration={800}
              />
            </div>
          </div>
          <div className='flex items-center gap-2 relative z-20 flex-shrink-0'>
            {/* Text-to-speech buttons */}
            <div className='flex space-x-1 mr-2 relative z-20' style={{ pointerEvents: 'auto' }}>
              <TooltipProvider delayDuration={300} skipDelayDuration={200}>
                {!isSpeaking && !isPaused ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        onClick={handleSpeakText}
                        variant='ghost'
                        size='icon'
                        className='h-8 w-8'
                      >
                        <Play size={16} className='text-foreground' />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>Read aloud</p>
                    </TooltipContent>
                  </Tooltip>
                ) : null}

                {isPaused ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        onClick={handleSpeakText}
                        variant='ghost'
                        size='icon'
                        className='h-8 w-8'
                      >
                        <Play size={16} className='text-foreground' />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>Resume</p>
                    </TooltipContent>
                  </Tooltip>
                ) : null}

                {isSpeaking || isPaused ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        onClick={handleStopText}
                        variant='ghost'
                        size='icon'
                        className='h-8 w-8'
                      >
                        <Square size={16} className='text-foreground' />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>Stop</p>
                    </TooltipContent>
                  </Tooltip>
                ) : null}

                {/* Voice-mode trigger — opens the hands-free conversation
                    dialog scoped to this single PDF. Different from the TTS
                    Play button above: TTS reads the document out loud,
                    voice mode lets the user TALK TO the document via
                    grep/cat tools. */}
                {documentId && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        data-testid='pdf-viewer-voice-mode-trigger'
                        variant='ghost'
                        size='icon'
                        className='h-8 w-8'
                        aria-label={t('voiceMode.triggerLabel', 'Open voice mode')}
                        onClick={() => {
                          openVoiceWithDocument({
                            documentId,
                            documentName: documentTitle || internalDocumentTitle || '',
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
                        data-testid='pdf-viewer-chat-about-button'
                        variant='ghost'
                        size='icon'
                        className='h-8 w-8'
                        aria-label={t('pdfViewer.chatAbout', 'Chat with this document')}
                        onClick={() => {
                          openChatWithDocument({
                            documentId,
                            documentName: documentTitle || internalDocumentTitle,
                            collectionId: pdfState.collectionId || undefined,
                          });
                        }}
                      >
                        <MessageSquare size={16} className='text-foreground' />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>{t('pdfViewer.chatAbout', 'Chat with this document')}</p>
                    </TooltipContent>
                  </Tooltip>
                )}

                {/* Reader settings (voice, speed, inversion, ambient, and additional actions) */}
                <PDFReaderSettings
                  availableVoices={availableVoices}
                  selectedVoice={selectedVoice}
                  isLoadingVoices={isLoadingVoices}
                  onVoiceChange={updateSelectedVoice}
                  speechRate={speechRate}
                  onSpeechRateChange={updateSpeechRate}
                  isInverted={isColorInverted}
                  onInvertChange={handleInvertChange}
                  theme={theme === 'dark' ? 'dark' : 'light'}
                  showNotesPanel={showNotesPanel}
                  onToggleNotes={() => setShowNotesPanel(prev => !prev)}
                  showMultimodalPanel={showMultimodalPanel}
                  onToggleMultimodal={() => setShowMultimodalPanel(prev => !prev)}
                  documentId={documentId}
                />
              </TooltipProvider>
            </div>


            {!isNarrowScreen && (
              <WindowPinMenu
                mode={fw.isFloating ? 'floating' : (effectiveOnRight ? 'pinned-right' : 'pinned-left')}
                onSetMode={setPinMode}
                showFloating={true}
                showMaximize={false}
                testId="pdf-viewer-pin-menu"
                className="h-8 w-8"
              />
            )}

            {!isNarrowScreen && (
              <>
                <Select value={viewerWidth} onValueChange={handleWidthChange}>
                  <SelectTrigger data-testid="pdf-viewer-width-selector" className='w-[80px]'>
                    <SelectValue placeholder={t('pdfViewer.width')} />
                  </SelectTrigger>
                  <SelectContent className='z-[1600]'>
                    <SelectItem value='30'>30%</SelectItem>
                    <SelectItem value='40'>40%</SelectItem>
                    <SelectItem value='50'>50%</SelectItem>
                    <SelectItem value='60'>60%</SelectItem>
                    <SelectItem value='75'>75%</SelectItem>
                    <SelectItem value='100'>100%</SelectItem>
                  </SelectContent>
                </Select>
                <Button
                  data-testid="pdf-viewer-maximize-button"
                  variant='ghost'
                  size='icon'
                  onClick={toggleFullWidth}
                  title={viewerWidth === '100' ? t('pdfViewer.restore') : t('pdfViewer.maximize')}
                  className='text-foreground'
                >
                  {viewerWidth === '100' ? (
                    <Minimize className='h-4 w-4' />
                  ) : (
                    <Maximize className='h-4 w-4' />
                  )}
                </Button>
              </>
            )}
            {/* Document notes toggle - now in settings dropdown */}
            {/* Visual entities (multimodal elements) toggle - now in settings dropdown */}
            {/* Annotation comment search - now in settings dropdown */}
            <div className="hidden">
              <AnnotationCommentSearch documentId={documentId} />
            </div>

            {/* Close button — always visible (also on md/lg). */}
            <Button
              data-testid='pdf-viewer-close-button'
              variant='ghost'
              size='icon'
              onClick={handleCloseWithSave}
              onMouseDown={(e) => e.preventDefault()}
              className='h-8 w-8 hover:bg-accent transition-colors'
              title={t('common.close', 'Close')}
            >
              <X className='h-4 w-4' />
            </Button>
          </div>
        </div>
        <div className="flex-1 flex overflow-hidden">
        <div
          className={`flex-1 overflow-hidden pdf-viewer-container ${isColorInverted ? 'pdf-inverted' : ''}`}
          ref={viewerRef}
          style={{
            pointerEvents: 'auto',
            touchAction: 'pan-x pan-y pinch-zoom', // Enable touch scrolling and zooming
            position: 'relative',
          }}
        >
          {pdfUrl && (
            <PDFViewer
              url={pdfUrl}
              initialPage={effectiveInitialPage}
              highlightLineStart={highlightLineStart}
              highlightLineEnd={highlightLineEnd}
              highlightText={highlightText}
              annotationHighlights={annotations.flatMap(ann => {
                try {
                  const pos = JSON.parse(ann.position_json);
                  if (pos?.type !== 'pdf' || !pos.rects) return [];
                  return pos.rects
                    .filter((r: { width: number }) => r.width > 1.5)
                    .map((r: { pageIndex: number; top: number; left: number; width: number; height: number }) => ({
                      id: ann.id,
                      pageIndex: pos.page_index,
                      left: r.left,
                      top: r.top,
                      width: r.width,
                      height: r.height,
                      color: ann.color,
                      annotationType: ann.annotation_type,
                    }));
                } catch { return []; }
              })}
              key={`pdf-viewer-${documentId || pdfUrl?.split('/').pop() || 'unknown'
                }-hl-${highlightLineStart || 0}-${highlightLineEnd || 0
                }-txt-${highlightText ? highlightText.substring(0, 20) : 'none'
                }-cid-${citationId}`}
            />
          )}
          {/* Annotation layer — captures selection and renders persistent highlights */}
          {documentId && (
            <PdfAnnotationLayer
              annotations={annotations}
              activeTool={activeTool}
              activeColor={activeColor}
              onActiveToolChange={setActiveTool}
              onCreateAnnotation={async (text, position, pageLabel, color, comment, toolOverride) => {
                await createHighlight(text, position, pageLabel, color, comment, toolOverride);
              }}
              onDeleteAnnotation={removeAnnotation}
              onUpdateComment={updateComment}
              onUpdateTags={async (id, tagIds) => {
                const { updateAnnotation } = await import('@/lib/api-annotations');
                await updateAnnotation(id, { tag_ids: tagIds });
              }}
              viewerContainerRef={viewerRef as React.RefObject<HTMLDivElement>}
              documentId={documentId}
              documentTitle={documentTitle}
              transientHighlight={pdfState.transientHighlight}
              onTransientHighlightExpired={() => pdfDispatch({ type: 'CLEAR_TRANSIENT_HIGHLIGHT' })}
            />
          )}
        </div>
        {/* Document notes sidebar */}
        {showNotesPanel && documentId && (
          <div className="w-72 border-l border-border bg-background flex-shrink-0 overflow-hidden">
            <PdfDocumentNotes
              documentId={documentId}
              documentTitle={documentTitle}
              onOpenNote={(noteId) => {
                notesDrawer.open(undefined, noteId);
              }}
            />
          </div>
        )}
        {/* Visual entities sidebar */}
        {showMultimodalPanel && documentId && (
          <div className="w-72 border-l border-border bg-background flex-shrink-0 overflow-hidden">
            <PdfMultimodalPanel
              documentId={documentId}
              onJumpToPage={(page) => {
                // Reuse existing citation page-jump dispatch — viewer reads
                // citationPage / page from pdfState and scrolls there.
                pdfDispatch({
                  type: 'OPEN_PDF_VIEWER',
                  payload: {
                    url: pdfState.pdfUrl || '',
                    documentId,
                    documentTitle,
                    page,
                    citationId: 0,
                  },
                });
              }}
            />
          </div>
        )}
        </div>
      </div>
    </div>
  );
};

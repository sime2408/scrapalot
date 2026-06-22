import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { FileText, Loader2, Maximize, MessageSquare, Minimize, X } from 'lucide-react';
import { WindowPinMenu } from '@/components/ui/window-pin-menu';
import { useFloatingWindowManager } from '@/contexts/floating-window-context';
import { useFloatingWindow } from '@/hooks/use-floating-window';
import { makeFloatingWindowStorage } from '@/lib/floating-window-storage';
import type { WindowMode } from '@/types/floating-window';
import { openChatWithDocument } from '@/lib/chat-with-document';
import { AnimatedTitle } from '@/components/ui/animated-title';
import { Button } from '@/components/ui/button';
import { useIsNarrowScreen } from '@/hooks/use-mobile';
import { useSidebar } from '@/contexts/sidebar-context';
import { useTheme } from '@/providers/theme-provider';
import { useTranslation } from 'react-i18next';
import { useDocxViewer } from '@/contexts/docx-viewer-context';
import { useDeepResearchPanel } from '@/contexts/deep-research-context';
import { api } from '@/lib/api';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import './docx-viewer.css';

const ICON_SIDEBAR_WIDTH = 56;

interface DocxViewerDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  documentId: string;
  documentTitle?: string;
  isNotesOpen?: boolean;
}

export const DocxViewerDrawer = ({
  isOpen,
  onClose,
  documentId,
  documentTitle,
  isNotesOpen = false,
}: DocxViewerDrawerProps) => {
  const { t } = useTranslation();
  const isNarrowScreen = useIsNarrowScreen();
  const { isSidebarOpen, toggleSidebar } = useSidebar();
  const { theme: _theme } = useTheme();
  const { state: docxState, dispatch: docxDispatch } = useDocxViewer();
  const deepResearchPanel = useDeepResearchPanel();
  const floatingMgr = useFloatingWindowManager();
  const docxStorage = useMemo(() => makeFloatingWindowStorage('docx-viewer'), []);
  const fw = useFloatingWindow({
    id: 'docx-viewer',
    initialMode: 'pinned-right',
    storage: docxStorage,
    forceMaximized: isNarrowScreen,
    defaultFloatingSize: { width: 720, height: 720 },
  });

  const [viewerWidth, setViewerWidth] = useState<string>('50');
  const [internalDocumentTitle, setInternalDocumentTitle] = useState<string>(
    t('docxViewer.documentViewer', 'Document Viewer')
  );
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [renderedHtml, setRenderedHtml] = useState<string | null>(null);
  const docxContainerRef = useRef<HTMLDivElement | null>(null);
  const docxContentRef = useRef<HTMLDivElement | null>(null);
  const [scale, setScale] = useState<number>(1.0); // For pinch-to-zoom only
  const lastTouchDistanceRef = useRef<number>(0);

  // Load DOCX using docx-preview (with patched node_modules for null check bug)
  useEffect(() => {
    if (!documentId || !isOpen) {
      setRenderedHtml(null);
      return;
    }

    const loadDocx = async () => {
      setIsLoading(true);
      setError(null);

      try {
        console.log('📄 [DocxViewer] Loading DOCX via docx-preview (patched):', documentId);

        // Fetch DOCX file as ArrayBuffer
        const response = await api.get(`/documents/${documentId}/file`, {
          responseType: 'arraybuffer',
        });

        console.log('📄 [DocxViewer] Fetched file, size:', response.data.byteLength);
        console.log('📄 [DocxViewer] ArrayBuffer type:', response.data.constructor.name);
        console.log('📄 [DocxViewer] First 50 bytes (hex):',
          Array.from(new Uint8Array(response.data.slice(0, 50)))
            .map(b => b.toString(16).padStart(2, '0'))
            .join(' ')
        );

        // Import renderAsync dynamically to avoid SSR issues
        const { renderAsync } = await import('docx-preview');

        // Create temporary container for rendering
        const tempContainer = document.createElement('div');

        // Render DOCX using patched docx-preview
        await renderAsync(response.data, tempContainer, undefined, {
          className: 'docx-preview-container',
          inWrapper: false,
          ignoreWidth: false,
          ignoreHeight: false,
          ignoreFonts: false,
          breakPages: true,
          experimental: false,
          trimXmlDeclaration: true,
          useBase64URL: false,
          renderHeaders: true,
          renderFooters: true,
          renderFootnotes: true,
          renderEndnotes: true,
          debug: false,
        });

        // Extract rendered HTML
        const htmlContent = tempContainer.innerHTML;
        console.log('📄 [DocxViewer] docx-preview rendering successful, HTML length:', htmlContent.length);

        setRenderedHtml(htmlContent);
      } catch (err) {
        console.error('📄 [DocxViewer] Error loading DOCX:', err);
        console.error('📄 [DocxViewer] Error name:', err instanceof Error ? err.name : 'Unknown');
        console.error('📄 [DocxViewer] Error message:', err instanceof Error ? err.message : String(err));
        console.error('📄 [DocxViewer] Error stack:', err instanceof Error ? err.stack : 'No stack trace');
        setError(err instanceof Error ? err.message : 'Failed to load document');
      } finally {
        setIsLoading(false);
      }
    };

    void loadDocx();
  }, [documentId, isOpen]);

  // Position tracking
  const [openedOnRight, setOpenedOnRight] = useState<boolean | null>(null);
  const prevIsOpenRef = useRef<boolean>(false);
  const [wasSidebarOpen, setWasSidebarOpen] = useState<boolean>(false);

  // Helper function to calculate width value (matches PDF viewer pattern)
  const calculateWidth = (widthValue: string): string => {
    // On narrow screens (< 992px), always use full width
    if (isNarrowScreen) {
      return '100%';
    }

    // CRITICAL: Use vw (viewport width) instead of % for fixed position
    // Fixed position elements need vw to properly calculate width
    return widthValue === '100'
      ? `calc(100vw - ${ICON_SIDEBAR_WIDTH}px)`
      : `${widthValue}vw`;
  };

  // Calculate position based on viewport and other viewers
  const calculatePosition = useCallback(() => {
    if (isNarrowScreen) {
      return {
        width: '100vw',
        left: '0',
        right: '0',
      };
    }

    // Use the captured opening position (first come, first served).
    // Deep Research panel always occupies the right 50vw — when it's open,
    // force DOCX to the left regardless of the earlier captured side.
    const shouldBeOnRight = deepResearchPanel.isOpen
      ? false
      : (openedOnRight !== null ? openedOnRight : !isNotesOpen);

    if (!shouldBeOnRight && !isNarrowScreen) {
      // DOCX on LEFT side
      // Sidebar auto-closes when DOCX opens, so always use ICON_SIDEBAR_WIDTH
      const sidebarWidth = ICON_SIDEBAR_WIDTH;
      return {
        width: `calc(50vw - ${sidebarWidth}px)`, // Half viewport minus icon sidebar
        left: `${sidebarWidth}px`, // LEFT side after icon sidebar
        right: 'auto',
      };
    }

    // DOCX on RIGHT side (default)
    const width = (isNotesOpen || deepResearchPanel.isOpen) ? 'calc(50vw)' : calculateWidth(viewerWidth);
    return {
      width,
      right: '0',
      left: 'auto',
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are intentionally limited
  }, [isNarrowScreen, isNotesOpen, viewerWidth, openedOnRight, isSidebarOpen, deepResearchPanel.isOpen]);

  // Width change handler
  const handleWidthChange = useCallback((value: string) => {
    setViewerWidth(value);
  }, []);

  // Maximize/restore toggle
  const handleMaximizeToggle = useCallback(() => {
    const newWidth = viewerWidth === '100' ? '50' : '100';
    setViewerWidth(newWidth);
  }, [viewerWidth]);

  // Track opening position
  useEffect(() => {
    const wasOpen = prevIsOpenRef.current;
    const justOpened = !wasOpen && isOpen;
    const justClosed = wasOpen && !isOpen;

    if (justOpened) {
      // Drawer just opened - determine position
      const opensOnRight = !isNotesOpen; // If Notes not open, DOCX goes right
      setOpenedOnRight(opensOnRight);
      // Update global context with position
      docxDispatch({ type: 'SET_DOCX_POSITION', payload: { isOnLeft: !opensOnRight } });
      prevIsOpenRef.current = true;
    } else if (justClosed) {
      // Drawer just closed - reset for next open
      setOpenedOnRight(null);
      prevIsOpenRef.current = false;
    }
  }, [isOpen, isNotesOpen, docxDispatch]);

  // Manage sidebar state when the DOCX viewer opens/closes
  useEffect(() => {
    if (isOpen) {
      // Remember the sidebar state before closing it
      setWasSidebarOpen(isSidebarOpen);

      // Automatically close the sidebar when the DOCX viewer opens
      if (isSidebarOpen) {
        toggleSidebar();
      }
    } else if (wasSidebarOpen && !isSidebarOpen) {
      // Restore sidebar when DOCX viewer closes (if it was open before)
      toggleSidebar();
    }
  }, [isOpen, isSidebarOpen, toggleSidebar, wasSidebarOpen]);

  // Escape (desktop) + mobile back gesture close the viewer.
  // Push a synthetic history entry on open so Android back / iOS swipe-back
  // pops it instead of leaving the app.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!isOpen) return;

    let closedViaHistory = false;
    window.history.pushState({ docxViewer: true }, '');

    const onPopState = () => {
      closedViaHistory = true;
      closeRef.current();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
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
      if (!closedViaHistory && window.history.state?.docxViewer) {
        window.history.back();
      }
    };
  }, [isOpen]);

  // Update title when document changes
  useEffect(() => {
    if (documentTitle) {
      setInternalDocumentTitle(documentTitle);
    }
  }, [documentTitle]);

  // Auto-fit zoom when document loads
  useEffect(() => {
    if (!renderedHtml || !docxContentRef.current || !docxContainerRef.current) {
      return;
    }

    // Wait for DOM to render
    const timer = setTimeout(() => {
      const contentEl = docxContentRef.current;
      const containerEl = docxContainerRef.current;

      if (!contentEl || !containerEl) return;

      // CRITICAL: Remove ALL inline width/min-width/max-width styles
      // docx-preview sets inline styles that override CSS
      const allElements = contentEl.querySelectorAll('*');
      let removedCount = 0;

      allElements.forEach((el) => {
        const htmlEl = el as HTMLElement;

        // Remove width, min-width, max-width from inline styles
        if (htmlEl.style.width || htmlEl.style.minWidth || htmlEl.style.maxWidth) {
          if (htmlEl.style.width) {
            console.log('📄 [DocxViewer] Removing inline width:', htmlEl.style.width, 'from', htmlEl.tagName);
            htmlEl.style.width = '';
            removedCount++;
          }
          if (htmlEl.style.minWidth) {
            console.log('📄 [DocxViewer] Removing inline min-width:', htmlEl.style.minWidth, 'from', htmlEl.tagName);
            htmlEl.style.minWidth = '';
            removedCount++;
          }
          if (htmlEl.style.maxWidth) {
            htmlEl.style.maxWidth = '';
            removedCount++;
          }
        }

        // CRITICAL: Remove all padding and margin from inline styles
        if (htmlEl.style.padding || htmlEl.style.paddingLeft || htmlEl.style.paddingRight) {
          htmlEl.style.padding = '0';
          htmlEl.style.paddingLeft = '0';
          htmlEl.style.paddingRight = '0';
          removedCount++;
        }
        if (htmlEl.style.margin || htmlEl.style.marginLeft || htmlEl.style.marginRight) {
          htmlEl.style.margin = '0';
          htmlEl.style.marginLeft = '0';
          htmlEl.style.marginRight = '0';
          removedCount++;
        }

        // Force width constraints on ALL elements (more aggressive)
        htmlEl.style.maxWidth = '100%';
        htmlEl.style.boxSizing = 'border-box';

        // For block elements, also set width to 100%
        if (['DIV', 'SECTION', 'ARTICLE', 'TABLE', 'TBODY', 'THEAD', 'TR'].includes(htmlEl.tagName)) {
          htmlEl.style.width = '100%';
        }
      });

      console.log('📄 [DocxViewer] Removed', removedCount, 'inline width styles');

      // Small delay to let CSS reflow complete
      setTimeout(() => {
        if (!contentEl || !containerEl) return;

        // Measure actual document width (after CSS reflow)
        const documentWidth = contentEl.scrollWidth;
        const containerWidth = containerEl.clientWidth;
        const padding = 16; // 8px on each side (8px * 2 = 16px total)

        if (documentWidth > 0 && containerWidth > 0) {
          // Calculate zoom to fit width (max 1.0, only zoom out if needed)
          const fitZoom = Math.min((containerWidth - padding) / documentWidth, 1.0);

          console.log('📄 [DocxViewer] Initial auto-fit zoom:', {
            documentWidth,
            containerWidth,
            padding,
            availableWidth: containerWidth - padding,
            fitZoom: fitZoom.toFixed(3),
            willZoomOut: fitZoom < 1.0,
          });

          setScale(fitZoom);

          // CRITICAL: After setting zoom, verify scrollWidth again
          // Some elements might still overflow after zoom
          setTimeout(() => {
            if (!contentEl || !containerEl) return;

            const afterZoomWidth = contentEl.scrollWidth;
            const currentContainerWidth = containerEl.clientWidth;

            if (afterZoomWidth > currentContainerWidth) {
              // Still overflowing! Reduce zoom further
              const adjustmentFactor = 0.95; // 5% safety margin
              const correctedZoom = fitZoom * (currentContainerWidth / afterZoomWidth) * adjustmentFactor;

              console.log('📄 [DocxViewer] Correcting zoom (still overflowing):', {
                afterZoomWidth,
                currentContainerWidth,
                overflow: afterZoomWidth - currentContainerWidth,
                originalZoom: fitZoom.toFixed(3),
                correctedZoom: correctedZoom.toFixed(3),
              });

              setScale(correctedZoom);
            } else {
              console.log('📄 [DocxViewer] Zoom correct, no overflow');
            }
          }, 150); // Wait for zoom to apply
        }
      }, 100); // 100ms for CSS reflow
    }, 200); // 200ms for DOM render

    return () => clearTimeout(timer);
  }, [renderedHtml]);

  // Pinch-to-zoom handlers
  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    if (e.touches.length === 2) {
      console.log('📱 [DocxViewer] Pinch start detected');
      const touch1 = e.touches[0];
      const touch2 = e.touches[1];
      lastTouchDistanceRef.current = Math.hypot(
        touch2.clientX - touch1.clientX,
        touch2.clientY - touch1.clientY
      );
    }
  }, []);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (e.touches.length === 2) {
      // Only prevent default for two-finger touch (pinch)
      e.preventDefault();
      e.stopPropagation();

      const touch1 = e.touches[0];
      const touch2 = e.touches[1];
      const distance = Math.hypot(
        touch2.clientX - touch1.clientX,
        touch2.clientY - touch1.clientY
      );

      if (lastTouchDistanceRef.current > 0) {
        const delta = distance - lastTouchDistanceRef.current;
        const scaleChange = delta * 0.005; // Increased sensitivity
        const newScale = Math.min(Math.max(scale + scaleChange, 0.3), 3.0); // 0.3x - 3.0x (wider range)

        console.log('📱 [DocxViewer] Pinch zoom:', {
          distance,
          delta,
          scaleChange: scaleChange.toFixed(4),
          oldScale: scale.toFixed(3),
          newScale: newScale.toFixed(3),
        });

        setScale(newScale);
      }

      lastTouchDistanceRef.current = distance;
    }
  }, [scale]);

  const handleTouchEnd = useCallback((_e: React.TouchEvent) => {
    if (lastTouchDistanceRef.current > 0) {
      console.log('📱 [DocxViewer] Pinch end, final scale:', scale);
    }
    lastTouchDistanceRef.current = 0;
  }, [scale]);

  if (!isOpen) return null;

  return (
    <>
      {/* Background overlay for dismiss */}
      {isOpen && !isNarrowScreen && (
        <div
          className="fixed inset-0 bg-black/20 dark:bg-black/40 z-[1699]"
          onClick={onClose}
        />
      )}

      {/* Drawer */}
      <div
        ref={fw.panelRef}
        data-testid='docx-viewer-drawer'
        {...fw.focusProps}
        className={`fixed docx-viewer-drawer bg-background ${fw.isFloating ? '' : 'transition-all duration-300 ease-in-out'} ${
          isOpen && !fw.isFloating ? 'translate-x-0' : !fw.isFloating ? 'translate-x-full' : ''
        }`}
        style={{
          ...(fw.isFloating ? fw.floatingStyle : { ...calculatePosition(), top: 0, bottom: 0 }),
          zIndex: floatingMgr.isTopFocused('docx-viewer') ? 9999 : 1700 + Math.max(0, floatingMgr.getOrder('docx-viewer')),
          isolation: 'isolate',
          borderLeft: !isNarrowScreen && (openedOnRight !== null ? openedOnRight : !isNotesOpen)
            ? `1px solid hsl(var(--border))`
            : 'none',
          borderRight: !isNarrowScreen && (openedOnRight !== null ? !openedOnRight : isNotesOpen)
            ? `1px solid hsl(var(--border))`
            : 'none',
        }}
      >
      {fw.resizeHandles}
      {/* Header */}
      <div
        {...(fw.isFloating ? fw.headerDragProps : {})}
        className={`flex items-center justify-between px-4 py-3 border-b border-border bg-muted/30 ${fw.isFloating ? fw.headerDragProps.className : ''}`}
      >
        <div className='flex items-center gap-2 min-w-0 flex-1'>
          <FileText className='h-5 w-5 text-muted-foreground flex-shrink-0' />
          <AnimatedTitle className='text-base font-medium truncate'>
            {internalDocumentTitle}
          </AnimatedTitle>
        </div>

        <div className='flex items-center gap-2'>
          {/* Width selector (hide on narrow screens) */}
          {!isNarrowScreen && !isNotesOpen && (
            <Select value={viewerWidth} onValueChange={handleWidthChange}>
              <SelectTrigger data-testid="docx-viewer-width-selector" className='w-[80px] h-8'>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value='30'>30%</SelectItem>
                <SelectItem value='40'>40%</SelectItem>
                <SelectItem value='50'>50%</SelectItem>
                <SelectItem value='60'>60%</SelectItem>
                <SelectItem value='70'>70%</SelectItem>
                <SelectItem value='80'>80%</SelectItem>
                <SelectItem value='100'>100%</SelectItem>
              </SelectContent>
            </Select>
          )}

          {/* Maximize/Restore button */}
          {!isNarrowScreen && !isNotesOpen && (
            <Button
              data-testid="docx-viewer-maximize-button"
              variant='ghost'
              size='sm'
              onClick={handleMaximizeToggle}
              title={viewerWidth === '100' ? t('pdfViewer.restore') : t('pdfViewer.maximize')}
            >
              {viewerWidth === '100' ? (
                <Minimize className='h-4 w-4' />
              ) : (
                <Maximize className='h-4 w-4' />
              )}
            </Button>
          )}

          {!isNarrowScreen && (
            <WindowPinMenu
              mode={fw.isFloating ? 'floating' : (docxState.isOnLeft ? 'pinned-left' : 'pinned-right')}
              onSetMode={(m: WindowMode) => {
                fw.setMode(m);
                if (m === 'pinned-left' || m === 'pinned-right') {
                  docxDispatch({ type: 'SET_DOCX_POSITION', payload: { isOnLeft: m === 'pinned-left' } });
                }
              }}
              showFloating={true}
              showMaximize={false}
              testId="docx-viewer-pin-menu"
              className="h-8 w-8"
            />
          )}

          {/* Chat with this document */}
          {documentId && (
            <Button
              data-testid='docx-viewer-chat-about-button'
              variant='ghost'
              size='sm'
              onClick={() => {
                // Keep the DOCX viewer open side-by-side with the chat.
                // Knowledge Stacks dialog closes via its own listener
                // on scrapalot:chat-with-document.
                openChatWithDocument({
                  documentId,
                  documentName: documentTitle || internalDocumentTitle,
                });
              }}
              title={t('docxViewer.chatAbout', 'Chat with this document')}
            >
              <MessageSquare className='h-4 w-4' />
            </Button>
          )}

          {/* Close button — always visible (also on md/lg). */}
          <Button
            data-testid='docx-viewer-close-button'
            variant='ghost'
            size='icon'
            onClick={onClose}
            onMouseDown={(e) => e.preventDefault()}
            className='h-8 w-8 hover:bg-accent transition-colors'
            title={t('common.close', 'Close')}
          >
            <X className='h-4 w-4' />
          </Button>

        </div>
      </div>

      {/* Content */}
      <div className='h-[calc(100vh-57px)] overflow-auto bg-background'>
        {/* Loading state */}
        {isLoading && (
          <div className='flex items-center justify-center h-full'>
            <Loader2 className='h-8 w-8 animate-spin text-muted-foreground' />
          </div>
        )}

        {/* Error state */}
        {!isLoading && error && (
          <div className='flex flex-col items-center justify-center h-full gap-4 px-4'>
            <FileText className='h-12 w-12 text-destructive' />
            <p className='text-destructive text-center'>{error}</p>
          </div>
        )}

        {/* docx-preview rendered HTML content with theme support */}
        {!isLoading && !error && renderedHtml && (
          <div
            ref={docxContainerRef}
            className='docx-wrapper overflow-auto'
            onTouchStart={handleTouchStart}
            onTouchMove={handleTouchMove}
            onTouchEnd={handleTouchEnd}
            style={{
              padding: '8px',
              // touch-action handled by CSS (.docx-wrapper { touch-action: pan-x pan-y; })
            }}
          >
            <div
              ref={docxContentRef}
              className='docx-preview-container'
              style={{
                // Use CSS zoom instead of transform: scale()
                // zoom changes actual layout, not just visual scaling
                zoom: scale !== 1.0 ? scale : undefined,
                transition: scale !== 1.0 ? 'zoom 0.1s ease-out' : undefined,
              }}
              dangerouslySetInnerHTML={{ __html: renderedHtml }}
            />
          </div>
        )}
      </div>
    </div>
    </>
  );
};

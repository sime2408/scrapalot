import React, {
  forwardRef,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { PageChangeEvent, PdfJs, SpecialZoomLevel, Viewer, Worker } from '@react-pdf-viewer/core';
import { defaultLayoutPlugin } from '@react-pdf-viewer/default-layout';
import {
  highlightPlugin,
  RenderHighlightsProps,
  Trigger,
} from '@react-pdf-viewer/highlight';
import { zoomPlugin } from '@react-pdf-viewer/zoom';
import { useTheme } from '@/providers/theme-provider';
import { useIsMobile } from '@/hooks/use-mobile.tsx';

// Import styles
import '@react-pdf-viewer/core/lib/styles/index.css';
import '@react-pdf-viewer/default-layout/lib/styles/index.css';
import '@react-pdf-viewer/highlight/lib/styles/index.css';
import '@react-pdf-viewer/zoom/lib/styles/index.css';

import { api } from '@/contexts/api-client-context';

interface AnnotationHighlight {
  id: string;
  pageIndex: number;
  left: number;
  top: number;
  width: number;
  height: number;
  color: string;
  annotationType: number; // 1=highlight, 3=underline
}

interface PDFViewerProps {
  url: string;
  initialPage?: number;
  highlightLineStart?: number; // Deprecated: Use highlightText instead
  highlightLineEnd?: number; // Deprecated: Use highlightText instead
  highlightText?: string; // The actual text to highlight on the page
  topOffset?: number; // Manual offset (will be ignored if autoCalibrate is true)
  heightPadding?: number; // Manual padding (will be ignored if autoCalibrate is true)
  autoCalibrate?: boolean; // Whether to automatically calculate positioning
  lineOffset?: number; // Correction for line number mapping (can be positive or negative)
  fitToWidth?: boolean; // Whether to fit to width or use fixed scale
  scale?: number; // Explicit scale value
  annotationHighlights?: AnnotationHighlight[]; // Persistent annotation highlights
}

export const PDFViewer = forwardRef<HTMLDivElement, PDFViewerProps>(
  (
    {
      url,
      initialPage,
      highlightLineStart,
      highlightLineEnd,
      highlightText,
      topOffset = 3,
      heightPadding = 1.5,
      autoCalibrate = true,
      lineOffset = 0,
      fitToWidth = true,
      scale,
      annotationHighlights = [],
    },
    ref
  ) => {
    const [isLoaded, setIsLoaded] = useState(false);
    const [pdfDocument, setPdfDocument] = useState<PdfJs.PdfDocument | null>(
      null
    );
    const { theme, accentColor } = useTheme();
    
    // Map accent colors to RGB values
    const accentColorMap: Record<string, string> = {
      blue: '59, 130, 246',    // blue-500
      violet: '124, 58, 237',  // violet-600
      green: '34, 197, 94',    // green-500
      red: '239, 68, 68',      // red-500
      orange: '249, 115, 22',  // orange-500
      gray: '107, 114, 128',   // gray-500
    };
    
    const accentRgb = accentColorMap[accentColor] || accentColorMap.blue;
    // Use ref so renderHighlights callback always sees latest annotations
    const annotationHighlightsRef = useRef(annotationHighlights);
    annotationHighlightsRef.current = annotationHighlights;
    const isMobile = useIsMobile();
    const [authenticatedUrl, setAuthenticatedUrl] = useState<string>('');
    const [isLoadingPdf, setIsLoadingPdf] = useState(false);
    const [pdfError, setPdfError] = useState<string>('');
    const [textHighlightAreas, setTextHighlightAreas] = useState<{ pageIndex: number; left: number; top: number; width: number; height: number }[]>([]);
    const retryCountRef = useRef(0);
    const maxRetries = 3;

    // Apply theme class to PDF viewer
    useEffect(() => {
      if (!isLoaded) return;

      // Add a class to the document body for PDF theming
      document.documentElement.classList.add(`pdf-theme-${theme}`);

      return () => {
        document.documentElement.classList.remove(`pdf-theme-${theme}`);
      };
    }, [theme, isLoaded]);

    // Apply invert filter to PDF pages only (not the entire container) on dark mode
    useEffect(() => {
      // Create or update style tag for PDF page inversion
      const styleId = 'pdf-page-invert-style';
      let styleEl = document.getElementById(styleId) as HTMLStyleElement;

      if (!styleEl) {
        styleEl = document.createElement('style');
        styleEl.id = styleId;
        document.head.appendChild(styleEl);
      }

      if (theme === 'dark') {
        styleEl.textContent = `
          /* Invert only PDF pages on dark mode, not the container background */
          .rpv-core__page-layer {
            filter: invert(1) hue-rotate(180deg);
          }
        `;
      } else {
        styleEl.textContent = '';
      }

      return () => {
        // Cleanup style tag on unmount
        const el = document.getElementById(styleId);
        if (el) {
          el.remove();
        }
      };
    }, [theme]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- react-pdf-viewer layout plugin type is complex
    const layoutPluginRef = useRef<any>(null);
    const viewerContainerRef = useRef<HTMLDivElement>(null);

    // Pinch-zoom state: tracked via refs so touch handlers don't re-render.
    // currentScaleRef is updated by Viewer.onZoom; pinchRef holds the gesture origin.
    // pendingTransformCleanupRef hands the CSS-transform target off from touchEnd
    // to handleZoom so the GPU transform stays applied until pdf.js delivers the
    // freshly-rasterized canvas (no flash between CSS scale and re-render).
    const currentScaleRef = useRef<number>(1);
    const pinchRef = useRef<{
      startDist: number;
      startScale: number;
      // Anchor: element-local coords under the pinch midpoint at touchStart.
      // We translate during the gesture so this point stays under the live
      // pinch midpoint as the user moves and spreads their fingers.
      anchorX: number;
      anchorY: number;
      // Untransformed top-left of the target element in viewport coords.
      // Captured once at touchStart (no transform applied yet).
      elementLeft: number;
      elementTop: number;
      // Scroll state at gesture start — needed at commit to compute the
      // post-zoom scroll position that keeps the anchor under the fingers.
      scrollLeft0: number;
      scrollTop0: number;
      targetEl: HTMLElement;
    } | null>(null);
    const pendingTransformCleanupRef = useRef<{
      el: HTMLElement;
      expectedScale: number;
      scrollLeftNew: number;
      scrollTopNew: number;
    } | null>(null);

    // Use ref for the container, not directly on the Viewer component
    useEffect(() => {
      if (ref) {
        if (typeof ref === 'function') {
          ref(viewerContainerRef.current);
        } else {
          ref.current = viewerContainerRef.current;
        }
      }
    }, [ref]);

    // Reset loading state when url or initialPage changes to ensure proper loading
    useEffect(() => {

      setIsLoaded(false);
    }, [url, initialPage]);

    // Track the blob URL for cleanup
    const authenticatedUrlRef = useRef<string>('');

    // Fetch PDF with authentication and retry logic
    useEffect(() => {
      let isCancelled = false;

      const fetchPDF = async (currentRetry = 0) => {
        if (!url) {
          setIsLoadingPdf(false);
          return;
        }

        setIsLoadingPdf(true);
        setPdfError('');

        try {
          const response = await api.get(url, {
            headers: {
              Accept: 'application/pdf',
            },
            responseType: 'arraybuffer',
            // Add timeout to prevent hanging
            timeout: 30000, // 30 seconds
          });

          if (isCancelled) return;

          if (response.status !== 200) {
            setPdfError(`Failed to fetch PDF: ${response.status} ${response.statusText}`);
            return;
          }

          const contentType =
            response.headers && response.headers['content-type'];

          if (contentType && !contentType.includes('application/pdf')) {
            if (contentType.includes('application/json')) {
              // Attempt to extract a human-readable message from the JSON error body;
              // fall back to a generic message if parsing fails.
              const decoder = new TextDecoder();
              const errorText = decoder.decode(response.data);
              let jsonMessage = '';
              try {
                const errorJson = JSON.parse(errorText);
                jsonMessage = errorJson.message || errorJson.detail || '';
              } catch {
                // JSON parsing failed — use fallback message below
              }
              setPdfError(
                jsonMessage
                  ? `Backend error: ${jsonMessage}`
                  : `Expected PDF but received ${contentType}. Backend returned an error.`
              );
              return;
            } else {
              setPdfError(
                `Expected PDF but received ${contentType}. Check if the document endpoint is working correctly.`
              );
              return;
            }
          }

          const blob = new Blob([response.data], { type: 'application/pdf' });
          const blobUrl = URL.createObjectURL(blob);

          // Clean up previous blob URL if any
          if (authenticatedUrlRef.current) {
            URL.revokeObjectURL(authenticatedUrlRef.current);
          }
          authenticatedUrlRef.current = blobUrl;

          if (!isCancelled) {
            setAuthenticatedUrl(blobUrl);
            retryCountRef.current = 0;
          }
        } catch (error) {
          if (isCancelled) return;

          console.error('Error fetching authenticated PDF:', error);

          // Check if this is a network error and we should retry
          const isNetworkError =
            error instanceof Error &&
            (error.message.includes('Network Error') ||
             error.message.includes('Connection refused') ||
             error.message.includes('timeout'));

          if (isNetworkError && currentRetry < maxRetries) {
            const nextRetry = currentRetry + 1;
            const delay = Math.pow(2, nextRetry) * 1000; // Exponential backoff: 2s, 4s, 8s

            console.log(
              `PDF fetch failed (attempt ${currentRetry + 1}/${maxRetries + 1}), ` +
              `retrying in ${delay / 1000}s...`
            );

            retryCountRef.current = nextRetry;

            // Retry after exponential backoff delay
            setTimeout(() => {
              if (!isCancelled) {
                fetchPDF(nextRetry);
              }
            }, delay);

            return; // Don't set error state yet, will retry
          }

          // Final error after all retries exhausted or non-network error
          setPdfError(
            error instanceof Error ? error.message : 'Failed to load PDF'
          );
        } finally {
          if (!isCancelled) {
            setIsLoadingPdf(false);
          }
        }
      };

      // Reset state for new URL
      setAuthenticatedUrl('');
      void fetchPDF(0);

      // Listen for connection restoration and retry PDF fetch
      const handleConnectionRestored = () => {
        // Only retry if we don't have a successful PDF loaded yet
        if (!authenticatedUrlRef.current && url && retryCountRef.current <= maxRetries) {
          console.log('Connection restored, retrying PDF fetch...');
          retryCountRef.current = 0; // Reset counter for connection restoration retry
          void fetchPDF(0);
        }
      };

      // Listen for custom event from ConnectionLostDialog
      window.addEventListener('connection-restored', handleConnectionRestored);

      // Cleanup blob URL on unmount or URL change
      return () => {
        isCancelled = true;
        window.removeEventListener('connection-restored', handleConnectionRestored);
        if (authenticatedUrlRef.current) {
          URL.revokeObjectURL(authenticatedUrlRef.current);
          authenticatedUrlRef.current = '';
        }
      };
    }, [url, maxRetries]);

    // Function to find text in PDF text layer and get bounding boxes
    const findTextInPage = useCallback(
      async (pageNum: number, searchText: string) => {
        if (!pdfDocument || !searchText) return [];

        try {
          const page = await pdfDocument.getPage(pageNum);
          const textContent = await page.getTextContent();
          const viewport = page.getViewport({ scale: 1 });

          // Normalize search text - aggressive normalization for flexible matching
          const normalizedSearch = searchText
            .toLowerCase()
            .replace(/[_*[\]]/g, '') // Remove markdown formatting
            .replace(/\s+/g, ' ') // Collapse whitespace
            .replace(/[^\w\s]/g, ' ') // Replace punctuation with spaces
            .replace(/\s+/g, ' ') // Collapse again
            .trim();

          // Create search variants with different strategies
          const searchVariants = [];
          
          // Strategy 1: Full text
          searchVariants.push(normalizedSearch);
          
          // Strategy 2: Remove leading reference number (e.g., "83 Kropej..." -> "Kropej...")
          const withoutRefNumber = normalizedSearch.replace(/^\d+\s+/, '');
          if (withoutRefNumber !== normalizedSearch) {
            searchVariants.push(withoutRefNumber);
          }
          
          // Strategy 3: Progressive word truncation (more aggressive for granular text)
          const words = normalizedSearch.split(' ').filter(w => w.length > 0);
          searchVariants.push(
            words.slice(0, 15).join(' '), // First 15 words
            words.slice(0, 10).join(' '), // First 10 words
            words.slice(0, 7).join(' '),  // First 7 words
            words.slice(0, 5).join(' '),  // First 5 words
            words.slice(0, 3).join(' ')   // First 3 words (very short for granular text)
          );
          
          // Strategy 4: For bibliography entries, try author + year + title keywords
          // Pattern: "Author (Year). Title" or "Number Author (Year). Title"
          const bibMatch = searchText.match(/(?:\d+\s+)?([A-Z][a-z]+)[^(]*\((\d{4})[^)]*\)[^.]*\.?\s*([^.]{10,50})/);
          if (bibMatch) {
            const [, author, year, titleStart] = bibMatch;
            const bibVariant = `${author} ${year} ${titleStart}`.toLowerCase()
              .replace(/[_*[\]]/g, '')
              .replace(/[^\w\s]/g, ' ')
              .replace(/\s+/g, ' ')
              .trim();
            searchVariants.push(bibVariant);
          }
          
          // Filter out duplicates and too-short variants (reduced to 5 chars for granular text)
          const uniqueVariants = [...new Set(searchVariants)].filter(s => s && s.length >= 5);

          // Build full text and track positions
          let fullText = '';
          let normalizedText = '';
          interface PdfTextItem { str: string; transform: number[]; width: number; height: number }
          const itemPositions: Array<{
            start: number;
            end: number;
            normalizedStart: number;
            normalizedEnd: number;
            item: PdfTextItem;
          }> = [];

          textContent.items.forEach((item: PdfTextItem) => {
            const originalStart = fullText.length;
            const normalizedStart = normalizedText.length;
            
            const text = item.str || '';
            
            // Add original text with space
            fullText += text + ' ';
            
            // Normalize this item's text - same aggressive normalization
            const normalizedItemText = text
              .toLowerCase()
              .replace(/[_*[\]]/g, '')
              .replace(/\s+/g, ' ')
              .replace(/[^\w\s]/g, ' ')
              .replace(/\s+/g, ' ')
              .trim();
            
            // Only add non-empty normalized text
            if (normalizedItemText) {
              normalizedText += normalizedItemText + ' ';
            }
            
            const originalEnd = fullText.length;
            const normalizedEnd = normalizedText.length;
            
            itemPositions.push({ 
              start: originalStart, 
              end: originalEnd,
              normalizedStart,
              normalizedEnd,
              item 
            });
          });

          // Trim the normalized text
          normalizedText = normalizedText.trim();
          
          // Log a sample of the normalized text for debugging
          console.log('📄 Normalized PDF text sample (first 200 chars):', normalizedText.substring(0, 200));
          console.log('📄 Total text length:', normalizedText.length, 'from', textContent.items.length, 'items');
          
          // Try each search variant until we find a match
          let matchIndex = -1;
          let matchLength = 0;
          let usedVariant = '';
          
          for (const variant of uniqueVariants) {
            matchIndex = normalizedText.indexOf(variant);
            if (matchIndex !== -1) {
              matchLength = variant.length;
              usedVariant = variant;
              break;
            }
          }
          
          console.log('🔍 PDF Text Search:', {
            originalSearch: searchText.substring(0, 60) + '...',
            normalizedSearch: normalizedSearch.substring(0, 60) + '...',
            usedVariant: usedVariant ? usedVariant.substring(0, 60) + '...' : 'none',
            variantsTried: uniqueVariants.length,
            pageNum,
            found: matchIndex !== -1,
            matchIndex,
            textLength: normalizedText.length
          });

          if (matchIndex === -1) {
            console.log('❌ Text not found on page - tried', uniqueVariants.length, 'variants:', 
              uniqueVariants.map(v => v.substring(0, 30) + '...'));
            return [];
          }

          // Find which text items contain the match using normalized positions
          const matchEnd = matchIndex + matchLength;
          const matchingItems = itemPositions.filter(
            pos => pos.normalizedStart < matchEnd && pos.normalizedEnd > matchIndex
          );
          
          console.log('Found matching items:', matchingItems.length, 'for match range:', matchIndex, '-', matchEnd);

          if (matchingItems.length === 0) return [];

          // Calculate bounding box for all matching items
          let minX = Infinity,
            minY = Infinity,
            maxX = -Infinity,
            maxY = -Infinity;

          matchingItems.forEach(({ item }) => {
            const tx = item.transform;
            const x = tx[4];
            const y = tx[5];
            const width = item.width;
            const height = item.height;

            minX = Math.min(minX, x);
            minY = Math.min(minY, y);
            maxX = Math.max(maxX, x + width);
            maxY = Math.max(maxY, y + height);
          });

          // Convert to percentage-based coordinates for react-pdf-viewer
          const left = Math.max(0, Math.min(100, (minX / viewport.width) * 100));
          const top = Math.max(0, Math.min(100, ((viewport.height - maxY) / viewport.height) * 100));
          const width = Math.max(0, Math.min(100, ((maxX - minX) / viewport.width) * 100));
          const height = Math.max(0, Math.min(100, ((maxY - minY) / viewport.height) * 100));
          
          // Validate dimensions to prevent RangeError
          if (width <= 0 || height <= 0 || !isFinite(width) || !isFinite(height)) {
            console.warn('⚠️ Invalid highlight dimensions:', { width, height, minX, maxX, minY, maxY });
            return [];
          }
          
          const highlightArea = {
            left,
            top,
            width,
            height,
            pageIndex: pageNum - 1,
          };
          
          console.log('📐 Highlight area:', highlightArea);

          return [highlightArea];
        } catch (error) {
          console.error('Error finding text in page:', error);
          return [];
        }
      },
      [pdfDocument]
    );

    // Search for text when document loads and highlightText is provided
    useEffect(() => {
      console.log('📄 PDF Viewer - Highlight params:', {
        hasPdfDocument: !!pdfDocument,
        highlightText: highlightText ? highlightText.substring(0, 50) + '...' : null,
        initialPage,
        highlightLineStart,
        highlightLineEnd
      });
      
      if (pdfDocument && highlightText && typeof initialPage === 'number') {
        console.log('🔎 Searching for text on page', initialPage);
        findTextInPage(initialPage, highlightText).then(areas => {
          console.log('📍 Highlight areas found:', areas.length);
          setTextHighlightAreas(areas);
          
          // If text search failed and we have percentage fallback, clear textHighlightAreas
          // so the percentage-based highlighting can be used
          if (areas.length === 0 && highlightLineStart && highlightLineEnd) {
            console.log('⚠️ Text search failed, will use percentage-based fallback');
          }
        });
      } else if (pdfDocument && !highlightText && highlightLineStart && highlightLineEnd) {
        console.log('⚠️ Using legacy percentage-based highlighting');
      }
    }, [pdfDocument, highlightText, initialPage, highlightLineStart, highlightLineEnd, findTextInPage]);

    // Create highlight plugin with custom renderHighlights function
    // Trigger.None disables the plugin's built-in selection popup so our custom
    // PdfAnnotationLayer can handle text selection without interference
    const highlightPluginInstance = highlightPlugin({
      trigger: Trigger.None,
      renderHighlights: (props: RenderHighlightsProps) => {
        const { pageIndex, rotation, getCssProperties } = props;

        // Prioritize text-based highlighting
        if (highlightText && textHighlightAreas.length > 0) {
          const pageAreas = textHighlightAreas.filter(
            area => area.pageIndex === pageIndex
          );

          if (pageAreas.length > 0) {
            console.log('✨ Rendering text-based highlight on page', pageIndex);
            return (
              <div className='rpv-highlight__container'>
                {pageAreas.map((area, idx) => {
                  const cssProps = getCssProperties(area, rotation);
                  
                  console.log('🎨 CSS Properties for highlight:', {
                    area,
                    cssProps,
                    theme,
                    accentColor
                  });
                  
                  // Override the area to span full line width
                  const fullLineArea = {
                    ...area,
                    left: 5,      // Start from left margin
                    width: 90,    // Span most of the page width
                    height: Math.max(area.height, 1.5), // Ensure minimum height for visibility
                  };
                  
                  const fullLineCssProps = getCssProperties(fullLineArea, rotation);
                  
                  return (
                    <div
                      key={`highlight-text-${idx}`}
                      className='rpv-highlight__area'
                      style={{
                        ...fullLineCssProps,
                        backgroundColor: theme === 'dark'
                          ? `rgba(${accentRgb}, 0.45)` // Stronger highlight on dark mode
                          : `rgba(${accentRgb}, 0.25)`, // Stronger highlight on light mode
                        position: 'absolute' as const,
                        zIndex: 999,
                        pointerEvents: 'none' as const,
                        border: theme === 'dark'
                          ? `3px solid rgba(${accentRgb}, 0.75)` // Stronger border on dark mode
                          : `3px solid rgba(${accentRgb}, 0.5)`, // Stronger border on light mode
                        borderRadius: '4px',
                        boxShadow: theme === 'dark'
                          ? `0 0 12px rgba(${accentRgb}, 0.6)` // Stronger glow on dark mode
                          : `0 0 8px rgba(${accentRgb}, 0.4)`, // Subtle glow on light mode
                        // Counter-invert highlight so it stays in original colors on dark mode
                        filter: theme === 'dark' ? 'invert(1) hue-rotate(180deg)' : 'none',
                      }}
                    />
                  );
                })}
              </div>
            );
          }
        }

        // Annotation highlights rendered by PdfAnnotationLayer (direct overlays, not plugin).

        return <></>;
      },
    });

    // Create zoom plugin with default zoom level based on device
    const zoomPluginInstance = zoomPlugin({
      enableShortcuts: true,
    });

    // Create an instance of the default layout plugin with customized options
    const defaultLayoutPluginInstance = defaultLayoutPlugin({
      sidebarTabs: defaultTabs => [
        // Only show the thumbnail tab
        defaultTabs[0],
      ],
      // Set initial sidebar collapsed on mobile
      ...(isMobile ? { setInitialTab: () => Promise.resolve(-1) } : {}),
      toolbarPlugin: {
        fullScreenPlugin: {
          // Disable the full screen option
          enableShortcuts: false,
        },
      },
    });
    layoutPluginRef.current = defaultLayoutPluginInstance;

    // Handle document load
    const handleDocumentLoaded = useCallback(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- react-pdf-viewer document load event type
      (e: any) => {
        setIsLoaded(true);

        // Store the document if needed
        if (e.doc) {
          setPdfDocument(e.doc);
        }

        // Navigate to the initial page after layout settles.
        // On mobile, defaultScale={PageFit} handles zoom via Viewer prop.
        // Use jumpToPage to navigate after layout settles. The Viewer's initialPage prop
        // handles initial scroll on desktop, but on mobile the zoom/layout changes can
        // disrupt it, so jumpToPage reinforces the correct position.
        if (typeof initialPage === 'number' && initialPage > 1) {
          setTimeout(() => {
            try {
              layoutPluginRef.current?.toolbarPluginInstance
                ?.pageNavigationPluginInstance?.jumpToPage(initialPage - 1);
            } catch (err) {
              console.warn('PDF: Failed to jump to page:', err);
            }
          }, 1000);
        }
      },
      [initialPage]
    );

    // Track zoom so pinch handlers know the baseline scale, and complete the
    // pinch hand-off when pdf.js has re-rasterized at the requested scale:
    // we set the precomputed scroll position FIRST (re-positions layout) then
    // immediately drop the CSS transform (stops the GPU scale). Both mutations
    // commit in the same paint, so the anchor point stays visually anchored.
    const handleZoom = useCallback((e: { scale: number }) => {
      if (typeof e.scale === 'number' && Number.isFinite(e.scale)) {
        currentScaleRef.current = e.scale;
      }
      const pending = pendingTransformCleanupRef.current;
      if (pending && Math.abs(e.scale - pending.expectedScale) / pending.expectedScale < 0.01) {
        pending.el.scrollLeft = pending.scrollLeftNew;
        pending.el.scrollTop = pending.scrollTopNew;
        pending.el.style.transform = '';
        pending.el.style.transformOrigin = '';
        pending.el.style.willChange = '';
        pendingTransformCleanupRef.current = null;
      }
    }, []);

    // Pinch-zoom: two-finger gesture drives a CSS transform during the gesture
    // (GPU-smooth, no pdf.js work). On gesture end we call zoomPlugin.zoomTo
    // once, then handleZoom drops the transform when the new canvas is ready.
    // Single-finger touch falls through to native pan (touchAction: pan-x pan-y).
    const pinchDistance = (touches: React.TouchList): number => {
      const dx = touches[0].clientX - touches[1].clientX;
      const dy = touches[0].clientY - touches[1].clientY;
      return Math.hypot(dx, dy);
    };

    const findPinchTarget = (): HTMLElement | null => {
      // .rpv-core__inner-pages is the scroll container that holds the rendered
      // page layers; it's mounted late (post documentLoaded) so we query each
      // time. See memory: feedback_late_mounted_scroll_targets.
      return (viewerContainerRef.current?.querySelector(
        '.rpv-core__inner-pages'
      ) as HTMLElement | null) ?? null;
    };

    const handleTouchStart = useCallback((e: React.TouchEvent) => {
      if (e.touches.length !== 2) return;
      const target = findPinchTarget();
      if (!target) return;
      const t1 = e.touches[0];
      const t2 = e.touches[1];
      // Untransformed rect (no transform applied yet) — gives us the element's
      // natural top-left in the viewport.
      const rect = target.getBoundingClientRect();
      const midX = (t1.clientX + t2.clientX) / 2;
      const midY = (t1.clientY + t2.clientY) / 2;
      target.style.willChange = 'transform';
      // Origin at element top-left so translate + scale composes predictably.
      target.style.transformOrigin = '0 0';
      pinchRef.current = {
        startDist: pinchDistance(e.touches),
        startScale: currentScaleRef.current,
        anchorX: midX - rect.left,
        anchorY: midY - rect.top,
        elementLeft: rect.left,
        elementTop: rect.top,
        scrollLeft0: target.scrollLeft,
        scrollTop0: target.scrollTop,
        targetEl: target,
      };
    }, []);

    const handleTouchMove = useCallback((e: React.TouchEvent) => {
      const pinch = pinchRef.current;
      if (e.touches.length !== 2 || !pinch) return;
      e.preventDefault();
      const t1 = e.touches[0];
      const t2 = e.touches[1];
      const dist = pinchDistance(e.touches);
      if (dist <= 0) return;
      const ratio = dist / pinch.startDist;
      // Clamp commit scale; derive the visual ratio from the clamped value so
      // the gesture stops growing past the limits instead of feeling rubbery.
      const clampedScale = Math.min(4, Math.max(0.5, pinch.startScale * ratio));
      const s = clampedScale / pinch.startScale;
      // Track the current pinch midpoint and translate so the original anchor
      // point stays exactly under the fingers: anchor * s + (tx, ty) == midpoint.
      const midX = (t1.clientX + t2.clientX) / 2;
      const midY = (t1.clientY + t2.clientY) / 2;
      const tx = midX - pinch.elementLeft - pinch.anchorX * s;
      const ty = midY - pinch.elementTop - pinch.anchorY * s;
      pinch.targetEl.style.transform = `translate(${tx}px, ${ty}px) scale(${s})`;
    }, []);

    const handleTouchEnd = useCallback((e: React.TouchEvent) => {
      // Only commit when both fingers have left
      if (e.touches.length >= 2) return;
      const pinch = pinchRef.current;
      pinchRef.current = null;
      if (!pinch) return;
      const target = pinch.targetEl;
      // Recover the final (tx, ty, scale) we applied during the gesture
      const scaleMatch = target.style.transform.match(/scale\(([\d.]+)\)/);
      const translateMatch = target.style.transform.match(
        /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/
      );
      const finalVisualRatio = scaleMatch ? parseFloat(scaleMatch[1]) : 1;
      const tx = translateMatch ? parseFloat(translateMatch[1]) : 0;
      const ty = translateMatch ? parseFloat(translateMatch[2]) : 0;
      const next = Math.min(
        4,
        Math.max(0.5, pinch.startScale * finalVisualRatio)
      );
      // If user barely moved, abort and reset transform immediately
      if (Math.abs(next - pinch.startScale) / pinch.startScale < 0.01) {
        target.style.transform = '';
        target.style.transformOrigin = '';
        target.style.willChange = '';
        return;
      }
      // Compute the scroll position that keeps the anchor point under the
      // final pinch midpoint after pdf.js re-rasterizes at scale=next.
      //
      // During the gesture: anchor lands at viewport (L + tx + anchor * s),
      // where s = next/startScale.
      // After zoomTo(next), the same content point (originally at scrollable
      // coords scrollLeft0 + anchorX) sits at scrollable coords
      // (scrollLeft0 + anchorX) * s. To keep it at the same viewport position
      // (L + tx + anchorX * s), we need:
      //   scrollLeftNew = (scrollLeft0 + anchorX) * s - (tx + anchorX * s)
      //                 = scrollLeft0 * s - tx
      const s = finalVisualRatio;
      const scrollLeftNew = Math.max(0, pinch.scrollLeft0 * s - tx);
      const scrollTopNew = Math.max(0, pinch.scrollTop0 * s - ty);
      pendingTransformCleanupRef.current = {
        el: target,
        expectedScale: next,
        scrollLeftNew,
        scrollTopNew,
      };
      try {
        zoomPluginInstance.zoomTo(next);
      } catch {
        // zoomPlugin not ready — drop transform to avoid stuck scaled view
        target.style.transform = '';
        target.style.transformOrigin = '';
        target.style.willChange = '';
        pendingTransformCleanupRef.current = null;
      }
    }, [zoomPluginInstance]);

    // Track page changes
    const handlePageChange = (e: PageChangeEvent) => {
      const pageNumber = e.currentPage + 1; // Store as 1-indexed for consistency

      // Dispatch custom event for reading position tracking
      const totalPagesCount = pdfDocument?.numPages;
      window.dispatchEvent(
        new CustomEvent('pdfPageChange', {
          detail: {
            pageNumber,
            totalPages: totalPagesCount,
          },
        })
      );
    };

    // Use the exact version that matches the API version shown in the error message
    const workerUrl =
      'https://unpkg.com/pdfjs-dist@3.11.174/build/pdf.worker.min.js';

    // Loading state
    if (isLoadingPdf) {
      return (
        <div
          ref={ref}
          style={{
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
            height: '400px',
            background: theme === 'dark' ? '#1a1a1a' : '#f5f5f5',
            color: theme === 'dark' ? '#fff' : '#000',
          }}
        >
          Loading PDF...
        </div>
      );
    }

    // Error state
    if (pdfError) {
      return (
        <div
          ref={ref}
          style={{
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
            height: '400px',
            background: theme === 'dark' ? '#1a1a1a' : '#f5f5f5',
            color: theme === 'dark' ? '#ff6b6b' : '#d63031',
            flexDirection: 'column',
            padding: '20px',
            textAlign: 'center',
          }}
        >
          <div>Error loading PDF: {pdfError}</div>
          <button
            onClick={() => window.location.reload()}
            style={{
              marginTop: '10px',
              padding: '8px 16px',
              background: theme === 'dark' ? '#333' : '#007bff',
              color: '#fff',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer',
            }}
          >
            Retry
          </button>
        </div>
      );
    }

    // No authenticated URL
    if (!authenticatedUrl) {
      return (
        <div
          ref={ref}
          style={{
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
            height: '400px',
            background: theme === 'dark' ? '#1a1a1a' : '#f5f5f5',
            color: theme === 'dark' ? '#fff' : '#000',
          }}
        >
          No PDF URL provided
        </div>
      );
    }

    // Render PDF viewer with built-in layout
    return (
      <div
        ref={viewerContainerRef}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onTouchCancel={handleTouchEnd}
        style={{
          height: '100%',
          width: '100%',
          background: theme === 'dark' ? '#1a1a1a' : '#fff',
          // pan-x pan-y enables single-finger scroll; pinch-zoom is intentionally
          // omitted so we own the two-finger gesture via zoomPlugin.zoomTo (which
          // triggers a real pdf.js re-rasterization instead of CSS upscaling).
          touchAction: 'pan-x pan-y',
        }}
      >
        <Worker workerUrl={workerUrl}>
          <div
            className='h-full w-full absolute pdf-viewer-worker-container'
            style={{
              touchAction: 'pan-x pan-y',
              // Note: Invert filter is applied to individual pages via global CSS, not the container
            }}
          >
            <Viewer
              fileUrl={authenticatedUrl}
              plugins={[
                defaultLayoutPluginInstance,
                highlightPluginInstance,
                zoomPluginInstance,
              ]}
              theme={{
                theme: theme,
              }}
              onDocumentLoad={handleDocumentLoaded}
              onPageChange={handlePageChange}
              onZoom={handleZoom}
              initialPage={typeof initialPage === 'number' ? initialPage - 1 : 0}
              defaultScale={isMobile ? SpecialZoomLevel.PageFit : undefined}
            />
          </div>
        </Worker>
      </div>
    );
  }
);

PDFViewer.displayName = 'PDFViewer';

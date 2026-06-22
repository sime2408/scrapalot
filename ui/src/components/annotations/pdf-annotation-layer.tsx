/**
 * PDF Annotation Layer — renders persistent annotation highlights directly as
 * overlaid divs, captures text selection, and provides click-to-delete via hover popover.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SelectionPopover, AnnotationHoverPopover } from './annotation-popover';
import { ShareAnnotationDialog } from './share-annotation-dialog';
import { ExplainPanel } from './explain-panel';
import { SimilarPanel } from './similar-panel';
import type { Annotation, PdfAnnotationPosition } from '@/types/annotations';
import { parseAnnotationPosition } from '@/types/annotations';

export interface TransientHighlight {
  /** 1-based PDF page number */
  page: number;
  charOffsetStart?: number;
  charOffsetEnd?: number;
  bbox?: number[];
  ttlSeconds?: number;
  issuedAt: number;
}

interface PdfAnnotationLayerProps {
  annotations: Annotation[];
  activeTool: number | null;
  activeColor: string;
  /** Forwarded into the SelectionPopover so the user can pick a tool
   *  (highlight / underline / strikethrough / note / area-capture)
   *  before tapping a colour swatch. */
  onActiveToolChange?: (tool: 1 | 2 | 3 | 4 | 5) => void;
  onCreateAnnotation: (
    selectedText: string,
    position: PdfAnnotationPosition,
    pageLabel?: string,
    color?: string,
    comment?: string,
    toolOverride?: 1 | 2 | 3 | 4 | 5,
  ) => Promise<void>;
  onDeleteAnnotation: (annotationId: string) => Promise<void>;
  onUpdateComment: (annotationId: string, comment: string) => Promise<void>;
  onUpdateTags?: (annotationId: string, tagIds: string[]) => Promise<void>;
  viewerContainerRef: React.RefObject<HTMLDivElement>;
  documentId?: string;
  documentTitle?: string;
  transientHighlight?: TransientHighlight;
  onTransientHighlightExpired?: () => void;
}

export function PdfAnnotationLayer({
  annotations,
  activeTool,
  activeColor,
  onActiveToolChange,
  onCreateAnnotation,
  onDeleteAnnotation,
  onUpdateComment,
  onUpdateTags,
  viewerContainerRef,
  documentId,
  documentTitle,
  transientHighlight,
  onTransientHighlightExpired,
}: PdfAnnotationLayerProps) {
  const [selectionPopover, setSelectionPopover] = useState<{
    x: number;
    y: number;
    text: string;
    position: PdfAnnotationPosition;
    pageLabel: string;
  } | null>(null);
  // Hoisted from AnnotationHoverPopover — see comment on
  // AnnotationHoverPopoverProps.onRequestShare. Radix Dialog modal
  // backdrop dismissed the popover when the dialog mounted as a child,
  // unmounting the dialog along with it. Mounting the dialog here
  // sidesteps the parent/child unmount cascade.
  const [shareTarget, setShareTarget] = useState<{ id: string; selected_text: string | null | undefined } | null>(null);
  const [hoverPopover, setHoverPopover] = useState<{
    annotation: Annotation;
    x: number;
    y: number;
  } | null>(null);

  // Explain panel state — opened via the "Explain" action on a selection.
  // Holds the full selection + surrounding paragraph to give the LLM context.
  const [explainState, setExplainState] = useState<{
    text: string;
    contextBefore: string;
    contextAfter: string;
  } | null>(null);

  // Similar-search panel state — opened via the "Similar" action.
  const [similarText, setSimilarText] = useState<string | null>(null);

  // Area capture state
  const [areaSelection, setAreaSelection] = useState<{
    startX: number;
    startY: number;
    currentX: number;
    currentY: number;
    pageIndex: number;
    pageRect: DOMRect;
  } | null>(null);
  const isDrawingArea = useRef(false);

  const popoverVisibleRef = useRef(false);
  popoverVisibleRef.current = !!selectionPopover;

  const isInsideViewer = useCallback((node: Node | null): boolean => {
    if (!node || !viewerContainerRef.current) return false;
    const el = node instanceof Element ? node : node.parentElement;
    return !!el && viewerContainerRef.current.contains(el);
  }, [viewerContainerRef]);

  const captureSelection = useCallback(() => {
    if (popoverVisibleRef.current) return;
    if (!viewerContainerRef.current) return;

    const selection = document.getSelection();
    if (!selection || selection.isCollapsed) return;

    const selectedText = selection.toString().trim();
    if (selectedText.length < 2) return;
    if (!isInsideViewer(selection.anchorNode)) return;

    const range = selection.getRangeAt(0);
    const clientRects = range.getClientRects();
    if (clientRects.length === 0) return;

    const startEl = range.startContainer instanceof Element
      ? range.startContainer
      : range.startContainer.parentElement;

    const pageLayer = startEl?.closest('.rpv-core__page-layer');
    if (!pageLayer) return;

    const allPages = viewerContainerRef.current.querySelectorAll('.rpv-core__page-layer');
    let pageIndex = Array.from(allPages).indexOf(pageLayer as Element);
    if (pageIndex === -1) {
      const pageNum = pageLayer.getAttribute('data-page-number');
      if (pageNum) pageIndex = parseInt(pageNum, 10) - 1;
    }
    if (pageIndex === -1) return;

    const textLayer = pageLayer.querySelector('.rpv-core__text-layer') || pageLayer;
    const pageBounds = textLayer.getBoundingClientRect();

    // Per-line merge tolerance derived from the actual line height.
    // Previous fixed `< 2` (in %-of-page units) collapsed adjacent
    // lines into one because 2% of a typical 700-px page = 14 px,
    // larger than the ~16-px line spacing — every other line was
    // discarded. We want to dedupe rects on the *same* line (browser
    // emits one per text-span) without ever pulling in the rect on
    // the next line.
    const rawRects = Array.from(clientRects)
      .filter((r) => r.width > 1 && r.height > 3)
      .map((rect) => ({
        left: Math.max(0, ((rect.left - pageBounds.left) / pageBounds.width) * 100),
        top: Math.max(0, ((rect.top - pageBounds.top) / pageBounds.height) * 100),
        width: Math.min(100, (rect.width / pageBounds.width) * 100),
        height: Math.min(100, (rect.height / pageBounds.height) * 100),
      }));

    // Half a line height keeps rects on the same line together but
    // never absorbs the rect above or below.
    const lineMergeTolerance = rawRects.length > 0
      ? Math.max(0.2, (rawRects[0].height || 1) * 0.4)
      : 0.4;

    const rects: typeof rawRects = [];
    for (const rect of rawRects) {
      if (rect.width < 0.4) continue; // skip edge slivers (~5 px on a 1200-px page)
      const existing = rects.find(r => Math.abs(r.top - rect.top) < lineMergeTolerance);
      if (existing) {
        const minLeft = Math.min(existing.left, rect.left);
        const maxRight = Math.max(existing.left + existing.width, rect.left + rect.width);
        existing.left = minLeft;
        existing.width = maxRight - minLeft;
        existing.height = Math.max(existing.height, rect.height);
      } else {
        rects.push({ ...rect });
      }
    }
    if (rects.length === 0) return;

    const position: PdfAnnotationPosition = { type: 'pdf', page_index: pageIndex, rects };

    const lastRect = clientRects[clientRects.length - 1];
    const drawerEl = viewerContainerRef.current?.closest('[data-testid="pdf-viewer-drawer"]');
    const drawerRect = drawerEl?.getBoundingClientRect() || { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
    const popX = Math.max(8, Math.min(lastRect.left - drawerRect.left + lastRect.width / 2, drawerRect.width - 220));
    const popY = Math.max(8, Math.min(lastRect.bottom - drawerRect.top + 4, drawerRect.height - 120));

    setSelectionPopover({ x: popX, y: popY, text: selectedText, position, pageLabel: String(pageIndex + 1) });
  }, [isInsideViewer, viewerContainerRef]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    // pointerup catches the desktop mouse-drag-release flow.
    // selectionchange catches mobile (long-press + handle drag) where
    // the touch sequence may never produce a clean pointerup on the
    // document — Chrome/Safari only fire pointerup on the selection
    // handle, not on document. Both feed the same debounced
    // captureSelection; the function early-returns on collapsed or
    // tiny selections so duplicate firings are cheap.
    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(captureSelection, 250);
    };
    document.addEventListener('pointerup', schedule);
    document.addEventListener('selectionchange', schedule);
    return () => {
      document.removeEventListener('pointerup', schedule);
      document.removeEventListener('selectionchange', schedule);
      if (timer) clearTimeout(timer);
    };
  }, [activeTool, captureSelection]);

  // Area capture mouse handlers
  useEffect(() => {
    if (activeTool !== 4) return; // Only active when AREA_CAPTURE tool selected
    const container = viewerContainerRef.current;
    if (!container) return;

    const handleMouseDown = (e: MouseEvent) => {
      const pageLayer = (e.target as Element)?.closest('.rpv-core__page-layer');
      if (!pageLayer) return;
      const pageRect = pageLayer.getBoundingClientRect();
      const allPages = container.querySelectorAll('.rpv-core__page-layer');
      const pageIndex = Array.from(allPages).indexOf(pageLayer);

      isDrawingArea.current = true;
      setAreaSelection({
        startX: e.clientX - pageRect.left,
        startY: e.clientY - pageRect.top,
        currentX: e.clientX - pageRect.left,
        currentY: e.clientY - pageRect.top,
        pageIndex,
        pageRect,
      });
    };

    const handleMouseMove = (e: MouseEvent) => {
      if (!isDrawingArea.current) return;
      setAreaSelection(prev => prev ? {
        ...prev,
        currentX: e.clientX - prev.pageRect.left,
        currentY: e.clientY - prev.pageRect.top,
      } : null);
    };

    const handleMouseUp = async () => {
      if (!isDrawingArea.current || !areaSelection) { isDrawingArea.current = false; return; }
      isDrawingArea.current = false;

      const { startX, startY, currentX, currentY, pageIndex, pageRect } = areaSelection;
      const left = Math.min(startX, currentX) / pageRect.width * 100;
      const top = Math.min(startY, currentY) / pageRect.height * 100;
      const width = Math.abs(currentX - startX) / pageRect.width * 100;
      const height = Math.abs(currentY - startY) / pageRect.height * 100;

      // Skip tiny selections (< 1% of page)
      if (width < 1 || height < 1) { setAreaSelection(null); return; }

      const position: PdfAnnotationPosition = {
        type: 'pdf',
        page_index: pageIndex,
        rects: [{ left, top, width, height }],
      };

      await onCreateAnnotation('', position, String(pageIndex + 1), activeColor, 'Area capture');
      setAreaSelection(null);
    };

    container.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      container.removeEventListener('mousedown', handleMouseDown);
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTool, activeColor, viewerContainerRef, areaSelection]);

  const handleConfirm = useCallback(
    async (color: string, comment?: string, toolOverride?: 1 | 2 | 3 | 4 | 5) => {
      if (!selectionPopover) return;
      console.log('\uD83D\uDCBE [Annotation] Saving:', selectionPopover.text.substring(0, 40), 'color:', color, 'tool:', toolOverride ?? 'default');
      await onCreateAnnotation(selectionPopover.text, { ...selectionPopover.position }, selectionPopover.pageLabel, color, comment, toolOverride);
      setSelectionPopover(null);
      document.getSelection()?.removeAllRanges();
    },
    [selectionPopover, onCreateAnnotation]
  );

  const handleCite = useCallback((text: string) => {
    const page = selectionPopover?.pageLabel;
    window.dispatchEvent(new CustomEvent('insert-citation-into-note', {
      detail: { text, title: documentTitle, page, documentId },
    }));
    setSelectionPopover(null);
    document.getSelection()?.removeAllRanges();
  }, [selectionPopover, documentId, documentTitle]);

  /**
   * Collect surrounding-paragraph context for the Explain panel.
   * We read the two sibling text containers (previous + next) inside the PDF
   * text layer — these are the rendered paragraph spans. If unavailable, we
   * send empty context and let the LLM work from the selection alone.
   */
  const handleExplain = useCallback((text: string) => {
    let contextBefore = '';
    let contextAfter = '';
    try {
      const selection = document.getSelection();
      const startEl = selection?.anchorNode instanceof Element
        ? selection.anchorNode
        : selection?.anchorNode?.parentElement ?? null;
      const pageLayer = startEl?.closest('.rpv-core__page-layer');
      const textLayer = pageLayer?.querySelector('.rpv-core__text-layer');
      if (textLayer && startEl) {
        const spans = Array.from(textLayer.querySelectorAll<HTMLElement>('span'));
        const hostSpan = (startEl.closest('span') ?? startEl) as HTMLElement | null;
        const idx = hostSpan ? spans.indexOf(hostSpan) : -1;
        if (idx >= 0) {
          contextBefore = spans
            .slice(Math.max(0, idx - 6), idx)
            .map(s => s.textContent || '')
            .join(' ')
            .trim()
            .slice(-600);
          contextAfter = spans
            .slice(idx + 1, idx + 7)
            .map(s => s.textContent || '')
            .join(' ')
            .trim()
            .slice(0, 600);
        }
      }
    } catch {
      /* best-effort — empty context is fine */
    }
    setExplainState({ text, contextBefore, contextAfter });
    setSelectionPopover(null);
    document.getSelection()?.removeAllRanges();
  }, []);

  const handleSimilar = useCallback((text: string) => {
    setSimilarText(text);
    setSelectionPopover(null);
    document.getSelection()?.removeAllRanges();
  }, []);

  const parsedAnnotations = useMemo(() => {
    return annotations.flatMap(ann => {
      try {
        const pos = parseAnnotationPosition(ann.position_json);
        if (!pos || pos.type !== 'pdf' || !('rects' in pos)) return [];
        return (pos as PdfAnnotationPosition).rects
          .filter(r => r.width > 1.5)
          .map(r => ({ ...r, annotationId: ann.id, color: ann.color, annotationType: ann.annotation_type, pageIndex: pos.page_index, annotation: ann }));
      } catch { return []; }
    });
  }, [annotations]);

  /**
   * One gutter pin per annotation that carries a comment. Anchored to the
   * top-most rect so it stays close to the highlight, rendered in the
   * page's right margin (NOT over the text), Notion-style.
   */
  const gutterPins = useMemo(() => {
    type Pin = {
      annotationId: string;
      annotation: Annotation;
      color: string;
      pageIndex: number;
      anchorTop: number;
    };
    const byAnnotation = new Map<string, Pin>();
    for (const ann of annotations) {
      const comment = (ann.comment || '').trim();
      if (!comment) continue;
      try {
        const pos = parseAnnotationPosition(ann.position_json);
        if (!pos || pos.type !== 'pdf' || !('rects' in pos)) continue;
        const topRect = (pos as PdfAnnotationPosition).rects.reduce<{ top: number } | null>(
          (acc, r) => (acc === null || r.top < acc.top ? { top: r.top } : acc),
          null
        );
        if (!topRect) continue;
        byAnnotation.set(ann.id, {
          annotationId: ann.id,
          annotation: ann,
          color: ann.color,
          pageIndex: pos.page_index,
          anchorTop: topRect.top,
        });
      } catch {
        /* ignore */
      }
    }
    return Array.from(byAnnotation.values());
  }, [annotations]);

  // Compute clip-path inset for an overlay so it never paints outside
  // `.rpv-core__inner-pages` (the visible PDF reading area). Without this,
  // position:fixed overlays with high z-index draw over the drawer header
  // and the rpv-toolbar at the top of the viewer.
  const computeClipInset = useCallback(
    (left: number, top: number, width: number, height: number, visible: { top: number; right: number; bottom: number; left: number } | null) => {
      if (!visible) return undefined;
      const insetTop = Math.max(0, visible.top - top);
      const insetLeft = Math.max(0, visible.left - left);
      const insetRight = Math.max(0, left + width - visible.right);
      const insetBottom = Math.max(0, top + height - visible.bottom);
      if (insetTop === 0 && insetLeft === 0 && insetRight === 0 && insetBottom === 0) return undefined;
      return `inset(${insetTop}px ${insetRight}px ${insetBottom}px ${insetLeft}px)`;
    },
    []
  );

  // Render overlays using position:fixed in viewport coordinates. The drawer
  // is position:fixed without a transform, so it does NOT establish a
  // containing block for fixed-positioned descendants — they must be anchored
  // to the viewport directly. getBoundingClientRect already returns viewport
  // coords, so we use them as-is. clipPath clamps each overlay to the visible
  // .rpv-core__inner-pages rect (also viewport-absolute).
  const renderOverlays = useCallback(() => {
    if (!viewerContainerRef.current || parsedAnnotations.length === 0) return null;
    const pages = viewerContainerRef.current.querySelectorAll('.rpv-core__page-layer');
    if (pages.length === 0) return null;

    const drawerEl = viewerContainerRef.current?.closest('[data-testid="pdf-viewer-drawer"]');
    const drawerRect = drawerEl?.getBoundingClientRect();
    const innerEl = viewerContainerRef.current.querySelector('.rpv-core__inner-pages');
    const innerRect = innerEl?.getBoundingClientRect();
    const visible = innerRect
      ? {
          top: innerRect.top,
          left: innerRect.left,
          right: innerRect.right,
          bottom: innerRect.bottom,
        }
      : null;

    return parsedAnnotations.map((rect, idx) => {
      const page = pages[rect.pageIndex] as HTMLElement;
      if (!page) return null;
      const textLayer = (page.querySelector('.rpv-core__text-layer') || page) as HTMLElement;
      const pageBounds = textLayer.getBoundingClientRect();

      const baseLeft = pageBounds.left;
      const baseTop = pageBounds.top;

      const left = baseLeft + (rect.left / 100) * pageBounds.width;
      const top = baseTop + (rect.top / 100) * pageBounds.height;
      const width = (rect.width / 100) * pageBounds.width;
      const height = Math.max((rect.height / 100) * pageBounds.height, 4);
      const isUnderline = rect.annotationType === 3;
      const isStrikethrough = rect.annotationType === 5;

      const overlayBackground = isUnderline || isStrikethrough ? 'transparent' : `${rect.color}50`;
      const clipPath = computeClipInset(left, top, width, height, visible);

      return (
        <div
          key={`ann-${rect.annotationId}-${idx}`}
          style={{
            position: 'fixed',
            left, top, width, height,
            backgroundColor: overlayBackground,
            borderBottom: isUnderline ? `3px solid ${rect.color}` : 'none',
            cursor: 'pointer',
            zIndex: 9999,
            pointerEvents: 'auto',
            borderRadius: '2px',
            clipPath,
          }}
          onClick={(e) => {
            e.stopPropagation();
            e.preventDefault();
            const popX = drawerRect ? e.clientX - drawerRect.left : e.clientX;
            const popY = drawerRect ? e.clientY - drawerRect.top : e.clientY;
            setHoverPopover({ annotation: rect.annotation, x: popX, y: popY });
          }}
        >
          {isStrikethrough && (
            <span
              aria-hidden
              style={{
                position: 'absolute',
                left: 0,
                right: 0,
                top: '50%',
                height: 2,
                backgroundColor: rect.color,
                transform: 'translateY(-1px)',
                pointerEvents: 'none',
              }}
            />
          )}
        </div>
      );
    });
  }, [parsedAnnotations, viewerContainerRef, computeClipInset]);

  /**
   * Gutter sticky-note icons. Rendered just outside the right edge of
   * each PDF page so they don't obscure the text. Click opens the
   * existing annotation hover popover (read/edit comment).
   */
  const renderGutterPins = useCallback(() => {
    if (!viewerContainerRef.current || gutterPins.length === 0) return null;

    const drawerEl = viewerContainerRef.current.closest('[data-testid="pdf-viewer-drawer"]');
    const drawerRect = drawerEl?.getBoundingClientRect();
    // Inner-pages is the actual VISIBLE viewport into the PDF. The
    // page-layer often renders wider than this container at high zoom
    // and the overflow gets clipped. Pin needs to sit just inside the
    // visible viewport, not in the clipped overflow.
    const innerEl = viewerContainerRef.current.querySelector('.rpv-core__inner-pages');
    const innerRect = innerEl?.getBoundingClientRect();
    const visible = innerRect
      ? {
          top: innerRect.top,
          left: innerRect.left,
          right: innerRect.right,
          bottom: innerRect.bottom,
        }
      : null;

    return gutterPins.map((pin) => {
      // rpv-core virtualises pages — only ~8 page-layers around the current
      // scroll are mounted, with their absolute page index in
      // `data-virtual-index`. Indexing the rendered NodeList positionally
      // (`pages[pin.pageIndex]`) only happens to be correct when the viewer
      // is parked near page 0; for any other scroll it picks the wrong page.
      const page = viewerContainerRef.current!.querySelector(
        `.rpv-core__page-layer[data-virtual-index="${pin.pageIndex}"]`
      ) as HTMLElement | null;
      if (!page) return null;
      const textLayer = (page.querySelector('.rpv-core__text-layer') || page) as HTMLElement;
      const pageBounds = textLayer.getBoundingClientRect();

      // Anchor the pin on the LEFT side, just inside the visible
      // viewport — the right edge often coincides with the drawer edge
      // (or a side panel) and the pin gets clipped or floats off-screen.
      // Coords are viewport-absolute (matching position:fixed semantics).
      const PIN_WIDTH = 18;
      const PIN_LEFT_MARGIN = 4;
      const visibleLeft = innerRect ? Math.max(pageBounds.left, innerRect.left) : pageBounds.left;
      const baseLeft = visibleLeft;
      const baseTop = pageBounds.top;
      const left = baseLeft + PIN_LEFT_MARGIN;
      const top = baseTop + (pin.anchorTop / 100) * pageBounds.height - 8;
      const clipPath = computeClipInset(left, top, PIN_WIDTH, 18, visible);

      return (
        <button
          key={`gutter-${pin.annotationId}`}
          type="button"
          data-testid={`pdf-gutter-pin-${pin.annotationId}`}
          aria-label="Open note"
          title={pin.annotation.comment || ''}
          style={{
            position: 'fixed',
            left,
            top,
            width: 18,
            height: 18,
            backgroundColor: pin.color,
            border: '1px solid rgba(0,0,0,0.18)',
            borderRadius: 2,
            cursor: 'pointer',
            zIndex: 9999,
            padding: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxShadow: '0 1px 2px rgba(0,0,0,0.18)',
            clipPath,
          }}
          onClick={(e) => {
            e.stopPropagation();
            e.preventDefault();
            const popX = drawerRect ? e.clientX - drawerRect.left : e.clientX;
            const popY = drawerRect ? e.clientY - drawerRect.top : e.clientY;
            setHoverPopover({ annotation: pin.annotation, x: popX, y: popY });
          }}
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            width="11"
            height="11"
            fill="none"
            stroke="rgba(0,0,0,0.55)"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d="M16 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8z" />
            <polyline points="14 3 14 8 21 8" />
          </svg>
        </button>
      );
    });
  }, [gutterPins, viewerContainerRef, computeClipInset]);

  // Re-render overlays on scroll (position:fixed needs recalc when pages scroll).
  // rpv-core mounts `.rpv-core__inner-pages` lazily AFTER the PDF document loads,
  // so attaching a listener at mount time silently misses it (querySelector returns
  // null, listener falls through to a non-scrolling parent, gutter pins never
  // recompute and end up positioned in the original render's scroll frame —
  // off-screen for any later page jump). Use a MutationObserver to retry the
  // querySelector until the scrollable element actually exists.
  const [, setRenderTick] = useState(0);
  useEffect(() => {
    const container = viewerContainerRef.current;
    if (!container) return;
    const handleChange = () => setRenderTick(t => t + 1);
    let scrollEl: Element | null = null;
    const resizeObserver = new ResizeObserver(handleChange);

    const tryAttach = () => {
      const candidate = container.querySelector('.rpv-core__inner-pages');
      if (candidate && candidate !== scrollEl) {
        if (scrollEl) {
          scrollEl.removeEventListener('scroll', handleChange);
          resizeObserver.unobserve(scrollEl);
        }
        scrollEl = candidate;
        scrollEl.addEventListener('scroll', handleChange, { passive: true });
        // Width of the visible PDF viewport changes when a side panel
        // (notes / multimodal) toggles open or closed. Without a resize
        // observer the gutter pin sticks to its old `pageBounds.right`
        // and floats over the side panel.
        resizeObserver.observe(scrollEl);
        // Force an initial recalc once the scroller is found — the original
        // render computed positions before the PDF was loaded.
        setRenderTick(t => t + 1);
      }
    };

    tryAttach();
    const observer = new MutationObserver(tryAttach);
    observer.observe(container, { childList: true, subtree: true });

    // Recompute overlay coords when the floating PDF drawer is dragged
    // or resized. The drawer mutates its inline `left`/`top`/`width`/
    // `height` during drag; without this listener the position:fixed
    // overlays stay anchored to the original viewport coords and "leak"
    // out of the panel.
    const drawerEl = container.closest('[data-testid="pdf-viewer-drawer"]');
    let drawerStyleObserver: MutationObserver | null = null;
    if (drawerEl) {
      resizeObserver.observe(drawerEl);
      drawerStyleObserver = new MutationObserver(handleChange);
      drawerStyleObserver.observe(drawerEl, { attributes: true, attributeFilter: ['style'] });
    }

    return () => {
      observer.disconnect();
      resizeObserver.disconnect();
      if (drawerStyleObserver) drawerStyleObserver.disconnect();
      if (scrollEl) scrollEl.removeEventListener('scroll', handleChange);
    };
  }, [viewerContainerRef]);

  // Transient highlight visibility — driven by two effects below. The TTL
  // doesn't start until the cited page-layer is actually mounted in the
  // DOM (rpv-core lazily renders pages as it scrolls to the target page;
  // starting the timer at click-time makes the pulse expire before the
  // page is even visible).
  const [transientVisible, setTransientVisible] = useState(false);

  // Effect 1: clear visibility when transientHighlight goes away.
  useEffect(() => {
    if (!transientHighlight) setTransientVisible(false);
  }, [transientHighlight]);

  // Effect 2: wait for the cited page-layer to mount, THEN flip visible
  // and start the TTL countdown. Uses a MutationObserver to react to
  // rpv-core finishing its lazy mount + zoom transition.
  useEffect(() => {
    if (!transientHighlight || !viewerContainerRef.current) return;
    const target = String(Math.max(0, (transientHighlight.page ?? 1) - 1));
    const ttlMs = (transientHighlight.ttlSeconds ?? 3) * 1000;
    let ttlTimer: ReturnType<typeof setTimeout> | null = null;

    const arm = () => {
      if (ttlTimer) return; // already armed for this issuedAt
      setTransientVisible(true);
      setRenderTick(t => t + 1);
      ttlTimer = setTimeout(() => {
        setTransientVisible(false);
        onTransientHighlightExpired?.();
      }, ttlMs);
    };

    if (viewerContainerRef.current.querySelector(`.rpv-core__page-layer[data-virtual-index="${target}"]`)) {
      arm();
    } else {
      const observer = new MutationObserver(() => {
        if (viewerContainerRef.current?.querySelector(`.rpv-core__page-layer[data-virtual-index="${target}"]`)) {
          observer.disconnect();
          arm();
        }
      });
      observer.observe(viewerContainerRef.current, { childList: true, subtree: true });
      return () => {
        observer.disconnect();
        if (ttlTimer) clearTimeout(ttlTimer);
      };
    }

    return () => {
      if (ttlTimer) clearTimeout(ttlTimer);
    };
  }, [transientHighlight, viewerContainerRef, onTransientHighlightExpired]);

  const renderTransientOverlay = useCallback(() => {
    if (!transientVisible || !transientHighlight || !viewerContainerRef.current) return null;
    const pageIndex = Math.max(0, (transientHighlight.page ?? 1) - 1);
    // Virtualised page lookup — see renderGutterPins above for why
    // positional indexing (`pages[pageIndex]`) is wrong when the viewer
    // has scrolled away from page 0.
    const page = viewerContainerRef.current.querySelector(
      `.rpv-core__page-layer[data-virtual-index="${pageIndex}"]`
    ) as HTMLElement | null;
    if (!page) return null;

    const drawerEl = viewerContainerRef.current.closest('[data-testid="pdf-viewer-drawer"]');
    const drawerRect = drawerEl?.getBoundingClientRect();
    const textLayer = (page.querySelector('.rpv-core__text-layer') || page) as HTMLElement;
    const pageBounds = textLayer.getBoundingClientRect();

    const left = (drawerRect ? pageBounds.left - drawerRect.left : pageBounds.left) - 4;
    const top = (drawerRect ? pageBounds.top - drawerRect.top : pageBounds.top) - 4;
    const width = pageBounds.width + 8;
    const height = pageBounds.height + 8;

    const innerEl = viewerContainerRef.current.querySelector('.rpv-core__inner-pages');
    const innerRect = innerEl?.getBoundingClientRect();
    const visible = innerRect && drawerRect
      ? {
          top: innerRect.top - drawerRect.top,
          left: innerRect.left - drawerRect.left,
          right: innerRect.right - drawerRect.left,
          bottom: innerRect.bottom - drawerRect.top,
        }
      : null;
    const clipPath = computeClipInset(left, top, width, height, visible);

    return (
      <div
        data-testid="pdf-transient-highlight"
        className="animate-pulse"
        style={{
          position: 'fixed',
          left, top, width, height,
          border: '3px solid #ffd400',
          backgroundColor: 'rgba(255, 212, 0, 0.08)',
          boxShadow: '0 0 24px rgba(255, 212, 0, 0.55)',
          pointerEvents: 'none',
          zIndex: 9998,
          borderRadius: 4,
          clipPath,
        }}
      />
    );
  }, [transientVisible, transientHighlight, viewerContainerRef, computeClipInset]);

  return (
    <>
      {renderOverlays()}
      {renderGutterPins()}
      {renderTransientOverlay()}

      {selectionPopover && (
        <SelectionPopover
          position={{ x: selectionPopover.x, y: selectionPopover.y }}
          activeColor={activeColor}
          activeTool={activeTool as 1 | 2 | 3 | 4 | 5 | null}
          onToolChange={onActiveToolChange}
          onConfirm={handleConfirm}
          onCancel={() => setSelectionPopover(null)}
          onCite={handleCite}
          onExplain={handleExplain}
          onSimilar={handleSimilar}
          selectedText={selectionPopover.text}
        />
      )}

      {explainState && (
        <ExplainPanel
          open={!!explainState}
          onOpenChange={(open) => !open && setExplainState(null)}
          selectedText={explainState.text}
          contextBefore={explainState.contextBefore}
          contextAfter={explainState.contextAfter}
          documentTitle={documentTitle}
        />
      )}

      {similarText && (
        <SimilarPanel
          open={!!similarText}
          onOpenChange={(open) => !open && setSimilarText(null)}
          selectedText={similarText}
          excludeDocumentId={documentId}
        />
      )}

      {/* Area selection drawing overlay */}
      {areaSelection && (
        <div
          className="fixed pointer-events-none z-[9998] border-2 border-dashed"
          style={{
            left: areaSelection.pageRect.left + Math.min(areaSelection.startX, areaSelection.currentX),
            top: areaSelection.pageRect.top + Math.min(areaSelection.startY, areaSelection.currentY),
            width: Math.abs(areaSelection.currentX - areaSelection.startX),
            height: Math.abs(areaSelection.currentY - areaSelection.startY),
            borderColor: activeColor,
            backgroundColor: `${activeColor}20`,
          }}
        />
      )}

      {hoverPopover && (
        <AnnotationHoverPopover
          annotation={hoverPopover.annotation}
          position={{ x: hoverPopover.x, y: hoverPopover.y }}
          onDelete={async (id) => {
            await onDeleteAnnotation(id);
            setHoverPopover(null);
          }}
          onUpdateComment={async (id, comment) => {
            await onUpdateComment(id, comment);
            setHoverPopover(null);
          }}
          onUpdateTags={onUpdateTags}
          onClose={() => setHoverPopover(null)}
          onRequestShare={() => {
            setShareTarget({ id: hoverPopover.annotation.id, selected_text: hoverPopover.annotation.selected_text });
          }}
        />
      )}

      {shareTarget && (
        <ShareAnnotationDialog
          annotationId={shareTarget.id}
          selectedText={shareTarget.selected_text}
          open={!!shareTarget}
          onOpenChange={(open) => { if (!open) setShareTarget(null); }}
        />
      )}
    </>
  );
}

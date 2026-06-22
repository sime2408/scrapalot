/**
 * EPUB Annotation Layer — renders persistent annotations and captures text selection.
 *
 * EPUB uses CFI (Canonical Fragment Identifier) for positioning,
 * and DOM-based highlighting inside the epub.js iframe.
 *
 * Unlike PDF (percentage-based rects), EPUB annotations:
 * - Store CFI string as position (semantic, survives reflow)
 * - Render by injecting CSS styles into the iframe
 * - Capture selection via iframe's getSelection() API
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { SelectionPopover, AnnotationHoverPopover } from './annotation-popover';
import { ShareAnnotationDialog } from './share-annotation-dialog';
import { ExplainPanel } from './explain-panel';
import { SimilarPanel } from './similar-panel';
import type { Annotation, EpubAnnotationPosition } from '@/types/annotations';
import type { Rendition } from 'epubjs';

interface EpubAnnotationLayerProps {
  annotations: Annotation[];
  activeTool: number | null;
  activeColor: string;
  /** Forwarded into the SelectionPopover so the user can pick a tool
   *  before tapping a colour swatch (highlight / underline /
   *  strikethrough / note). Area-capture is PDF-only. */
  onActiveToolChange?: (tool: 1 | 2 | 3 | 4 | 5) => void;
  onCreateAnnotation: (
    selectedText: string,
    position: EpubAnnotationPosition,
    pageLabel?: string,
    color?: string,
    comment?: string,
    toolOverride?: 1 | 2 | 3 | 4 | 5,
  ) => Promise<void>;
  onDeleteAnnotation: (annotationId: string) => Promise<void>;
  onUpdateComment: (annotationId: string, comment: string) => Promise<void>;
  /** epubjs Rendition instance */
  rendition: Rendition | null;
  documentId?: string;
  documentTitle?: string;
}

export function EpubAnnotationLayer({
  annotations,
  activeTool,
  activeColor,
  onActiveToolChange,
  onCreateAnnotation,
  onDeleteAnnotation,
  onUpdateComment,
  rendition,
  documentId,
  documentTitle,
}: EpubAnnotationLayerProps) {
  const [selectionPopover, setSelectionPopover] = useState<{
    x: number;
    y: number;
    text: string;
    cfi: string;
    sectionIndex: number;
  } | null>(null);
  // Hoisted from AnnotationHoverPopover so the share dialog isn't a
  // child of the popover. Without this, Radix Dialog's modal backdrop
  // dismisses the popover and unmounts the dialog along with it.
  const [shareTarget, setShareTarget] = useState<{ id: string; selected_text: string | null | undefined } | null>(null);
  const [hoverPopover, setHoverPopover] = useState<{
    annotation: Annotation;
    x: number;
    y: number;
  } | null>(null);
  const [explainState, setExplainState] = useState<{
    text: string;
    contextBefore: string;
    contextAfter: string;
  } | null>(null);
  const [similarText, setSimilarText] = useState<string | null>(null);
  const appliedHighlightsRef = useRef<Set<string>>(new Set());

  // Guard: skip capture when popover is already showing
  const popoverVisibleRef = useRef(false);
  popoverVisibleRef.current = !!selectionPopover;

  // Find the epub iframe — try rendition manager first, fallback to DOM query
  const findIframe = useCallback((): HTMLIFrameElement | null => {
    let iframe: HTMLIFrameElement | null = null;
    if (rendition) {
      const manager = // eslint-disable-next-line @typescript-eslint/no-explicit-any -- epub.js internal API not exposed in types
      (rendition as any).manager;
      iframe = manager?.container?.querySelector('iframe');
    }
    if (!iframe) {
      const drawer = document.querySelector('[data-testid="epub-viewer-drawer"]');
      iframe = drawer?.querySelector('iframe') || null;
    }
    return iframe;
  }, [rendition]);

  // Capture text selection in epub iframe
  const handleMouseUp = useCallback(() => {
    if (popoverVisibleRef.current) return;
    try {
      // Find iframe — try rendition first, fallback to DOM query
      const iframe = findIframe();
      if (!iframe?.contentDocument) return;

      const selection = iframe.contentDocument.getSelection();
      if (!selection || selection.isCollapsed || !selection.toString().trim()) return;

      const selectedText = selection.toString().trim();
      if (selectedText.length < 2) return;

      // Get exact text-range CFI from selection using epub.js contents.cfiFromRange()
      // This produces a CFI like epubcfi(/6/6!/4/2/1:0,/2/1:7) that identifies the exact
      // text range, enabling rendition.annotations.highlight() to render correctly.
      const range = selection.getRangeAt(0);
      let cfi = '';
      let sectionIndex = 0;
      if (rendition) {
        const currentLocation = rendition.currentLocation();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- epub.js currentLocation() returns untyped object
        sectionIndex = (currentLocation as any)?.start?.index || 0;

        // Try to get exact range CFI from epub.js contents
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- epub.js internal API not exposed in types
          const contents = (rendition as any).getContents?.();
          const content = contents?.[0] || contents;
          if (content?.cfiFromRange) {
            cfi = content.cfiFromRange(range);
          }
        } catch { /* fallback below */ }

        // Fallback to section-level CFI if range CFI failed
        if (!cfi) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- epub.js currentLocation() returns untyped object
          cfi = (currentLocation as any)?.start?.cfi || '';
        }
      }

      const rect = range.getBoundingClientRect();
      const iframeRect = iframe.getBoundingClientRect();
      const drawerEl = document.querySelector('[data-testid="epub-viewer-drawer"]');
      const drawerRect = drawerEl?.getBoundingClientRect() || { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };

      const popX = Math.max(8, Math.min(iframeRect.left - drawerRect.left + rect.right, drawerRect.width - 220));
      const popY = Math.max(8, Math.min(iframeRect.top - drawerRect.top + rect.bottom + 4, drawerRect.height - 120));

      console.log('[EPUB Annotation] Selection:', selectedText.substring(0, 30), 'cfi:', cfi.substring(0, 30));

      setSelectionPopover({
        x: popX,
        y: popY,
        text: selectedText,
        cfi: cfi || `epubcfi(/6/${sectionIndex * 2 + 2}!/4/1:0)`,
        sectionIndex,
      });
    } catch (err) {
      console.error('EPUB annotation selection error:', err);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are intentionally limited
  }, [activeTool, rendition]);

  // Attach mouseup listener to epub iframe — always active
  useEffect(() => {

    const attachListener = () => {
      try {
        // Find iframe — try rendition first, fallback to DOM
        const iframe = findIframe();
        if (!iframe?.contentDocument) return;

        // selectionchange catches the mobile path where touch
        // selection finalises without a clean mouseup/touchend on
        // the iframe document (handle drag fires events on the
        // system handle, not on document). Debounce so we only fire
        // once after the user stops adjusting handles.
        let timer: ReturnType<typeof setTimeout> | null = null;
        const debounced = () => {
          if (timer) clearTimeout(timer);
          timer = setTimeout(handleMouseUp, 250);
        };

        iframe.contentDocument.addEventListener('mouseup', debounced);
        iframe.contentDocument.addEventListener('touchend', debounced);
        iframe.contentDocument.addEventListener('selectionchange', debounced);
        return () => {
          iframe?.contentDocument?.removeEventListener('mouseup', debounced);
          iframe?.contentDocument?.removeEventListener('touchend', debounced);
          iframe?.contentDocument?.removeEventListener('selectionchange', debounced);
          if (timer) clearTimeout(timer);
        };
      } catch {
        return undefined;
      }
    };

    // Attach now — retry after delay if iframe not ready yet
    let cleanup = attachListener();
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    if (!cleanup) {
      // iframe not ready — retry in 2s (epubjs needs time to create iframe)
      retryTimer = setTimeout(() => { cleanup = attachListener(); }, 2000);
    }

    const onRelocated = () => {
      cleanup?.();
      cleanup = attachListener();
      applyHighlights();
    };

    if (rendition) {
      rendition.on('relocated', onRelocated);
    }
    return () => {
      cleanup?.();
      if (retryTimer) clearTimeout(retryTimer);
      if (rendition) rendition.off('relocated', onRelocated);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are intentionally limited
  }, [rendition, activeTool, handleMouseUp]);

  // Apply annotation highlights by finding selected_text in iframe DOM and
  // wrapping matches in <span> elements with highlight styling.
  // This is more reliable than epub.js annotations.highlight(cfi) which requires
  // exact range CFI format that's hard to capture from browser selections.
  const applyHighlights = useCallback(() => {
    if (!rendition || annotations.length === 0) return;

    try {
      const manager = // eslint-disable-next-line @typescript-eslint/no-explicit-any -- epub.js internal API not exposed in types
        (rendition as any).manager;
      if (!manager?.container) return;

      const iframe = manager.container.querySelector('iframe');
      if (!iframe?.contentDocument) return;

      const doc = iframe.contentDocument;

      // Inject annotation styles if not already present
      if (!doc.getElementById('scrapalot-annotation-styles')) {
        const style = doc.createElement('style');
        style.id = 'scrapalot-annotation-styles';
        style.textContent = `
          .scrapalot-epub-highlight {
            cursor: pointer;
            border-radius: 2px;
            transition: background-color 0.15s;
          }
          .scrapalot-epub-highlight:hover {
            filter: brightness(0.85);
          }
        `;
        doc.head.appendChild(style);
      }

      for (const ann of annotations) {
        if (appliedHighlightsRef.current.has(ann.id)) continue;
        if (!ann.selected_text || ann.selected_text.length < 2) continue;

        // Search for the selected text in the iframe body using TreeWalker
        const searchText = ann.selected_text.trim();
        const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
        let found = false;

        while (walker.nextNode()) {
          const node = walker.currentNode;
          const text = node.textContent || '';
          const idx = text.indexOf(searchText);
          if (idx === -1) continue;

          // Don't re-highlight if parent is already a highlight span
          if ((node.parentElement as HTMLElement)?.classList?.contains('scrapalot-epub-highlight')) {
            found = true;
            break;
          }

          // Split text node and wrap the match in a highlight span
          const range = doc.createRange();
          range.setStart(node, idx);
          range.setEnd(node, idx + searchText.length);

          const span = doc.createElement('span');
          span.className = 'scrapalot-epub-highlight';
          span.dataset.annotationId = ann.id;
          span.style.setProperty('background-color', `${ann.color}80`, 'important');
          span.addEventListener('click', (e: Event) => {
            const me = e as MouseEvent;
            me.stopPropagation();
            // me.clientX/Y are relative to iframe viewport, convert to parent page coords
            const iframeEl = doc.defaultView?.frameElement as HTMLElement;
            const iframeRect = iframeEl?.getBoundingClientRect() || { left: 0, top: 0 };
            const parentX = iframeRect.left + me.clientX;
            const parentY = iframeRect.top + me.clientY;
            const drawerEl = document.querySelector('[data-testid="epub-viewer-drawer"]');
            const drawerRect = drawerEl?.getBoundingClientRect();
            const popX = drawerRect ? parentX - drawerRect.left : parentX;
            const popY = drawerRect ? parentY - drawerRect.top + 8 : parentY;
            setHoverPopover({ annotation: ann, x: popX, y: popY });
          });

          range.surroundContents(span);
          found = true;
          break;
        }

        if (found) {
          appliedHighlightsRef.current.add(ann.id);
        }
      }
    } catch (err) {
      console.error('Error applying EPUB highlights:', err);
    }
  }, [rendition, annotations]);

  // When annotations change: remove stale highlight spans from iframe, then re-apply
  useEffect(() => {
    // Remove spans for annotations that no longer exist
    try {
      const manager = rendition && // eslint-disable-next-line @typescript-eslint/no-explicit-any -- epub.js internal API not exposed in types
        (rendition as any).manager;
      const iframe = manager?.container?.querySelector('iframe');
      const doc = iframe?.contentDocument;
      if (doc) {
        const spans = doc.querySelectorAll('.scrapalot-epub-highlight');
        const currentIds = new Set(annotations.map(a => a.id));
        spans.forEach((span: Element) => {
          const id = (span as HTMLElement).dataset.annotationId;
          if (id && !currentIds.has(id)) {
            // Unwrap: replace span with its text content
            const text = doc.createTextNode(span.textContent || '');
            span.parentNode?.replaceChild(text, span);
          }
        });
      }
    } catch { /* ignore */ }

    appliedHighlightsRef.current.clear();
    applyHighlights();
  }, [applyHighlights, annotations, rendition]);

  // Handle confirm from selection popover
  const handleConfirm = useCallback(
    async (color: string, comment?: string, toolOverride?: 1 | 2 | 3 | 4 | 5) => {
      if (!selectionPopover) return;

      const position: EpubAnnotationPosition = {
        type: 'epub',
        cfi: selectionPopover.cfi,
        section_index: selectionPopover.sectionIndex,
      };

      await onCreateAnnotation(
        selectionPopover.text,
        position,
        String(selectionPopover.sectionIndex + 1),
        color,
        comment,
        toolOverride,
      );

      setSelectionPopover(null);

      // Clear selection in iframe
      try {
        const manager = // eslint-disable-next-line @typescript-eslint/no-explicit-any -- epub.js internal API not exposed in types
        (rendition as any)?.manager;
        const iframe = manager?.container?.querySelector('iframe');
        iframe?.contentDocument?.getSelection()?.removeAllRanges();
      } catch { /* ignore */ }
    },
    [selectionPopover, onCreateAnnotation, rendition]
  );

  const handleCite = useCallback((text: string) => {
    window.dispatchEvent(new CustomEvent('insert-citation-into-note', {
      detail: { text, title: documentTitle, documentId },
    }));
    setSelectionPopover(null);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- epub.js internal API
      const iframe = (rendition as any)?.manager?.container?.querySelector('iframe');
      iframe?.contentDocument?.getSelection()?.removeAllRanges();
    } catch { /* ignore */ }
  }, [documentId, documentTitle, rendition]);

  /**
   * Capture the paragraphs around the selection inside the epub iframe to
   * feed the Explain panel. We walk siblings of the selection's host element.
   */
  const handleExplain = useCallback((text: string) => {
    let contextBefore = '';
    let contextAfter = '';
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- epub.js internal API
      const iframe = (rendition as any)?.manager?.container?.querySelector('iframe');
      const doc = iframe?.contentDocument;
      if (doc) {
        const selection = doc.getSelection();
        const anchor = selection?.anchorNode instanceof Element
          ? selection.anchorNode
          : selection?.anchorNode?.parentElement ?? null;
        const host = anchor?.closest('p, li, blockquote, h1, h2, h3, h4, h5, h6, div') as HTMLElement | null;
        if (host) {
          const collect = (el: Element | null, dir: 'prev' | 'next'): string => {
            const parts: string[] = [];
            let node: Element | null = el;
            for (let i = 0; i < 4 && node; i++) {
              node = dir === 'prev' ? node.previousElementSibling : node.nextElementSibling;
              if (!node) break;
              const textContent = (node.textContent || '').trim();
              if (textContent) parts.push(textContent);
            }
            return dir === 'prev' ? parts.reverse().join(' ').slice(-600) : parts.join(' ').slice(0, 600);
          };
          contextBefore = collect(host, 'prev');
          contextAfter = collect(host, 'next');
        }
        doc.getSelection()?.removeAllRanges();
      }
    } catch {
      /* best-effort */
    }
    setExplainState({ text, contextBefore, contextAfter });
    setSelectionPopover(null);
  }, [rendition]);

  const handleSimilar = useCallback((text: string) => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- epub.js internal API
      const iframe = (rendition as any)?.manager?.container?.querySelector('iframe');
      iframe?.contentDocument?.getSelection()?.removeAllRanges();
    } catch { /* ignore */ }
    setSimilarText(text);
    setSelectionPopover(null);
  }, [rendition]);

  return (
    <>
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

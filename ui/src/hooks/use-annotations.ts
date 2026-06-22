/**
 * Hook for managing document annotations.
 * Handles CRUD operations, local state, and optimistic updates.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  getDocumentAnnotations,
  createAnnotation as apiCreateAnnotation,
  updateAnnotation as apiUpdateAnnotation,
  deleteAnnotation as apiDeleteAnnotation,
} from '@/lib/api-annotations';
import type {
  Annotation,
  AnnotationType,
  ViewerType,
  AnnotationPosition,
  PdfAnnotationPosition,
} from '@/types/annotations';
import { ANNOTATION_COLORS } from '@/types/annotations';

interface PdfRect { left: number; top: number; width: number; height: number }

/** Two PDF rects (percentage units, same page) overlap iff their
 *  axis-aligned bounding boxes intersect. */
function pdfRectsOverlap(a: PdfRect, b: PdfRect): boolean {
  return !(
    a.left + a.width < b.left ||
    b.left + b.width < a.left ||
    a.top + a.height < b.top ||
    b.top + b.height < a.top
  );
}

/** Existing annotations whose rects overlap the new annotation's rects
 *  on the same PDF page. Used by the strike auto-replace flow — when
 *  the user strikes already-marked text, the prior marks should yield
 *  to the explicit discard intent. */
function findOverlappingPdfAnnotations(
  newPos: PdfAnnotationPosition,
  existing: Annotation[],
): Annotation[] {
  const out: Annotation[] = [];
  for (const ann of existing) {
    try {
      const pos = JSON.parse(ann.position_json) as AnnotationPosition;
      if (pos.type !== 'pdf' || pos.page_index !== newPos.page_index) continue;
      const overlaps = pos.rects.some((r1) =>
        newPos.rects.some((r2) => pdfRectsOverlap(r1 as PdfRect, r2 as PdfRect)),
      );
      if (overlaps) out.push(ann);
    } catch {
      /* ignore malformed position_json */
    }
  }
  return out;
}

interface UseAnnotationsOptions {
  documentId: string | null;
  collectionId: string | null;
  viewerType: ViewerType;
  enabled?: boolean;
}

interface UseAnnotationsReturn {
  annotations: Annotation[];
  loading: boolean;
  activeColor: string;
  activeTool: AnnotationType | null;
  setActiveColor: (color: string) => void;
  setActiveTool: (tool: AnnotationType | null) => void;
  createHighlight: (selectedText: string, position: AnnotationPosition, pageLabel?: string, color?: string, comment?: string, toolOverride?: AnnotationType) => Promise<Annotation | null>;
  updateComment: (annotationId: string, comment: string) => Promise<void>;
  updateColor: (annotationId: string, color: string) => Promise<void>;
  removeAnnotation: (annotationId: string) => Promise<void>;
  refresh: () => Promise<void>;
}

export function useAnnotations({
  documentId,
  collectionId,
  viewerType,
  enabled = true,
}: UseAnnotationsOptions): UseAnnotationsReturn {
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeColor, setActiveColor] = useState<string>(ANNOTATION_COLORS[0].hex);
  const [activeTool, setActiveTool] = useState<AnnotationType | null>(null);

  const refresh = useCallback(async () => {
    if (!documentId || !enabled) return;
    setLoading(true);
    try {
      const data = await getDocumentAnnotations(documentId);
      setAnnotations(data);
    } catch (err) {
      console.error('Failed to load annotations:', err);
    } finally {
      setLoading(false);
    }
  }, [documentId, enabled]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const createHighlight = useCallback(
    async (
      selectedText: string,
      position: AnnotationPosition,
      pageLabel?: string,
      color?: string,
      comment?: string,
      toolOverride?: AnnotationType,
    ): Promise<Annotation | null> => {
      if (!documentId || !collectionId) {
        console.error('[Annotation] Cannot create: documentId=%s, collectionId=%s', documentId, collectionId);
        return null;
      }

      const usedColor = color || activeColor;
      const usedType = toolOverride ?? activeTool ?? 1;
      const posJson = JSON.stringify(position);

      // Strike auto-replace: when creating a strikethrough on PDF text,
      // remove any existing annotations whose rects overlap the new
      // strike's rects on the same page. The user explicitly struck
      // this passage out — keeping a prior highlight or underline on
      // the same span would conflict with their "discard" intent. The
      // boost calculation downstream then sees only the strike (Gray,
      // 0.8x) for that page region. EPUB skipped — CFI overlap
      // detection is too fuzzy for an automatic destructive action.
      // See memory/feedback_annotation_color_semantics.md.
      if (usedType === 5 && position.type === 'pdf') {
        const overlapping = findOverlappingPdfAnnotations(position, annotations);
        if (overlapping.length > 0) {
          const ids = overlapping.map((a) => a.id);
          // Optimistically remove from local state so the UI updates
          // before the server round-trip completes.
          setAnnotations((prev) => prev.filter((a) => !ids.includes(a.id)));
          // Fire deletes in parallel; swallow individual failures so
          // one stale row doesn't block the new strike from saving.
          await Promise.allSettled(
            ids
              .filter((id) => !id.startsWith('temp-'))
              .map((id) => apiDeleteAnnotation(id).catch(() => null)),
          );
        }
      }

      // Optimistic update — show highlight instantly before server responds
      const tempId = `temp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const optimistic: Annotation = {
        id: tempId,
        document_id: documentId,
        collection_id: collectionId,
        user_id: '',
        annotation_type: usedType,
        selected_text: selectedText,
        color: usedColor,
        comment: comment || null,
        page_label: pageLabel || null,
        sort_index: null,
        position_json: posJson,
        viewer_type: viewerType,
        is_pinned: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      setAnnotations((prev) => [...prev, optimistic]);

      try {
        const annotation = await apiCreateAnnotation(documentId, {
          document_id: documentId,
          collection_id: collectionId,
          annotation_type: usedType,
          selected_text: selectedText,
          color: usedColor,
          comment: comment,
          page_label: pageLabel,
          position_json: posJson,
          viewer_type: viewerType,
        });

        // Replace temp with real server annotation
        setAnnotations((prev) => prev.map((a) => a.id === tempId ? annotation : a));
        return annotation;
      } catch (err) {
        // Rollback optimistic update on failure
        setAnnotations((prev) => prev.filter((a) => a.id !== tempId));
        console.error('Failed to create annotation:', err);
        return null;
      }
    },
    [documentId, collectionId, activeColor, activeTool, viewerType, annotations]
  );

  const updateComment = useCallback(async (annotationId: string, comment: string) => {
    try {
      const updated = await apiUpdateAnnotation(annotationId, { comment });
      setAnnotations((prev) =>
        prev.map((a) => (a.id === annotationId ? updated : a))
      );
    } catch (err) {
      console.error('Failed to update annotation:', err);
    }
  }, []);

  const updateColor = useCallback(async (annotationId: string, color: string) => {
    try {
      const updated = await apiUpdateAnnotation(annotationId, { color });
      setAnnotations((prev) =>
        prev.map((a) => (a.id === annotationId ? updated : a))
      );
    } catch (err) {
      console.error('Failed to update annotation color:', err);
    }
  }, []);

  const removeAnnotation = useCallback(async (annotationId: string) => {
    // Optimistic removal — hide immediately, restore on failure
    const removed = annotations.find((a) => a.id === annotationId);
    setAnnotations((prev) => prev.filter((a) => a.id !== annotationId));
    try {
      await apiDeleteAnnotation(annotationId);
    } catch (err) {
      console.error('Failed to delete annotation:', err);
      if (removed) setAnnotations((prev) => [...prev, removed]);
    }
  }, [annotations]);

  return {
    annotations,
    loading,
    activeColor,
    activeTool,
    setActiveColor,
    setActiveTool,
    createHighlight,
    updateComment,
    updateColor,
    removeAnnotation,
    refresh,
  };
}

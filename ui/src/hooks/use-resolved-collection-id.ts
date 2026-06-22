/**
 * Resolves a viewer's collection_id when the upstream dispatcher didn't
 * supply it. The PDF / EPUB viewer drawers can be opened from surfaces
 * that only know the document_id (knowledge sidebar, "Open in viewer"
 * shortcut), but the annotations API requires both document_id AND
 * collection_id. Without this lazy lookup every Save / Highlight /
 * Underline silently no-ops because `useAnnotations.createHighlight`
 * short-circuits with "Cannot create".
 */

import { useEffect, useState } from 'react';

export function useResolvedCollectionId(
  upstream: string | null | undefined,
  documentId: string | null | undefined,
  isOpen: boolean,
): string | null {
  const [resolved, setResolved] = useState<string | null>(upstream || null);

  useEffect(() => {
    if (upstream) {
      setResolved(upstream);
      return;
    }
    if (!documentId || !isOpen) return;
    let cancelled = false;
    (async () => {
      try {
        const { getDocumentById } = await import('@/lib/api-documents');
        const doc = await getDocumentById(documentId);
        const collId = doc?.collection_id;
        if (!cancelled && typeof collId === 'string' && collId.length > 0) {
          setResolved(collId);
        }
      } catch (err) {
        console.warn('[useResolvedCollectionId] lookup failed:', err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [upstream, documentId, isOpen]);

  return resolved;
}

import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { usePDFViewer } from '@/contexts/pdf-viewer-context.tsx';
import { useEpubViewer } from '@/contexts/epub-viewer-context.tsx';
import { useDocxViewer } from '@/contexts/docx-viewer-context.tsx';
import { PDFViewerDrawer } from './pdf-viewer-drawer.tsx';
import { useNotesDrawer } from '@/hooks/use-notes-drawer.tsx';
import { getDocumentById } from '@/lib/api-documents';
import { resolveFileType } from '@/lib/resolve-file-type';

// Create portal container once globally to prevent insertBefore errors
let pdfPortalContainer: HTMLDivElement | null = null;

const getOrCreatePortalContainer = () => {
  if (!pdfPortalContainer) {
    const existing = document.getElementById('pdf-viewer-portal');
    if (existing instanceof HTMLDivElement) {
      pdfPortalContainer = existing;
    } else {
      // No position/z-index on the portal container — that would create a
      // stacking context and trap the drawer's dynamic z-index inside it,
      // breaking cross-viewer focus (clicking PDF wouldn't raise it above
      // an EPUB sitting in a different portal).
      const container = document.createElement('div');
      container.id = 'pdf-viewer-portal';
      document.body.appendChild(container);
      pdfPortalContainer = container;
    }
  }
  return pdfPortalContainer;
};

export const GlobalPDFViewer: React.FC = () => {
  const { state, dispatch } = usePDFViewer();
  const epubViewer = useEpubViewer();
  const { dispatch: epubDispatch } = epubViewer;
  const { dispatch: docxDispatch } = useDocxViewer();
  const notesDrawer = useNotesDrawer();
  const portalContainerRef = useRef<HTMLDivElement | null>(null);

  const handleClose = () => {
    dispatch({ type: 'CLOSE_PDF_VIEWER' });
  };

  // record a 'pdf_open' view whenever a NEW document
  // opens. Triggers on documentId transition from null/different to a
  // value, not on every isOpen flip (so re-opening the same PDF after
  // closing the drawer doesn't double-count). Service-side throttle
  // dedups within a 5-min window for good measure.
  useEffect(() => {
    if (!state.isOpen || !state.documentId) return;
    let cancelled = false;
    void (async () => {
      try {
        const { recordDocumentView } = await import('@/lib/api-document-views');
        if (cancelled) return;
        await recordDocumentView(state.documentId!, 'pdf_open', state.collectionId);
      } catch {
        // recordDocumentView already logs; nothing more to do here.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [state.isOpen, state.documentId, state.collectionId]);

  // listen for the Command Palette's
  // `scrapalot:open-document` event so picking a recent document from
  // Cmd+K opens the PDF viewer here. The palette dispatches a
  // CustomEvent rather than importing this dispatch directly to keep
  // the palette free of viewer-context coupling.
  useEffect(() => {
    // Single router for `scrapalot:open-document` — covers the Command
    // Palette and the Recent Documents sidebar. We resolve the file type
    // BEFORE dispatching so EPUB / DOCX books don't get force-loaded
    // into the PDF viewer (which then 500s with "Expected PDF but
    // received application/epub+zip"). We try the title first (free),
    // and only hit the metadata endpoint when the title doesn't carry
    // an extension.
    const onOpenDoc = (e: Event) => {
      const detail = (e as CustomEvent<{
        documentId: string;
        collectionId?: string | null;
        documentTitle?: string | null;
      }>).detail;
      if (!detail?.documentId) return;
      const url = `/documents/${detail.documentId}/file`;
      const collectionId = detail.collectionId || undefined;
      const documentTitle = detail.documentTitle || undefined;

      const openIn = (fileType: 'pdf' | 'epub' | 'docx', title?: string) => {
        if (fileType === 'epub') {
          epubDispatch({
            type: 'OPEN_EPUB_VIEWER',
            payload: {
              url,
              documentId: detail.documentId,
              collectionId,
              documentTitle: title,
              citationId: 0,
            },
          });
        } else if (fileType === 'docx') {
          docxDispatch({
            type: 'OPEN_DOCX_VIEWER',
            payload: {
              url,
              documentId: detail.documentId,
              documentTitle: title,
              citationId: 0,
            },
          });
        } else {
          dispatch({
            type: 'OPEN_PDF_VIEWER',
            payload: {
              url,
              documentId: detail.documentId,
              collectionId,
              documentTitle: title,
              citationId: -1,
            },
          });
        }
      };

      // Fast path: extension is in the title we already have.
      const fastType = resolveFileType({ title: documentTitle });
      if (documentTitle && fastType !== 'pdf') {
        openIn(fastType, documentTitle);
        return;
      }
      // Slow path: title is missing or extensionless. Fetch metadata so
      // we don't blindly default to PDF on EPUB books with stripped titles.
      void (async () => {
        try {
          const doc = await getDocumentById(detail.documentId);
          const resolvedTitle =
            (doc.title as string | undefined) ||
            (doc.file_name as string | undefined) ||
            (doc.filename as string | undefined) ||
            documentTitle;
          const fileType = resolveFileType({
            file_type: doc.file_type as string | undefined,
            filename: (doc.file_name as string | undefined) || (doc.filename as string | undefined),
            title: doc.title as string | undefined,
            source: doc.source as string | undefined,
          });
          openIn(fileType, resolvedTitle);
        } catch {
          // Metadata fetch failed — best-effort PDF default.
          openIn('pdf', documentTitle);
        }
      })();
    };
    window.addEventListener('scrapalot:open-document', onOpenDoc);
    return () => window.removeEventListener('scrapalot:open-document', onOpenDoc);
  }, [dispatch, epubDispatch, docxDispatch]);

  // Create stable portal container on mount
  useEffect(() => {
    portalContainerRef.current = getOrCreatePortalContainer();

    const handleUnload = () => {
      if (pdfPortalContainer?.parentNode) {
        pdfPortalContainer.parentNode.removeChild(pdfPortalContainer);
        pdfPortalContainer = null;
      }
    };

    window.addEventListener('beforeunload', handleUnload);
    return () => {
      window.removeEventListener('beforeunload', handleUnload);
    };
  }, []);

  if (!portalContainerRef.current) {
    return null;
  }

  return createPortal(
    <PDFViewerDrawer
      isOpen={state.isOpen}
      onClose={handleClose}
      pdfUrl={state.pdfUrl}
      documentId={state.documentId}
      documentTitle={state.documentTitle}
      citationPage={state.citationPage}
      highlightLineStart={state.highlightLineStart || 1}
      highlightLineEnd={state.highlightLineEnd || 1}
      highlightText={state.highlightText}
      citationId={state.citationId}
      isNotesOpen={notesDrawer.isOpen || epubViewer.state.isOpen}
    />,
    portalContainerRef.current
  );
};

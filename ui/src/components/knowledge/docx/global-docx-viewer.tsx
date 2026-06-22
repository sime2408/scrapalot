import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useDocxViewer } from '@/contexts/docx-viewer-context';
import { usePDFViewer } from '@/contexts/pdf-viewer-context';
import { useEpubViewer } from '@/contexts/epub-viewer-context';
import { DocxViewerDrawer } from './docx-viewer-drawer';
import { useNotesDrawer } from '@/hooks/use-notes-drawer';

// Create portal container once globally to prevent insertBefore errors
let docxPortalContainer: HTMLDivElement | null = null;

const getOrCreatePortalContainer = () => {
  if (!docxPortalContainer) {
    const existing = document.getElementById('docx-viewer-portal');
    if (existing instanceof HTMLDivElement) {
      docxPortalContainer = existing;
    } else {
      // No position/z-index on the portal container — would create a
      // stacking context that traps the drawer's dynamic z-index, breaking
      // click-to-front across PDF / EPUB / DOCX / markdown viewers.
      const container = document.createElement('div');
      container.id = 'docx-viewer-portal';
      document.body.appendChild(container);
      docxPortalContainer = container;
    }
  }
  return docxPortalContainer;
};

export const GlobalDocxViewer: React.FC = () => {
  const { state, dispatch } = useDocxViewer();
  const pdfViewer = usePDFViewer();
  const epubViewer = useEpubViewer();
  const notesDrawer = useNotesDrawer();
  const portalContainerRef = useRef<HTMLDivElement | null>(null);

  const handleClose = () => {
    dispatch({ type: 'CLOSE_DOCX_VIEWER' });
  };

  useEffect(() => {
    if (!state.isOpen || !state.documentId) return;
    let cancelled = false;
    void (async () => {
      try {
        const { recordDocumentView } = await import('@/lib/api-document-views');
        if (cancelled) return;
        await recordDocumentView(state.documentId!, 'docx_open', null);
      } catch {
        // recordDocumentView already logs; nothing more to do here.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [state.isOpen, state.documentId]);

  // Create stable portal container on mount
  useEffect(() => {
    portalContainerRef.current = getOrCreatePortalContainer();

    const handleUnload = () => {
      if (docxPortalContainer?.parentNode) {
        docxPortalContainer.parentNode.removeChild(docxPortalContainer);
        docxPortalContainer = null;
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

  // Calculate isNotesOpen - true if Notes, PDF or EPUB viewers are open
  const isNotesOpen = notesDrawer.isOpen || pdfViewer.state.isOpen || epubViewer.state.isOpen;

  return createPortal(
    <DocxViewerDrawer
      isOpen={state.isOpen}
      onClose={handleClose}
      documentId={state.documentId || ''}
      documentTitle={state.documentTitle}
      isNotesOpen={isNotesOpen}
    />,
    portalContainerRef.current
  );
};

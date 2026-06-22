import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useEpubViewer } from '@/contexts/epub-viewer-context.tsx';
import { usePDFViewer } from '@/contexts/pdf-viewer-context.tsx';
import { useNotesDrawer } from '@/hooks/use-notes-drawer.tsx';
import { EpubViewerDrawer } from './epub-viewer-drawer.tsx';

// Create portal container once globally to prevent insertBefore errors
let epubPortalContainer: HTMLDivElement | null = null;

const getOrCreatePortalContainer = () => {
  if (!epubPortalContainer) {
    const existing = document.getElementById('epub-viewer-portal');
    if (existing instanceof HTMLDivElement) {
      epubPortalContainer = existing;
    } else {
      // No position/z-index on the portal container — would create a
      // stacking context that traps the drawer's dynamic z-index, breaking
      // click-to-front across PDF / EPUB / DOCX / markdown viewers.
      const container = document.createElement('div');
      container.id = 'epub-viewer-portal';
      document.body.appendChild(container);
      epubPortalContainer = container;
    }
  }
  return epubPortalContainer;
};

export const GlobalEpubViewer: React.FC = () => {
  const { state, dispatch } = useEpubViewer();
  const pdfViewer = usePDFViewer();
  const notesDrawer = useNotesDrawer();
  const portalContainerRef = useRef<HTMLDivElement | null>(null);
  const [isContainerReady, setIsContainerReady] = React.useState(false);

  const handleClose = () => {
    dispatch({ type: 'CLOSE_EPUB_VIEWER' });
  };

  useEffect(() => {
    if (!state.isOpen || !state.documentId) return;
    let cancelled = false;
    void (async () => {
      try {
        const { recordDocumentView } = await import('@/lib/api-document-views');
        if (cancelled) return;
        await recordDocumentView(state.documentId!, 'epub_open', state.collectionId ?? null);
      } catch {
        // recordDocumentView already logs; nothing more to do here.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [state.isOpen, state.documentId, state.collectionId]);

  // Create stable portal container on mount
  useEffect(() => {
    // Small delay to ensure DOM is fully ready before creating portal
    const timer = setTimeout(() => {
      portalContainerRef.current = getOrCreatePortalContainer();
      setIsContainerReady(true);
    }, 10);

    const handleUnload = () => {
      if (epubPortalContainer?.parentNode) {
        epubPortalContainer.parentNode.removeChild(epubPortalContainer);
        epubPortalContainer = null;
      }
    };

    window.addEventListener('beforeunload', handleUnload);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('beforeunload', handleUnload);
    };
  }, []);

  if (!isContainerReady || !portalContainerRef.current) {
    return null;
  }

  return createPortal(
    <EpubViewerDrawer
      isOpen={state.isOpen}
      onClose={handleClose}
      epubUrl={state.epubUrl}
      documentId={state.documentId}
      documentTitle={state.documentTitle}
      initialLocation={state.location}
      citationId={state.citationId}
      isNotesOpen={notesDrawer.isOpen}
      isPdfOpen={pdfViewer.state.isOpen}
    />,
    portalContainerRef.current
  );
};

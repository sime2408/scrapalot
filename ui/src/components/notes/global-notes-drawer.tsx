import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useNotesDrawer } from '@/hooks/use-notes-drawer';
import { usePdfDrawer } from '@/hooks/use-pdf-drawer';
import { useMarkdownViewer } from '@/contexts/markdown-viewer-context';
import { NotesDrawer } from './notes-drawer';

// Create portal container once globally to prevent insertBefore errors
let notesPortalContainer: HTMLDivElement | null = null;

const getOrCreatePortalContainer = () => {
  if (!notesPortalContainer) {
    // Check if container already exists in DOM (from previous render)
    const existing = document.getElementById('notes-drawer-portal');
    if (existing instanceof HTMLDivElement) {
      notesPortalContainer = existing;
    } else {
      // No position/z-index on the portal container — would create a
      // stacking context that traps the drawer's dynamic z-index, breaking
      // click-to-front between notes and PDF / EPUB / DOCX / markdown
      // viewers (notes' z=9999 stayed inside z=1300, so it could never
      // climb above a 9999 PDF drawer sitting in a no-stacking-context
      // portal).
      const container = document.createElement('div');
      container.id = 'notes-drawer-portal';
      document.body.appendChild(container);
      notesPortalContainer = container;
    }
  }
  return notesPortalContainer;
};

export const GlobalNotesDrawer: React.FC = () => {
  const notesDrawer = useNotesDrawer();
  const isPdfOpen = usePdfDrawer(); // Returns boolean directly
  // Mirror PDF tracking for the markdown viewer (Deep Research "View Full
  // Report"). Without this, clicking "Use in Notes" from a discovery card
  // while the markdown viewer is on the right opens Notes on the right too —
  // straight on top of the markdown panel — instead of the empty left half.
  const { state: markdownState } = useMarkdownViewer();
  const portalContainerRef = useRef<HTMLDivElement | null>(null);
  const [isContainerReady, setIsContainerReady] = React.useState(false);

  // Create stable portal container on mount
  useEffect(() => {
    // Use double requestAnimationFrame to ensure DOM is truly stable
    // This is more reliable than arbitrary timeouts as it waits for:
    // 1. First rAF: Browser completes current frame
    // 2. Second rAF: Browser completes next frame (DOM fully painted)
    let rafId2: number;

    const rafId1: number = requestAnimationFrame(() => {
      rafId2 = requestAnimationFrame(() => {
        portalContainerRef.current = getOrCreatePortalContainer();
        setIsContainerReady(true);
      });
    });

    // Only cleanup on window unload, not on component unmount
    // This prevents insertBefore errors when TipTap is still rendering
    const handleUnload = () => {
      if (notesPortalContainer?.parentNode) {
        notesPortalContainer.parentNode.removeChild(notesPortalContainer);
        notesPortalContainer = null;
      }
    };

    window.addEventListener('beforeunload', handleUnload);
    return () => {
      cancelAnimationFrame(rafId1);
      cancelAnimationFrame(rafId2);
      window.removeEventListener('beforeunload', handleUnload);
      // Don't remove portal container here - keep it persistent
    };
  }, []);

  // Don't render until container is ready
  if (!isContainerReady || !portalContainerRef.current) {
    return null;
  }

  // Render through Portal to dedicated container to prevent DOM conflicts
  // This avoids insertBefore errors from nested Radix UI portals and TipTap editor
  return createPortal(
    <NotesDrawer
      isOpen={notesDrawer.isOpen}
      onClose={notesDrawer.close}
      sessionId={notesDrawer.sessionId}
      noteId={notesDrawer.noteId}
      isPdfOpen={isPdfOpen}
      isMarkdownViewerOpen={markdownState.isOpen}
      isMarkdownViewerOnLeft={markdownState.isOnLeft}
    />,
    portalContainerRef.current
  );
};

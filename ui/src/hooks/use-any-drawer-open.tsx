import { usePDFViewer } from '@/contexts/pdf-viewer-context';
import { useEpubViewer } from '@/contexts/epub-viewer-context';
import { useDocxViewer } from '@/contexts/docx-viewer-context';
import { useNotesDrawer } from '@/hooks/use-notes-drawer';
import { useDeepResearchPanel } from '@/contexts/deep-research-context';
import { useFloatingWindowManager } from '@/contexts/floating-window-context';

/**
 * Hook to check if any of the global side panels (PDF, EPUB, DOCX, Notes, or
 * Deep Research) are open. When any one is open, the available screen space
 * is narrower, so dialogs should render in "mobile" format on the opposite
 * half and other overlays should respect the 50/50 split.
 *
 * Deep Research panel always sits on the right; the other viewers can be on
 * either side. `isDrawerOnLeft` reports the side of whichever viewer is open.
 *
 * @returns Object with isOpen (boolean) and isDrawerOnLeft (boolean)
 */
export function useAnyDrawerOpen(): { isOpen: boolean; isDrawerOnLeft: boolean } {
  const { state: pdfState } = usePDFViewer();
  const { state: epubState } = useEpubViewer();
  const { state: docxState } = useDocxViewer();
  const notesDrawer = useNotesDrawer();
  const deepResearchPanel = useDeepResearchPanel();
  const floatingMgr = useFloatingWindowManager();

  // A drawer/viewer only "occupies side space" when it is open AND in a
  // pinned mode. A floating viewer sits over the page and must not flip
  // dialogs/sheets into the narrow split-screen layout.
  const isPdfPinned = pdfState.isOpen && floatingMgr.modes['pdf-viewer'] !== 'floating';
  const isEpubPinned = epubState.isOpen && floatingMgr.modes['epub-viewer'] !== 'floating';
  const isDocxPinned = docxState.isOpen && floatingMgr.modes['docx-viewer'] !== 'floating';
  const isNotesPinned = notesDrawer.isOpen && floatingMgr.modes['notes-drawer'] !== 'floating';

  // Use isPanelMounted, NOT isOpen: the deep research panel lives inside the
  // chat view, so isOpen can be true (e.g. a cross-device run) while no panel
  // renders because no conversation is selected. Keying off isOpen here would
  // dock dialogs (e.g. Knowledge Stacks) into a half-screen split with nothing
  // beside them.
  const isDeepResearchVisible = deepResearchPanel.isPanelMounted;

  const isOpen =
    isPdfPinned ||
    isEpubPinned ||
    isDocxPinned ||
    isNotesPinned ||
    isDeepResearchVisible;

  // Determine which side the drawer is on (check all open pinned drawers)
  let isDrawerOnLeft = false;
  if (isPdfPinned) {
    isDrawerOnLeft = pdfState.isOnLeft || false;
  } else if (isEpubPinned) {
    isDrawerOnLeft = epubState.isOnLeft || false;
  } else if (isDocxPinned) {
    isDrawerOnLeft = docxState.isOnLeft || false;
  } else if (isNotesPinned) {
    isDrawerOnLeft = notesDrawer.isOnLeft || false;
  } else if (isDeepResearchVisible) {
    // Deep Research panel is always anchored to the right edge
    isDrawerOnLeft = false;
  }

  return { isOpen, isDrawerOnLeft };
}

/**
 * Hook that provides responsive class names based on drawer state.
 * When drawers are open, dialogs should use mobile-style full-screen layout.
 *
 * @returns Object with helper functions and values
 */
export function useDrawerResponsive() {
  const isAnyDrawerOpen = useAnyDrawerOpen();

  /**
   * Returns true if dialogs should use mobile layout.
   * This happens when:
   * 1. Screen is actually mobile (< 768px)
   * 2. Any drawer is open (making available space narrow)
   */
  const shouldUseMobileLayout = () => {
    const isMobileScreen = window.innerWidth < 768;
    return isMobileScreen || isAnyDrawerOpen;
  };

  /**
   * Gets the appropriate dialog/sheet class names based on drawer state.
   * When drawers are open, dialogs should cover the right half of the screen.
   */
  const getDialogClasses = () => {
    if (isAnyDrawerOpen) {
      // When drawer is open, dialog should be full screen on the right half
      // Quick sidebar is 70px wide
      return {
        overlay: 'sm:left-[70px]', // Start after quick sidebar
        content: 'sm:left-[70px] sm:w-[calc(100%-70px)] sm:max-w-none sm:h-screen sm:rounded-none',
      };
    }
    return {
      overlay: '',
      content: '',
    };
  };

  /**
   * Gets the appropriate sheet side based on drawer state.
   * When drawers are open on the right, sheets should also open from right
   * but in a narrower space.
   */
  const getSheetSide = (defaultSide: 'left' | 'right' | 'top' | 'bottom' = 'right') => {
    return defaultSide; // Keep the same side, but adjust width
  };

  /**
   * Gets the appropriate sheet class names based on drawer state.
   */
  const getSheetClasses = () => {
    if (isAnyDrawerOpen) {
      return {
        overlay: 'sm:left-[70px]',
        content: 'sm:left-[70px] sm:w-[calc(50%-70px)] data-[state=open]:slide-in-from-left sm:data-[state=closed]:slide-out-to-left',
      };
    }
    return {
      overlay: '',
      content: '',
    };
  };

  return {
    isAnyDrawerOpen,
    shouldUseMobileLayout,
    getDialogClasses,
    getSheetSide,
    getSheetClasses,
  };
}

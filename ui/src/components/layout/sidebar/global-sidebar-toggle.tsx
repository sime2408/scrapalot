import React, { useEffect, useState } from 'react';
import { Network, PanelLeft, PanelLeftClose } from 'lucide-react';
import { useSidebar } from '@/contexts/sidebar-context';
import { usePDFViewer } from '@/contexts/pdf-viewer-context';
import { useNotesDrawer } from '@/hooks/use-notes-drawer';
import { useDeepResearchPanel } from '@/contexts/deep-research-context';
import { useFloatingWindowManager } from '@/contexts/floating-window-context';
import {
  useIsMobile,
  useIsNarrowScreen,
  useIsMobileOrTabletPortrait,
} from '@/hooks/use-mobile';

interface GlobalSidebarToggleProps {
  mobileMenuOpen?: boolean;
  onMobileMenuToggle?: (open: boolean) => void;
  onOpenAdminInspector?: () => void;
}

export const GlobalSidebarToggle = ({
  mobileMenuOpen,
  onMobileMenuToggle,
  onOpenAdminInspector,
}: GlobalSidebarToggleProps = {}) => {
  const { isSidebarOpen, toggleSidebar } = useSidebar();
  const { state: pdfState } = usePDFViewer();
  const { isOpen: isNotesOpen } = useNotesDrawer();
  const { isOpen: isResearchPanelOpen } = useDeepResearchPanel();
  const floatingMgr = useFloatingWindowManager();
  // A floating viewer / notes panel doesn't take side space, so the
  // sidebar toggle should still be reachable even though one is "open".
  const isPdfPinned = pdfState.isOpen && floatingMgr.modes['pdf-viewer'] !== 'floating';
  const isNotesPinned = isNotesOpen && floatingMgr.modes['notes-drawer'] !== 'floating';
  const isMobile = useIsMobile();
  const isNarrowScreen = useIsNarrowScreen();
  const isMobileOrTabletPortrait = useIsMobileOrTabletPortrait();
  const [isToggling, setIsToggling] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);

  // Detect the *settings* dialog specifically (not any open Radix
  // overlay). The previous heuristic — "any [role=dialog] AND any
  // [data-state=open]" — matched every Radix Popover (search options,
  // tooltips, dropdowns) and falsely hid the sidebar toggle whenever
  // one was opened. Use the stable testid placed on the real settings
  // dialog (`settings.tsx`) instead.
  useEffect(() => {
    const checkSettingsDialog = () => {
      setIsSettingsOpen(!!document.querySelector('[data-testid="settings-dialog"]'));
    };

    checkSettingsDialog();
    const observer = new MutationObserver(checkSettingsDialog);
    observer.observe(document.body, { childList: true, subtree: true });

    return () => observer.disconnect();
  }, []);

  // Hide the button when a PINNED PDF viewer or notes drawer is open.
  // Floating windows don't occupy the sidebar lane.
  if (isPdfPinned || isNotesPinned) {
    return null;
  }

  // Hide when deep research panel is open (all screen sizes)
  if (isResearchPanelOpen) {
    return null;
  }

  // Always hide when settings dialog is open
  if (isSettingsOpen) {
    return null;
  }

  const handleClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    // Prevent rapid toggling
    if (isToggling) {
      return;
    }

    setIsToggling(true);

    if (isMobileOrTabletPortrait && onMobileMenuToggle) {
      // On mobile, toggle mobile menu state
      const newState = !mobileMenuOpen;
      onMobileMenuToggle(newState);
    } else {
      // On desktop, toggle regular sidebar
      toggleSidebar();
    }

    // Reset toggle flag after a short delay
    setTimeout(() => {
      setIsToggling(false);
    }, 300);
  };

  // Determine which state to show based on device type
  const isOpen = isMobileOrTabletPortrait ? mobileMenuOpen : isSidebarOpen;

  return (
    <div className={`fixed z-50 flex items-center gap-1 ${
      isMobile
        ? 'top-0 left-0 py-[10px] pl-[10px] pr-1' // Mobile: tight right padding so the chat-header title can sit closer to the buttons
        : isNarrowScreen
          ? 'top-0 left-[70px] py-[10px] pl-[10px] pr-1' // Tablet: same tight right padding
          : 'top-2 left-[70px]' // Desktop (≥1200px): after quick-tools bar, higher up
      }`}>
      <button
        data-testid="sidebar-toggle-button"
        data-global-sidebar-toggle="true"
        className={`ml-[4px] flex items-center justify-center text-zinc-600 dark:text-zinc-400 hover:text-zinc-800 dark:hover:text-zinc-200 transition-all duration-300 ${isMobile
          ? 'p-1 hover:bg-zinc-100 dark:hover:bg-zinc-800 flex-shrink-0' // Mobile - flat, matches chat header buttons
          : isNarrowScreen
            ? 'p-2 bg-background/95 backdrop-blur-sm border border-muted/50 hover:bg-background/80' // Tablet - no rounded corners
            : 'p-2 hover:bg-zinc-100 dark:hover:bg-zinc-800' // Desktop styling
          }`}
        onClick={handleClick}
        onMouseDown={(e) => e.preventDefault()} // Prevent any mouse down interference
        title={isOpen ? 'Close sidebar' : 'Open sidebar'}
        type="button" // Explicitly set button type
      >
        {isOpen ? (
          <PanelLeftClose
            className={`${isMobile ? 'w-5 h-5' : isNarrowScreen ? 'w-4 h-4' : 'w-5 h-5'} pointer-events-none`}
            strokeWidth={2}
          />
        ) : (
          <PanelLeft
            className={`${isMobile ? 'w-5 h-5' : isNarrowScreen ? 'w-4 h-4' : 'w-5 h-5'} pointer-events-none`}
            strokeWidth={2}
          />
        )}
      </button>
      {/* Data Inspector button - mobile only */}
      {isMobile && onOpenAdminInspector && (
        <button
          data-testid="sidebar-admin-inspector-mobile-button"
          className='p-1 flex items-center justify-center text-zinc-600 dark:text-zinc-400 hover:text-zinc-800 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 flex-shrink-0 transition-all duration-300'
          onClick={onOpenAdminInspector}
          onMouseDown={(e) => e.preventDefault()}
          title='Data Inspector'
          type="button"
        >
          <Network className='w-5 h-5 pointer-events-none' strokeWidth={2} />
        </button>
      )}
    </div>
  );
};

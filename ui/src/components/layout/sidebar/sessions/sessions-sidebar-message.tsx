import React, { useCallback, useEffect, useRef, useState } from 'react';
import { SessionsHeader } from '@/components/layout/sidebar/sessions-list/sessions-header.tsx';
import { SessionsArea } from '@/components/layout/sidebar/sessions-list/sessions-area.tsx';
import { SessionsNew } from '@/components/layout/sidebar/sessions/sessions-new.tsx';
import { Session } from '@/types';
import { useSidebar } from '@/contexts/sidebar-context.tsx';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useIsMobile } from '@/hooks/use-mobile';
import { cn } from '@/lib/utils';

interface SidebarMessageSessionsProps {
  onSelectSession: (session: Session) => void;
  onNewSession: () => void;
  refreshSessions?: () => Promise<void>;
  externalRefreshTrigger?: number;
  openSettingsWithTab?: (tab: string) => void;
  mobileMenuOpen?: boolean;
  onCloseMobileMenu?: () => void;
  onShowWorkspaceManagement?: () => void;
}

export const SessionsSidebarMessage = ({
  onSelectSession,
  onNewSession,
  refreshSessions,
  externalRefreshTrigger,
  openSettingsWithTab,
  mobileMenuOpen,
  onCloseMobileMenu,
  onShowWorkspaceManagement,
}: SidebarMessageSessionsProps) => {
  const { isSidebarOpen, toggleSidebar, closeSidebar, sidebarWidth, setSidebarWidth } =
    useSidebar();

  const sidebarRef = useRef<HTMLDivElement>(null);
  const isResizing = useRef(false);
  const startX = useRef(0);
  const startWidth = useRef(0);
  const [isSearchActive, setIsSearchActive] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [shortcutsExpanded, setShortcutsExpanded] = useState(true);
  const [miscGroupExpanded, setMiscGroupExpanded] = useState(true);
  const [isAnimating, _setIsAnimating] = useState(false);
  const [isAllExpanded, setIsAllExpanded] = useState(true);
  const [isMobile, setIsMobile] = useState(window.innerWidth < 1080); // Mobile breakpoint
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const isMobileHook = useIsMobile();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();

  const selectedSessionId = searchParams.get('session_id');


  // Handle window resize for mobile detection
  useEffect(() => {
    const handleResize = () => {
      setIsMobile(window.innerWidth < 1080); // Mobile breakpoint
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // Add/remove class to body based on sidebar state
  // Width is now managed by the sidebar context

  // Add/remove classes based on sidebar state
  useEffect(() => {
    if (isSidebarOpen) {
      document.body.classList.remove('conversations-sidebar-closed');
      document.body.classList.add('conversations-sidebar-open');
    } else {
      document.body.classList.add('conversations-sidebar-closed');
      document.body.classList.remove('conversations-sidebar-open');
    }

    return () => {
      document.body.classList.remove('conversations-sidebar-closed');
      document.body.classList.remove('conversations-sidebar-open');
    };
  }, [isSidebarOpen]);

  // Handle mouse down on resize handle
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      isResizing.current = true;
      startX.current = e.clientX;
      startWidth.current = sidebarWidth;
      document.body.style.cursor = 'ew-resize';
      document.body.style.userSelect = 'none';

      // Add event listeners for mouse move and mouse up
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are intentionally limited
    [sidebarWidth]
  );

  // Handle mouse move during resize
  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!isResizing.current) return;

    const deltaX = e.clientX - startX.current;
    let newWidth = startWidth.current + deltaX;

    // Apply constraints (min 300px, max 500px)
    newWidth = Math.max(300, Math.min(500, newWidth));

    setSidebarWidth(newWidth);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are intentionally limited
  }, []);

  // Handle mouse up to end resizing
  const handleMouseUp = useCallback(() => {
    isResizing.current = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';

    // Remove event listeners
    document.removeEventListener('mousemove', handleMouseMove);
    document.removeEventListener('mouseup', handleMouseUp);
  }, [handleMouseMove]);

  // Handle a new session - delegate to parent component
  const handleNewSession = () => {
    // Let the parent component handle session creation and navigation
    onNewSession();

    // Close sidebar on mobile/tablet
    const isMobileOrTablet = window.innerWidth < 1080;
    if (isMobileOrTablet) {
      onCloseMobileMenu?.();
      closeSidebar();
    }
  };

  // Wrap refreshSessions to also update the refresh trigger
  const handleRefreshSessions = useCallback(async (_forceRefresh?: boolean) => {
    if (refreshSessions) {
      await refreshSessions();
      // Increment refresh trigger to notify SessionsGroupHeader to refetch count
      setRefreshTrigger(prev => prev + 1);
    }
  }, [refreshSessions]);

  // Handle selection of an existing session
  const handleSelectSession = (session: Session) => {
    // Update URL with the new session_id and remove session_state (it's only for new sessions)
    const newSearchParams = new URLSearchParams(searchParams);
    newSearchParams.set('session_id', session.id);
    newSearchParams.delete('session_state'); // Remove new session marker when selecting existing session
    navigate({
      pathname: location.pathname,
      search: newSearchParams.toString(),
    });

    // Call the original onSelectSession function
    onSelectSession(session);

    // Close sidebar on mobile/tablet after session selection
    const isMobileOrTablet = window.innerWidth < 1080;
    if (isMobileOrTablet) {
      onCloseMobileMenu?.();
      closeSidebar();
    }
  };

  // Handle click outside to close sidebar (mobile only)
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const isMobileOrTablet = window.innerWidth < 1080;
      const target = event.target as Node;

      // Check if the click was on the GlobalSidebarToggle button
      const isGlobalToggleClick = target && (
        (target as Element).closest?.('[data-global-sidebar-toggle]') ||
        (target as Element).classList?.contains('global-sidebar-toggle') ||
        (target as Element).closest?.('.global-sidebar-toggle')
      );

      // A row's three-dots menu (and its rename/move/share dialogs) are Radix
      // primitives PORTALED to document.body, i.e. outside sidebarRef. Without
      // this guard a mousedown on any menu item / dialog counts as "outside" and
      // collapses the whole sidebar — so pinning/deleting/renaming closed it on
      // mobile. The sidebar must only close on a genuine outside tap, not when
      // interacting with a menu/dialog that logically belongs to a session row.
      const isInsidePortalLayer = target instanceof Element && !!target.closest(
        '[data-radix-popper-content-wrapper],[data-radix-menu-content],[role="menu"],[role="dialog"]'
      );

      if (
        isMobileOrTablet &&
        (mobileMenuOpen || isSidebarOpen) &&
        sidebarRef.current &&
        !sidebarRef.current.contains(target) &&
        !isResizing.current &&
        !isGlobalToggleClick &&
        !isInsidePortalLayer
      ) {
        onCloseMobileMenu?.();
        closeSidebar();
      } else if (
        !isMobileOrTablet &&
        isSidebarOpen &&
        sidebarRef.current &&
        !sidebarRef.current.contains(event.target as Node) &&
        !isResizing.current
      ) {
        // On desktop, don't auto-close sidebar on outside click
        // Users can use the toggle button to close it manually
        // toggleSidebar();
      }
    };

    // Only add the event listener if sidebar is open (mobile or desktop)
    if (mobileMenuOpen || isSidebarOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isSidebarOpen, mobileMenuOpen, onCloseMobileMenu, closeSidebar]);

  const toggleSearch = () => {
    setIsSearchActive(!isSearchActive);
    if (!isSearchActive) {
      setTimeout(() => {
        const searchInput = document.getElementById('sidebar-search');
        if (searchInput) {
          searchInput.focus();
        }
      }, 100);
    }
  };

  const handleExpandAll = () => {
    const newExpandedState = !isAllExpanded;
    setIsAllExpanded(newExpandedState);
    setMiscGroupExpanded(newExpandedState);
    setShortcutsExpanded(newExpandedState);
  };

  return (
    <>
      {/* Mobile backdrop overlay */}
      {(mobileMenuOpen || (isSidebarOpen && isMobile)) && (
        <div
          data-testid="sidebar-mobile-backdrop"
          className="fixed inset-0 bg-black/50 dark:bg-black/70 z-40 lg:hidden"
          onClick={() => {
            if (isMobile && onCloseMobileMenu) {
              onCloseMobileMenu();
            }
          }}
        />
      )}

      <div
        ref={sidebarRef}
        data-sidebar
        style={{
          width: isMobile ? '320px' : `${sidebarWidth}px`,
          maxWidth: isMobile ? '90vw' : `${sidebarWidth}px`
        }}
        className={cn(
          // h-screen-dynamic (not h-screen): 100vh on mobile Chrome includes
          // the area behind the collapsible URL bar, which pushed the sidebar
          // footer (user menu / logout) below the visible viewport.
          'fixed top-0 left-0 min-[1080px]:left-[70px] border-r border-border/70 dark:border-sidebar-border/80 flex flex-col h-screen-dynamic transition-all duration-300 transform z-50 bg-card dark:bg-zinc-950 text-zinc-900 dark:text-zinc-100 max-[1079px]:w-[320px] max-[1079px]:max-w-[90vw]',
          isSidebarOpen || mobileMenuOpen
            ? 'translate-x-0 opacity-100 visible'
            : '-translate-x-full opacity-0 invisible',
          isAnimating ? 'pointer-events-none' : '',
          isMobileHook ? 'mobile-sidebar' : ''
        )}
      >
        {/* Resize handle - hidden on mobile */}
        <div
          data-testid="sidebar-resize-handle"
          className='absolute top-0 right-0 w-1 h-full cursor-ew-resize bg-transparent hover:bg-blue-400/50 z-1 max-lg:hidden'
          onMouseDown={handleMouseDown}
        />
        <SessionsHeader
          isSearchActive={isSearchActive}
          searchQuery={searchQuery}
          setSearchQuery={setSearchQuery}
          toggleSearch={toggleSearch}
          isSidebarOpen={isSidebarOpen}
          toggleSidebar={toggleSidebar}
          onExpandAll={handleExpandAll}
          isAllExpanded={isAllExpanded}
          mobileMenuOpen={mobileMenuOpen}
          onCloseMobileMenu={onCloseMobileMenu}
          onShowWorkspaceManagement={onShowWorkspaceManagement}
        />

        <SessionsArea
          miscGroupExpanded={miscGroupExpanded}
          setMiscGroupExpanded={setMiscGroupExpanded}
          shortcutsExpanded={shortcutsExpanded}
          setShortcutsExpanded={setShortcutsExpanded}
          selectedSessionId={selectedSessionId}
          onSelectSession={handleSelectSession}
          onNewSession={handleNewSession}
          refreshSessions={handleRefreshSessions}
          mobileMenuOpen={mobileMenuOpen}
          onCloseMobileMenu={onCloseMobileMenu}
          refreshTrigger={externalRefreshTrigger ?? refreshTrigger}
        />

        <SessionsNew
          onNewSession={handleNewSession}
          openSettingsWithTab={openSettingsWithTab}
          mobileMenuOpen={mobileMenuOpen}
          onCloseMobileMenu={onCloseMobileMenu}
        />
      </div>
    </>
  );
};

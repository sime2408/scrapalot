import React, { useState } from 'react';
import { DocumentCollection, Session } from '@/types';
import { SidebarQuickTools } from '@/components/layout/sidebar/sidebar-quick-tools.tsx';
import { SessionsSidebarMessage } from '@/components/layout/sidebar/sessions/sessions-sidebar-message.tsx';
import Settings from '@/components/settings/settings.tsx';
import type { SettingsTab } from '@/types/settings-types.ts';
import { v4 as uuidv4 } from 'uuid';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';

interface SidebarProps {
  selectedSessionId: string | null;
  onSelectSession: (session: Session) => void;
  onNewSession: () => void;
  selectedCollection: DocumentCollection | null;
  onSelectCollection: (collection: DocumentCollection | null) => void;
  isOpen: boolean;
  onToggleSidebar: () => void;
  isMobile: boolean;
  sessions: Session[];
  refreshSessions?: () => Promise<void>;
  sidebarRefreshCount?: number;
  isChatPage?: boolean;
  openSettingsWithTab?: (tab: string) => void;
  showSettingsDialog?: boolean;
  setShowSettingsDialog?: (show: boolean) => void;
  activeSettingsTab?: SettingsTab;
  mobileMenuOpen?: boolean;
  onMobileMenuToggle?: (open: boolean) => void;
  onShowWorkspaceManagement?: () => void;
}

export const Sidebar = ({
  onSelectSession,
  onNewSession,
  isOpen,
  onToggleSidebar,
  refreshSessions,
  isChatPage,
  openSettingsWithTab: externalOpenSettingsWithTab,
  showSettingsDialog,
  setShowSettingsDialog,
  activeSettingsTab,
  mobileMenuOpen,
  onMobileMenuToggle,
  onShowWorkspaceManagement,
  sidebarRefreshCount,
}: SidebarProps) => {
  // Use prop values if provided, otherwise use local state
  const [localShowSettingsDialog, setLocalShowSettingsDialog] = useState(false);
  const [localActiveSettingsTab, setLocalActiveSettingsTab] =
    useState<SettingsTab>('general');

  // Use provided state or local state
  const isSettingsDialogOpen =
    showSettingsDialog !== undefined
      ? showSettingsDialog
      : localShowSettingsDialog;
  const setIsSettingsDialogOpen =
    setShowSettingsDialog || setLocalShowSettingsDialog;
  const currentActiveTab = activeSettingsTab || localActiveSettingsTab;
  const setCurrentActiveTab = activeSettingsTab
    ? (_tab: SettingsTab) => {}
    : setLocalActiveSettingsTab;

  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const handleShowRemoteProviders = (show: boolean) => {
    setCurrentActiveTab('remote-providers');
    setIsSettingsDialogOpen(show);
  };

  const handleShowSettingsGeneral = (show: boolean) => {
    setCurrentActiveTab('general');
    setIsSettingsDialogOpen(show);
  };

  const handleOpenSettingsWithTab = (tab: string) => {
    // Use the external handler if provided, otherwise use the internal one
    if (externalOpenSettingsWithTab) {
      externalOpenSettingsWithTab(tab);
    } else {
      setCurrentActiveTab(tab as SettingsTab);
      setIsSettingsDialogOpen(true);
    }
  };

  const handleNewSession = () => {
    const sessionId = uuidv4();
    // Add the session_id and session_state=new to the URL as query parameters
    const currentPath = location.pathname;
    const newSearchParams = new URLSearchParams(searchParams);
    newSearchParams.set('session_id', sessionId);
    newSearchParams.set('session_state', 'new');

    // Navigate to the new URL with the session_id and session_state parameters
    navigate(`${currentPath}?${newSearchParams.toString()}`, {
      replace: false,
    });

    // Call the original onNewSession function
    onNewSession();
  };

  return (
    <>
      {/* Icon sidebar - show on all screens now */}
      <SidebarQuickTools
        onNewSession={handleNewSession}
        setShowRemoteModelProviders={handleShowRemoteProviders}
        setShowSettingsGeneral={handleShowSettingsGeneral}
        openSettingsWithTab={handleOpenSettingsWithTab}
        isOpen={isOpen}
        closeSidebar={onToggleSidebar}
        isChatPage={isChatPage}
        mobileMenuOpen={mobileMenuOpen}
        onCloseMobileMenu={() => onMobileMenuToggle?.(false)}
      />

      {/* Sessions sidebar - hidden on mobile and tablet portrait unless mobile menu is open */}
      {isChatPage && (
        <div className='z-20' data-testid="sidebar-sessions-container">
          <SessionsSidebarMessage
            onSelectSession={onSelectSession}
            onNewSession={handleNewSession}
            refreshSessions={refreshSessions}
            externalRefreshTrigger={sidebarRefreshCount}
            openSettingsWithTab={handleOpenSettingsWithTab}
            mobileMenuOpen={mobileMenuOpen}
            onCloseMobileMenu={() => onMobileMenuToggle?.(false)}
            onShowWorkspaceManagement={onShowWorkspaceManagement}
          />
        </div>
      )}

      <Settings
        open={isSettingsDialogOpen}
        onOpenChange={setIsSettingsDialogOpen}
        defaultTab={currentActiveTab}
      />
    </>
  );
};

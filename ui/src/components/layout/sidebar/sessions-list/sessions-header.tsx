import React, { useRef, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { LayoutGrid, Search } from 'lucide-react';
import Settings from '@/components/settings/settings';
import { AnimatedTitle } from '@/components/ui/animated-title';

interface SessionsHeaderProps {
  isSearchActive: boolean;
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  toggleSearch: () => void;
  isSidebarOpen: boolean;
  toggleSidebar: () => void;
  onExpandAll?: () => void;
  isAllExpanded?: boolean;
  mobileMenuOpen?: boolean;
  onCloseMobileMenu?: () => void;
  onShowWorkspaceManagement?: () => void;
}

export const SessionsHeader = ({
  isSearchActive,
  searchQuery,
  setSearchQuery,
  toggleSearch,
  isSidebarOpen: _isSidebarOpen,
  toggleSidebar: _toggleSidebar,
  onExpandAll,
  isAllExpanded,
  mobileMenuOpen,
  onCloseMobileMenu,
  onShowWorkspaceManagement: _onShowWorkspaceManagement,
}: SessionsHeaderProps) => {
  const { t } = useTranslation();
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);

  // listen for the Command Palette's
  // 'scrapalot:open-settings' event so picking 'Open Settings' from
  // Cmd+K opens the existing dialog. The palette dispatches a
  // CustomEvent rather than reaching into this state directly to keep
  // it free of upstream coupling.
  useEffect(() => {
    const onOpenSettings = () => setIsSettingsOpen(true);
    window.addEventListener('scrapalot:open-settings', onOpenSettings);
    return () => window.removeEventListener('scrapalot:open-settings', onOpenSettings);
  }, []);

  useEffect(() => {
    if (!svgRef.current) return;

    const upChevron = svgRef.current.querySelector(
      '#chevron-up'
    ) as SVGPathElement;
    const downChevron = svgRef.current.querySelector(
      '#chevron-down'
    ) as SVGPathElement;

    if (upChevron && downChevron) {
      if (isAllExpanded) {
        upChevron.style.transform = 'translateY(-3px)';
        downChevron.style.transform = 'translateY(3px)';
      } else {
        upChevron.style.transform = 'translateY(0px)';
        downChevron.style.transform = 'translateY(0px)';
      }
    }
  }, [isAllExpanded]);

  return (
    <div className='sessions-header-container' data-testid="sidebar-sessions-header">
      <div className='h-14 border-b border-border dark:border-chat-sidebar-border flex-shrink-0 flex items-center bg-card dark:bg-black relative'>
        <div className='ml-[92px] lg:ml-3 flex-1'>
          {isSearchActive ? (
            <div className='flex items-center bg-zinc-200 dark:bg-chat-sidebar-button px-2'>
              <Search className='h-4 w-4 text-zinc-600 dark:text-chat-sidebar-foreground/50 mr-2' />
              <input
                id='sidebar-search'
                data-testid="sidebar-search-input"
                type='text'
                placeholder={t('sidebar.searchConversations')}
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                className='w-full py-1.5 bg-transparent text-zinc-800 dark:text-chat-sidebar-foreground border-none text-sm focus:outline-none'
                autoFocus
              />
            </div>
          ) : (
            <div className='text-zinc-500 dark:text-zinc-600 dark:text-chat-sidebar-foreground'>
              <AnimatedTitle title={t('sidebar.conversations')} animationDuration={5000} />
            </div>
          )}
        </div>

        <div className='mr-2 flex items-center gap-2 no-mobile-scale'>
          <button
            data-testid="sidebar-search-toggle-button"
            className='w-8 h-8 flex items-center justify-center text-zinc-600 dark:text-chat-sidebar-foreground/70 hover:text-zinc-800 dark:hover:text-chat-sidebar-foreground'
            onClick={() => {
              toggleSearch();
              // Close mobile menu if open
              const isMobileOrTablet = window.innerWidth < 1080;
              if (isMobileOrTablet && mobileMenuOpen && onCloseMobileMenu) {
                onCloseMobileMenu();
              }
            }}
          >
            <Search className='h-5 w-5' />
          </button>

          <button
            data-testid="sidebar-expand-all-button"
            className='w-8 h-8 flex items-center justify-center text-zinc-600 dark:text-chat-sidebar-foreground/70 hover:text-zinc-800 dark:hover:text-chat-sidebar-foreground'
            onClick={() => {
              if (onExpandAll) onExpandAll();
              // Close mobile menu if open
              const isMobileOrTablet = window.innerWidth < 1080;
              if (isMobileOrTablet && mobileMenuOpen && onCloseMobileMenu) {
                onCloseMobileMenu();
              }
            }}
            title={
              isAllExpanded
                ? t('sidebar.collapseAllFolders')
                : t('sidebar.expandAllFolders')
            }
          >
            <img
              src={isAllExpanded ? '/icons/collapse.jpg' : '/icons/expand.jpg'}
              alt={
                isAllExpanded
                  ? t('sidebar.collapseAllFolders')
                  : t('sidebar.expandAllFolders')
              }
              className='h-4 w-4 dark:invert'
            />
          </button>

          <button
            data-testid="sidebar-workspace-settings-button"
            className='w-8 h-8 flex items-center justify-center text-zinc-600 dark:text-chat-sidebar-foreground/70 hover:text-zinc-800 dark:hover:text-chat-sidebar-foreground'
            onClick={() => {
              setIsSettingsOpen(true);
              // Close mobile menu if open
              const isMobileOrTablet = window.innerWidth < 1080;
              if (isMobileOrTablet && mobileMenuOpen && onCloseMobileMenu) {
                onCloseMobileMenu();
              }
            }}
            title={t('sidebar.manageWorkspaces')}
          >
            <LayoutGrid className='h-5 w-5' />
          </button>
        </div>
      </div>

      {/* Settings Dialog with Workspaces Tab */}
      <Settings
        open={isSettingsOpen}
        onOpenChange={setIsSettingsOpen}
        defaultTab="workspaces"
      />
    </div>
  );
};

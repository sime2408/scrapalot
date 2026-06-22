import { MoreHorizontal, Pencil, LogOut } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu.tsx';
import { useTranslation } from 'react-i18next';
import { useIsMobileOrTabletPortrait, useIsMobile } from '@/hooks/use-mobile';
import { cn } from '@/lib/utils';
import { navigateToLogin } from '@/lib/navigation';
import { AnimatedTitle } from '@/components/ui/animated-title';

interface NewSessionFooterProps {
  onNewSession: () => void;
  openSettingsWithTab?: (tab: string) => void;
  mobileMenuOpen?: boolean;
  onCloseMobileMenu?: () => void;
}

export const SessionsNew = ({
  onNewSession,
  openSettingsWithTab: _openSettingsWithTab,
  mobileMenuOpen,
  onCloseMobileMenu,
}: NewSessionFooterProps) => {
  const { t } = useTranslation();
  const isMobileOrTabletPortrait = useIsMobileOrTabletPortrait();
  const isMobile = useIsMobile();

  return (
    <div className={cn(
      'border-border dark:border-zinc-800 md:px-2 py-[10px] lg:px-3 lg:py-2 mt-auto bg-card dark:bg-black border-t border-t-border' +
      ' dark:border-t-[#333333]',
      isMobile ? 'mobile-sidebar -mb-[2px]' : ''
    )}>
      <div className='flex text-zinc-800 dark:text-white overflow-hidden'>
        {/* Logout button for mobile */}
        {isMobileOrTabletPortrait && (
          <button
            data-testid="sidebar-mobile-logout-button"
            onClick={() => {
              // Clear auth tokens
              localStorage.removeItem('auth_tokens');
              sessionStorage.removeItem('auth_tokens');
              // Redirect to login
              navigateToLogin();
            }}
            className='w-12 h-[34px] md:h-8 lg:h-6 flex items-center justify-center text-zinc-600 dark:text-white hover:bg-zinc-200 dark:hover:bg-[#2b2b2b] transition-colors'
            title='Logout'
          >
            <LogOut className='h-4 w-4' />
          </button>
        )}

        {/* Separator after mobile buttons */}
        {isMobileOrTabletPortrait && (
          <div className='w-[1px] bg-zinc-300 dark:bg-zinc-600/40 self-stretch'></div>
        )}

        <div
          data-testid="sidebar-new-session-button"
          className='flex items-center justify-between flex-1 p-2 h-[34px] md:h-[32px] cursor-pointer hover:bg-zinc-200 dark:hover:bg-[#2b2b2b]'
          onClick={() => {
            onNewSession();
            // Close mobile menu if open on mobile devices only
            const isMobileOrTablet = window.innerWidth < 1080;
            if (isMobileOrTablet && mobileMenuOpen && onCloseMobileMenu) {
              onCloseMobileMenu();
            }
          }}
        >
          <div className='flex items-center'>
            <Pencil className='h-4 w-4 mr-2 text-zinc-600 dark:text-white' />
            <AnimatedTitle title={t('sidebar.newConversation')} className='text-sm' animationDuration={5000} />
          </div>
          <span className='text-xs text-zinc-500 dark:text-gray-400'>+</span>
        </div>

        <div className='w-[1px] bg-zinc-300 dark:bg-zinc-600/40 self-stretch'></div>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <div className='flex items-center justify-center'>
              <button data-testid="sidebar-session-options-button" className='h-[34px] md:h-8 w-12 flex items-center justify-center text-zinc-600 dark:text-white hover:bg-zinc-200 dark:hover:bg-[#2b2b2b] transition-colors'>
                <MoreHorizontal className='h-4 w-4' />
              </button>
            </div>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align='end'
            className='bg-card dark:bg-zinc-900 border border-border dark:border-zinc-800 text-zinc-800 dark:text-white'
          >
            <DropdownMenuItem data-testid="sidebar-clear-chat-option" className='text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800 focus:bg-zinc-100 dark:focus:bg-zinc-800 focus:text-zinc-900 dark:focus:text-white cursor-pointer'>
              <span>{t('sidebar.clearChat')}</span>
            </DropdownMenuItem>
            <DropdownMenuItem data-testid="sidebar-new-chat-tab-option" className='text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800 focus:bg-zinc-100 dark:focus:bg-zinc-800 focus:text-zinc-900 dark:focus:text-white cursor-pointer'>
              <span>{t('sidebar.newChatInNewTab')}</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
};

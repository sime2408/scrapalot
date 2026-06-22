import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useTheme } from '@/providers/theme-provider';
import { usePDFViewer } from '@/contexts/pdf-viewer-context';
import { useNotesDrawer } from '@/hooks/use-notes-drawer';
import { useSidebar } from '@/contexts/sidebar-context';
import { useIsMobileOrTabletPortrait } from '@/hooks/use-mobile';
import { useFloatingWindowManager } from '@/contexts/floating-window-context';

interface WelcomeScreenProps {
  onNewSession: () => void;
  isDrawerOpen?: boolean;
}

export const ChatMessageWelcome = ({ onNewSession, isDrawerOpen = false }: WelcomeScreenProps) => {
  const { t } = useTranslation();
  const { accentColor } = useTheme();
  const { state: pdfState } = usePDFViewer();
  const notesDrawer = useNotesDrawer();
  const { isSidebarOpen } = useSidebar();
  const isMobileOrTabletPortrait = useIsMobileOrTabletPortrait();
  const floatingMgr = useFloatingWindowManager();

  // Memoize position style to avoid recalculating on every render
  const positionStyle = useMemo((): React.CSSProperties => {
    if (!isDrawerOpen || isMobileOrTabletPortrait) {
      return {};
    }

    const isPdfOpen = pdfState.isOpen && floatingMgr.modes['pdf-viewer'] !== 'floating';
    const isNotesOpen = notesDrawer.isOpen && floatingMgr.modes['notes-drawer'] !== 'floating';
    const isPdfOnLeft = pdfState.isOnLeft;
    const isNotesOnLeft = notesDrawer.isOnLeft;

    const drawerOnLeft = (isPdfOpen && isPdfOnLeft) || (isNotesOpen && isNotesOnLeft && !isPdfOpen);

    if (drawerOnLeft) {
      return {
        width: 'calc(50vw)',
        position: 'absolute' as const,
        right: '0',
        left: 'auto',
        height: '100%',
      };
    } else {
      const sidebarWidth = isSidebarOpen ? 335 : 70;
      return {
        width: `calc(50vw - ${sidebarWidth}px)`,
        position: 'absolute' as const,
        left: '0',
        right: 'auto',
        height: '100%',
      };
    }
  }, [isDrawerOpen, isMobileOrTabletPortrait, pdfState.isOpen, pdfState.isOnLeft, notesDrawer.isOpen, notesDrawer.isOnLeft, isSidebarOpen, floatingMgr.modes]);

  // Memoize button gradient class based on accent color
  const buttonGradientClass = useMemo(() => {
    switch (accentColor) {
      case 'gray': return 'bg-gradient-to-r from-zinc-400 to-zinc-600 hover:from-zinc-500 hover:to-zinc-700';
      case 'blue': return 'bg-gradient-to-r from-blue-400 to-blue-600 hover:from-blue-500 hover:to-blue-700';
      case 'green': return 'bg-gradient-to-r from-green-400 to-green-600 hover:from-green-500 hover:to-green-700';
      case 'red': return 'bg-gradient-to-r from-red-400 to-red-600 hover:from-red-500 hover:to-red-700';
      case 'violet': return 'bg-gradient-to-r from-violet-400 to-violet-600 hover:from-violet-500 hover:to-violet-700';
      case 'orange': return 'bg-gradient-to-r from-orange-400 to-orange-600 hover:from-orange-500 hover:to-orange-700';
      default: return 'bg-gradient-to-r from-violet-400 to-violet-600 hover:from-violet-500 hover:to-violet-700';
    }
  }, [accentColor]);

  return (
    <div
      className='h-full flex flex-col items-center justify-center p-4 md:p-8 animate-fade-in bg-gradient-to-b from-zinc-100 to-white dark:from-zinc-900 dark:to-black'
      style={positionStyle}
    >
      <div className='max-w-lg text-center space-y-4'>
        <h3 className='text-xl md:text-2xl font-semibold'>
          {t('chat.welcome.noConversation')}
        </h3>
        <p className='text-muted-foreground text-sm md:text-base'>
          {t('chat.welcome.selectOrStart')}
        </p>
        <button
          data-testid="chat-welcome-new-session-button"
          data-tour="start-conversation"
          onClick={onNewSession}
          className={`inline-flex items-center px-4 py-2 cursor-pointer font-medium transition-all duration-200 text-white ${buttonGradientClass}`}
        >
          {t('chat.welcome.startNew')}
        </button>
        {/* Cmd/Ctrl+K hint on the empty session
            screen so users discover the global Command Palette. We
            sniff platform via navigator.userAgent rather than the
            deprecated navigator.platform; falls back to Ctrl when
            unknown so non-Mac users don't see a misleading ⌘. */}
        {!isMobileOrTabletPortrait && (
          <p className='text-xs text-muted-foreground/70 pt-4'>
            {t('chat.welcome.commandPaletteHint', 'Tip: press')}{' '}
            <kbd className='inline-flex items-center px-1.5 py-0.5 border border-border bg-card font-mono text-[11px]'>
              {/^Mac/i.test(navigator.userAgent) ? '⌘' : 'Ctrl'}
            </kbd>
            <span className='mx-1 text-muted-foreground/50'>+</span>
            <kbd className='inline-flex items-center px-1.5 py-0.5 border border-border bg-card font-mono text-[11px]'>K</kbd>
            <span className='ml-2'>
              {t('chat.welcome.commandPaletteHintTail', 'to open the Command Palette anywhere.')}
            </span>
          </p>
        )}
      </div>
    </div>
  );
};

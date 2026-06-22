import { useEffect, useRef, useState } from 'react';
import { ArrowUp, ChevronDown } from 'lucide-react';
import { useTheme } from '@/providers/theme-provider';
import { useTranslation } from 'react-i18next';

interface SidebarShortcutsProps {
  shortcutsExpanded?: boolean;
  setShortcutsExpanded: (expanded: boolean) => void;
}

export const SessionsShortcutHints = ({
  shortcutsExpanded: initialExpanded = true,
  setShortcutsExpanded,
}: SidebarShortcutsProps) => {
  // Start with expanded state by default
  const [expanded, setExpanded] = useState(initialExpanded);

  // Keep parent state in sync with local state
  useEffect(() => {
    setShortcutsExpanded(expanded);
  }, [expanded, setShortcutsExpanded]);
  const contentRef = useRef<HTMLDivElement>(null);
  const { theme } = useTheme();
  const { t } = useTranslation();

  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;

    if (expanded) {
      content.style.maxHeight = `${content.scrollHeight}px`;
    } else {
      content.style.maxHeight = '0px';
    }
  }, [expanded]);

  return (
    <div className='px-4 py-3 hidden min-[1080px]:block' data-testid="sidebar-shortcut-hints">
      <div className='w-full border-2 border-dashed border-[#e5e5e8] dark:border-zinc-700'>
        <button
          data-testid="sidebar-shortcut-hints-toggle"
          onClick={() => setExpanded(!expanded)}
          className={`w-full flex items-center justify-center gap-2 px-4 py-4 text-xs 
          ${theme === 'light' ? 'text-black hover:text-black' : 'dark:text-white/70 dark:hover:text-white'}`}
        >
          <span>{t('sidebar.usefulShortcuts')}</span>
          <ChevronDown
            className={`h-4 w-4 transition-transform duration-1000 ease-&lsqb;cubic-bezier(0.16,1,0.3,1)&rsqb; ${expanded ? 'rotate-180' : ''
              }`}
          />
        </button>

        <div
          ref={contentRef}
          style={{
            maxHeight: expanded ? '1000px' : '0px',
            overflow: 'hidden',
            transition: 'max-height 0.5s cubic-bezier(0.16, 1, 0.3, 1)',
          }}
        >
          <div
            className={`py-3 ${theme === 'light' ? 'text-zinc-700' : 'text-white/70'} text-xs space-y-3`}
          >
            <div className='px-4 py-2 flex items-center hover:bg-chat-sidebar-button/20'>
              <span
                className={`${theme === 'light' ? 'text-zinc-500' : 'text-white/50'} font-bold text-right w-16 flex-shrink-0`}
              >
                Ctrl N
              </span>
              <span className='ml-3 text-left flex-1'>
                {t('shortcuts.newConversation')}
              </span>
            </div>
            <div className='px-4 py-2 flex items-center hover:bg-chat-sidebar-button/20'>
              <span
                className={`${theme === 'light' ? 'text-zinc-500' : 'text-white/50'} font-bold text-right w-16 flex-shrink-0`}
              >
                Ctrl T
              </span>
              <span className='ml-3 text-left flex-1'>
                {t('shortcuts.addSplitChat')}
              </span>
            </div>
            <div className='px-4 py-2 flex items-center hover:bg-chat-sidebar-button/20'>
              <span
                className={`${theme === 'light' ? 'text-zinc-500' : 'text-white/50'} font-bold text-right w-16 flex-shrink-0`}
              >
                Ctrl ⇧ S
              </span>
              <span className='ml-3 text-left flex-1'>
                {t('shortcuts.toggleContextShield')}
              </span>
            </div>
            <div className='px-4 py-2 flex items-center hover:bg-chat-sidebar-button/20'>
              <span
                className={`${theme === 'light' ? 'text-zinc-500' : 'text-white/50'} font-bold text-right w-16 flex-shrink-0`}
              >
                Ctrl ⇧ T
              </span>
              <span className='ml-3 text-left flex-1'>
                {t('shortcuts.toggleThemeTray')}
              </span>
            </div>
            <div className='px-4 py-2 flex items-center hover:bg-chat-sidebar-button/20'>
              <span
                className={`${theme === 'light' ? 'text-zinc-500' : 'text-white/50'} font-bold text-right w-16 flex-shrink-0`}
              >
                Ctrl ⇧ C
              </span>
              <span className='ml-3 text-left flex-1'>
                {t('shortcuts.copyLastAIMessage')}
              </span>
            </div>
            <div className='px-4 py-2 flex items-center hover:bg-chat-sidebar-button/20'>
              <span
                className={`${theme === 'light' ? 'text-zinc-500' : 'text-white/50'} font-bold text-right w-16 flex-shrink-0`}
              >
                Ctrl ⇧ R
              </span>
              <span className='ml-3 text-left flex-1'>
                {t('shortcuts.regenerateLastAIMessage')}
              </span>
            </div>
            <div className='px-4 py-2 flex items-center hover:bg-chat-sidebar-button/20'>
              <span
                className={`${theme === 'light' ? 'text-zinc-500' : 'text-white/50'} font-bold text-right w-16 flex-shrink-0`}
              >
                <ArrowUp className='h-3 w-3 inline' />
              </span>
              <span className='ml-3 text-left flex-1'>
                {t('shortcuts.editLastUserMessage')}
              </span>
            </div>
            <div className='px-4 py-2 flex items-center hover:bg-chat-sidebar-button/20'>
              <span
                className={`${theme === 'light' ? 'text-zinc-500' : 'text-white/50'} font-bold text-right w-16 flex-shrink-0`}
              >
                Alt <ArrowUp className='h-3 w-3 inline' />
              </span>
              <span className='ml-3 text-left flex-1'>
                {t('shortcuts.editLastAIMessage')}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

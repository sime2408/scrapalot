import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FolderOpen, FileText, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { MentionItem } from '@/hooks/use-chat-mentions';

interface ChatMentionPopoverProps {
  suggestions: MentionItem[];
  loading: boolean;
  isCollectionMode: boolean;
  isDrillDown?: boolean;
  drillDownCollectionName?: string;
  onSelect: (item: MentionItem) => void;
  onClose: () => void;
  anchorRef: React.RefObject<HTMLTextAreaElement | null>;
}

export const ChatMentionPopover = ({
  suggestions,
  loading,
  isCollectionMode,
  isDrillDown,
  drillDownCollectionName,
  onSelect,
  onClose,
  anchorRef,
}: ChatMentionPopoverProps) => {
  const { t } = useTranslation();
  const [selectedIndex, setSelectedIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // Reset selection when suggestions change
  useEffect(() => {
    setSelectedIndex(0);
  }, [suggestions]);

  // Scroll selected item into view
  useEffect(() => {
    itemRefs.current[selectedIndex]?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  // Keyboard navigation (attached to textarea via parent)
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (suggestions.length === 0 && !loading) return;

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        e.stopPropagation();
        setSelectedIndex(prev => (prev + 1) % Math.max(suggestions.length, 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        e.stopPropagation();
        setSelectedIndex(prev => (prev - 1 + Math.max(suggestions.length, 1)) % Math.max(suggestions.length, 1));
        break;
      case 'Enter':
        e.preventDefault();
        e.stopPropagation();
        if (suggestions[selectedIndex]) {
          onSelect(suggestions[selectedIndex]);
        }
        break;
      case 'Tab':
        e.preventDefault();
        e.stopPropagation();
        if (suggestions[selectedIndex]) {
          onSelect(suggestions[selectedIndex]);
        }
        break;
      case 'Escape':
        e.preventDefault();
        onClose();
        break;
    }
  }, [suggestions, selectedIndex, onSelect, onClose, loading]);

  // Attach keyboard handler to textarea
  useEffect(() => {
    const textarea = anchorRef.current;
    if (!textarea) return;

    textarea.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => {
      textarea.removeEventListener('keydown', handleKeyDown, { capture: true });
    };
  }, [anchorRef, handleKeyDown]);

  const isEmpty = suggestions.length === 0 && !loading;

  return (
    <div
      ref={listRef}
      data-testid="chat-mention-popover"
      onMouseDown={e => e.preventDefault()}
      className={cn(
        'absolute bottom-full left-0 mb-1 mx-2 w-[320px]',
        'bg-card dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700',
        'shadow-lg max-h-[200px] overflow-y-auto overscroll-contain z-50'
      )}
    >
      {/* Header */}
      <div className='px-2 py-1 border-b border-zinc-100 dark:border-zinc-800 text-[10px] font-medium text-zinc-400 dark:text-zinc-500 uppercase tracking-wider flex items-center gap-1'>
        {isDrillDown && drillDownCollectionName ? (
          <>
            <FolderOpen className='h-2.5 w-2.5' />
            <span className='truncate max-w-[120px]'>{drillDownCollectionName}</span>
            <span>/</span>
            <span>{t('chat.mentions.documents')}</span>
          </>
        ) : isCollectionMode
          ? t('chat.mentions.collections')
          : t('chat.mentions.documents')}
      </div>

      {/* Loading state */}
      {loading && suggestions.length === 0 && (
        <div className='flex items-center gap-1.5 px-2 py-2 text-xs text-zinc-500'>
          <Loader2 className='h-3 w-3 animate-spin' />
          {t('chat.mentions.loading')}
        </div>
      )}

      {/* Empty state */}
      {isEmpty && (
        <div className='px-2 py-2 text-xs text-zinc-400 dark:text-zinc-500'>
          {t('chat.mentions.noResults')}
        </div>
      )}

      {/* Suggestion list */}
      {suggestions.map((item, index) => (
        <button
          key={`${item.type}-${item.id}`}
          data-testid={`chat-mention-suggestion-${item.type}-${item.id}`}
          ref={el => { itemRefs.current[index] = el; }}
          onClick={() => onSelect(item)}
          className={cn(
            'w-full flex items-center gap-1.5 px-2 py-2.5 text-xs text-left transition-colors touch-manipulation',
            'hover:bg-zinc-100 dark:hover:bg-zinc-800 active:bg-zinc-200 dark:active:bg-zinc-700',
            index === selectedIndex && 'bg-zinc-100 dark:bg-zinc-800'
          )}
        >
          {item.type === 'collection' ? (
            <FolderOpen className='h-3 w-3 text-primary flex-shrink-0' />
          ) : (
            <FileText className='h-3 w-3 text-zinc-400 flex-shrink-0' />
          )}
          <div className='flex-1 min-w-0'>
            <span className='truncate block text-zinc-700 dark:text-zinc-300'>
              {item.name}
            </span>
            {item.type === 'document' && item.collectionName && (
              <span className='truncate block text-[10px] text-zinc-400 dark:text-zinc-500 leading-tight'>
                {item.collectionName}
                {typeof item.pageCount === 'number' && ` \u00B7 ${item.pageCount} ${t('chat.mentions.pages')}`}
              </span>
            )}
          </div>
          <span className='text-[9px] text-zinc-400 dark:text-zinc-600 flex-shrink-0 uppercase'>
            {item.type === 'collection' ? t('chat.mentions.tagCollection') : t('chat.mentions.tagDocument')}
          </span>
        </button>
      ))}

      {/* Hint footer */}
      <div className='px-2 py-0.5 border-t border-zinc-100 dark:border-zinc-800 text-[9px] text-zinc-400 dark:text-zinc-600 flex gap-2'>
        <span>@ {t('chat.mentions.hintDoc')}</span>
        <span>@/ {t('chat.mentions.hintCollection')}</span>
        <span>@/…/ {t('chat.mentions.hintDrillDown')}</span>
        <span className='ml-auto'>Tab/Enter {t('chat.mentions.hintSelect')}</span>
      </div>
    </div>
  );
};

/**
 * Saved search item — shown in collection sidebar as "smart collection".
 * Supports result count badge, inline rename, context menu, and pin/unpin.
 */

import React, { useRef, useState } from 'react';
import { Pencil, Pin, PinOff, Search, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/input';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { updateSavedSearch } from '@/lib/api-saved-searches';

interface SavedSearchItemProps {
  id: string;
  name: string;
  color?: string | null;
  isActive?: boolean;
  isPinned?: boolean;
  resultCount?: number | null;
  lastEvaluatedAt?: string | null;
  onClick: () => void;
  onDelete?: () => void;
  onEdit?: () => void;
  onUpdated?: () => void;
  className?: string;
}

export function SavedSearchItem({
  id,
  name,
  color,
  isActive,
  isPinned,
  resultCount,
  lastEvaluatedAt,
  onClick,
  onDelete,
  onEdit,
  onUpdated,
  className,
}: SavedSearchItemProps) {
  const { t } = useTranslation();
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(name);
  const inputRef = useRef<HTMLInputElement>(null);

  const isStale = lastEvaluatedAt
    ? (Date.now() - new Date(lastEvaluatedAt).getTime()) > 5 * 60 * 1000
    : true;

  const handleRenameStart = () => {
    setRenameValue(name);
    setIsRenaming(true);
    setTimeout(() => inputRef.current?.select(), 50);
  };

  const handleRenameSubmit = async () => {
    setIsRenaming(false);
    const trimmed = renameValue.trim();
    if (!trimmed || trimmed === name) return;
    await updateSavedSearch(id, { name: trimmed });
    onUpdated?.();
  };

  const handleTogglePin = async () => {
    await updateSavedSearch(id, { is_pinned: !isPinned });
    onUpdated?.();
  };

  const content = (
    <button
      data-testid={'knowledge-saved-search-' + id}
      type="button"
      onClick={isRenaming ? undefined : onClick}
      className={cn(
        'w-full flex items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors group',
        isActive
          ? 'bg-zinc-100 dark:bg-zinc-800 text-zinc-900 dark:text-white'
          : 'text-zinc-600 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-800/50',
        className,
      )}
    >
      <Search className="w-3.5 h-3.5 flex-shrink-0" style={{ color: color || undefined }} />
      {isRenaming ? (
        <Input
          ref={inputRef}
          value={renameValue}
          onChange={e => setRenameValue(e.target.value)}
          onBlur={handleRenameSubmit}
          onKeyDown={e => { if (e.key === 'Enter') void handleRenameSubmit(); if (e.key === 'Escape') setIsRenaming(false); }}
          className="flex-1 h-6 text-xs py-0"
          autoFocus
          onClick={e => e.stopPropagation()}
        />
      ) : (
        <span className="flex-1 truncate italic">{name}</span>
      )}
      {isPinned && <Pin className="w-3 h-3 text-zinc-400 flex-shrink-0" />}
      {typeof resultCount === 'number' && (
        <span className={cn(
          'text-[10px] tabular-nums px-1.5 py-0.5 bg-zinc-200 dark:bg-zinc-700 flex-shrink-0',
          isStale && 'opacity-50',
        )}>
          {resultCount}
        </span>
      )}
      {onDelete && !isRenaming && (
        <button
          data-testid={'knowledge-saved-search-delete-' + id}
          type="button"
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
          className="p-0.5 opacity-0 group-hover:opacity-100 text-zinc-400 hover:text-red-500 transition-all"
        >
          <Trash2 className="w-3 h-3" />
        </button>
      )}
    </button>
  );

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        {content}
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onClick={handleRenameStart}>
          <Pencil className="w-3.5 h-3.5 mr-2" />
          {t('common.rename', 'Rename')}
        </ContextMenuItem>
        {onEdit && (
          <ContextMenuItem onClick={onEdit}>
            <Search className="w-3.5 h-3.5 mr-2" />
            {t('knowledge.savedSearch.editCriteria', 'Edit Criteria')}
          </ContextMenuItem>
        )}
        <ContextMenuItem onClick={handleTogglePin}>
          {isPinned
            ? <><PinOff className="w-3.5 h-3.5 mr-2" />{t('knowledge.savedSearch.unpin', 'Unpin')}</>
            : <><Pin className="w-3.5 h-3.5 mr-2" />{t('knowledge.savedSearch.pin', 'Pin')}</>
          }
        </ContextMenuItem>
        {onDelete && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem onClick={onDelete} className="text-red-500 focus:text-red-500">
              <Trash2 className="w-3.5 h-3.5 mr-2" />
              {t('common.delete', 'Delete')}
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}

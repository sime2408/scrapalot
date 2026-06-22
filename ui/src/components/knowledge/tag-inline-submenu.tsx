/**
 * Inline tag submenu — renders tag checkboxes directly inside a DropdownMenuSub.
 * Loads tags on open, toggles optimistically.
 */

import React, { useEffect, useState, useCallback } from 'react';
import { Check, Tag } from 'lucide-react';
import { cn } from '@/lib/utils';
import { listTags, getDocumentTags, type Tag as TagType } from '@/lib/api-tags';
import { applyOptimisticTagToggle } from './tag-toggle-utils';
import {
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu';
import { useTranslation } from 'react-i18next';
import { toast } from '@/lib/toast-compat';

interface TagInlineSubmenuProps {
  documentId: string;
  workspaceId: string;
  onTagsChanged?: () => void;
}

export function TagInlineSubmenu({ documentId, workspaceId, onTagsChanged }: TagInlineSubmenuProps) {
  const { t } = useTranslation();
  const [allTags, setAllTags] = useState<TagType[]>([]);
  const [docTagIds, setDocTagIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const loadTags = useCallback(() => {
    if (loaded) return;
    setLoading(true);
    Promise.all([
      listTags(workspaceId),
      getDocumentTags(documentId),
    ]).then(([tags, docTags]) => {
      setAllTags(tags);
      setDocTagIds(new Set(docTags.map(t => t.id)));
      setLoaded(true);
    }).catch(err => {
      console.error('Failed to load tags:', err);
      toast.error(t('knowledge.tags.loadFailed'));
    }).finally(() => setLoading(false));
  }, [loaded, workspaceId, documentId, t]);

  useEffect(() => {
    setLoaded(false);
  }, [documentId]);

  // Use ref to always read current docTagIds (avoids stale closure in rapid toggles)
  const docTagIdsRef = React.useRef(docTagIds);
  docTagIdsRef.current = docTagIds;

  const handleToggle = useCallback(async (e: Event, tagId: string) => {
    e.preventDefault();
    const hasTag = docTagIdsRef.current.has(tagId);
    await applyOptimisticTagToggle(tagId, hasTag, documentId, setDocTagIds, onTagsChanged);
  }, [documentId, onTagsChanged]);

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger
        className="flex items-center gap-2"
        onPointerEnter={loadTags}
        onClick={loadTags}
      >
        <Tag className="h-4 w-4" />
        {t('knowledge.library.manageTags', 'Manage tags')}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-44 z-[9999]">
        {loading ? (
          <div className="flex items-center justify-center py-3">
            <div className="w-3.5 h-3.5 border-2 border-zinc-300 dark:border-zinc-600 border-t-primary animate-spin" />
          </div>
        ) : allTags.length === 0 ? (
          <div className="px-2 py-3 text-xs text-muted-foreground text-center">
            {t('knowledge.library.noTags', 'No tags in this workspace')}
          </div>
        ) : (
          allTags.map(tag => {
            const active = docTagIds.has(tag.id);
            return (
              <DropdownMenuItem
                key={tag.id}
                className="flex items-center gap-2 text-xs cursor-pointer"
                onSelect={(e) => handleToggle(e, tag.id)}
              >
                <span
                  className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                  style={{ backgroundColor: tag.color || '#888' }}
                />
                <span className="flex-1 truncate">{tag.name}</span>
                <div className={cn(
                  'w-3.5 h-3.5 flex-shrink-0 flex items-center justify-center border transition-all',
                  active
                    ? 'bg-primary border-primary text-primary-foreground'
                    : 'border-zinc-300 dark:border-zinc-600'
                )}>
                  {active && <Check className="w-2.5 h-2.5" />}
                </div>
              </DropdownMenuItem>
            );
          })
        )}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

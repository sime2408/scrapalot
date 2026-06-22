/**
 * Tag assignment — compact toggleable tag list.
 * Uses Dialog on desktop, Drawer on mobile.
 * Optimistic UI — toggles instantly, rolls back on failure.
 */

import React, { useEffect, useState, useCallback } from 'react';
import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import { listTags, getDocumentTags, type Tag } from '@/lib/api-tags';
import { applyOptimisticTagToggle } from './tag-toggle-utils';
import { useIsMobile } from '@/hooks/use-mobile';
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
} from '@/components/ui/drawer';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { useTranslation } from 'react-i18next';
import { toast } from '@/lib/toast-compat';

interface TagAssignmentPopoverProps {
  documentId: string;
  workspaceId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onTagsChanged?: () => void;
}

export function TagAssignmentPopover({
  documentId,
  workspaceId,
  open,
  onOpenChange,
  onTagsChanged,
}: TagAssignmentPopoverProps) {
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  const [allTags, setAllTags] = useState<Tag[]>([]);
  const [docTagIds, setDocTagIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    Promise.all([
      listTags(workspaceId),
      getDocumentTags(documentId),
    ]).then(([tags, docTags]) => {
      setAllTags(tags);
      setDocTagIds(new Set(docTags.map(t => t.id)));
    }).catch(err => {
      console.error('Failed to load tags:', err);
      toast.error(t('knowledge.tags.loadFailed'));
    }).finally(() => setLoading(false));
  }, [open, documentId, workspaceId, t]);

  const handleToggle = useCallback(async (tagId: string) => {
    const hasTag = docTagIds.has(tagId);
    await applyOptimisticTagToggle(tagId, hasTag, documentId, setDocTagIds, onTagsChanged);
  }, [docTagIds, documentId, onTagsChanged]);

  const getColorLabel = (hex: string | null): string | null => {
    if (!hex) return null;
    const lower = hex.toLowerCase();
    const map: Record<string, string> = {
      '#ffd400': t('knowledge.library.colorYellow', 'Priority / Attention'),
      '#ff6666': t('knowledge.library.colorRed', 'Urgent / Critical'),
      '#5fb236': t('knowledge.library.colorGreen', 'Reviewed / Approved'),
      '#2ea8e5': t('knowledge.library.colorBlue', 'In Progress'),
      '#a28ae5': t('knowledge.library.colorPurple', 'Research / Analysis'),
      '#e56eee': t('knowledge.library.colorMagenta', 'Creative / Ideas'),
      '#f19837': t('knowledge.library.colorOrange', 'Needs Review'),
      '#aaaaaa': t('knowledge.library.colorGray', 'Archived / Inactive'),
      '#3b82f6': t('knowledge.library.colorSky', 'Reference / Info'),
      '#14b8a6': t('knowledge.library.colorTeal', 'Complete / Done'),
    };
    return map[lower] ?? null;
  };

  const buildTooltip = (tag: Tag): string => {
    const parts: string[] = [];
    const colorLabel = getColorLabel(tag.color);
    if (colorLabel) parts.push(colorLabel);
    if (typeof tag.doc_count === 'number') {
      parts.push(t('knowledge.library.tagDocCount', '{{count}} documents', { count: tag.doc_count }));
    }
    return parts.length > 0 ? parts.join(' · ') : tag.name;
  };

  const tagList = (
    <TooltipProvider delayDuration={300}>
      <div className="p-2">
        {loading ? (
          <div className="flex items-center justify-center py-6">
            <div className="w-4 h-4 border-2 border-zinc-300 dark:border-zinc-600 border-t-primary animate-spin" />
          </div>
        ) : allTags.length === 0 ? (
          <p className="text-xs text-muted-foreground px-1 py-4 text-center">
            {t('knowledge.library.noTags', 'No tags in this workspace')}
          </p>
        ) : (
          <div className="grid grid-cols-2 gap-1">
            {allTags.map(tag => {
              const active = docTagIds.has(tag.id);
              return (
                <Tooltip key={tag.id}>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={() => handleToggle(tag.id)}
                      className={cn(
                        'flex items-center gap-2 px-2 py-1.5 text-xs transition-colors',
                        'hover:bg-zinc-100 dark:hover:bg-zinc-800 active:bg-zinc-200 dark:active:bg-zinc-700',
                        active && 'bg-primary/5',
                      )}
                    >
                      <span
                        className="w-2.5 h-2.5 flex-shrink-0"
                        style={{ backgroundColor: tag.color || '#888' }}
                      />
                      <span className="flex-1 truncate text-left text-zinc-800 dark:text-zinc-200">
                        {tag.name}
                      </span>
                      <div className={cn(
                        'w-3.5 h-3.5 flex-shrink-0 flex items-center justify-center border transition-all',
                        active
                          ? 'bg-primary border-primary text-primary-foreground'
                          : 'border-zinc-300 dark:border-zinc-600'
                      )}>
                        {active && <Check className="w-2.5 h-2.5" />}
                      </div>
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="text-xs">
                    {buildTooltip(tag)}
                  </TooltipContent>
                </Tooltip>
              );
            })}
          </div>
        )}
      </div>
    </TooltipProvider>
  );

  if (isMobile) {
    return (
      <Drawer open={open} onOpenChange={onOpenChange}>
        <DrawerContent overlayClassName="!z-[1250]" style={{ zIndex: 1300 }}>
          <DrawerHeader className="pb-1">
            <DrawerTitle className="text-sm">
              {t('knowledge.library.manageTags', 'Manage tags')}
            </DrawerTitle>
          </DrawerHeader>
          <div className="pb-6 max-h-[50vh] overflow-y-auto">
            {tagList}
          </div>
        </DrawerContent>
      </Drawer>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm p-0" overlayZIndex="1250" style={{ zIndex: 1300 }}>
        <DialogHeader className="px-3 py-2 border-b border-border">
          <DialogTitle className="text-sm">
            {t('knowledge.library.manageTags', 'Manage tags')}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {t('knowledge.library.manageTagsDesc', 'Toggle tags for this document')}
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[300px] overflow-y-auto">
          {tagList}
        </div>
      </DialogContent>
    </Dialog>
  );
}

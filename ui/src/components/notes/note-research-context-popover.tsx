/**
 * Research Context popover for the Notes editor.
 *
 * Triggered by the pill in NoteMenuBar (Candidate G Layer 1). Lets the
 * user pick which collections + web search + agentic routing should scope
 * every AI action invoked from this note. Same affordances as the chat
 * Knowledge Stacks popover but trimmed down — the chat version exposes RAG
 * strategy + parameters tabs that don't apply here.
 */

import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { Globe, Sparkles, Folder, Check } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Switch } from '@/components/ui/switch';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import { useCollections } from '@/contexts/collections-context';
import { cn } from '@/lib/utils';
import type { NoteResearchContext } from '@/lib/note-research-context';
import { CollectionTreeList } from './collection-tree-list';

export interface NoteResearchContextPopoverProps {
  context: NoteResearchContext;
  onChange: (next: Partial<NoteResearchContext>) => void;
  /** Slot rendered inside <PopoverTrigger asChild> — typically the pill button. */
  trigger: React.ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export const NoteResearchContextPopover: React.FC<NoteResearchContextPopoverProps> = ({
  context,
  onChange,
  trigger,
  open,
  onOpenChange,
}) => {
  const { t } = useTranslation();
  const { collections } = useCollections();

  const selected = React.useMemo(() => new Set(context.collectionIds), [context.collectionIds]);

  const toggleCollection = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    onChange({ collectionIds: Array.from(next) });
  };

  const allSelected = collections.length > 0 && collections.every((c) => selected.has(c.id));
  const noneSelected = selected.size === 0;

  const selectAll = () => onChange({ collectionIds: collections.map((c) => c.id) });
  const clearAll = () => onChange({ collectionIds: [] });

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent
        align="start"
        side="bottom"
        sideOffset={6}
        className="w-80 p-0 z-[10050]"
        data-testid="note-research-context-popover"
        collisionPadding={8}
      >
        {/* Header */}
        <div className="px-3 py-2 border-b border-border">
          <div className="flex items-center justify-between">
            <div className="text-sm font-medium text-foreground">
              {t('notes.researchContext.title', 'Research context')}
            </div>
            <div className="text-[10px] text-muted-foreground">
              {selected.size === 0
                ? t('notes.researchContext.empty', 'no scope')
                : t('notes.researchContext.selectedCount', '{{count}} selected', { count: selected.size })}
            </div>
          </div>
          <div className="text-[11px] text-muted-foreground mt-0.5">
            {t('notes.researchContext.description', 'Every AI action in this note will be scoped to the choices below.')}
          </div>
        </div>

        {/* Scope list — Web rendered as a first-class peer of individual
            collections, checkbox-driven like the rest of the list. */}
        <div className="max-h-[320px] overflow-y-auto py-1">
          <div className="flex items-center justify-between px-3 py-1.5">
            <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider font-semibold text-muted-foreground">
              <Folder className="h-3 w-3" />
              {t('notes.researchContext.scope', 'Scope')}
            </div>
            <div className="flex items-center gap-2 text-[11px]">
              <button
                type="button"
                onClick={selectAll}
                disabled={collections.length === 0 || allSelected}
                className="text-primary hover:underline disabled:opacity-40 disabled:no-underline"
                data-testid="note-research-context-select-all"
              >
                {t('notes.researchContext.selectAll', 'All')}
              </button>
              <span className="text-muted-foreground/40">·</span>
              <button
                type="button"
                onClick={clearAll}
                disabled={noneSelected}
                className="text-muted-foreground hover:underline disabled:opacity-40 disabled:no-underline"
                data-testid="note-research-context-clear-all"
              >
                {t('notes.researchContext.clear', 'None')}
              </button>
            </div>
          </div>

          {/* Web — peer to collections, lives at the top of the list so it
              behaves like any other scope source instead of a hidden toggle. */}
          <button
            type="button"
            data-testid="note-research-context-web-entry"
            onClick={() => onChange({ webSearchEnabled: !context.webSearchEnabled })}
            className={cn(
              'flex w-full items-center gap-2 px-3 py-1.5 text-sm text-left',
              'hover:bg-accent transition-colors',
              context.webSearchEnabled && 'bg-primary/5'
            )}
          >
            <Checkbox
              checked={context.webSearchEnabled}
              onCheckedChange={(checked) => onChange({ webSearchEnabled: !!checked })}
              className="h-4 w-4"
              aria-label={t('notes.researchContext.webSearch', 'Web search')}
            />
            <Globe className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
            <span className="flex-1 truncate">
              {t('notes.researchContext.webSearch', 'Web search')}
            </span>
            {context.webSearchEnabled && <Check className="h-3.5 w-3.5 text-primary flex-shrink-0" />}
          </button>

          {/* Subtle divider between Web and the collections block */}
          {collections.length > 0 && <div className="h-px bg-border mx-3 my-1" />}

          {collections.length === 0 && (
            <div className="px-3 py-3 text-xs text-muted-foreground text-center">
              {t('notes.researchContext.noCollections', 'No collections yet')}
            </div>
          )}

          {/* Nested collection tree (parent → subcollections). Same
              component used by the chat toolbar so hierarchy stays
              consistent across the app. */}
          {collections.length > 0 && (
            <CollectionTreeList
              collections={collections}
              selected={context.collectionIds}
              onToggle={toggleCollection}
              testIdPrefix="note-research-context-collection"
            />
          )}
        </div>

        {/* Advanced toggle (agentic routing stays as a separate opt-in below) */}
        <div className="border-t border-border py-2 px-3">
          <label
            className="flex items-center justify-between gap-3 text-sm cursor-pointer"
            data-testid="note-research-context-agentic-toggle-label"
          >
            <span className="flex items-center gap-2 text-foreground">
              <Sparkles className="h-4 w-4 text-muted-foreground" />
              {t('notes.researchContext.agenticRouting', 'Agentic routing')}
            </span>
            <Switch
              checked={context.agenticRoutingEnabled}
              onCheckedChange={(checked) => onChange({ agenticRoutingEnabled: checked })}
              data-testid="note-research-context-agentic-toggle"
            />
          </label>
        </div>

        {/* Footer */}
        <div className="border-t border-border px-3 py-2 flex items-center justify-between">
          <div className="text-[10px] text-muted-foreground">
            {t('notes.researchContext.persistedHint', 'Saved per-note locally for now.')}
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={() => onOpenChange?.(false)}
            data-testid="note-research-context-done"
          >
            {t('common.done', 'Done')}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
};

export default NoteResearchContextPopover;

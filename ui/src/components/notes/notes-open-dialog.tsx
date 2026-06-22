/**
 * NotesOpenDialog — entry point for note discovery.
 *
 * Replaces the removed sidebar `<NotesSection />` grouping. Invoked from
 * Datoteka → Otvori… in the note editor menubar.
 *
 * UX:
 *   - Tab row: Sve · Akademski · Blog & Medium · Social · Dnevnici ·
 *              Peer reviews · Nekategorizirano (icon + label, horizontally
 *              scrollable on narrow viewports).
 *   - Paginated list (20 / page) hits GET /notes/paged on the backend.
 *   - Click a row → dialog closes and notesDrawer.open(sessionId, noteId)
 *     loads that note. Persistence of "last opened note per session" is
 *     unchanged — existing localStorage `note-id-${sessionId}` still wins.
 *   - Per-row ⋮ dropdown reassigns category (kept out of the row's main
 *     tap zone so tapping the row itself opens the note, not the menu).
 *   - Search filters the active tab by title substring.
 */

import React, { useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  BookOpen,
  ChevronLeft,
  ChevronRight,
  ClipboardCheck,
  FolderOpen,
  FolderSearch,
  Heart,
  Layers,
  Microscope,
  MoreVertical,
  PenLine,
  Search,
  Share2,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import {
  listNotesPaged,
  updateNote,
  type Note,
  type NoteCategory,
  type NoteCategoryFilter,
} from '@/lib/api-notes';
import { WorkspaceContext } from '@/contexts/workspace-context';
import { toast } from '@/lib/toast-compat';
import { cn } from '@/lib/utils';

interface NotesOpenDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called when the user picks a note. Receives the chosen note id. */
  onPickNote: (noteId: string) => void;
}

type CategoryKey = NoteCategory | 'uncategorized';
type TabKey = NoteCategoryFilter;

interface CategoryMeta {
  icon: LucideIcon;
  i18nKey: string;
  fallback: string;
}

// Per-category accent palette. Mirrors the convention used by
// sessions-group-header.tsx (subtle bg + saturated foreground icon),
// so the dialog's color story matches the rest of the sidebar.
// `tile` is the leading icon container (light/dark pair); `text` is
// the icon stroke; `dot` is a flat 4px chip for tab triggers.
interface CategoryColor {
  tile: string;
  text: string;
  dot: string;
}

const CATEGORY_COLORS: Record<CategoryKey, CategoryColor> = {
  academic: {
    tile: 'bg-blue-100 dark:bg-blue-900/30',
    text: 'text-blue-600 dark:text-blue-400',
    dot: 'bg-blue-500',
  },
  writing: {
    tile: 'bg-emerald-100 dark:bg-emerald-900/30',
    text: 'text-emerald-600 dark:text-emerald-400',
    dot: 'bg-emerald-500',
  },
  social: {
    tile: 'bg-violet-100 dark:bg-violet-900/30',
    text: 'text-violet-600 dark:text-violet-400',
    dot: 'bg-violet-500',
  },
  personal: {
    tile: 'bg-rose-100 dark:bg-rose-900/30',
    text: 'text-rose-600 dark:text-rose-400',
    dot: 'bg-rose-500',
  },
  review: {
    tile: 'bg-amber-100 dark:bg-amber-900/30',
    text: 'text-amber-700 dark:text-amber-400',
    dot: 'bg-amber-500',
  },
  uncategorized: {
    tile: 'bg-zinc-100 dark:bg-zinc-800/60',
    text: 'text-zinc-600 dark:text-zinc-400',
    dot: 'bg-zinc-400',
  },
};

const TAB_META: Record<TabKey, CategoryMeta> = {
  all: { icon: Layers, i18nKey: 'notes.openDialog.tabs.all', fallback: 'Sve' },
  academic: { icon: Microscope, i18nKey: 'notes.openDialog.tabs.academic', fallback: 'Akademski' },
  writing: { icon: PenLine, i18nKey: 'notes.openDialog.tabs.writing', fallback: 'Blog & Medium' },
  social: { icon: Share2, i18nKey: 'notes.openDialog.tabs.social', fallback: 'Social' },
  personal: { icon: Heart, i18nKey: 'notes.openDialog.tabs.personal', fallback: 'Dnevnici' },
  review: { icon: ClipboardCheck, i18nKey: 'notes.openDialog.tabs.review', fallback: 'Peer reviews' },
  uncategorized: { icon: BookOpen, i18nKey: 'notes.openDialog.tabs.uncategorized', fallback: 'Nekategorizirano' },
};

const CATEGORY_META: Record<CategoryKey, CategoryMeta> = {
  academic: { icon: Microscope, i18nKey: 'notes.openDialog.categories.academic', fallback: 'Akademski' },
  writing: { icon: PenLine, i18nKey: 'notes.openDialog.categories.writing', fallback: 'Blog & Medium' },
  social: { icon: Share2, i18nKey: 'notes.openDialog.categories.social', fallback: 'Social' },
  personal: { icon: Heart, i18nKey: 'notes.openDialog.categories.personal', fallback: 'Dnevnici' },
  review: { icon: ClipboardCheck, i18nKey: 'notes.openDialog.categories.review', fallback: 'Peer reviews' },
  uncategorized: { icon: BookOpen, i18nKey: 'notes.openDialog.categories.uncategorized', fallback: 'Nekategorizirano' },
};

const TABS: TabKey[] = ['all', 'academic', 'writing', 'social', 'personal', 'review', 'uncategorized'];
const CATEGORY_KEYS: CategoryKey[] = ['academic', 'writing', 'social', 'personal', 'review', 'uncategorized'];

const PAGE_SIZE = 20;

/** Lightweight relative-time formatter — avoids adding a formatting dep. */
function formatRelative(iso: string, t: (k: string, f: string, v?: object) => string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const diffSec = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (diffSec < 60) return t('notes.openDialog.relativeTime.justNow', 'upravo sada');
  const mins = Math.floor(diffSec / 60);
  if (mins < 60) return t('notes.openDialog.relativeTime.minutesAgo', 'prije {{count}} min', { count: mins });
  const hours = Math.floor(mins / 60);
  if (hours < 24) return t('notes.openDialog.relativeTime.hoursAgo', 'prije {{count}} h', { count: hours });
  const days = Math.floor(hours / 24);
  if (days < 7) return t('notes.openDialog.relativeTime.daysAgo', 'prije {{count}} d', { count: days });
  return new Date(iso).toLocaleDateString();
}

export const NotesOpenDialog: React.FC<NotesOpenDialogProps> = ({ open, onOpenChange, onPickNote }) => {
  const { t } = useTranslation();
  const workspaceCtx = useContext(WorkspaceContext);
  const currentWorkspace = workspaceCtx?.currentWorkspace ?? null;

  const [activeTab, setActiveTab] = useState<TabKey>('all');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [items, setItems] = useState<Note[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);

  // Reset pagination + search when the dialog closes so it reopens fresh.
  useEffect(() => {
    if (!open) {
      setPage(1);
      setQuery('');
      setActiveTab('all');
    }
  }, [open]);

  // Reset page on tab / query change — stale page numbers return empty lists
  // that look like bugs to the user.
  useEffect(() => {
    setPage(1);
  }, [activeTab, query]);

  const fetchPage = useCallback(async () => {
    if (!open || !currentWorkspace?.id) return;
    setLoading(true);
    try {
      const res = await listNotesPaged(currentWorkspace.id, {
        category: activeTab,
        q: query || undefined,
        page,
        pageSize: PAGE_SIZE,
      });
      setItems(res.items);
      setTotal(res.total);
    } catch (err) {
      console.error('[NotesOpenDialog] listNotesPaged failed:', err);
      toast({
        title: t('notes.openDialog.loadFailed.title', 'Could not load notes'),
        description: t('notes.openDialog.loadFailed.description', 'The notes service is temporarily unavailable.'),
        variant: 'destructive',
      });
      setItems([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [open, currentWorkspace?.id, activeTab, query, page, t]);

  useEffect(() => {
    void fetchPage();
  }, [fetchPage]);

  const totalPages = useMemo(() => Math.max(1, Math.ceil(total / PAGE_SIZE)), [total]);

  const handleReassign = useCallback(
    async (noteId: string, newValue: CategoryKey) => {
      const apiCategory: NoteCategory | null = newValue === 'uncategorized' ? null : newValue;
      try {
        await updateNote(noteId, { category: apiCategory });
        toast({ title: t('notes.openDialog.reassigned.title', 'Category updated') });
        setItems((prev) =>
          prev.map((n) => (n.id === noteId ? { ...n, category: apiCategory } : n))
        );
        // If we're inside a specific-category tab, a re-assigned row should
        // disappear from the current view → refetch.
        if (activeTab !== 'all') void fetchPage();
      } catch (err) {
        console.error('[NotesOpenDialog] updateNote(category) failed:', err);
        toast({
          title: t('notes.openDialog.reassignFailed.title', 'Could not update category'),
          variant: 'destructive',
        });
      }
    },
    [activeTab, fetchPage, t]
  );

  const handlePick = useCallback(
    (noteId: string) => {
      onPickNote(noteId);
      onOpenChange(false);
    },
    [onPickNote, onOpenChange]
  );

  const renderRow = (n: Note) => {
    const displayTitle =
      (n.title && n.title.trim()) || t('notes.openDialog.untitled', 'Neimenovana bilješka');
    const currentKey: CategoryKey = (n.category as NoteCategory | null) ?? 'uncategorized';
    const categoryMeta = CATEGORY_META[currentKey];
    const categoryColor = CATEGORY_COLORS[currentKey];
    const CategoryIcon = categoryMeta.icon;
    const categoryLabel = t(categoryMeta.i18nKey, categoryMeta.fallback);
    const relDate = formatRelative(n.updated_at, t);

    return (
      <div
        key={n.id}
        data-testid={`notes-open-dialog-row-${n.id}`}
        className={cn(
          'group relative flex items-start gap-3 px-4 py-3',
          'border-b border-border/60 last:border-b-0',
          'hover:bg-zinc-100 dark:hover:bg-zinc-800/40 cursor-pointer transition-colors'
        )}
        onClick={() => handlePick(n.id)}
      >
        {/* Category anchor icon — colored per category so the user can
            scan the list visually. Border keeps the tile crisp in light. */}
        <div
          className={cn(
            'mt-0.5 shrink-0 h-8 w-8 flex items-center justify-center',
            categoryColor.tile,
            categoryColor.text
          )}
        >
          <CategoryIcon className='h-4 w-4' />
        </div>

        {/* Title + secondary meta line */}
        <div className='flex-1 min-w-0'>
          <div className='text-sm font-medium text-foreground truncate'>{displayTitle}</div>
          <div className='mt-0.5 flex items-center gap-2 text-xs text-muted-foreground'>
            {relDate && <span className='tabular-nums'>{relDate}</span>}
            {relDate && <span aria-hidden className='h-1 w-1 rounded-full bg-muted-foreground/40' />}
            <span aria-hidden className={cn('h-1.5 w-1.5 shrink-0', categoryColor.dot)} />
            <span className='truncate'>{categoryLabel}</span>
          </div>
        </div>

        {/* Row action — reassign category. Wrapped in a click-stopper so the
            dropdown doesn't also open the note. Visible on hover (desktop) or
            always (touch) via group-hover + focus-visible. */}
        <div
          className='shrink-0 self-center'
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.preventDefault()}
        >
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type='button'
                variant='ghost'
                size='icon'
                className={cn(
                  'h-8 w-8 text-muted-foreground',
                  'md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100',
                  'transition-opacity'
                )}
                data-testid={`notes-open-dialog-category-${n.id}`}
                aria-label={t('notes.openDialog.rowMenu', 'Radnje')}
              >
                <MoreVertical className='h-4 w-4' />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align='end' className='z-[10060] min-w-[200px]'>
              <DropdownMenuLabel className='text-[10px] uppercase tracking-wider text-muted-foreground'>
                {t('notes.openDialog.reassignTitle', 'Premjesti u kategoriju')}
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              {CATEGORY_KEYS.map((key) => {
                const meta = CATEGORY_META[key];
                const color = CATEGORY_COLORS[key];
                const Icon = meta.icon;
                const selected = key === currentKey;
                return (
                  <DropdownMenuItem
                    key={key}
                    onClick={() => void handleReassign(n.id, key)}
                    data-testid={`notes-open-dialog-reassign-${n.id}-${key}`}
                    className={cn(selected && 'font-semibold bg-accent/60')}
                  >
                    <span aria-hidden className={cn('mr-2 h-1.5 w-1.5 shrink-0', color.dot)} />
                    <Icon className={cn('mr-2 h-4 w-4', color.text)} />
                    <span>{t(meta.i18nKey, meta.fallback)}</span>
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid='notes-open-dialog'
        // Lifts the dialog above #notes-drawer-portal (z-1300). Same value as TemplateGallery.
        overlayZIndex='10050'
        // Centered card on mobile (not full-bleed).
        disableFullscreenOnMobile
        className='w-[95vw] max-w-2xl max-h-[85vh] p-0 gap-0 flex flex-col bg-card'
      >
        <DialogHeader className='px-4 pt-4 pb-3 border-b border-border shrink-0 bg-zinc-50/60 dark:bg-zinc-900/40'>
          <div className='flex items-center gap-3'>
            <div className='shrink-0 h-9 w-9 flex items-center justify-center bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 border border-blue-200/50 dark:border-blue-800/40'>
              <FolderOpen className='h-4 w-4' />
            </div>
            <div className='flex-1 min-w-0'>
              <DialogTitle className='text-base font-semibold leading-tight'>
                {t('notes.openDialog.title', 'Otvori bilješku')}
              </DialogTitle>
              {total > 0 && (
                <p className='text-[11px] text-muted-foreground tabular-nums mt-0.5'>
                  {t('notes.openDialog.totalCount', '{{count}} bilješki', { count: total })}
                </p>
              )}
            </div>
          </div>
        </DialogHeader>

        <div className='px-4 pt-3 shrink-0'>
          <div className='relative'>
            <Search className='absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none' />
            <Input
              data-testid='notes-open-dialog-search'
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('notes.openDialog.searchPlaceholder', 'Pretraži po naslovu…')}
              className='pl-9 h-9'
            />
          </div>
        </div>

        <Tabs
          value={activeTab}
          onValueChange={(v) => setActiveTab(v as TabKey)}
          className='w-full flex-1 min-h-0 flex flex-col'
        >
          <div className='px-4 pt-3 shrink-0'>
            <TabsList
              data-testid='notes-open-dialog-tabs'
              className='flex flex-wrap w-full h-auto p-1 bg-zinc-100 dark:bg-zinc-900 border border-border gap-1'
            >
              {TABS.map((key) => {
                const meta = TAB_META[key];
                const Icon = meta.icon;
                // The 'all' tab keeps a neutral chip; category tabs get
                // a colored dot so the user can visually scan them.
                const colorKey: CategoryKey | null =
                  key === 'all' ? null : (key as CategoryKey);
                const dotColor = colorKey ? CATEGORY_COLORS[colorKey].dot : null;
                return (
                  <TabsTrigger
                    key={key}
                    data-testid={`notes-open-dialog-tab-${key}`}
                    value={key}
                    className={cn(
                      'inline-flex items-center gap-1.5 text-xs py-1.5 px-2.5',
                      'text-muted-foreground hover:text-foreground transition-colors',
                      'data-[state=active]:bg-card data-[state=active]:text-foreground',
                      'data-[state=active]:border data-[state=active]:border-border',
                      'data-[state=active]:shadow-none'
                    )}
                  >
                    {dotColor ? (
                      <span aria-hidden className={cn('h-1.5 w-1.5 shrink-0', dotColor)} />
                    ) : null}
                    <Icon className='h-3 w-3 shrink-0' />
                    <span className='whitespace-nowrap'>{t(meta.i18nKey, meta.fallback)}</span>
                  </TabsTrigger>
                );
              })}
            </TabsList>
          </div>

          {TABS.map((key) => (
            <TabsContent
              key={key}
              value={key}
              className='mt-0 p-0 flex-1 min-h-0 flex flex-col'
            >
              <div className='flex-1 min-h-0 sm:h-[440px] overflow-y-auto border-t border-border mt-3'>
                {loading ? (
                  <div className='flex flex-col items-center justify-center h-full gap-2 text-muted-foreground'>
                    <div className='h-6 w-6 border-2 border-muted-foreground/30 border-t-primary rounded-full animate-spin' />
                    <span className='text-xs'>{t('notes.openDialog.loading', 'Učitavam…')}</span>
                  </div>
                ) : items.length === 0 ? (
                  <div className='flex flex-col items-center justify-center h-full gap-2 text-muted-foreground'>
                    <FolderSearch className='h-10 w-10 text-muted-foreground/40' />
                    <p className='text-sm'>{t('notes.openDialog.empty', 'Nema bilješki u ovoj kategoriji.')}</p>
                  </div>
                ) : (
                  items.map(renderRow)
                )}
              </div>
            </TabsContent>
          ))}
        </Tabs>

        <div className='flex items-center justify-between px-4 py-2.5 border-t border-border shrink-0 bg-zinc-50/60 dark:bg-zinc-900/40'>
          <div className='flex items-center gap-1'>
            <Button
              data-testid='notes-open-dialog-prev'
              variant='ghost'
              size='icon'
              className='h-7 w-7'
              disabled={page <= 1 || loading}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              aria-label={t('common.previous', 'Prethodno')}
            >
              <ChevronLeft className='h-4 w-4' />
            </Button>
            <span
              className={cn(
                'inline-flex items-center justify-center min-w-[3.5rem] h-7 px-2',
                'text-xs font-medium tabular-nums text-foreground bg-card border border-border',
                loading && 'opacity-50'
              )}
            >
              {page} / {totalPages}
            </span>
            <Button
              data-testid='notes-open-dialog-next'
              variant='ghost'
              size='icon'
              className='h-7 w-7'
              disabled={page >= totalPages || loading}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              aria-label={t('common.next', 'Sljedeće')}
            >
              <ChevronRight className='h-4 w-4' />
            </Button>
          </div>
          <Button
            type='button'
            variant='ghost'
            size='sm'
            className='text-xs h-7'
            onClick={() => onOpenChange(false)}
            data-testid='notes-open-dialog-close'
          >
            {t('common.close', 'Zatvori')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
};

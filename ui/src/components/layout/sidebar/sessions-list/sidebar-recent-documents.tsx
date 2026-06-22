import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatDistanceToNow } from 'date-fns';
import { hr as hrLocale, mk as mkLocale } from 'date-fns/locale';
import {
  BookOpen,
  ChevronDown,
  ChevronRight,
  FileText,
  History,
  Quote,
  Search,
  StickyNote,
  X,
} from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';
import { useAuth } from '@/hooks/use-auth';
import { useIsMobilePhone } from '@/hooks/use-mobile';
import {
  dismissRecentDocument,
  getRecentDocuments,
  type DocumentViewSource,
  type RecentDocument,
} from '@/lib/api-document-views';
import { getDocumentById } from '@/lib/api-documents';

const STORAGE_KEY = 'scrapalot_sidebar_recent_expanded';
// Fetch a deeper buffer than we render so dismissing a visible row
// promotes the next cached entry into view instead of going blank.
const MAX_ROWS = 10;
const VISIBLE_ROWS = 5;

const sourceIcon: Record<DocumentViewSource, React.ComponentType<{ className?: string }>> = {
  pdf_open: FileText,
  epub_open: BookOpen,
  docx_open: FileText,
  cited: Quote,
  rag_retrieved: Search,
  note_linked: StickyNote,
};

function readExpanded(): boolean {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return true;
    return JSON.parse(raw) === true;
  } catch {
    return true;
  }
}

function writeExpanded(value: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    // ignore
  }
}

interface SidebarRecentDocumentsProps {
  onCloseMobileMenu?: () => void;
}

export const SidebarRecentDocuments = ({
  onCloseMobileMenu,
}: SidebarRecentDocumentsProps) => {
  const { t, i18n } = useTranslation();
  const { isAuthenticated } = useAuth();
  const isMobilePhone = useIsMobilePhone();

  const [expanded, setExpanded] = useState<boolean>(readExpanded);
  const [recents, setRecents] = useState<RecentDocument[]>([]);
  const [docNames, setDocNames] = useState<Record<string, string>>({});
  const [loaded, setLoaded] = useState(false);

  const dateLocale = useMemo(() => {
    if (i18n.language?.startsWith('hr')) return hrLocale;
    if (i18n.language?.startsWith('mk')) return mkLocale;
    return undefined;
  }, [i18n.language]);

  const setExpandedPersisted = useCallback((value: boolean) => {
    setExpanded(value);
    writeExpanded(value);
  }, []);

  // Fetch recents when authenticated. Refetch on a custom event so the
  // viewer can ping us after recordDocumentView() — keeps the strip
  // in sync without polling.
  const refresh = useCallback(async () => {
    if (!isAuthenticated) return;
    const list = await getRecentDocuments(MAX_ROWS);
    setRecents(list);
    setLoaded(true);
    const missing = list.map(r => r.document_id).filter(id => !docNames[id]);
    if (missing.length === 0) return;
    const results = await Promise.all(
      missing.map(async id => {
        try {
          const doc = await getDocumentById(id);
          const fileName =
            (typeof doc.file_name === 'string' && doc.file_name.trim()) ||
            (typeof doc.filename === 'string' && doc.filename.trim()) ||
            (typeof doc.title === 'string' && doc.title.trim()) ||
            null;
          return [id, fileName] as const;
        } catch {
          return [id, null] as const;
        }
      })
    );
    setDocNames(prev => {
      const next = { ...prev };
      for (const [id, name] of results) {
        if (name) next[id] = name;
      }
      return next;
    });
  // docNames intentionally omitted: re-fetching on every name update
  // would loop. New IDs are detected inside the effect via the
  // missing-filter.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated]);

  useEffect(() => {
    void refresh();
    const onChanged = () => { void refresh(); };
    window.addEventListener('scrapalot:recent-documents-changed', onChanged);
    return () => {
      window.removeEventListener('scrapalot:recent-documents-changed', onChanged);
    };
  }, [refresh]);

  const handleOpen = useCallback((doc: RecentDocument) => {
    const name = docNames[doc.document_id];
    window.dispatchEvent(new CustomEvent('scrapalot:open-document', {
      detail: {
        documentId: doc.document_id,
        collectionId: doc.collection_id,
        documentTitle: name || undefined,
      },
    }));
    const isMobileOrTablet = window.innerWidth < 1080;
    if (isMobileOrTablet) onCloseMobileMenu?.();
  }, [docNames, onCloseMobileMenu]);

  // Optimistic dismiss — pull the row out of local state immediately so
  // the next buffered entry slides up into the visible 5. The backend
  // call is fire-and-forget; the next `scrapalot:recent-documents-changed`
  // refresh will reconcile if it ever disagrees.
  const handleDismiss = useCallback((doc: RecentDocument, event: React.MouseEvent | React.TouchEvent) => {
    event.stopPropagation();
    event.preventDefault();
    setRecents(prev => prev.filter(r => r.document_id !== doc.document_id));
    void dismissRecentDocument(doc.document_id);
  }, []);

  // Hide the buffer; only the first VISIBLE_ROWS get rendered. The
  // remainder waits in `recents` so a dismiss promotes one into view
  // without a refetch round-trip.
  const visibleRecents = useMemo(() => recents.slice(0, VISIBLE_ROWS), [recents]);

  // Hide entirely until first response — empty state would flash on
  // every mount because /document-views/recent is async.
  if (!loaded || !isAuthenticated) return null;
  if (recents.length === 0) return null;

  return (
    <div
      data-testid="sidebar-recent-documents"
      className='border-b border-zinc-100 dark:border-zinc-800 border-zinc-200 dark:border-border/10'
    >
      <Collapsible open={expanded} onOpenChange={setExpandedPersisted}>
        <CollapsibleTrigger asChild>
          <div
            data-testid="sidebar-recent-documents-header"
            className={cn(
              'flex items-center justify-between group cursor-pointer transition-colors duration-200',
              'text-zinc-600 hover:text-zinc-900 dark:text-zinc-300 dark:hover:text-white',
              'hover:bg-zinc-50/80 dark:hover:bg-zinc-800/40',
              'border-l-2 border-transparent hover:border-blue-500/20 dark:hover:border-blue-400/20',
              isMobilePhone ? 'px-3 py-2.5' : 'px-4 py-2'
            )}
          >
            <div className='flex items-center flex-1 min-w-0'>
              <div className={cn(
                'p-1.5 bg-zinc-100 dark:bg-zinc-800/60 transition-colors duration-200 mr-3',
                'group-hover:bg-blue-100 dark:group-hover:bg-blue-900/30',
                'group-hover:text-blue-600 dark:group-hover:text-blue-400'
              )}>
                <History className={cn(isMobilePhone ? 'h-3.5 w-3.5' : 'h-4 w-4')} />
              </div>
              <span className='text-sm font-medium truncate'>
                {t('sidebar.recent.title', 'Recent')}
              </span>
            </div>
            <div className='flex items-center gap-1'>
              <div className={cn(
                'bg-zinc-200/80 dark:bg-zinc-700/80 backdrop-blur-sm px-2 py-0.5 transition-all duration-200',
                'text-zinc-600 dark:text-zinc-300 border border-zinc-300/50 dark:border-zinc-600/50',
                'text-xs'
              )}>
                {visibleRecents.length}
              </div>
              <button
                data-testid="sidebar-recent-documents-toggle"
                aria-label={expanded
                  ? t('general.collapse', 'Collapse')
                  : t('general.expand', 'Expand')}
                className={cn(
                  'flex items-center justify-center transition-all duration-200',
                  'text-zinc-400 hover:text-zinc-600 dark:text-zinc-500 dark:hover:text-zinc-300',
                  'hover:bg-zinc-200/60 dark:hover:bg-zinc-700/60',
                  isMobilePhone ? 'w-8 h-8' : 'w-6 h-6'
                )}
              >
                {expanded
                  ? <ChevronDown className='h-4 w-4' />
                  : <ChevronRight className='h-4 w-4' />}
              </button>
            </div>
          </div>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <ul className='py-1' data-testid="sidebar-recent-documents-list">
            {visibleRecents.map(doc => {
              const Icon = sourceIcon[doc.source] ?? FileText;
              const name = docNames[doc.document_id]
                ?? `${doc.document_id.slice(0, 8)}…`;
              let relative = '';
              try {
                relative = formatDistanceToNow(new Date(doc.last_viewed_at), {
                  addSuffix: true,
                  locale: dateLocale,
                });
              } catch {
                relative = '';
              }
              return (
                <li key={doc.document_id} className='group relative'>
                  <button
                    data-testid={`sidebar-recent-doc-${doc.document_id}`}
                    onClick={() => handleOpen(doc)}
                    title={name}
                    className={cn(
                      'w-full flex items-center gap-2 text-left transition-colors duration-150',
                      'text-zinc-600 dark:text-zinc-300',
                      'hover:bg-zinc-100 dark:hover:bg-zinc-800/60',
                      'hover:text-zinc-900 dark:hover:text-white',
                      // Reserve space on the right for the dismiss
                      // button so it never overlaps the timestamp.
                      isMobilePhone ? 'px-3 py-2 pr-9' : 'px-4 py-1.5 pr-8'
                    )}
                  >
                    <Icon className='h-3.5 w-3.5 shrink-0 text-zinc-400 dark:text-zinc-500' />
                    <span className='flex-1 min-w-0 text-sm truncate'>{name}</span>
                    {relative && (
                      <span className='shrink-0 text-xs text-zinc-400 dark:text-zinc-500'>
                        {relative}
                      </span>
                    )}
                  </button>
                  <button
                    type='button'
                    data-testid={`sidebar-recent-doc-dismiss-${doc.document_id}`}
                    onClick={(e) => handleDismiss(doc, e)}
                    title={t('sidebar.recent.dismiss', 'Remove from recent')}
                    aria-label={t('sidebar.recent.dismiss', 'Remove from recent')}
                    className={cn(
                      'absolute top-1/2 -translate-y-1/2 right-1 p-1',
                      'text-zinc-400 dark:text-zinc-500',
                      'hover:text-zinc-700 dark:hover:text-zinc-200',
                      'hover:bg-zinc-200/70 dark:hover:bg-zinc-700/70',
                      // Always visible on touch (no hover state); fades
                      // in with the row on pointer-capable devices.
                      'opacity-0 group-hover:opacity-100 focus:opacity-100 touch:opacity-100',
                      isMobilePhone && 'opacity-100',
                      'transition-opacity duration-150',
                    )}
                  >
                    <X className='h-3 w-3' />
                  </button>
                </li>
              );
            })}
          </ul>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
};

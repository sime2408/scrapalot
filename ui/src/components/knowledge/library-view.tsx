import React, { useState, useEffect, useMemo, useRef, useCallback, Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import { FileStack, Loader2, AlertCircle, AlertTriangle, Search, Filter, X, RotateCcw, RefreshCw, MoreVertical, Trash2, BookOpen, Download, CheckSquare, Square, FolderInput, FolderPlus, Copy, HardDrive, ArrowUpDown, ArrowUp, ArrowDown, Database, GitBranch, FileSearch, ChevronDown, ChevronUp, Tag, Link2, Settings2, Monitor, Server, Check, ChevronsUpDown, Clock, CircleCheck, CircleDashed } from 'lucide-react';
import { useCollections } from '@/contexts/collections-context';
import { getDocumentsByCollection, getDocumentById, deleteDocument, partialDeleteDocument, downloadBookCover, downloadDocumentToComputer, moveDocuments, batchDeleteDocuments, getCollectionStats, CollectionStats, buildDocumentGraph, rebuildDocumentEmbeddings, addDocumentToCollection, findOpenAccessPdf, extractPdfAnnotations, updateDocumentPriority, deleteCustomThumbnail } from '@/lib/api-documents';
import { clearCache } from '@/lib/api';
import { mapWithConcurrency } from '@/lib/api-utils';
import { userPrefs } from '@/lib/storage-utils';
import { DocumentThumbnail } from './document-thumbnail';
import { MetadataBadge } from './metadata-badge';
import { TagDots } from './tag-badge';
const RelationBadge = (_props: any) => null;  // (CE) graph relations are hosted-only
import { DuplicateBadge } from './duplicate-badge';
import { CollectionBadge } from './collection-badge';
import { TagInlineSubmenu } from './tag-inline-submenu';
import { getDocumentTags } from '@/lib/api-tags';
import { listSavedSearches, executeSavedSearch, type SavedSearch } from '@/lib/api-saved-searches';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Command, CommandInput, CommandList, CommandEmpty, CommandGroup, CommandItem, CommandSeparator } from '@/components/ui/command';
import { DuplicateReviewDialog } from './duplicate-review-dialog';
const DocumentRelationsDialog = (_props: any) => null;  // (CE) graph relations are hosted-only
import { enrichDocumentMetadata, parseDocumentMetadata, type ResolvedMetadata } from '@/lib/api-metadata';
import { CITATION_STYLES, formatCitation } from '@/lib/citation-formatter';
import { ExportDialog } from './export-dialog';
import { StarRating } from '@/components/document-rating/star-rating';
import { getMyRatings } from '@/lib/api-document-ratings';

// (CE) External-book re-download is hosted-only — inert no-op.
const LibraryRedownloadDialog = (_props: any) => null;
const BookSummaryHoverCard = React.lazy(() =>
  import('./book-summary-hover-card').then(m => ({ default: m.BookSummaryHoverCard }))
);
import { cn } from '@/lib/utils';
import { usePDFViewer } from '@/contexts/pdf-viewer-context';
import { useEpubViewer } from '@/contexts/epub-viewer-context';
import { useDocxViewer } from '@/contexts/docx-viewer-context';
import { useIsMobile } from '@/hooks/use-mobile';
import { Input } from '@/components/ui/input';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
  DropdownMenuSeparator,
  DropdownMenuLabel,
} from '@/components/ui/dropdown-menu';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { toast } from '@/lib/toast-compat';
import { useWorkspace } from '@/hooks/use-workspace';
import { getWorkspaceStorage } from '@/lib/api-workspace';
import { deduplicateById } from '@/lib/collection-utils';
import { getAncestors } from '@/lib/collection-tree';

export interface ProcessedDocument {
  id: string;
  title: string;
  filename: string;
  collection_id: string;
  collection_name: string;
  file_metadata?: {
    cover_url?: string;
    author?: string;
    thumbnail?: { has_thumbnail?: boolean; is_custom?: boolean };
    [key: string]: unknown;
  };
  thumbnail?: { has_thumbnail?: boolean; has_custom?: boolean };
  processing_status: string;
  page_count?: number;
  file_size?: number;
  created_at?: string;
  file_stored?: boolean;
  graph_status?: 'pending' | 'hierarchy_done' | 'entity_running' | 'completed' | 'failed' | null;
  has_summary?: boolean;
  extracted_metadata?: { resolved?: { year?: number; authors?: string[]; title?: string; doi?: string; isbn?: string; document_type?: string }; [key: string]: unknown };
  tags?: Array<{ name: string; color: string | null }>;
  relation_count?: number;
  duplicate_count?: number;
  collection_count?: number;
  collection_memberships?: Array<{ collection_id: string; collection_name: string }>;
  // PageRank — per-collection centrality score; null until the
  // nightly recompute runs or `RecomputePageRank` admin op is invoked.
  pagerank_score?: number | null;
  pagerank_computed_at?: string | null;
}

interface LibraryViewProps {
  /** Pre-fetched documents from parent (for background loading) */
  preloadedDocuments?: ProcessedDocument[];
  /** Whether preloaded data is still loading */
  preloadedLoading?: boolean;
  /** Auto-select this collection in the filter dropdown */
  initialCollection?: string;
  /** When true, hide delete actions (viewer role in shared workspace) */
  readOnly?: boolean;
  /** When set, only show documents matching these IDs (from saved search / smart collection) */
  savedSearchDocIds?: string[] | null;
  /** Callback to navigate to a different collection (for breadcrumb clicks) */
  onCollectionChange?: (collectionId: string) => void;
  /** Optional refresh callback — when provided, the toolbar refresh button calls it
   *  so the parent can re-fetch the preloaded document list. */
  onRefresh?: () => Promise<void> | void;
  /** Asks the host (Knowledge Stacks dialog) to dismiss itself. Called
   *  *before* a viewer is opened so Radix Dialog never flips its `modal`
   *  prop while it's still mounted — that flip triggers an internal
   *  history.back() which then races with the viewer's own pushState
   *  and unmounts the viewer mid-render. Without this, opening any book
   *  cover briefly mounted the EPUB/PDF drawer and then closed both the
   *  drawer *and* the Library dialog. */
  onRequestCloseStacks?: () => void;
}

export function LibraryView({ preloadedDocuments, preloadedLoading, initialCollection, readOnly = false, savedSearchDocIds, onCollectionChange, onRefresh, onRequestCloseStacks }: LibraryViewProps = {}) {
  const { t } = useTranslation();
  const { collections, loading: collectionsLoading } = useCollections();
  const { dispatch: pdfDispatch } = usePDFViewer();
  const { dispatch: epubDispatch } = useEpubViewer();
  const { dispatch: docxDispatch } = useDocxViewer();
  const { currentWorkspace } = useWorkspace();

  const [documents, setDocuments] = useState<ProcessedDocument[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  // per-doc rating cache, bulk-loaded after the
  // documents array changes. Map keyed by document_id; absence = unrated.
  const [ratingsByDoc, setRatingsByDoc] = useState<Record<string, number>>({});

  // Re-fetch when the visible documents change (collection switch,
  // pagination). Server returns only docs the user has rated, so the
  // payload is small even on a 200-doc library page.
  useEffect(() => {
    if (documents.length === 0) {
      setRatingsByDoc({});
      return;
    }
    let cancelled = false;
    void (async () => {
      const ids = documents.map(d => d.id);
      const map = await getMyRatings(ids);
      if (cancelled) return;
      const next: Record<string, number> = {};
      for (const [docId, r] of map.entries()) {
        if (typeof r.rating === 'number') next[docId] = r.rating;
      }
      setRatingsByDoc(next);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only react to id-set changes, not full array identity
  }, [documents.map(d => d.id).join(',')]);
  const [, setWorkspaceStorage] = useState<{
    storage_used_bytes: number;
    documents_count: number;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  // Default to 'all' when a specific collection is pre-selected; 'completed' when browsing all collections
  // filterStatus can be a built-in preset OR 'smart:<id>' for user-defined smart collections
  const [filterStatus, setFilterStatusRaw] = useState<string>(initialCollection ? 'all' : 'completed');
  const [selectedCollection, setSelectedCollectionRaw] = useState<string>(() => {
    if (initialCollection) return initialCollection;
    try {
      const saved = userPrefs.get() as Record<string, unknown>;
      return (saved.lastLibraryCollection as string) || 'all';
    } catch { return 'all'; }
  });
  const setSelectedCollection = useCallback((value: string) => {
    setSelectedCollectionRaw(value);
    try { userPrefs.set({ lastLibraryCollection: value } as Record<string, unknown>); } catch { /* ignore */ }
  }, []);
  const [displayedCount, setDisplayedCount] = useState(50);
  const [sortBy, setSortBy] = useState<'date' | 'title' | 'collection' | 'status' | 'size' | 'year' | 'author' | 'centrality'>('date');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');
  const isMobile = useIsMobile();

  // Tag filter
  const [selectedTags, setSelectedTags] = useState<Set<string>>(new Set());
  const [tagList, setTagList] = useState<Array<{ id: string; name: string; color: string | null; doc_count: number; tag_type: number }>>([]);
  const [tagFilterOpen, setTagFilterOpen] = useState(false);

  // Smart Collections (lazy-loaded on filter dropdown open)
  const [smartCollections, setSmartCollections] = useState<SavedSearch[]>([]);
  const [smartCollectionsLoaded, setSmartCollectionsLoaded] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const [localSavedSearchDocIds, setLocalSavedSearchDocIds] = useState<string[] | null>(null);
  // Merged: prop from parent (desktop sidebar) takes precedence, otherwise local (from filter dropdown)
  const effectiveSavedSearchDocIds = savedSearchDocIds ?? localSavedSearchDocIds;

  // Unified filter setter — handles both built-in presets and smart collections
  const setFilterStatus = useCallback(async (value: string) => {
    setFilterStatusRaw(value);
    if (value.startsWith('smart:')) {
      const searchId = value.slice(6);
      setSelectedCollection('all');
      const docIds = await executeSavedSearch(searchId);
      setLocalSavedSearchDocIds(docIds);
    } else {
      setLocalSavedSearchDocIds(null);
    }
  }, [setSelectedCollection]);

  // When parent sets savedSearchDocIds (desktop sidebar click), sync filter dropdown
  useEffect(() => {
    if (savedSearchDocIds !== null) {
      setSelectedCollection('all');
    }
  }, [savedSearchDocIds, setSelectedCollection]);

  // Human-readable label for the active filter
  const filterLabel = useMemo(() => {
    if (filterStatus.startsWith('smart:')) {
      const ss = smartCollections.find(s => s.id === filterStatus.slice(6));
      return ss?.name || 'Smart filter';
    }
    const labels: Record<string, string> = {
      all: t('knowledge.library.showAll', 'Show all'),
      completed: t('knowledge.library.showProcessed', 'Processed'),
      graph_running: t('knowledge.library.showRunning', 'Graph running'),
      graph_hierarchy: t('knowledge.library.showHierarchy', 'Hierarchy only'),
      graph_failed: t('knowledge.library.showFailed', 'Graph failed'),
      no_summary: t('knowledge.library.showNoSummary', 'No summary'),
    };
    return labels[filterStatus] || filterStatus;
  }, [filterStatus, smartCollections, t]);

  // Collection stats
  const [collectionStats, setCollectionStats] = useState<CollectionStats | null>(null);
  const [statsLoading, setStatsLoading] = useState(false);
  const [statsExpanded, setStatsExpanded] = useState(false);

  // Document actions state
  const [duplicateReviewDoc, setDuplicateReviewDoc] = useState<{ id: string; title: string } | null>(null);
  const [deleteConfirmDocId, setDeleteConfirmDocId] = useState<string | null>(null);
  const [isDeletingDoc, setIsDeletingDoc] = useState(false);
  const [showSummaryForDoc, setShowSummaryForDoc] = useState<string | null>(null);
  // tagManageDocId removed — tag management is now inline via TagInlineSubmenu
  const [relationDoc, setRelationDoc] = useState<{ id: string; title: string } | null>(null);
  const [redownloadDoc, setRedownloadDoc] = useState<ProcessedDocument | null>(null);
  const [collectionManageDoc, setCollectionManageDoc] = useState<ProcessedDocument | null>(null);
  // downloadOptionsDoc removed — download options now inline submenu

  // Batch selection state
  const [selectedDocIds, setSelectedDocIds] = useState<Set<string>>(new Set());
  const [isBatchDeleting, setIsBatchDeleting] = useState(false);
  const [isMovingDocs, setIsMovingDocs] = useState(false);
  const [batchDeleteConfirm, setBatchDeleteConfirm] = useState(false);
  const [draggedDocId, setDraggedDocId] = useState<string | null>(null);
  const [dragOverCollection, setDragOverCollection] = useState<string | null>(null);

  // Mobile long-press → enter selection mode. Tap in selection mode toggles instead of preview.
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressTriggeredRef = useRef(false);
  const longPressStartXYRef = useRef<{ x: number; y: number } | null>(null);
  // Mobile: the same long-press that toggles selection also reveals the title
  // overlay (desktop shows it on hover instead). Cleared when the finger lifts.
  const [titlePreviewId, setTitlePreviewId] = useState<string | null>(null);

  // Export dialog state
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  const [exportMetadata, setExportMetadata] = useState<ResolvedMetadata[]>([]);

  // Sync filter when parent changes selected collection
  useEffect(() => {
    if (initialCollection) {
      setSelectedCollection(initialCollection);
    }
  }, [initialCollection, setSelectedCollection]);

  // Fetch collection stats when a specific collection is selected + auto-poll every 30s when expanded
  useEffect(() => {
    if (!selectedCollection || selectedCollection === 'all') {
      setCollectionStats(null);
      return;
    }
    const fetchStats = () => {
      getCollectionStats(selectedCollection).then(stats => {
        if (stats) setCollectionStats(stats);
      });
    };
    setStatsLoading(true);
    fetchStats();
    setStatsLoading(false);

    // Auto-poll while stats panel is expanded and there's active processing
    const interval = setInterval(() => {
      if (statsExpanded && collectionStats &&
          (collectionStats.graph_completed < collectionStats.total_documents ||
           collectionStats.docs_with_summaries < collectionStats.total_documents)) {
        fetchStats();
      }
    }, 30000);
    return () => clearInterval(interval);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are intentionally limited
  }, [selectedCollection, statsExpanded]);

  // Fetch workspace storage info
  useEffect(() => {
    if (!currentWorkspace?.id) return;
    getWorkspaceStorage(currentWorkspace.id)
      .then((data) => {
        if (data) {
          setWorkspaceStorage({
            storage_used_bytes: data.storage_used_bytes,
            documents_count: data.documents_count,
          });
        }
      })
      .catch((err) => console.error('Failed to fetch workspace storage:', err));
  }, [currentWorkspace?.id]);

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const loadMoreTriggerRef = useRef<HTMLDivElement>(null);

  // Refresh a single document by ID and merge it into the local state.
  // Used by the async-dispatch handlers (Build graph, Rebuild embeddings)
  // so the menu labels react as the background job progresses.
  const refreshDocumentById = useCallback(async (docId: string): Promise<Record<string, unknown> | null> => {
    try {
      const updated = await getDocumentById(docId);
      setDocuments(prev => prev.map(d =>
        d.id === docId
          ? ({ ...d, ...(updated as Partial<ProcessedDocument>), collection_name: d.collection_name } as ProcessedDocument)
          : d
      ));
      return updated;
    } catch (err) {
      console.error('Failed to refresh document:', err);
      return null;
    }
  }, []);

  // Tracks active polling timers per document so we can cancel them on
  // unmount or when a fresh dispatch supersedes an in-flight poll.
  const activePollsRef = useRef<Map<string, () => void>>(new Map());

  // Poll one document at increasing intervals (back-off schedule) until
  // `isDone` is true on the fetched payload, or the schedule is exhausted.
  const pollDocumentStatus = useCallback((
    docId: string,
    isDone: (doc: Record<string, unknown>) => boolean,
    delaysMs: number[]
  ) => {
    activePollsRef.current.get(docId)?.();
    let cancelled = false;
    const cancel = () => { cancelled = true; };
    activePollsRef.current.set(docId, cancel);

    const tick = async (idx: number) => {
      if (cancelled || idx >= delaysMs.length) {
        activePollsRef.current.delete(docId);
        return;
      }
      await new Promise<void>(r => setTimeout(r, delaysMs[idx]));
      if (cancelled) return;
      const updated = await refreshDocumentById(docId);
      if (cancelled) return;
      if (updated && isDone(updated)) {
        activePollsRef.current.delete(docId);
        return;
      }
      void tick(idx + 1);
    };
    void tick(0);
  }, [refreshDocumentById]);

  // Cancel any in-flight polls on unmount so setState doesn't fire on a
  // dead component.
  useEffect(() => {
    const polls = activePollsRef.current;
    return () => {
      polls.forEach(c => c());
      polls.clear();
    };
  }, []);

  // Refetch documents for a specific collection (used by action handlers)
  const fetchDocuments = useCallback(async (collectionId: string) => {
    try {
      let page = 1;
      let hasMore = true;
      const allDocs: ProcessedDocument[] = [];
      const collection = collections.find(c => c.id === collectionId);
      while (hasMore) {
        const response = await getDocumentsByCollection(collectionId, page, 100);
        const docs = response.documents.map((doc: ProcessedDocument) => ({
          ...doc,
          collection_name: collection?.name || '',
        }));
        allDocs.push(...docs);
        hasMore = response.hasMore && response.documents.length > 0;
        page++;
      }
      setDocuments(prev => {
        const otherDocs = prev.filter(d => d.collection_id !== collectionId);
        return deduplicateById([...otherDocs, ...allDocs]).sort((a, b) => {
          const dateA = a.created_at ? new Date(a.created_at).getTime() : 0;
          const dateB = b.created_at ? new Date(b.created_at).getTime() : 0;
          return dateB - dateA;
        });
      });
    } catch (err) {
      console.error('Error refetching documents:', err);
    }
  }, [collections]);

  const handleRefresh = useCallback(async () => {
    if (isRefreshing) return;
    setIsRefreshing(true);
    try {
      clearCache('/documents/collection/');
      if (onRefresh) {
        await onRefresh();
      } else {
        await mapWithConcurrency(collections, 6, c => fetchDocuments(c.id));
      }
    } finally {
      setIsRefreshing(false);
    }
  }, [isRefreshing, onRefresh, collections, fetchDocuments]);

  // Use preloaded data if available, otherwise fetch
  useEffect(() => {
    // If we have preloaded documents, use them directly
    if (preloadedDocuments !== undefined) {
      // Don't filter by status here — let filteredDocuments useMemo handle it
      // Sort by created_at (newest first)
      setDocuments([...preloadedDocuments].sort((a, b) => {
        const dateA = a.created_at ? new Date(a.created_at).getTime() : 0;
        const dateB = b.created_at ? new Date(b.created_at).getTime() : 0;
        return dateB - dateA;
      }));
      setLoading(preloadedLoading ?? false);
      return;
    }

    // Fallback: fetch if no preloaded data provided
    async function fetchAllDocuments() {
      // Don't fetch while collections are still loading
      if (collectionsLoading) {
        return;
      }

      // If no collections, stop loading and show empty state
      if (collections.length === 0) {
        setLoading(false);
        return;
      }

      setLoading(true);
      setError(null);

      try {
        const allDocuments: ProcessedDocument[] = [];

        // Fetch documents from each collection (paginate to get ALL docs)
        for (const collection of collections) {
          try {
            let page = 1;
            let hasMore = true;
            while (hasMore) {
              const response = await getDocumentsByCollection(collection.id, page, 100);
              const docs = response.documents
                .filter((doc: LibraryDocument) =>
                  filterStatus === 'all' || doc.processing_status === 'completed'
                )
                .map((doc: LibraryDocument) => ({
                  ...doc,
                  collection_name: collection.name,
                }));
              allDocuments.push(...docs);
              hasMore = response.hasMore && response.documents.length > 0;
              page++;
            }
          } catch (err) {
            console.error(`Error fetching documents for collection ${collection.name}:`, err);
          }
        }

        // Deduplicate by document ID (a document in multiple collections
        // via multi-collection membership would appear from each collection fetch)
        const uniqueDocuments = deduplicateById(allDocuments);

        // Sort by created_at (newest first)
        uniqueDocuments.sort((a, b) => {
          const dateA = a.created_at ? new Date(a.created_at).getTime() : 0;
          const dateB = b.created_at ? new Date(b.created_at).getTime() : 0;
          return dateB - dateA;
        });

        setDocuments(uniqueDocuments);
      } catch (err) {
        console.error('Error fetching all documents:', err);
        setError(t('knowledge.library.errorLoading', 'Failed to load documents'));
      } finally {
        setLoading(false);
      }
    }

    void fetchAllDocuments();
  }, [collections, collectionsLoading, filterStatus, t, preloadedDocuments, preloadedLoading]);

  // Filter documents by search query and collection
  // Breadcrumb ancestors for nested collections
  const collectionAncestors = useMemo(() => {
    if (!initialCollection) return [];
    return getAncestors(collections, initialCollection);
  }, [collections, initialCollection]);

  const filteredDocuments = useMemo(() => {
    let filtered = documents;

    // Filter by saved search results (smart collection) — mutually exclusive with status filter
    if (effectiveSavedSearchDocIds !== null) {
      const idSet = new Set(effectiveSavedSearchDocIds);
      filtered = filtered.filter(doc => idSet.has(doc.id));
    }

    // Filter by built-in status presets (skip when smart collection is active)
    if (!filterStatus.startsWith('smart:') && !filterStatus.startsWith('type:')) switch (filterStatus) {
      case 'completed':
        filtered = filtered.filter(doc => doc.processing_status === 'completed');
        break;
      case 'graph_running':
        filtered = filtered.filter(doc => doc.graph_status === 'entity_running');
        break;
      case 'graph_hierarchy':
        filtered = filtered.filter(doc => doc.graph_status === 'hierarchy_done');
        break;
      case 'graph_failed':
        filtered = filtered.filter(doc => doc.graph_status === 'failed');
        break;
      case 'no_summary':
        filtered = filtered.filter(doc => doc.processing_status === 'completed' && !doc.has_summary);
        break;
      // 'all' — no filtering
    }

    // Filter by document type
    if (filterStatus.startsWith('type:')) {
      const typeValue = filterStatus.slice(5); // remove "type:" prefix
      if (typeValue === 'no_type') {
        filtered = filtered.filter(doc => !doc.extracted_metadata?.resolved?.document_type);
      } else {
        filtered = filtered.filter(doc => doc.extracted_metadata?.resolved?.document_type === typeValue);
      }
    }

    // Filter by collection (check primary collection_id + multi-collection memberships)
    if (selectedCollection !== 'all') {
      filtered = filtered.filter(doc =>
        doc.collection_id === selectedCollection
        || doc.collection_memberships?.some(m => m.collection_id === selectedCollection)
      );
    }

    // Filter by selected tags
    if (selectedTags.size > 0) {
      filtered = filtered.filter(doc => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- tags may arrive as strings or {id, name} objects depending on API version
        const docTagIds = new Set((doc.tags || []).map(t => typeof t === 'string' ? t : (t as any).id || (t as any).name));
        return [...selectedTags].some(tagId => docTagIds.has(tagId));
      });
    }

    // Filter by search query
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter(doc => {
        if (doc.title.toLowerCase().includes(query)) return true;
        if (doc.filename.toLowerCase().includes(query)) return true;
        if (doc.collection_name.toLowerCase().includes(query)) return true;
        if (doc.file_metadata?.author?.toLowerCase().includes(query)) return true;
        // Search resolved metadata (auto-enriched academic metadata)
        const resolved = doc.extracted_metadata?.resolved;
        if (resolved) {
          if (resolved.title?.toLowerCase().includes(query)) return true;
          if (resolved.journal?.toLowerCase().includes(query)) return true;
          if (resolved.authors?.some((a: string) => a.toLowerCase().includes(query))) return true;
          if (resolved.abstract?.toLowerCase().includes(query)) return true;
        }
        return false;
      });
    }

    // Sort
    const statusOrder: Record<string, number> = { failed: 0, processing: 1, pending: 2, completed: 3 };
    return [...filtered].sort((a, b) => {
      let cmp = 0;
      switch (sortBy) {
        case 'date': {
          const dateA = a.created_at ? new Date(a.created_at).getTime() : 0;
          const dateB = b.created_at ? new Date(b.created_at).getTime() : 0;
          cmp = dateA - dateB;
          break;
        }
        case 'title':
          cmp = (a.title || a.filename).localeCompare(b.title || b.filename);
          break;
        case 'collection':
          cmp = a.collection_name.localeCompare(b.collection_name);
          break;
        case 'status':
          cmp = (statusOrder[a.processing_status] ?? 3) - (statusOrder[b.processing_status] ?? 3);
          break;
        case 'size':
          cmp = (a.file_size ?? 0) - (b.file_size ?? 0);
          break;
        case 'year': {
          const yearA = a.extracted_metadata?.resolved?.year ?? 0;
          const yearB = b.extracted_metadata?.resolved?.year ?? 0;
          cmp = yearA - yearB;
          break;
        }
        case 'author': {
          const authA = (a.extracted_metadata?.resolved?.authors?.[0] ?? '').toString();
          const authB = (b.extracted_metadata?.resolved?.authors?.[0] ?? '').toString();
          cmp = authA.localeCompare(authB);
          break;
        }
        case 'centrality': {
          const prA = typeof a.pagerank_score === 'number' ? a.pagerank_score : 0;
          const prB = typeof b.pagerank_score === 'number' ? b.pagerank_score : 0;
          cmp = prA - prB;
          break;
        }
      }
      return sortDirection === 'asc' ? cmp : -cmp;
    });
  }, [documents, searchQuery, selectedCollection, filterStatus, sortBy, sortDirection, effectiveSavedSearchDocIds, selectedTags]);

  // PageRank — normalize against max of the current filtered
  // set so the centrality bar on each card has a meaningful proportion.
  // Returns 0 when no document has a score yet (pre-compute window).
  const maxPagerank = useMemo(() => {
    let m = 0;
    for (const d of filteredDocuments) {
      if (typeof d.pagerank_score === 'number' && d.pagerank_score > m) {
        m = d.pagerank_score;
      }
    }
    return m;
  }, [filteredDocuments]);

  // Documents to display (with infinite scroll limit)
  const displayedDocuments = useMemo(() => {
    return filteredDocuments.slice(0, displayedCount);
  }, [filteredDocuments, displayedCount]);

  const hasMoreDocuments = filteredDocuments.length > displayedCount;

  // Infinite scroll via document-level scroll capture.
  // Uses capture: true to catch scroll events from ANY ancestor (works regardless of
  // which container actually scrolls — inner scrollContainerRef or outer swipe wrapper).
  // getBoundingClientRect checks trigger's actual screen position.
  useEffect(() => {
    if (!hasMoreDocuments || loading) return;

    const trigger = loadMoreTriggerRef.current;
    if (!trigger) return;

    const handleScroll = () => {
      const rect = trigger.getBoundingClientRect();
      if (rect.top < window.innerHeight + 300) {
        setDisplayedCount(prev => prev + 50);
      }
    };

    document.addEventListener('scroll', handleScroll, { passive: true, capture: true });
    return () => document.removeEventListener('scroll', handleScroll, { capture: true } as EventListenerOptions);
  }, [hasMoreDocuments, loading]);

  // Reset displayed count when filters or sort change
  useEffect(() => {
    setDisplayedCount(50);
  }, [searchQuery, selectedCollection, filterStatus, sortBy, sortDirection]);

  // Handle document preview
  const handleDocumentTypeChange = useCallback(async (documentId: string, newType: string) => {
    try {
      const { updateDocumentType } = await import('@/lib/api-metadata');
      await updateDocumentType(documentId, newType);
      // Update local state optimistically
      setDocuments(prev => prev.map(doc => {
        if (doc.id !== documentId) return doc;
        const meta = doc.extracted_metadata || {};
        const resolved = (meta.resolved || {}) as Record<string, unknown>;
        return { ...doc, extracted_metadata: { ...meta, resolved: { ...resolved, document_type: newType } } };
      }));
      toast.success(t('knowledge.documentType.typeUpdated', 'Document type updated'));
    } catch (error) {
      console.error('Failed to update document type:', error);
      toast.error(t('knowledge.documentType.updateFailed', 'Failed to update document type'));
    }
  }, [t]);

  const handlePreview = useCallback((documentId: string, filename: string, collectionId?: string) => {
    const fileExtension = filename.split('.').pop()?.toLowerCase();
    const documentUrl = `/documents/${documentId}/file`;

    console.log('📚 [Library] Opening document:', { documentId, filename, collectionId, url: documentUrl });

    // Note: previously we closed the host (Knowledge Stacks) dialog here
    // to avoid a Radix `modal` flip race, but that broke the split-screen
    // UX — the host dialog must stay mounted so its `isSplitScreen` branch
    // can render the library on the opposite half from the viewer drawer.
    // The race is now defused inside EpubViewerDrawer (`useEffect` deps =
    // `[isOpen]` only, callback stashed in a ref) so the drawer no longer
    // tears itself down when the parent rerenders.

    if (fileExtension === 'pdf') {
      pdfDispatch({
        type: 'OPEN_PDF_VIEWER',
        payload: {
          url: documentUrl,
          documentId: documentId, // Explicitly pass documentId for RAG chat
          documentTitle: filename,
          collectionId: collectionId, // For annotation support
          // Don't set page - let the viewer use saved/cached position
          citationId: 0, // Use 0 for document preview (not a citation)
        },
      });
    } else if (fileExtension === 'epub') {
      epubDispatch({
        type: 'OPEN_EPUB_VIEWER',
        payload: {
          url: documentUrl,
          documentId: documentId,
          documentTitle: filename,
          collectionId: collectionId, // For annotation support
          // Don't set location - let the viewer use saved/cached position
          citationId: 0, // Use 0 for document preview (not a citation)
        },
      });
    } else if (fileExtension === 'docx') {
      docxDispatch({
        type: 'OPEN_DOCX_VIEWER',
        payload: {
          url: documentUrl,
          documentId: documentId,
          documentTitle: filename,
          citationId: 0, // Use 0 for document preview (not a citation)
        },
      });
    }
  }, [pdfDispatch, epubDispatch, docxDispatch]);

  // Handle document deletion
  const handleDeleteDoc = useCallback(async (docId: string) => {
    setIsDeletingDoc(true);
    try {
      await deleteDocument(docId);
      setDocuments(prev => prev.filter(doc => doc.id !== docId));
      toast({
        title: t('general.success'),
        description: t('knowledge.library.documentDeleted', 'Document deleted'),
      });
    } catch (error) {
      console.error('Error deleting document:', error);
      toast({
        title: t('general.error'),
        description: t('chat.knowledgeStack.failedToDeleteDocument'),
        variant: 'destructive',
      });
    } finally {
      setIsDeletingDoc(false);
      setDeleteConfirmDocId(null);
    }
  }, [t]);

  // Handle partial document deletion (embeddings, graph, or file only)
  const handlePartialDelete = useCallback(async (docId: string, scope: 'embeddings' | 'graph' | 'file') => {
    try {
      const result = await partialDeleteDocument(docId, scope);
      toast({
        title: t('general.success'),
        description: result.message,
      });
      // Update local state based on scope
      setDocuments(prev => prev.map(doc => {
        if (doc.id !== docId) return doc;
        if (scope === 'embeddings') return { ...doc, processing_status: 'pending' };
        if (scope === 'graph') return { ...doc, graph_status: null };
        if (scope === 'file') return { ...doc, file_stored: false };
        return doc;
      }));
    } catch (error) {
      console.error(`Error deleting ${scope}:`, error);
      toast({
        title: t('general.error'),
        description: t('knowledge.library.partialDeleteFailed', { scope }),
        variant: 'destructive',
      });
    }
  }, [t]);

  // Per-document key bumped after a thumbnail mutation. DocumentThumbnail
  // caches its blob URL until one of its deps changes — re-downloads
  // overwrite the same on-disk path so the image bytes change but the
  // React prop tree doesn't, leaving the stale blob on screen until a
  // full page reload. Bumping this key forces the child to refetch.
  const [thumbnailRefreshKey, setThumbnailRefreshKey] = useState<Record<string, number>>({});
  const bumpThumbRefresh = useCallback((docId: string) => {
    setThumbnailRefreshKey(prev => ({ ...prev, [docId]: (prev[docId] ?? 0) + 1 }));
  }, []);

  // Handle cover download from internet (via ISBN / Open Library)
  const handleDownloadCover = useCallback(async (docId: string) => {
    const existing = documents.find(d => d.id === docId);
    const wasRetry = existing?.thumbnail?.cover_downloaded === true;
    try {
      const result = await downloadBookCover(docId);
      if (result.success) {
        toast({
          title: wasRetry
            ? t('knowledge.thumbnail.alternateCoverDownloaded', 'Different cover loaded')
            : t('general.success'),
          description: result.message || t('knowledge.thumbnail.coverDownloaded', 'Cover downloaded successfully'),
        });
        clearCache('/documents/collection/');
        setDocuments(prev => prev.map(doc =>
          doc.id === docId
            ? { ...doc, thumbnail: { has_thumbnail: true, has_custom: true, cover_downloaded: true } }
            : doc
        ));
        bumpThumbRefresh(docId);
        return;
      }
      // Retry exhausted the alternatives — backend deleted the current
      // thumbnail and signalled no_more_covers. Reflect that in local
      // state so the stylised fake cover takes over without a reload.
      if (result.source === 'no_more_covers') {
        clearCache('/documents/collection/');
        setDocuments(prev => prev.map(doc =>
          doc.id === docId
            ? { ...doc, thumbnail: { has_thumbnail: false, has_custom: false, cover_downloaded: false } }
            : doc
        ));
        bumpThumbRefresh(docId);
        toast({
          title: t('knowledge.thumbnail.noMoreCovers', 'No more covers'),
          description: t('knowledge.thumbnail.noMoreCoversDescription', 'No alternative covers available for this book. You can upload one manually.'),
        });
        return;
      }
      toast({
        title: t('knowledge.thumbnail.noCoverFound', 'No Cover Found'),
        description: result.message,
        variant: 'destructive',
      });
    } catch (error: unknown) {
      console.error('Failed to download cover:', error);
      const axiosErr = error as { response?: { data?: { detail?: string } }; message?: string };
      const errorMsg = axiosErr?.response?.data?.detail || axiosErr?.message || t('knowledge.thumbnail.coverDownloadFailed', 'Failed to download cover');
      toast({
        title: t('general.error'),
        description: errorMsg,
        variant: 'destructive',
      });
    }
  }, [documents, t, bumpThumbRefresh]);

  // Delete a downloaded (or uploaded) cover so the stylised fake cover
  // takes over. Wired into the dropdown menu next to "Download cover".
  const handleRemoveCover = useCallback(async (docId: string) => {
    try {
      await deleteCustomThumbnail(docId);
      clearCache('/documents/collection/');
      setDocuments(prev => prev.map(doc =>
        doc.id === docId
          ? { ...doc, thumbnail: { has_thumbnail: false, has_custom: false, cover_downloaded: false } }
          : doc
      ));
      bumpThumbRefresh(docId);
      toast({
        title: t('knowledge.thumbnail.removeSuccess', 'Success'),
        description: t('knowledge.thumbnail.customRemoved', 'Custom thumbnail removed'),
      });
    } catch (error: unknown) {
      console.error('Failed to remove cover:', error);
      const axiosErr = error as { response?: { data?: { detail?: string } }; message?: string };
      toast({
        title: t('knowledge.thumbnail.removeError', 'Error'),
        description: axiosErr?.response?.data?.detail || axiosErr?.message || t('knowledge.thumbnail.removeFailed', 'Failed to remove thumbnail'),
        variant: 'destructive',
      });
    }
  }, [t, bumpThumbRefresh]);

  // Handle download to computer — browser download of the actual document file
  const handleDownloadToComputer = useCallback(async (doc: ProcessedDocument) => {
    try {
      await downloadDocumentToComputer(doc.id, doc.filename);
      toast({
        title: t('general.success'),
        description: t('knowledge.library.downloadToComputerSuccess', 'File downloaded successfully'),
      });
    } catch (error: unknown) {
      console.error('Failed to download file:', error);
      const axiosErr = error as { response?: { status?: number }; message?: string };
      if (axiosErr?.response?.status === 404) {
        toast({
          title: t('general.error'),
          description: t('knowledge.library.fileNotOnServer', 'File not found on server. Use "Save to server" first to download from external sources.'),
          variant: 'destructive',
        });
      } else {
        toast({
          title: t('general.error'),
          description: t('knowledge.library.downloadFailed', 'Failed to download file'),
          variant: 'destructive',
        });
      }
    }
  }, [t]);

  // Handle summary button — open the summary view (BookSummaryHoverCard handles fetch/generate)
  const handleSummary = useCallback((docId: string) => {
    setShowSummaryForDoc(docId);
  }, []);

  // Handle copy filename
  const handleCopyFilename = useCallback((filename: string) => {
    navigator.clipboard.writeText(filename).then(() => {
      toast({
        title: t('general.success'),
        description: t('knowledge.library.filenameCopied', 'Filename copied to clipboard'),
      });
    }).catch(() => {
      toast({
        title: t('general.error'),
        description: t('knowledge.library.filenameCopyFailed', 'Failed to copy filename'),
        variant: 'destructive',
      });
    });
  }, [t]);

  // Metadata enrichment — lookup DOI/ISBN from already-parsed document content
  const [enrichingDocId, setEnrichingDocId] = useState<string | null>(null);
  const handleEnrichMetadata = useCallback(async (docId: string) => {
    if (enrichingDocId) return;
    setEnrichingDocId(docId);
    try {
      const result = await enrichDocumentMetadata(docId);
      if (result?.success && result.metadata) {
        const meta = result.metadata;
        toast.success(
          meta.title
            ? `${meta.title}${meta.authors?.length ? ` — ${meta.authors.slice(0, 2).join(', ')}` : ''}${meta.year ? ` (${meta.year})` : ''}`
            : t('knowledge.library.metadataFound', 'Metadata found'),
          { duration: 5000 }
        );
        // Refresh documents to show updated metadata
        if (selectedCollection && selectedCollection !== 'all') {
          void fetchDocuments(selectedCollection);
        }
      } else {
        toast.info(
          result?.message || t('knowledge.library.noMetadataFound', 'No DOI, ISBN, or other identifiers found in this document.'),
          { duration: 4000 }
        );
      }
    } catch (err: unknown) {
      const axiosErr = err as { response?: { status?: number } };
      if (axiosErr?.response?.status === 404) {
        toast.info(t('knowledge.library.noMetadataEndpoint', 'Auto-enrichment not available.'), { duration: 5000 });
      } else {
        toast.error(t('knowledge.library.metadataError', 'Failed to lookup metadata. Please try again.'));
      }
    } finally {
      setEnrichingDocId(null);
    }
  }, [enrichingDocId, selectedCollection, fetchDocuments, t]);

  // Copy citation to clipboard
  const handleCopyCitation = useCallback(async (doc: ProcessedDocument, styleId: string) => {
    const meta = parseDocumentMetadata(doc.extracted_metadata);
    const resolved = meta?.resolved;
    if (!resolved) {
      toast.error(t('knowledge.library.noMetadataFound', 'No metadata found'));
      return;
    }
    try {
      const citation = await formatCitation(resolved, styleId);
      await navigator.clipboard.writeText(citation);
      const styleName = CITATION_STYLES.find(s => s.id === styleId)?.name || styleId;
      toast.success(t('knowledge.library.citationCopied', 'Citation copied ({{style}})', { style: styleName }));
    } catch (err) {
      console.error('[LibraryView] Failed to copy citation:', err);
      toast.error(t('knowledge.library.citationCopyFailed', 'Failed to copy citation'));
    }
  }, [t]);

  // Export citations
  const handleExportCitations = useCallback((docs: ProcessedDocument[]) => {
    const metas: ResolvedMetadata[] = [];
    for (const doc of docs) {
      const meta = parseDocumentMetadata(doc.extracted_metadata);
      if (meta?.resolved) {
        metas.push(meta.resolved);
      }
    }
    if (metas.length === 0) {
      toast.error(t('knowledge.library.noMetadataFound', 'No metadata found'));
      return;
    }
    setExportMetadata(metas);
    setExportDialogOpen(true);
  }, [t]);

  // Batch selection helpers
  const toggleDocSelection = useCallback((docId: string) => {
    setSelectedDocIds(prev => {
      const next = new Set(prev);
      if (next.has(docId)) next.delete(docId);
      else next.add(docId);
      return next;
    });
  }, []);

  const cancelLongPress = useCallback(() => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
    longPressStartXYRef.current = null;
    setTitlePreviewId(null);
  }, []);

  const handleTouchStartLongPress = useCallback((e: React.TouchEvent, docId: string) => {
    if (!isMobile || readOnly) return;
    const t = e.touches[0];
    if (!t) return;
    longPressTriggeredRef.current = false;
    longPressStartXYRef.current = { x: t.clientX, y: t.clientY };
    longPressTimerRef.current = setTimeout(() => {
      longPressTriggeredRef.current = true;
      if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
        try { navigator.vibrate(50); } catch { /* ignore */ }
      }
      // Reveal the title overlay AND toggle selection — the long-press serves
      // both purposes on mobile (no hover affordance for the title tooltip).
      setTitlePreviewId(docId);
      toggleDocSelection(docId);
    }, 500);
  }, [isMobile, readOnly, toggleDocSelection]);

  const handleTouchMoveLongPress = useCallback((e: React.TouchEvent) => {
    if (!longPressTimerRef.current || !longPressStartXYRef.current) return;
    const t = e.touches[0];
    if (!t) return;
    const dx = Math.abs(t.clientX - longPressStartXYRef.current.x);
    const dy = Math.abs(t.clientY - longPressStartXYRef.current.y);
    // 10px threshold — matches Radix mobile popover convention
    if (dx > 10 || dy > 10) {
      cancelLongPress();
    }
  }, [cancelLongPress]);

  const selectAllVisible = useCallback(() => {
    setSelectedDocIds(new Set(displayedDocuments.map(d => d.id)));
  }, [displayedDocuments]);

  const deselectAll = useCallback(() => {
    setSelectedDocIds(new Set());
  }, []);

  const hasSelection = selectedDocIds.size > 0;

  // Batch delete handler
  const handleBatchDelete = useCallback(async () => {
    setIsBatchDeleting(true);
    try {
      const ids = Array.from(selectedDocIds);
      const result = await batchDeleteDocuments(ids);
      setDocuments(prev => prev.filter(d => !selectedDocIds.has(d.id)));
      setSelectedDocIds(new Set());
      toast({
        title: t('general.success'),
        description: t('knowledge.library.batchDeleteSuccess', {
          count: result.deleted_count,
          defaultValue: '{{count}} documents deleted',
        }),
      });
    } catch (error) {
      console.error('Batch delete error:', error);
      toast({
        title: t('general.error'),
        description: t('knowledge.library.batchDeleteError', 'Failed to delete documents'),
        variant: 'destructive',
      });
    } finally {
      setIsBatchDeleting(false);
      setBatchDeleteConfirm(false);
    }
  }, [selectedDocIds, t]);

  // Move to collection handler
  const handleMoveToCollection = useCallback(async (targetCollectionId: string, docIds?: string[]) => {
    const ids = docIds || Array.from(selectedDocIds);
    if (ids.length === 0) return;

    setIsMovingDocs(true);
    try {
      const result = await moveDocuments(ids, targetCollectionId);
      const targetCollection = collections.find(c => c.id === targetCollectionId);
      setDocuments(prev => prev.map(d =>
        ids.includes(d.id)
          ? { ...d, collection_id: targetCollectionId, collection_name: targetCollection?.name || '' }
          : d
      ));
      setSelectedDocIds(new Set());
      toast({
        title: t('general.success'),
        description: t('knowledge.library.moveSuccess', {
          count: result.moved_count,
          collection: targetCollection?.name || '',
          defaultValue: '{{count}} documents moved to {{collection}}',
        }),
      });
    } catch (error) {
      console.error('Move error:', error);
      toast({
        title: t('general.error'),
        description: t('knowledge.library.moveError', 'Failed to move documents'),
        variant: 'destructive',
      });
    } finally {
      setIsMovingDocs(false);
    }
  }, [selectedDocIds, collections, t]);

  // Drag and drop handlers
  const handleDragStart = useCallback((e: React.DragEvent, docId: string) => {
    // If dragging a selected doc, drag all selected; otherwise just this one
    const ids = selectedDocIds.has(docId) ? Array.from(selectedDocIds) : [docId];
    e.dataTransfer.setData('application/json', JSON.stringify(ids));
    e.dataTransfer.effectAllowed = 'move';
    setDraggedDocId(docId);
  }, [selectedDocIds]);

  const handleDragEnd = useCallback(() => {
    setDraggedDocId(null);
    setDragOverCollection(null);
  }, []);

  // Show loading state with skeleton thumbnails
  if (collectionsLoading || loading) {
    return (
      <div className='h-full flex flex-col'>
        <div className='flex-1 overflow-y-auto bg-white dark:bg-black'>
          {/* Skeleton Header */}
          <div className='sticky top-0 z-10 bg-white dark:bg-black border-b border-zinc-200 dark:border-zinc-800 p-4 space-y-4'>
            <div className='flex items-center gap-2'>
              <FileStack className='h-5 w-5 text-zinc-600 dark:text-zinc-400' />
              <h3 className='text-lg font-semibold text-zinc-800 dark:text-white'>
                {t('knowledge.tabs.library')}
              </h3>
              <div className='h-4 w-24 bg-zinc-200 dark:bg-zinc-700 skeleton-shimmer' />
            </div>

            {/* Skeleton Search Bar */}
            <div className='h-14 bg-zinc-100 dark:bg-zinc-800 skeleton-shimmer' />

            {/* Skeleton Filters */}
            <div className='flex gap-2'>
              <div className='h-9 w-[180px] bg-zinc-100 dark:bg-zinc-800 skeleton-shimmer' />
              <div className='h-9 w-32 bg-zinc-100 dark:bg-zinc-800 skeleton-shimmer' />
            </div>
          </div>

          {/* Skeleton Thumbnail Grid */}
          <div className={cn(isMobile ? 'p-2' : 'p-4')}>
            <div className={cn(
              'grid',
              isMobile
                ? 'grid-cols-2 gap-2'
                : 'grid-cols-4 lg:grid-cols-8 gap-3'
            )}>
              {Array.from({ length: isMobile ? 9 : 12 }).map((_, index) => (
                <div key={index} className={cn('flex flex-col', isMobile ? 'gap-1' : 'gap-2')}>
                  {/* Thumbnail Skeleton */}
                  <div className='aspect-[3/4] bg-zinc-200 dark:bg-zinc-800 skeleton-shimmer' />
                  {/* Title Skeleton */}
                  <div className={cn(isMobile ? 'h-3' : 'h-4', 'w-full bg-zinc-200 dark:bg-zinc-700 skeleton-shimmer')} />
                  <div className={cn(isMobile ? 'h-3' : 'h-4', 'w-3/4 bg-zinc-200 dark:bg-zinc-700 skeleton-shimmer')} />
                  {!isMobile && (
                    <>
                      <div className='h-3 w-1/2 bg-zinc-100 dark:bg-zinc-800 skeleton-shimmer' />
                      <div className='h-3 w-1/3 bg-zinc-100 dark:bg-zinc-800 skeleton-shimmer' />
                    </>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Show error state
  if (error) {
    return (
      <div className='h-full flex flex-col'>
        <div className='flex-1 overflow-y-auto p-4 space-y-4 bg-white dark:bg-black'>
          <div className='flex items-center gap-2'>
            <FileStack className='h-5 w-5 text-zinc-600 dark:text-zinc-400' />
            <h3 className='text-lg font-semibold text-zinc-800 dark:text-white'>
              {t('knowledge.tabs.library')}
            </h3>
          </div>
          <div className='flex flex-col items-center justify-center h-96 text-red-500'>
            <AlertCircle className='h-12 w-12 mb-4' />
            <p className='text-sm'>{error}</p>
          </div>
        </div>
      </div>
    );
  }

  // Show empty state
  if (collections.length === 0) {
    return (
      <div className='h-full flex flex-col'>
        <div className='flex-1 overflow-y-auto p-4 space-y-4 bg-white dark:bg-black'>
          <div className='flex items-center gap-2'>
            <FileStack className='h-5 w-5 text-zinc-600 dark:text-zinc-400' />
            <h3 className='text-lg font-semibold text-zinc-800 dark:text-white'>
              {t('knowledge.tabs.library')}
            </h3>
          </div>
          <div className='flex flex-col items-center justify-center h-96 text-zinc-500 dark:text-zinc-400'>
            <FileStack className='h-16 w-16 mb-4 text-zinc-300 dark:text-zinc-600' />
            <p className='text-sm'>{t('knowledge.library.noCollections', 'No collections yet')}</p>
            <p className='text-xs text-zinc-400 dark:text-zinc-500 mt-1'>
              {t('knowledge.library.createFirst', 'Create a collection to start uploading documents')}
            </p>
          </div>
        </div>
      </div>
    );
  }

  // Shared search bar component used in both header (desktop) and floating bar (mobile)
  const searchBar = (
    <div className='relative flex-1'>
      <Search className='absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground' />
      <Input
        data-testid='library-search-input'
        placeholder={isMobile
          ? t('knowledge.library.searchPlaceholderShort', 'Search...')
          : t('knowledge.library.searchPlaceholder', 'Search by title, author, collection...')
        }
        value={searchQuery}
        onChange={(e) => setSearchQuery(e.target.value)}
        className={cn(
          'pl-9 pr-10 border-0 bg-transparent focus-visible:ring-0 focus-visible:ring-offset-0',
          isMobile ? 'h-8 text-xs' : 'h-8 text-sm'
        )}
      />
      {searchQuery && (
        <button
          className={cn(
            'absolute right-3 top-1/2 -translate-y-1/2',
            'h-5 w-5 flex items-center justify-center',
            'text-muted-foreground/40 hover:text-muted-foreground',
            'transition-all duration-200 ease-out',
            'hover:bg-muted/30',
            'rounded-sm'
          )}
          onClick={() => setSearchQuery('')}
        >
          <X className='h-3 w-3' />
        </button>
      )}
    </div>
  );

  return (
    <div className='h-full flex flex-col relative'>
      <div
        ref={scrollContainerRef}
        data-testid='library-view-container'
        className={cn('flex-1 overflow-y-auto bg-white dark:bg-black', isMobile && 'pb-16')}
      >
        {/* Sticky Header with Filters */}
        <div className={cn(
          !isMobile && 'sticky top-0 z-20',
          'bg-white dark:bg-black border-b border-zinc-200 dark:border-zinc-800',
          isMobile ? 'px-3 py-2 space-y-1.5' : 'px-4 py-2 space-y-2'
        )}>
          {/* Title, Count, and Selection Toolbar */}
          <div className='flex items-center justify-between'>
            <div className='flex items-center gap-2'>
              <FileStack className={cn(isMobile ? 'h-4 w-4' : 'h-5 w-5', 'text-zinc-600 dark:text-zinc-400')} />
              <h3 className={cn(isMobile ? 'text-base' : 'text-lg', 'font-semibold text-zinc-800 dark:text-white')}>
                {t('knowledge.tabs.library')}
              </h3>
              <span className={cn(isMobile ? 'text-xs' : 'text-sm', 'text-zinc-500 dark:text-zinc-400')}>
                ({displayedDocuments.length}
                {filteredDocuments.length > displayedDocuments.length ? ` / ${filteredDocuments.length}` : ''}
                {collectionStats && filterStatus !== 'all' && collectionStats.total_documents > filteredDocuments.length
                  ? ` · ${collectionStats.total_documents} ${t('knowledge.library.total', 'total')}`
                  : ''})
              </span>
            </div>
            {/* Selection toggle button */}
            {!readOnly && filteredDocuments.length > 0 && (
              <button
                data-testid="library-select-all-button"
                onClick={() => hasSelection ? deselectAll() : selectAllVisible()}
                className={cn(
                  'flex items-center gap-1.5 px-2 h-7',
                  'text-xs transition-colors',
                  hasSelection
                    ? 'bg-primary/10 text-primary border border-primary/20'
                    : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
                )}
              >
                {hasSelection ? <CheckSquare className='h-3.5 w-3.5' /> : <Square className='h-3.5 w-3.5' />}
                {hasSelection
                  ? t('knowledge.library.deselectAll', 'Deselect ({{count}})', { count: selectedDocIds.size })
                  : t('knowledge.library.selectAll', 'Select all')
                }
              </button>
            )}
          </div>

          {/* Batch action bar — visible when documents are selected */}
          {hasSelection && !readOnly && (
            <div data-testid="library-batch-actions" className={cn(
              'flex items-center gap-2 p-2',
              'bg-primary/5 border border-primary/10',
            )}>
              <span className='text-xs font-medium text-primary'>
                {t('knowledge.library.selectedCount', '{{count}} selected', { count: selectedDocIds.size })}
              </span>
              <div className='flex-1' />
              {/* Move to collection dropdown */}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    data-testid="library-batch-move-button"
                    disabled={isMovingDocs}
                    className={cn(
                      'flex items-center gap-1.5 px-2 h-7 text-xs',
                      'bg-background border border-border hover:bg-muted/50',
                      'transition-colors disabled:opacity-50',
                    )}
                  >
                    {isMovingDocs ? <Loader2 className='h-3 w-3 animate-spin' /> : <FolderInput className='h-3 w-3' />}
                    {t('knowledge.library.moveTo', 'Move to...')}
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align='end' className='w-56 z-[9999] max-h-64 overflow-y-auto'>
                  {collections.map((col) => (
                    <DropdownMenuItem
                      key={col.id}
                      onClick={() => handleMoveToCollection(col.id)}
                      className='text-sm'
                    >
                      {col.name}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
              {/* Batch delete */}
              <button
                data-testid="library-batch-delete-button"
                onClick={() => setBatchDeleteConfirm(true)}
                disabled={isBatchDeleting}
                className={cn(
                  'flex items-center gap-1.5 px-2 h-7 text-xs',
                  'bg-destructive/10 text-destructive border border-destructive/20',
                  'hover:bg-destructive/20 transition-colors disabled:opacity-50',
                )}
              >
                {isBatchDeleting ? <Loader2 className='h-3 w-3 animate-spin' /> : <Trash2 className='h-3 w-3' />}
                {t('knowledge.library.deleteSelected', 'Delete')}
              </button>
            </div>
          )}

          {/* Search Bar — desktop only (mobile has floating bar at bottom) */}
          {!isMobile && (
            <div className='relative'>
              <div className={cn(
                'relative flex gap-2 p-1.5',
                'bg-background/80 dark:bg-background/60',
                'backdrop-blur-md',
                'border border-border/50',
                'shadow-lg shadow-black/5 dark:shadow-black/20',
              )}>
                {searchBar}
              </div>
            </div>
          )}

          {/* Breadcrumb for nested collections */}
          {initialCollection && (() => {
            const ancestors = collectionAncestors;
            if (ancestors.length <= 1) return null;
            return (
              <div className="flex items-center gap-1 text-xs text-muted-foreground px-1">
                {ancestors.map((col, i) => (
                  <span key={col.id} className="flex items-center gap-1">
                    {i > 0 && <span className="text-muted-foreground/50">/</span>}
                    {i < ancestors.length - 1 && onCollectionChange ? (
                      <button
                        className="hover:text-foreground hover:underline transition-colors"
                        onClick={() => onCollectionChange(col.id)}
                      >
                        {col.name}
                      </button>
                    ) : (
                      <span className={i === ancestors.length - 1 ? 'text-foreground font-medium' : ''}>
                        {col.name}
                      </span>
                    )}
                  </span>
                ))}
              </div>
            );
          })()}

          {/* Filters Row */}
          <div className={cn('flex flex-wrap gap-2', isMobile && 'gap-1.5')}>
            {/* Collection Filter — hidden when a specific collection is pre-selected from the dialog */}
            {!initialCollection && (
              <Select value={selectedCollection} onValueChange={setSelectedCollection}>
                <SelectTrigger data-testid='library-collection-filter' className={cn(
                  'h-8',
                  isMobile ? 'flex-1 min-w-0 text-xs' : 'w-[180px]'
                )}>
                  <SelectValue placeholder={t('knowledge.library.allCollections', 'All collections')} />
                </SelectTrigger>
                <SelectContent className='z-[9999] max-h-[300px]'>
                  <SelectItem value='all'>{t('knowledge.library.allCollections', 'All collections')}</SelectItem>
                  <SelectGroup>
                    {collections.slice(0, visibleCollectionCount).map((collection) => (
                      <SelectItem key={collection.id} value={collection.id}>
                        {collection.name}
                      </SelectItem>
                    ))}
                    {collections.length > visibleCollectionCount && (
                      <button
                        type="button"
                        className="w-full px-2 py-1.5 text-xs text-primary hover:bg-zinc-100 dark:hover:bg-zinc-800 text-center cursor-pointer"
                        onPointerDown={(e) => { e.preventDefault(); setVisibleCollectionCount(c => c + 20); }}
                      >
                        {t('knowledge.library.showMore', 'Show more')} ({collections.length - visibleCollectionCount})
                      </button>
                    )}
                  </SelectGroup>
                </SelectContent>
              </Select>
            )}

            {/* Status Filter — built-in presets + user smart collections (searchable) */}
            <Popover open={filterOpen} onOpenChange={(open) => {
              setFilterOpen(open);
              if (open && !smartCollectionsLoaded && currentWorkspace?.id) {
                listSavedSearches(currentWorkspace.id).then(ss => {
                  setSmartCollections(ss);
                  setSmartCollectionsLoaded(true);
                });
              }
            }}>
              <PopoverTrigger asChild>
                <button
                  data-testid="library-status-filter"
                  className={cn(
                    'h-8 px-2 flex items-center gap-1.5 whitespace-nowrap border border-input bg-background hover:bg-accent hover:text-accent-foreground',
                    isMobile ? 'flex-1 min-w-0 text-xs' : 'w-[200px] justify-between',
                  )}
                >
                  <span className="flex items-center gap-1.5 truncate">
                    <Filter className={cn(isMobile ? 'h-3 w-3' : 'h-3.5 w-3.5', 'flex-shrink-0')} />
                    <span className="truncate">{filterLabel}</span>
                  </span>
                  <ChevronsUpDown className="h-3.5 w-3.5 opacity-50 flex-shrink-0" />
                </button>
              </PopoverTrigger>
              <PopoverContent className="w-[220px] p-0 z-[9999]" align="start">
                <Command>
                  <CommandInput placeholder={t('knowledge.library.searchFilters', 'Search filters...')} className="h-8 text-xs" />
                  <CommandList
                    className="max-h-[280px] overflow-y-auto overflow-x-hidden overscroll-contain touch-pan-y [&_[cmdk-list-sizer]]:overflow-visible"
                    onWheel={(e) => {
                      // Radix Dialog scroll-lock intercepts wheel events via preventDefault.
                      // Manually scroll the list to bypass it.
                      e.currentTarget.scrollTop += e.deltaY;
                    }}
                    onTouchMove={(e) => {
                      // Allow native touch scroll inside the list — prevent Radix scroll-lock
                      e.stopPropagation();
                    }}
                  >
                    <CommandEmpty className="py-3 text-center text-xs text-muted-foreground">{t('knowledge.library.noFiltersFound', 'No filters found')}</CommandEmpty>
                    <CommandGroup heading={t('knowledge.library.builtInFilters', 'Filters')}>
                      {[
                        { value: 'all', label: t('knowledge.library.showAll', 'Show all') },
                        { value: 'completed', label: t('knowledge.library.showProcessed', 'Processed') },
                        { value: 'graph_running', label: t('knowledge.library.showRunning', 'Graph running'), dot: 'bg-orange-500' },
                        { value: 'graph_hierarchy', label: t('knowledge.library.showHierarchy', 'Hierarchy only'), dot: 'bg-yellow-500' },
                        { value: 'graph_failed', label: t('knowledge.library.showFailed', 'Graph failed'), dot: 'bg-red-500' },
                        { value: 'no_summary', label: t('knowledge.library.showNoSummary', 'No summary'), dot: 'bg-zinc-400' },
                        { value: 'trash', label: t('knowledge.library.showTrash', 'Trash'), dot: 'bg-red-400' },
                      ].map(item => (
                        <CommandItem
                          key={item.value}
                          value={item.label}
                          onSelect={() => { void setFilterStatus(item.value); setFilterOpen(false); }}
                          className="flex items-center gap-2 text-xs"
                        >
                          <Check className={cn('h-3.5 w-3.5 flex-shrink-0', filterStatus === item.value ? 'opacity-100' : 'opacity-0')} />
                          {item.dot && <span className={cn('w-1.5 h-1.5 rounded-full flex-shrink-0', item.dot)} />}
                          {item.label}
                        </CommandItem>
                      ))}
                    </CommandGroup>
                    <CommandSeparator />
                    <CommandGroup heading={t('knowledge.documentType.filterByType', 'Document Type')}>
                      {[
                        { value: 'type:journal_article', label: t('knowledge.documentType.journal_article', 'Journal Article') },
                        { value: 'type:book', label: t('knowledge.documentType.book', 'Book') },
                        { value: 'type:book_section', label: t('knowledge.documentType.book_section', 'Book Section') },
                        { value: 'type:conference_paper', label: t('knowledge.documentType.conference_paper', 'Conference Paper') },
                        { value: 'type:preprint', label: t('knowledge.documentType.preprint', 'Preprint') },
                        { value: 'type:thesis', label: t('knowledge.documentType.thesis', 'Thesis') },
                        { value: 'type:report', label: t('knowledge.documentType.report', 'Report') },
                        { value: 'type:no_type', label: t('knowledge.documentType.noType', 'No type assigned') },
                      ].map(item => (
                        <CommandItem
                          key={item.value}
                          value={item.label}
                          onSelect={() => { void setFilterStatus(item.value); setFilterOpen(false); }}
                          className="flex items-center gap-2 text-xs"
                        >
                          <Check className={cn('h-3.5 w-3.5 flex-shrink-0', filterStatus === item.value ? 'opacity-100' : 'opacity-0')} />
                          {item.label}
                        </CommandItem>
                      ))}
                    </CommandGroup>
                    {smartCollections.length > 0 && (
                      <>
                        <CommandSeparator />
                        <CommandGroup heading={t('knowledge.stacks.savedSearches', 'Smart Collections')}>
                          {smartCollections.map(ss => (
                            <CommandItem
                              key={ss.id}
                              value={ss.name}
                              onSelect={() => { void setFilterStatus(`smart:${ss.id}`); setFilterOpen(false); }}
                              className="flex items-center gap-2 text-xs"
                            >
                              <Check className={cn('h-3.5 w-3.5 flex-shrink-0', filterStatus === `smart:${ss.id}` ? 'opacity-100' : 'opacity-0')} />
                              {ss.color && <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: ss.color }} />}
                              {ss.name}
                            </CommandItem>
                          ))}
                        </CommandGroup>
                      </>
                    )}
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>

            {/* Clear Filters — when initialCollection is locked, only reset search and status */}
            {/* Tag Cloud Filter */}
            <Popover open={tagFilterOpen} onOpenChange={async (open) => {
              setTagFilterOpen(open);
              if (open && tagList.length === 0) {
                try {
                  const { listTags } = await import('@/lib/api-tags');
                  const tags = await listTags(currentWorkspace?.id || '');
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- listTags returns unknown shape; mapped to local TagItem type
                  setTagList(tags.map((t: any) => ({ id: t.id, name: t.name, color: t.color, doc_count: t.doc_count || 0, tag_type: t.tag_type || 0 })));
                } catch { /* ignore */ }
              }
            }}>
              <PopoverTrigger asChild>
                <button
                  data-testid="library-tag-filter-button"
                  className={cn(
                    'h-8 px-2 flex items-center gap-1.5 whitespace-nowrap border transition-colors',
                    selectedTags.size > 0
                      ? 'bg-accent/10 border-accent/30 text-accent-foreground'
                      : 'border-border hover:bg-accent/5',
                    isMobile ? 'text-xs' : 'text-sm',
                  )}
                >
                  <Tag className={cn(isMobile ? 'h-3 w-3' : 'h-4 w-4')} />
                  {selectedTags.size > 0 ? `Tags (${selectedTags.size})` : t('knowledge.library.tags', 'Tags')}
                </button>
              </PopoverTrigger>
              <PopoverContent className="w-[220px] p-2 z-[9999]" align="start">
                <div className="text-xs font-medium mb-2">{t('knowledge.library.filterByTag', 'Filter by tag')}</div>
                <div className="max-h-[200px] overflow-y-auto space-y-1">
                  {tagList.length === 0 ? (
                    <p className="text-xs text-muted-foreground py-2 text-center">No tags</p>
                  ) : tagList.map(tag => (
                    <button
                      key={tag.id}
                      onClick={() => {
                        setSelectedTags(prev => {
                          const next = new Set(prev);
                          if (next.has(tag.id)) next.delete(tag.id); else next.add(tag.id);
                          return next;
                        });
                      }}
                      className={cn(
                        'w-full flex items-center gap-2 px-2 py-1 text-xs hover:bg-accent/10 transition-colors',
                        selectedTags.has(tag.id) && 'bg-accent/10',
                        tag.tag_type === 1 && 'italic text-muted-foreground'
                      )}
                    >
                      <Check className={cn('h-3 w-3 flex-shrink-0', selectedTags.has(tag.id) ? 'opacity-100' : 'opacity-0')} />
                      {tag.color && <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: tag.color }} />}
                      <span className="truncate flex-1 text-left">{tag.name}</span>
                      <span className="text-[10px] text-muted-foreground">{tag.doc_count}</span>
                    </button>
                  ))}
                </div>
                {selectedTags.size > 0 && (
                  <button
                    onClick={() => setSelectedTags(new Set())}
                    className="w-full mt-2 pt-2 border-t border-border text-xs text-destructive hover:text-destructive/80"
                  >
                    Clear tag filter
                  </button>
                )}
              </PopoverContent>
            </Popover>

            {(searchQuery || (!initialCollection && selectedCollection !== 'all') || filterStatus !== 'completed' || selectedTags.size > 0) && (
              <button
                data-testid="library-clear-filters-button"
                onClick={() => {
                  setSearchQuery('');
                  if (!initialCollection) setSelectedCollection('all');
                  void setFilterStatus('completed');
                  setSelectedTags(new Set());
                }}
                className={cn(
                  'h-8 px-2 flex items-center gap-1.5 whitespace-nowrap',
                  'bg-destructive/5 hover:bg-destructive/10',
                  'border border-destructive/10 hover:border-destructive/20',
                  'text-destructive',
                  isMobile ? 'text-xs' : 'text-sm',
                  'transition-all duration-300 ease-out',
                )}
              >
                <RotateCcw className={cn(isMobile ? 'h-3 w-3' : 'h-4 w-4')} />
                {isMobile ? t('knowledge.library.clear', 'Clear') : t('knowledge.library.clearFilters', 'Clear filters')}
              </button>
            )}

            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  data-testid="library-refresh-button"
                  onClick={() => void handleRefresh()}
                  disabled={isRefreshing}
                  aria-label={t('knowledge.library.refresh', 'Refresh')}
                  className={cn(
                    'h-8 px-2 flex items-center gap-1.5 whitespace-nowrap',
                    'bg-muted/50 hover:bg-muted',
                    'border border-border/50 hover:border-border',
                    'text-muted-foreground hover:text-foreground',
                    isMobile ? 'text-xs' : 'text-sm',
                    'transition-all duration-200',
                    isRefreshing && 'opacity-60 cursor-not-allowed',
                  )}
                >
                  <RefreshCw className={cn(isMobile ? 'h-3 w-3' : 'h-4 w-4', isRefreshing && 'animate-spin')} />
                  {!isMobile && t('knowledge.library.refresh', 'Refresh')}
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">{t('knowledge.library.refresh', 'Refresh')}</TooltipContent>
            </Tooltip>

            {/* Spacer to push sort to the right */}
            <div className='flex-1' />

            {/* Sort dropdown */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button data-testid="library-sort-button" className={cn(
                  'h-8 px-2 flex items-center gap-1.5 whitespace-nowrap',
                  'bg-muted/50 hover:bg-muted',
                  'border border-border/50 hover:border-border',
                  'text-muted-foreground hover:text-foreground',
                  isMobile ? 'text-xs' : 'text-sm',
                  'transition-all duration-200',
                )}>
                  {sortDirection === 'asc' ? <ArrowUp className='h-3 w-3' /> : <ArrowDown className='h-3 w-3' />}
                  {!isMobile && (
                    sortBy === 'date' ? t('knowledge.library.sortDate', 'Date')
                    : sortBy === 'title' ? t('knowledge.library.sortTitle', 'Title')
                    : sortBy === 'year' ? t('knowledge.library.sortYear', 'Year')
                    : sortBy === 'author' ? t('knowledge.library.sortAuthor', 'Author')
                    : sortBy === 'collection' ? t('knowledge.library.sortCollection', 'Collection')
                    : sortBy === 'status' ? t('knowledge.library.sortStatus', 'Status')
                    : sortBy === 'centrality' ? t('knowledge.library.sortCentrality', 'Centrality')
                    : t('knowledge.library.sortSize', 'Size')
                  )}
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align='end' className='z-[9999] w-44'>
                {(['date', 'title', 'year', 'author', 'collection', 'status', 'size', 'centrality'] as const).map((field) => (
                  <DropdownMenuItem
                    key={field}
                    onClick={() => {
                      if (sortBy === field) {
                        setSortDirection(d => d === 'asc' ? 'desc' : 'asc');
                      } else {
                        setSortBy(field);
                        setSortDirection(field === 'title' || field === 'collection' || field === 'status' || field === 'author' ? 'asc' : 'desc');
                      }
                      setDisplayedCount(50);
                    }}
                    className={cn('text-sm flex items-center justify-between', sortBy === field && 'font-medium')}
                  >
                    <span>
                      {field === 'date' ? t('knowledge.library.sortDate', 'Date')
                        : field === 'title' ? t('knowledge.library.sortTitle', 'Title')
                        : field === 'year' ? t('knowledge.library.sortYear', 'Year')
                        : field === 'author' ? t('knowledge.library.sortAuthor', 'Author')
                        : field === 'collection' ? t('knowledge.library.sortCollection', 'Collection')
                        : field === 'status' ? t('knowledge.library.sortStatus', 'Status')
                        : field === 'centrality' ? t('knowledge.library.sortCentrality', 'Centrality')
                        : t('knowledge.library.sortSize', 'Size')}
                    </span>
                    {sortBy === field && (
                      sortDirection === 'asc' ? <ArrowUp className='h-3 w-3' /> : <ArrowDown className='h-3 w-3' />
                    )}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          {/* Collection Stats Panel — visible when a specific collection is selected */}
          {selectedCollection && selectedCollection !== 'all' && (
            <div className='mt-2'>
              <button
                data-testid="library-collection-stats-toggle"
                onClick={() => setStatsExpanded(!statsExpanded)}
                className={cn(
                  'flex items-center gap-1.5 w-full text-left',
                  'px-2 py-1 text-xs text-muted-foreground hover:text-foreground',
                  'hover:bg-muted/50 transition-colors',
                )}
              >
                <Database className='h-3 w-3' />
                <span className='font-medium'>{t('knowledge.library.collectionStats', 'Collection stats')}</span>
                {statsLoading ? (
                  <Loader2 className='h-3 w-3 animate-spin ml-auto' />
                ) : (
                  statsExpanded ? <ChevronUp className='h-3 w-3 ml-auto' /> : <ChevronDown className='h-3 w-3 ml-auto' />
                )}
              </button>
              {statsExpanded && collectionStats && (
                <div className={cn(
                  'border border-border bg-muted/30',
                  isMobile ? 'p-2 mt-1' : 'p-3 mt-1',
                )}>
                  <div className={cn(
                    'grid gap-2',
                    isMobile ? 'grid-cols-2' : 'grid-cols-4',
                  )}>
                    {/* Documents */}
                    <div className='space-y-0.5'>
                      <div className='flex items-center gap-1.5'>
                        <HardDrive className='h-3 w-3 text-muted-foreground' />
                        <span className='text-[10px] font-medium text-muted-foreground uppercase tracking-wider'>
                          {t('knowledge.library.statsDocuments', 'Documents')}
                        </span>
                      </div>
                      <p className='text-sm font-semibold text-foreground'>{collectionStats.total_documents}</p>
                      <p className='text-[10px] text-muted-foreground'>
                        {collectionStats.docs_stored_on_disk > 0
                          ? t('knowledge.library.statsOnDisk', '{{count}} on disk', { count: collectionStats.docs_stored_on_disk })
                          : t('knowledge.library.statsAllMemoryOnly', 'All memory-only')
                        }
                      </p>
                    </div>
                    {/* Embeddings */}
                    <div className='space-y-0.5'>
                      <div className='flex items-center gap-1.5'>
                        <Database className='h-3 w-3 text-muted-foreground' />
                        <span className='text-[10px] font-medium text-muted-foreground uppercase tracking-wider'>
                          {t('knowledge.library.statsEmbeddings', 'Embeddings')}
                        </span>
                      </div>
                      <p className='text-sm font-semibold text-foreground'>
                        {collectionStats.docs_with_embeddings}/{collectionStats.total_documents}
                      </p>
                      <p className='text-[10px] text-muted-foreground'>
                        {collectionStats.total_embedding_chunks.toLocaleString()} {t('knowledge.library.statsChunks', 'chunks')}
                      </p>
                    </div>
                    {/* Graph */}
                    <div className='space-y-0.5'>
                      <div className='flex items-center gap-1.5'>
                        <GitBranch className='h-3 w-3 text-muted-foreground' />
                        <span className='text-[10px] font-medium text-muted-foreground uppercase tracking-wider'>
                          {t('knowledge.library.statsGraph', 'Knowledge Graph')}
                        </span>
                      </div>
                      <p className='text-sm font-semibold text-foreground'>
                        {collectionStats.graph_completed}/{collectionStats.total_documents}
                      </p>
                      <div className='flex flex-wrap gap-x-2 gap-y-0.5'>
                        {collectionStats.graph_entity_running > 0 && (
                          <span className='text-[10px] text-orange-600 dark:text-orange-400'>
                            {collectionStats.graph_entity_running} {t('knowledge.library.statsRunning', 'running')}
                          </span>
                        )}
                        {collectionStats.graph_hierarchy_done > 0 && (
                          <span className='text-[10px] text-yellow-600 dark:text-yellow-400'>
                            {collectionStats.graph_hierarchy_done} {t('knowledge.library.statsHierarchy', 'hierarchy')}
                          </span>
                        )}
                        {collectionStats.graph_failed > 0 && (
                          <span className='text-[10px] text-red-600 dark:text-red-400'>
                            {collectionStats.graph_failed} {t('knowledge.library.statsFailed', 'failed')}
                          </span>
                        )}
                        {collectionStats.graph_pending > 0 && (
                          <span className='text-[10px] text-muted-foreground'>
                            {collectionStats.graph_pending} {t('knowledge.library.statsPending', 'pending')}
                          </span>
                        )}
                      </div>
                    </div>
                    {/* Summaries */}
                    <div className='space-y-0.5'>
                      <div className='flex items-center gap-1.5'>
                        <FileSearch className='h-3 w-3 text-muted-foreground' />
                        <span className='text-[10px] font-medium text-muted-foreground uppercase tracking-wider'>
                          {t('knowledge.library.statsSummaries', 'Summaries')}
                        </span>
                      </div>
                      <p className='text-sm font-semibold text-foreground'>
                        {collectionStats.docs_with_summaries}/{collectionStats.total_documents}
                      </p>
                      <p className='text-[10px] text-muted-foreground'>
                        {collectionStats.total_summary_records} {t('knowledge.library.statsRecords', 'records')}
                      </p>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Document Grid */}
        <div className={cn(isMobile ? 'p-2' : 'p-4')}>
          {filteredDocuments.length === 0 ? (
          <div className='flex flex-col items-center justify-center h-96 text-zinc-500 dark:text-zinc-400'>
            <FileStack className={cn(isMobile ? 'h-12 w-12' : 'h-16 w-16', 'mb-4 text-zinc-300 dark:text-zinc-600')} />
            <p className='text-sm'>
              {searchQuery
                ? t('knowledge.library.noResults', 'No documents found')
                : t('knowledge.library.noDocuments', 'No documents in your library yet')
              }
            </p>
            <p className='text-xs text-zinc-400 dark:text-zinc-500 mt-1'>
              {searchQuery
                ? t('knowledge.library.tryDifferentSearch', 'Try a different search term')
                : t('knowledge.library.uploadToStart', 'Upload documents to the Upload tab to get started')
              }
            </p>
          </div>
        ) : (
          <>
            <div data-testid='library-document-grid' className={cn(
              'grid',
              isMobile
                ? 'grid-cols-2 gap-2'
                : 'grid-cols-4 lg:grid-cols-8 gap-3'
            )}>
              {displayedDocuments.map((doc) => {
                // Check both cover_url (EPUB books) AND backend-generated thumbnails
                const hasCover = !!doc.file_metadata?.cover_url;
                const hasBackendThumbnail = doc.file_metadata?.thumbnail?.has_thumbnail === true
                  || doc.thumbnail?.has_thumbnail === true;
                const hasThumbnail = hasCover || hasBackendThumbnail;

                // Readiness status as a single coloured icon, rendered as an
                // overlay on the cover's bottom-left corner. Full phrase shows
                // on hover via tooltip. Desktop: visible on card hover only;
                // mobile: always visible (no hover affordance).
                const statusInfo = (() => {
                  const ps = doc.processing_status;
                  const gs = doc.graph_status;
                  let phrase = '';
                  let phraseClass = 'text-zinc-300';
                  let StatusIcon = CircleDashed;
                  let spin = false;
                  if (ps === 'failed') {
                    phrase = t('knowledge.library.phraseFailed', 'Failed');
                    phraseClass = 'text-red-400';
                    StatusIcon = AlertTriangle;
                  } else if (ps === 'processing') {
                    phrase = t('knowledge.library.phraseIndexing', 'Indexing text…');
                    phraseClass = 'text-orange-400';
                    StatusIcon = Loader2;
                    spin = true;
                  } else if (ps === 'pending') {
                    const willBuildGraph = !!gs && gs !== 'completed' && gs !== 'failed' && gs !== 'not_requested';
                    phrase = willBuildGraph
                      ? t('knowledge.library.phrasePendingVectorGraph', 'Waiting: vector + graph embedding…')
                      : t('knowledge.library.phrasePendingVector', 'Waiting: vector embedding…');
                    phraseClass = 'text-yellow-400';
                    StatusIcon = Clock;
                  } else if (ps === 'completed') {
                    // Graph build is OPTIONAL post-processing. The primary phrase
                    // reflects the document's own readiness; we don't surface a
                    // bookkeeping "graph failed" as the headline status.
                    if (gs === 'entity_running' || gs === 'pending' || gs === 'hierarchy_done') {
                      phrase = t('knowledge.library.phraseGraphBuilding', 'Building graph…');
                      phraseClass = 'text-orange-400';
                      StatusIcon = Loader2;
                      spin = true;
                    } else if (gs === 'completed') {
                      phrase = doc.has_summary
                        ? t('knowledge.library.phraseReady', 'Ready')
                        : t('knowledge.library.phraseReadyNoSummary', 'Indexed · no summary');
                      phraseClass = doc.has_summary ? 'text-green-400' : 'text-zinc-300';
                      StatusIcon = CircleCheck;
                    } else {
                      phrase = t('knowledge.library.phraseIndexed', 'Indexed');
                      phraseClass = 'text-zinc-300';
                      StatusIcon = CircleCheck;
                    }
                  }
                  return phrase ? { phrase, phraseClass, StatusIcon, spin } : null;
                })();

                return (
                <div
                  key={doc.id}
                  data-testid={`library-document-item-${doc.id}`}
                  draggable={!readOnly && !isMobile}
                  onDragStart={(e) => handleDragStart(e, doc.id)}
                  onDragEnd={handleDragEnd}
                  onTouchStart={(e) => handleTouchStartLongPress(e, doc.id)}
                  onTouchMove={handleTouchMoveLongPress}
                  onTouchEnd={cancelLongPress}
                  onTouchCancel={cancelLongPress}
                  onClick={() => {
                    if (longPressTriggeredRef.current) {
                      longPressTriggeredRef.current = false;
                      return;
                    }
                    // Catches taps on areas that don't have their own preview handler
                    // (non-PDF/EPUB/DOCX thumbnails, title row). Previewable thumbnails
                    // call e.stopPropagation() so this stays a no-op for them.
                    if (isMobile && hasSelection && !readOnly) {
                      toggleDocSelection(doc.id);
                    }
                  }}
                  className={cn(
                    'flex flex-col relative group/card',
                    isMobile ? 'gap-1' : 'gap-2',
                    selectedDocIds.has(doc.id) && 'ring-2 ring-primary ring-offset-1',
                    draggedDocId === doc.id && 'opacity-50',
                    !readOnly && !isMobile && 'cursor-grab active:cursor-grabbing',
                  )}
                >
                  {/* Selection checkbox — desktop: hover or when selection active.
                      Mobile: only while in selection mode (hasSelection); long-press to enter. */}
                  {!readOnly && hasSelection && (
                    <button
                      className={cn(
                        'absolute top-1 left-1 z-[1]',
                        'bg-black/60 hover:bg-black/80 text-white p-0.5',
                      )}
                      onClick={(e) => { e.stopPropagation(); toggleDocSelection(doc.id); }}
                      onMouseDown={(e) => e.preventDefault()}
                    >
                      {selectedDocIds.has(doc.id)
                        ? <CheckSquare className={isMobile ? 'h-3.5 w-3.5' : 'h-4 w-4'} />
                        : <Square className={isMobile ? 'h-3.5 w-3.5' : 'h-4 w-4'} />
                      }
                    </button>
                  )}
                  {!readOnly && !hasSelection && !isMobile && (
                    <button
                      className={cn(
                        'absolute top-1 left-1 z-[1]',
                        'bg-black/60 hover:bg-black/80 text-white p-0.5',
                        'opacity-0 transition-opacity group-hover/card:opacity-100',
                      )}
                      onClick={(e) => { e.stopPropagation(); toggleDocSelection(doc.id); }}
                      onMouseDown={(e) => e.preventDefault()}
                    >
                      <Square className='h-4 w-4' />
                    </button>
                  )}

                  {/* 3-dot menu — desktop: hover, mobile: always visible */}
                  <div className={cn(
                    'absolute top-1 right-1 z-[1] transition-opacity',
                    isMobile ? 'opacity-100' : 'opacity-0 group-hover/card:opacity-100'
                  )}>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button
                          className={cn(
                            'bg-black/60 hover:bg-black/80 text-white',
                            'transition-colors cursor-pointer',
                            isMobile ? 'p-0.5' : 'p-1'
                          )}
                          onClick={(e) => e.stopPropagation()}
                        >
                          <MoreVertical className={isMobile ? 'h-3.5 w-3.5' : 'h-4 w-4'} />
                        </button>
                      </DropdownMenuTrigger>
                        <DropdownMenuContent align='end' className='w-48 z-[9999]'>
                          <DropdownMenuSub>
                            <DropdownMenuSubTrigger className='flex items-center gap-2'>
                              <Download className='h-4 w-4' />
                              {t('knowledge.library.download', 'Download')}
                            </DropdownMenuSubTrigger>
                            <DropdownMenuSubContent className='w-56 z-[9999]'>
                              {/* Save to computer — direct browser download if file on server, otherwise external sources */}
                              <DropdownMenuItem
                                className='flex items-center gap-2'
                                onClick={() => {
                                  if (doc.file_stored !== false) {
                                    void handleDownloadToComputer(doc);
                                  } else {
                                    setRedownloadDoc(doc);
                                  }
                                }}
                              >
                                <Monitor className='h-4 w-4' />
                                {t('knowledge.library.downloadToComputer', 'Save to computer')}
                              </DropdownMenuItem>
                              {/* Save to server disk — if not already stored, download from external sources */}
                              {!readOnly && (
                                <DropdownMenuItem
                                  className='flex items-center gap-2'
                                  disabled={doc.file_stored !== false}
                                  onClick={() => {
                                    if (doc.file_stored === false) {
                                      setRedownloadDoc(doc);
                                    }
                                  }}
                                >
                                  <Server className='h-4 w-4' />
                                  {doc.file_stored !== false
                                    ? t('knowledge.library.alreadyOnServer', 'Already on server')
                                    : t('knowledge.library.downloadToServer', 'Save to server')}
                                </DropdownMenuItem>
                              )}
                              {!readOnly && (
                                <DropdownMenuItem
                                  className='flex items-center gap-2'
                                  onClick={() => handleDownloadCover(doc.id)}
                                >
                                  <HardDrive className='h-4 w-4' />
                                  {doc.thumbnail?.cover_downloaded === true
                                    ? t('knowledge.thumbnail.tryDifferentCover', 'Try a different cover')
                                    : t('knowledge.library.downloadCover', 'Download cover')}
                                </DropdownMenuItem>
                              )}
                              {!readOnly && (doc.thumbnail?.has_custom === true || doc.thumbnail?.cover_downloaded === true) && (
                                <DropdownMenuItem
                                  className='flex items-center gap-2'
                                  onClick={() => handleRemoveCover(doc.id)}
                                >
                                  <Trash2 className='h-4 w-4' />
                                  {t('knowledge.thumbnail.removeCover', 'Remove cover')}
                                </DropdownMenuItem>
                              )}
                            </DropdownMenuSubContent>
                          </DropdownMenuSub>
                          {/* ── Copy submenu ── */}
                          <DropdownMenuSub>
                            <DropdownMenuSubTrigger className='flex items-center gap-2'>
                              <Copy className='h-4 w-4' />
                              {t('knowledge.library.copy', 'Copy')}
                            </DropdownMenuSubTrigger>
                            <DropdownMenuSubContent className='w-48 z-[9999]'>
                              <DropdownMenuItem
                                onClick={() => handleCopyFilename(doc.filename)}
                                className='flex items-center gap-2'
                              >
                                <Copy className='h-4 w-4' />
                                {t('knowledge.library.copyFilename', 'Copy filename')}
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              {doc.extracted_metadata?.resolved?.title ? (
                                <>
                                  <DropdownMenuLabel className='text-[10px] text-muted-foreground px-2 py-1'>
                                    {t('knowledge.library.copyCitation', 'Copy Citation')}
                                  </DropdownMenuLabel>
                                  {CITATION_STYLES.map(style => (
                                    <DropdownMenuItem
                                      key={style.id}
                                      onClick={() => handleCopyCitation(doc, style.id)}
                                      className='flex items-center gap-2 text-xs'
                                    >
                                      {style.name}
                                    </DropdownMenuItem>
                                  ))}
                                  <DropdownMenuSeparator />
                                  <DropdownMenuItem
                                    onClick={() => handleExportCitations([doc])}
                                    className='flex items-center gap-2'
                                  >
                                    <Download className='h-4 w-4' />
                                    {t('knowledge.library.exportCitation', 'Export citation')}
                                  </DropdownMenuItem>
                                </>
                              ) : (
                                <DropdownMenuItem
                                  disabled
                                  className='flex items-center gap-2 text-xs opacity-50'
                                >
                                  <BookOpen className='h-4 w-4' />
                                  {t('knowledge.library.copyCitationNoMeta', 'Citation (run Lookup metadata first)')}
                                </DropdownMenuItem>
                              )}
                            </DropdownMenuSubContent>
                          </DropdownMenuSub>
                          {/* ── Summary ── label reflects state (no lampice) */}
                          <DropdownMenuItem
                            onClick={() => handleSummary(doc.id)}
                            className='flex items-center gap-2'
                          >
                            <BookOpen className='h-4 w-4' />
                            {doc.has_summary
                              ? t('knowledge.library.summary', 'Summary')
                              : t('knowledge.library.createSummary', 'Create summary')}
                          </DropdownMenuItem>
                          {/* ── Manage tags (top-level to avoid 3-deep nesting) ── */}
                          {!readOnly && currentWorkspace?.id && (
                            <TagInlineSubmenu
                              documentId={doc.id}
                              workspaceId={currentWorkspace.id}
                              onTagsChanged={async () => {
                                try {
                                  const updatedTags = await getDocumentTags(doc.id);
                                  setDocuments(prev => prev.map(d =>
                                    d.id === doc.id
                                      ? { ...d, tags: updatedTags.map(t => ({ name: t.name, color: t.color })) }
                                      : d
                                  ));
                                } catch (err) {
                                  console.error('Failed to refresh document tags:', err);
                                }
                              }}
                            />
                          )}
                          {/* ── Manage submenu — relations, collection, processing, metadata, duplicates ── */}
                          {!readOnly && currentWorkspace?.id && (
                            <DropdownMenuSub>
                              <DropdownMenuSubTrigger className='flex items-center gap-2'>
                                <Settings2 className='h-4 w-4' />
                                {t('knowledge.library.manage', 'Manage')}
                              </DropdownMenuSubTrigger>
                              <DropdownMenuSubContent className='w-52 z-[9999]'>
                                <DropdownMenuItem
                                  className='flex items-center gap-2'
                                  onClick={() => setRelationDoc({ id: doc.id, title: doc.title || doc.filename })}
                                >
                                  <Link2 className='h-4 w-4' />
                                  {t('knowledge.library.manageRelations', 'Relations')}
                                </DropdownMenuItem>
                                {collections.length > 1 && (
                                  <DropdownMenuItem
                                    className='flex items-center gap-2'
                                    onClick={() => setCollectionManageDoc(doc)}
                                  >
                                    <FolderInput className='h-4 w-4' />
                                    {t('knowledge.library.manageCollection', 'Collection')}
                                  </DropdownMenuItem>
                                )}
                                <DropdownMenuSeparator />
                                {/* Graph — always visible. Label and disabled
                                    state surface the lifecycle that the old
                                    coloured dots used to encode. */}
                                {(() => {
                                  const gs = doc.graph_status;
                                  const isBuilding = gs === 'entity_running' || gs === 'pending';
                                  const isBuilt = gs === 'completed';
                                  const label = isBuilding
                                    ? t('knowledge.library.graphBuilding', 'Building graph…')
                                    : isBuilt
                                      ? t('knowledge.library.refreshGraph', 'Refresh graph')
                                      : t('knowledge.library.buildGraph', 'Build graph');
                                  return (
                                    <DropdownMenuItem
                                      disabled={isBuilding || doc.processing_status !== 'completed'}
                                      onClick={async () => {
                                        const ok = await buildDocumentGraph(doc.id, doc.collection_id);
                                        toast[ok ? 'success' : 'error'](t(`knowledge.library.${ok ? 'actionDispatched' : 'actionFailed'}`));
                                        if (!ok) return;
                                        // Optimistic: flip the label to "Graf u izgradnji…" immediately,
                                        // then poll on a back-off (15s, 30s, 60s, 90s, 2 min, 3 min, 5 min)
                                        // so the menu reflects completion without a manual refresh.
                                        setDocuments(prev => prev.map(d =>
                                          d.id === doc.id ? { ...d, graph_status: 'pending' } : d
                                        ));
                                        pollDocumentStatus(
                                          doc.id,
                                          (u) => {
                                            const g = (u as { graph_status?: string }).graph_status;
                                            return g === 'completed' || g === 'failed';
                                          },
                                          [15000, 30000, 60000, 90000, 120000, 180000, 300000],
                                        );
                                        if (selectedCollection && selectedCollection !== 'all') {
                                          getCollectionStats(selectedCollection).then(s => setCollectionStats(s));
                                        }
                                      }}
                                      className='flex items-center gap-2'
                                    >
                                      <GitBranch className='h-4 w-4' />
                                      {label}
                                    </DropdownMenuItem>
                                  );
                                })()}
                                {/* Embeddings — always visible. "Izradi" when
                                    the document hasn't been indexed yet,
                                    "Ponovi" when it has, "Ugradnja u tijeku…"
                                    while the background job is running. */}
                                <DropdownMenuItem
                                  disabled={doc.processing_status === 'processing'}
                                  onClick={async () => {
                                    const ok = await rebuildDocumentEmbeddings(doc.id, doc.collection_id);
                                    toast[ok ? 'success' : 'error'](t(`knowledge.library.${ok ? 'actionDispatched' : 'actionFailed'}`));
                                    if (!ok) return;
                                    setDocuments(prev => prev.map(d =>
                                      d.id === doc.id ? { ...d, processing_status: 'processing' } : d
                                    ));
                                    pollDocumentStatus(
                                      doc.id,
                                      (u) => {
                                        const p = (u as { processing_status?: string }).processing_status;
                                        return p === 'completed' || p === 'failed';
                                      },
                                      [10000, 20000, 30000, 60000, 90000, 120000, 180000],
                                    );
                                  }}
                                  className='flex items-center gap-2'
                                >
                                  <Database className='h-4 w-4' />
                                  {doc.processing_status === 'processing'
                                    ? t('knowledge.library.embeddingsRunning', 'Embedding in progress…')
                                    : doc.processing_status === 'completed'
                                      ? t('knowledge.library.rebuildEmbeddings', 'Rebuild embeddings')
                                      : t('knowledge.library.createEmbeddings', 'Build embeddings')}
                                </DropdownMenuItem>
                                {doc.processing_status === 'completed' && (
                                  <>
                                    <DropdownMenuItem
                                      onClick={() => handleEnrichMetadata(doc.id)}
                                      disabled={enrichingDocId === doc.id}
                                      className='flex items-center gap-2'
                                    >
                                      {enrichingDocId === doc.id
                                        ? <Loader2 className='h-4 w-4 animate-spin' />
                                        : <FileSearch className='h-4 w-4' />
                                      }
                                      {t('knowledge.library.lookupMetadata', 'Lookup metadata')}
                                    </DropdownMenuItem>
                                    {/* Find open-access PDF */}
                                    <DropdownMenuItem
                                      className='flex items-center gap-2'
                                      onClick={async () => {
                                        try {
                                          const result = await findOpenAccessPdf(doc.id);
                                          if (result.success && result.pdf_url) {
                                            window.open(result.pdf_url, '_blank');
                                            toast.success(t('knowledge.unpaywall.found', 'Open access PDF found'));
                                          } else {
                                            toast.info(result.message || t('knowledge.unpaywall.notFound', 'No open access version available'));
                                          }
                                        } catch { toast.error(t('knowledge.document.unpaywallFailed')); }
                                      }}
                                    >
                                      <Search className='h-4 w-4' />
                                      {t('knowledge.unpaywall.findPdf', 'Find open-access PDF')}
                                    </DropdownMenuItem>
                                    {/* Extract PDF annotations */}
                                    {doc.filename?.toLowerCase().endsWith('.pdf') && (
                                      <DropdownMenuItem
                                        className='flex items-center gap-2'
                                        onClick={async () => {
                                          try {
                                            const result = await extractPdfAnnotations(doc.id);
                                            if (result.success && result.annotations.length > 0) {
                                              toast.success(t('knowledge.annotations.extracted', { count: result.annotations.length, defaultValue: `Extracted ${result.annotations.length} annotations` }));
                                            } else {
                                              toast.info(result.message || t('knowledge.annotations.noneFound', 'No annotations found in PDF'));
                                            }
                                          } catch { toast.error(t('knowledge.document.annotationExtractionFailed')); }
                                        }}
                                      >
                                        <FileSearch className='h-4 w-4' />
                                        {t('knowledge.annotations.extractFromPdf', 'Extract PDF annotations')}
                                      </DropdownMenuItem>
                                    )}
                                  </>
                                )}
                                {typeof doc.duplicate_count === 'number' && doc.duplicate_count > 0 && (
                                  <>
                                    <DropdownMenuSeparator />
                                    <DropdownMenuItem
                                      className='flex items-center gap-2'
                                      onClick={() => setDuplicateReviewDoc({ id: doc.id, title: doc.title || doc.filename })}
                                    >
                                      <AlertTriangle className='h-4 w-4 text-orange-500' />
                                      {t('knowledge.library.reviewDuplicates', 'Review duplicates')}
                                    </DropdownMenuItem>
                                  </>
                                )}
                              </DropdownMenuSubContent>
                            </DropdownMenuSub>
                          )}
                          {!readOnly && (
                          <>
                          <DropdownMenuSeparator />
                          <DropdownMenuSub>
                            <DropdownMenuSubTrigger className='flex items-center gap-2 text-red-600 dark:text-red-400'>
                              <Trash2 className='h-4 w-4' />
                              {t('knowledge.library.deleteDocument', 'Delete')}
                            </DropdownMenuSubTrigger>
                            <DropdownMenuSubContent className='w-52 z-[9999]'>
                              <DropdownMenuItem
                                onClick={() => setDeleteConfirmDocId(doc.id)}
                                className='flex items-center gap-2 text-red-600 dark:text-red-400 focus:text-red-600 dark:focus:text-red-400'
                              >
                                <Trash2 className='h-4 w-4' />
                                {t('knowledge.library.deleteAll', 'Delete all')}
                              </DropdownMenuItem>
                              {doc.processing_status === 'completed' && (
                                <DropdownMenuItem
                                  className='flex items-center gap-2'
                                  onClick={() => handlePartialDelete(doc.id, 'embeddings')}
                                >
                                  <Database className='h-4 w-4' />
                                  {t('knowledge.library.deleteEmbeddings', 'Delete embeddings')}
                                </DropdownMenuItem>
                              )}
                              {doc.graph_status && doc.graph_status !== 'pending' && (
                                <DropdownMenuItem
                                  className='flex items-center gap-2'
                                  onClick={() => handlePartialDelete(doc.id, 'graph')}
                                >
                                  <GitBranch className='h-4 w-4' />
                                  {t('knowledge.library.deleteGraph', 'Delete graph')}
                                </DropdownMenuItem>
                              )}
                              {doc.file_stored !== false && (
                                <DropdownMenuItem
                                  className='flex items-center gap-2'
                                  onClick={() => handlePartialDelete(doc.id, 'file')}
                                >
                                  <HardDrive className='h-4 w-4' />
                                  {t('knowledge.library.deleteFile', 'Delete file')}
                                </DropdownMenuItem>
                              )}
                            </DropdownMenuSubContent>
                          </DropdownMenuSub>
                          </>
                          )}
                          <DropdownMenuSub>
                            <DropdownMenuSubTrigger className='flex items-center gap-2'>
                              <ArrowUpDown className='h-4 w-4' />
                              {t('knowledge.priority.label', 'Priority')}
                            </DropdownMenuSubTrigger>
                            <DropdownMenuSubContent className='z-[9999]'>
                              {[
                                { value: 2.0, label: t('knowledge.priority.high', 'High priority'), icon: <ArrowUp className='h-4 w-4' /> },
                                { value: 1.0, label: t('knowledge.priority.normal', 'Normal priority'), icon: <Check className='h-4 w-4' /> },
                                { value: 0.5, label: t('knowledge.priority.low', 'Low priority'), icon: <ArrowDown className='h-4 w-4' /> },
                              ].map(({ value, label, icon }) => (
                                <DropdownMenuItem
                                  key={value}
                                  className='flex items-center gap-2'
                                  onClick={async () => {
                                    try {
                                      await updateDocumentPriority(doc.id, value);
                                      toast.success(label);
                                    } catch { toast.error(t('knowledge.document.priorityUpdateFailed')); }
                                  }}
                                >
                                  {icon}
                                  {label}
                                </DropdownMenuItem>
                              ))}
                            </DropdownMenuSubContent>
                          </DropdownMenuSub>
                        </DropdownMenuContent>
                    </DropdownMenu>
                  </div>

                  {/* Thumbnail — clean, no corner overlays except type badge */}
                  <div className='relative'>
                  <DocumentThumbnail
                    documentId={doc.id}
                    filename={doc.filename}
                    hasThumbnail={hasThumbnail}
                    hasCustomThumbnail={doc.file_metadata?.thumbnail?.is_custom === true || doc.thumbnail?.has_custom === true}
                    coverDownloaded={doc.thumbnail?.cover_downloaded === true || doc.file_metadata?.thumbnail?.cover_downloaded === true}
                    refreshKey={thumbnailRefreshKey[doc.id] ?? 0}
                    coverUrl={doc.file_metadata?.cover_url}
                    documentType={doc.extracted_metadata?.resolved?.document_type}
                    onTypeChange={handleDocumentTypeChange}
                    onPreview={(doc.file_stored !== false || (isMobile && hasSelection)) ? () => {
                      // Long-press just toggled selection — swallow the synthetic click that follows touchend
                      if (longPressTriggeredRef.current) {
                        longPressTriggeredRef.current = false;
                        return;
                      }
                      // In mobile selection mode, tap toggles selection instead of opening the preview
                      if (isMobile && hasSelection) {
                        toggleDocSelection(doc.id);
                        return;
                      }
                      handlePreview(doc.id, doc.filename, doc.collection_id);
                    } : undefined}
                    title={doc.extracted_metadata?.resolved?.title || doc.title}
                    author={doc.extracted_metadata?.resolved?.authors?.[0] ?? doc.file_metadata?.author}
                    year={doc.extracted_metadata?.resolved?.year}
                  />
                  {/* Readiness status overlay — bottom-left corner of the cover,
                      sitting just above the format chip. Desktop: reveal on card
                      hover; mobile: always visible. */}
                  {statusInfo && (
                    <div className={cn(
                      'absolute bottom-1 left-1 z-[2] transition-opacity',
                      isMobile ? 'opacity-100' : 'opacity-0 group-hover/card:opacity-100'
                    )}>
                      <TooltipProvider delayDuration={150}>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span
                              className={cn(
                                'inline-flex items-center bg-black/70 p-0.5',
                                statusInfo.phraseClass,
                              )}
                              aria-label={statusInfo.phrase}
                            >
                              <statusInfo.StatusIcon className={cn('h-3.5 w-3.5', statusInfo.spin && 'animate-spin')} />
                            </span>
                          </TooltipTrigger>
                          <TooltipContent side='top'>{statusInfo.phrase}</TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    </div>
                  )}
                  {/* Title overlay — desktop shows the title via the cover's
                      hover tooltip; on mobile there is no hover, so the
                      long-press (which also toggles selection) reveals the
                      title here over the cover. */}
                  {isMobile && titlePreviewId === doc.id && (
                    <div className='absolute inset-0 z-[3] flex items-end bg-gradient-to-t from-black/90 via-black/55 to-transparent p-2 pointer-events-none'>
                      <span className='text-white text-[11px] font-medium leading-tight line-clamp-5'>
                        {doc.title || doc.filename}
                      </span>
                    </div>
                  )}
                  </div>

                  {/* Document Info — the title is no longer printed under the
                      cover; it surfaces on desktop hover (cover tooltip) and on
                      mobile long-press (overlay above). */}
                  <div className='space-y-0.5 min-w-0'>
                    {doc.file_metadata?.author && (
                      <p className={cn(
                        'text-zinc-500 dark:text-zinc-400 line-clamp-1',
                        isMobile ? 'text-[9px]' : 'text-[10px]'
                      )}>
                        {doc.file_metadata.author}
                      </p>
                    )}

                    {/* per-user document rating.
                        Hidden on the mobile compact card to keep
                        density manageable; library view on desktop
                        has plenty of room. */}
                    {!isMobile && currentWorkspace?.id && doc.processing_status === 'completed' && (
                      <div className='pt-0.5'>
                        <StarRating
                          documentId={doc.id}
                          workspaceId={currentWorkspace.id}
                          value={ratingsByDoc[doc.id] ?? null}
                          onChange={(next) =>
                            setRatingsByDoc(prev => {
                              const copy = { ...prev };
                              if (next === null) delete copy[doc.id];
                              else copy[doc.id] = next;
                              return copy;
                            })
                          }
                          size='sm'
                        />
                      </div>
                    )}

                    {/* Status info lives in the 3-dot menu now — labels like
                        "Izradi graf / Osvježi graf", "Izradi sažetak", and
                        "Izradi/Ponovi ugradnju" replace the old coloured dots
                        which weren't legible on mobile (no hover tooltip). */}

                    {/* Academic metadata from auto-enrichment (DOI/journal/year) */}
                    {doc.extracted_metadata && (
                      <MetadataBadge
                        extractedMetadata={doc.extracted_metadata}
                        compact={isMobile}
                      />
                    )}

                    {/* Tags, relations, duplicates, multi-collection badges */}
                    {!isMobile && (doc.tags?.length || doc.relation_count || doc.duplicate_count || (doc.collection_count && doc.collection_count > 1)) ? (
                      <div className="flex flex-wrap items-center gap-1">
                        {doc.tags && doc.tags.length > 0 && (
                          <TagDots tags={doc.tags} maxVisible={4} />
                        )}
                        {typeof doc.relation_count === 'number' && doc.relation_count > 0 && (
                          <RelationBadge count={doc.relation_count} />
                        )}
                        {typeof doc.duplicate_count === 'number' && doc.duplicate_count > 0 && (
                          <DuplicateBadge duplicateCount={doc.duplicate_count} />
                        )}
                        {doc.collection_memberships && doc.collection_memberships.length > 1 && (
                          <CollectionBadge collections={doc.collection_memberships} />
                        )}
                      </div>
                    ) : null}

                    {!isMobile && doc.page_count && (
                      <p className='text-xs text-zinc-400 dark:text-zinc-500'>
                        {doc.page_count} {t('knowledge.library.pages', 'pages')}
                      </p>
                    )}

                    {/* Centrality bar. Only visible when user
                        actively sorts by Centrality, to keep the default
                        card view free of extra visual elements. */}
                    {!isMobile && sortBy === 'centrality' && maxPagerank > 0 && (
                      <TooltipProvider>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <div
                              data-testid={`library-centrality-bar-${doc.id}`}
                              className='h-[2px] w-full bg-muted overflow-hidden'
                              aria-label={t('knowledge.library.centralityTooltip', 'Centrality')}
                            >
                              {typeof doc.pagerank_score === 'number' && doc.pagerank_score > 0 ? (
                                <div
                                  className='h-full bg-primary/70'
                                  style={{ width: `${Math.min(100, (doc.pagerank_score / maxPagerank) * 100)}%` }}
                                />
                              ) : null}
                            </div>
                          </TooltipTrigger>
                          <TooltipContent side='top'>
                            <div className='text-[10px] space-y-0.5'>
                              {typeof doc.pagerank_score === 'number' ? (
                                <p>
                                  <span className='font-medium'>PageRank:</span>{' '}
                                  {doc.pagerank_score.toFixed(4)}
                                </p>
                              ) : (
                                <p className='text-muted-foreground italic'>
                                  {t('knowledge.library.centralityNotComputed', 'Centrality not yet computed — runs nightly')}
                                </p>
                              )}
                              <p className='text-muted-foreground'>
                                {t('knowledge.library.centralityTooltip', 'Graph centrality: how many key concepts this document shares with the rest of the collection')}
                              </p>
                            </div>
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    )}
                  </div>
                </div>
                );
              })}
            </div>

            {/* Infinite Scroll Trigger */}
            {hasMoreDocuments && (
              <div
                ref={loadMoreTriggerRef}
                className='flex items-center justify-center py-8 text-zinc-500 dark:text-zinc-400'
              >
                <Loader2 className='h-6 w-6 animate-spin' />
                <span className='ml-2 text-sm'>
                  {t('knowledge.library.loadingMore', 'Loading more...')}
                </span>
              </div>
            )}
          </>
        )}
        </div>
      </div>

      {/* Floating search bar — mobile only, pinned to bottom */}
      {isMobile && (
        <div className={cn(
          'absolute bottom-0 left-0 right-0 z-20 px-3 py-2',
          'bg-background/80 dark:bg-background/60',
          'backdrop-blur-xl',
          'border-t border-border/50',
          'shadow-[0_-4px_12px_rgba(0,0,0,0.15)]',
        )}>
          <div className={cn(
            'relative flex gap-2 p-1',
            'bg-background/80 dark:bg-background/60',
            'border border-border/50',
          )}>
            {searchBar}
          </div>
        </div>
      )}

      {/* Duplicate review dialog */}
      {duplicateReviewDoc && (
        <DuplicateReviewDialog
          open={!!duplicateReviewDoc}
          onOpenChange={(open) => { if (!open) setDuplicateReviewDoc(null); }}
          documentId={duplicateReviewDoc.id}
          documentTitle={duplicateReviewDoc.title}
          onMerged={() => {
            if (selectedCollection && selectedCollection !== 'all') {
              void fetchDocuments(selectedCollection);
            }
          }}
        />
      )}

      {/* Redownload dialog */}
      {redownloadDoc && (
        <Suspense fallback={null}>
          <LibraryRedownloadDialog
            open={!!redownloadDoc}
            onOpenChange={(open) => { if (!open) setRedownloadDoc(null); }}
            documentId={redownloadDoc.id}
            documentTitle={redownloadDoc.title}
            documentFilename={redownloadDoc.filename}
            onRedownloadComplete={async () => {
              const docId = redownloadDoc.id;
              const collectionId = redownloadDoc.collection_id;
              const fallbackFilename = redownloadDoc.filename;

              // Re-fetch the document from backend and always mark as file_stored
              // (redownload succeeded = file is now on server disk). The backend
              // may have renamed the file (`.pdf` → `.epub` via magic-bytes
              // detection), so we pull the fresh filename/file_path too — a
              // stale closure filename would route the auto-open to the wrong
              // viewer (PDF viewer trying to render EPUB bytes → SafeGlobalPDFViewer
              // ErrorBoundary tears it down → user sees "dialog just closed").
              let resolvedFilename = fallbackFilename;
              try {
                const updatedDoc = await getDocumentById(docId);
                resolvedFilename = updatedDoc.filename || fallbackFilename;
                setDocuments(prev => prev.map(d =>
                  d.id === docId
                    ? { ...d, ...updatedDoc, collection_name: d.collection_name, file_stored: true }
                    : d
                ));
              } catch {
                // Fallback: at minimum mark as stored so the eye icon shows up.
                setDocuments(prev => prev.map(d =>
                  d.id === docId ? { ...d, file_stored: true } : d
                ));
              }
              setRedownloadDoc(null);

              // Auto-open the viewer with the *post-rename* filename so
              // handlePreview routes to the correct viewer when the backend
              // changed the extension after sniffing magic bytes.
              handlePreview(docId, resolvedFilename, collectionId);
            }}
          />
        </Suspense>
      )}

      {/* Download options dialog removed — now inline submenu in dropdown */}

      {/* Drag & drop collection targets — shown when dragging */}
      {draggedDocId && !isMobile && (
        <div className={cn(
          'absolute top-0 left-0 right-0 z-30 p-2',
          'bg-background/95 backdrop-blur-sm',
          'border-b border-primary/30',
          'flex flex-wrap gap-2',
        )}>
          <span className='text-xs text-muted-foreground self-center mr-2'>
            {t('knowledge.library.dropToMove', 'Drop on a collection:')}
          </span>
          {collections.map(col => (
            <div
              key={col.id}
              onDragOver={(e) => { e.preventDefault(); setDragOverCollection(col.id); }}
              onDragLeave={() => setDragOverCollection(null)}
              onDrop={(e) => {
                e.preventDefault();
                const ids = JSON.parse(e.dataTransfer.getData('application/json'));
                void handleMoveToCollection(col.id, ids);
                setDraggedDocId(null);
                setDragOverCollection(null);
              }}
              className={cn(
                'px-3 py-1.5 text-xs border transition-colors',
                dragOverCollection === col.id
                  ? 'bg-primary/20 border-primary text-primary font-medium'
                  : 'bg-muted/50 border-border hover:bg-muted text-foreground',
              )}
            >
              {col.name}
            </div>
          ))}
        </div>
      )}

      {/* Delete confirmation dialog (single) */}
      <AlertDialog open={!!deleteConfirmDocId} onOpenChange={(open) => { if (!open) setDeleteConfirmDocId(null); }}>
        <AlertDialogContent data-testid="library-delete-confirm-dialog" className='z-[10000]'>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('knowledge.library.deleteConfirmTitle', 'Delete document')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('knowledge.library.deleteConfirmDescription', 'Are you sure you want to delete this document? This action cannot be undone.')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeletingDoc}>
              {t('general.cancel', 'Cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={isDeletingDoc}
              className='bg-red-600 hover:bg-red-700 text-white'
              onClick={() => {
                if (deleteConfirmDocId) {
                  void handleDeleteDoc(deleteConfirmDocId);
                }
              }}
            >
              {isDeletingDoc ? (
                <Loader2 className='h-4 w-4 animate-spin mr-2' />
              ) : (
                <Trash2 className='h-4 w-4 mr-2' />
              )}
              {t('knowledge.library.deleteDocument', 'Delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Batch delete confirmation dialog */}
      <AlertDialog open={batchDeleteConfirm} onOpenChange={(open) => { if (!open) setBatchDeleteConfirm(false); }}>
        <AlertDialogContent data-testid="library-batch-delete-confirm-dialog" className='z-[10000]'>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('knowledge.library.batchDeleteTitle', 'Delete {{count}} documents', { count: selectedDocIds.size })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('knowledge.library.batchDeleteDescription', 'Are you sure you want to delete these documents? This action cannot be undone.')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isBatchDeleting}>
              {t('general.cancel', 'Cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={isBatchDeleting}
              className='bg-red-600 hover:bg-red-700 text-white'
              onClick={handleBatchDelete}
            >
              {isBatchDeleting ? (
                <Loader2 className='h-4 w-4 animate-spin mr-2' />
              ) : (
                <Trash2 className='h-4 w-4 mr-2' />
              )}
              {t('knowledge.library.deleteSelected', 'Delete')} ({selectedDocIds.size})
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Relations management dialog */}
      {relationDoc && currentWorkspace?.id && (
        <DocumentRelationsDialog
          open={!!relationDoc}
          onOpenChange={(open) => { if (!open) setRelationDoc(null); }}
          documentId={relationDoc.id}
          documentTitle={relationDoc.title}
          workspaceId={currentWorkspace.id}
          allDocuments={documents.map(d => ({ id: d.id, title: d.title, filename: d.filename }))}
          onRelationsChanged={() => {
            if (selectedCollection && selectedCollection !== 'all') {
              void fetchDocuments(selectedCollection);
            }
          }}
        />
      )}

      {/* Tag management is now inline via TagInlineSubmenu in the dropdown */}

      {/* Book summary dialog — triggered from three-dot menu → Summary */}
      {showSummaryForDoc && (
        <Suspense fallback={null}>
          <BookSummaryHoverCard
            documentId={showSummaryForDoc}
            openSummary={true}
            onSummaryOpenChange={(open) => { if (!open) setShowSummaryForDoc(null); }}
            onSummaryGenerated={() => {
              setDocuments(prev => prev.map(d =>
                d.id === showSummaryForDoc ? { ...d, has_summary: true } : d
              ));
            }}
          >
            <span />
          </BookSummaryHoverCard>
        </Suspense>
      )}

      {/* Collection manage dialog — combined add/move */}
      {/* Export Dialog */}
      <ExportDialog
        open={exportDialogOpen}
        onOpenChange={setExportDialogOpen}
        metadata={exportMetadata}
      />

      {collectionManageDoc && (
        <Dialog open={!!collectionManageDoc} onOpenChange={(open) => { if (!open) setCollectionManageDoc(null); }}>
          <DialogContent className='max-w-sm p-0' overlayZIndex="10000">
            <DialogTitle className='px-4 pt-4 pb-2 text-base font-semibold'>
              {t('knowledge.library.manageCollection', 'Manage collection')}
            </DialogTitle>
            <DialogDescription className='sr-only'>
              {t('knowledge.library.manageCollectionDescription', 'Add or move this document to another collection')}
            </DialogDescription>
            <div className='px-4 pb-2'>
              <p className='text-xs text-muted-foreground truncate'>
                {collectionManageDoc.title || collectionManageDoc.filename}
              </p>
            </div>
            <div className='px-4 pb-4 space-y-1 max-h-64 overflow-y-auto'>
              {collections
                .filter(c => c.id !== collectionManageDoc.collection_id)
                .map(col => {
                  const alreadyMember = collectionManageDoc.collection_memberships?.some(
                    m => m.collection_id === col.id
                  );
                  return (
                    <div key={col.id} className='flex items-center gap-2'>
                      <button
                        className={cn(
                          'flex-1 text-left text-sm px-3 py-2',
                          'hover:bg-zinc-100 dark:hover:bg-zinc-800',
                          'transition-colors',
                          alreadyMember && 'text-muted-foreground'
                        )}
                        disabled={alreadyMember}
                        onClick={async () => {
                          const ok = await addDocumentToCollection(collectionManageDoc.id, col.id);
                          if (ok) {
                            setDocuments(prev => prev.map(d =>
                              d.id === collectionManageDoc.id
                                ? {
                                    ...d,
                                    collection_memberships: [
                                      ...(d.collection_memberships || []),
                                      { collection_id: col.id, collection_name: col.name },
                                    ],
                                  }
                                : d
                            ));
                            setCollectionManageDoc(prev => prev ? {
                              ...prev,
                              collection_memberships: [
                                ...(prev.collection_memberships || []),
                                { collection_id: col.id, collection_name: col.name },
                              ],
                            } : null);
                          }
                          toast[ok ? 'success' : 'error'](
                            ok ? t('knowledge.library.addedToCollection', 'Added to {{name}}', { name: col.name })
                              : t('knowledge.library.actionFailed')
                          );
                        }}
                      >
                        <FolderPlus className='inline h-3.5 w-3.5 mr-2 align-text-bottom' />
                        {alreadyMember
                          ? t('knowledge.library.alreadyInCollection', 'Already in {{name}}', { name: col.name })
                          : t('knowledge.library.addTo', 'Add to {{name}}', { name: col.name })
                        }
                      </button>
                      <button
                        className={cn(
                          'text-xs px-2 py-2 shrink-0',
                          'text-muted-foreground hover:text-foreground',
                          'hover:bg-zinc-100 dark:hover:bg-zinc-800',
                          'transition-colors'
                        )}
                        onClick={async () => {
                          await handleMoveToCollection(col.id, [collectionManageDoc.id]);
                          setCollectionManageDoc(null);
                        }}
                      >
                        <FolderInput className='inline h-3.5 w-3.5 mr-1 align-text-bottom' />
                        {t('knowledge.library.moveTo', 'Move')}
                      </button>
                    </div>
                  );
                })
              }
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

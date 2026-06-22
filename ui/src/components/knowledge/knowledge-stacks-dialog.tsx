import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {Dialog, DialogContent, DialogDescription, DialogTitle,} from '@/components/ui/dialog';
import {DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,} from '@/components/ui/dropdown-menu';
import {Input} from '@/components/ui/input';
import {Button} from '@/components/ui/button';
import {Select, SelectContent, SelectItem, SelectTrigger, SelectValue,} from '@/components/ui/select';
import {Tooltip, TooltipContent, TooltipProvider, TooltipTrigger,} from '@/components/ui/tooltip';
import {useIsMobile, useIsSmallScreen, useIsNarrowScreen} from '@/hooks/use-mobile';
import {useAnyDrawerOpen} from '@/hooks/use-any-drawer-open';
import {cn} from '@/lib/utils';
import {getAccentBorderClasses} from '@/lib/accent-utils';
import {deduplicateById, isDocumentInProgress, isDocumentPending} from '@/lib/collection-utils';
import {buildCollectionTree, type CollectionTreeNode} from '@/lib/collection-tree';
import {
  ArrowDownAZ,
  ArrowUpAZ,
  CalendarArrowDown,
  CalendarArrowUp,
  ChevronDown,
  Cog,
  Database,
  FileStack,
  FileText,
  CornerDownLeft,
  FolderPlus,
  Globe,
  Headphones,
  Link2,
  Loader2,
  Plug2,
  PlusCircle,
  RefreshCw,
  Search,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import {cancelDocumentProcessing, deleteCollection, deleteDocument, getDocumentsByCollection, processDocument,} from '@/lib/api-documents';
import {uiState} from '@/lib/storage-utils';
import {mapWithConcurrency} from '@/lib/api-utils';
import {DOIImportDialog} from './doi-import-dialog';
import {PodcastDialog} from './podcast-dialog';
import {createCollection, generateCollectionCustomInstructions, generateCollectionDescription, generateCollectionDescriptionFromName, updateCollection} from '@/lib/api-collections';
import {toast} from '@/lib/toast-compat';
import {useTranslation} from 'react-i18next';
import {useTheme} from '@/providers/theme-provider';
import {useCollections} from '@/contexts/collections-context';
import {KnowledgeFileUploader} from './knowledge-file-uploader';
import {KnowledgeConnectors} from './knowledge-connectors.tsx';
import {ExternalBooksSearch} from './external-books-search';
import {LibraryView, ProcessedDocument} from './library-view';
import {ExistingDocument, KnowledgeFileUploaderRef, KnowledgeStacksDialogProps,} from '@/types/file-attachments';
import {PopoverEmbeddingSettings} from './popover-embedding-settings';
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
import {useWorkspace} from '@/hooks/use-workspace';
import {usePersistentJobSync} from '@/hooks/use-persistent-job-sync';
import {API_BASE_URL, apiClient} from '@/lib/api';
import {getMyWorkspaceRole, getWorkspaceStorage} from '@/lib/api-workspace';
import {listSavedSearches, type SavedSearch} from '@/lib/api-saved-searches';
import {SavedSearchCreateDialog} from './saved-search-create-dialog';

// Tab type for knowledge stacks dialog
type KnowledgeTab = 'upload' | 'library' | 'connectors';

export const KnowledgeStacksDialog = ({
  open,
  onOpenChange,
  onCollectionChange,
  defaultTab,
}: KnowledgeStacksDialogProps) => {
  const { t } = useTranslation();
  const { accentColor } = useTheme();

  // Check if any drawer (PDF/EPUB/DOCX/Notes) is open
  const { isOpen: isAnyDrawerOpen, isDrawerOnLeft } = useAnyDrawerOpen();

  // Resizable sidebar state
  const [sidebarWidth, setSidebarWidth] = useState(350);
  const isResizing = useRef(false);
  const startX = useRef(0);
  const startWidth = useRef(0);
  const isManualSelection = useRef(false); // Track manual collection selection
  const previousWorkspaceIdRef = useRef<string | null>(null);

  // Wrapper for shared accent border utility
  const accentBorder = (isSelected: boolean, isHover: boolean = false) =>
    getAccentBorderClasses(accentColor, isSelected, isHover);
  const isMobile = useIsMobile();
  const isSmallScreen = useIsSmallScreen(); // Below 1400px (for nested dialog logic)
  // Use narrow screen layout for screens below 1200px (not 1400px) to center dialog properly at 1260px
  const isNarrowScreen = useIsNarrowScreen();

  // Determine if we should use split-screen layout (drawer open + wide screen)
  const isSplitScreen = isAnyDrawerOpen && !isNarrowScreen;
  // Use narrow/tablet layout when screen is actually narrow OR in split mode (~50% width)
  const effectiveNarrow = isNarrowScreen || isSplitScreen;

  // Use preloaded collections from context with pagination support
  const {
    collections: contextCollections,
    loading: collectionsLoading,
    hasMore,
    refreshCollections,
    loadMoreCollections,
    updateCollectionInState,
    addCollectionToState,
    removeCollectionFromState,
    sortBy,
    sortOrder,
    setSort
  } = useCollections();

  // Restore last-selected collection on mount so reopening the dialog
  // returns the user to where they left off. Drift (deleted collection) is
  // cleaned up by the effect below once contextCollections is populated.
  const [selectedStack, setSelectedStack] = useState<string | null>(() => uiState.getLastKnowledgeCollectionId());
  const [, setSavedSearches] = useState<SavedSearch[]>([]);
  const [, setActiveSavedSearchId] = useState<string | null>(null);
  const [savedSearchDocIds, setSavedSearchDocIds] = useState<string[] | null>(null);
  const [showCreateSavedSearch, setShowCreateSavedSearch] = useState(false);
  const [showNewStackModal, setShowNewStackModal] = useState(false);
  const [shouldReopenParent, setShouldReopenParent] = useState(false);
  const [newStackName, setNewStackName] = useState('');
  const [newStackDescription, setNewStackDescription] = useState('');
  // per-collection system-prompt addendum. Edit-only
  // (the create flow never has a collection ID to anchor the AI call,
  // and asking the user to write a system prompt before knowing what's
  // inside the collection is a worse onboarding moment).
  const [newStackCustomInstructions, setNewStackCustomInstructions] = useState('');
  const [isGeneratingCustomInstructions, setIsGeneratingCustomInstructions] = useState(false);
  // Knowledge-graph build tier for the collection: null = inherit from parent,
  // 0 = none, 1 = light, 2 = full. Drives how much Neo4j graph each book builds.
  const [newStackGraphTier, setNewStackGraphTier] = useState<number | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [isGeneratingDescription, setIsGeneratingDescription] = useState(false);
  const [parentForSubcollection, setParentForSubcollection] = useState<string | null>(null);

  // Map context collections to local format (keeping backward compatibility)
  const knowledgeStacks = contextCollections.map((col, index) => {
    const colors = [
      'bg-yellow-500',
      'bg-green-500',
      'bg-blue-500',
      'bg-purple-500',
      'bg-red-500',
    ];
    const colorClass = colors[index % colors.length];
    return {
      id: col.id,
      name: col.name,
      color: colorClass,
      parentCollectionId: col.parentCollectionId || col.parent_collection_id || null,
      parent_collection_id: col.parent_collection_id || col.parentCollectionId || null,
      depth: col.depth ?? 0,
      sortOrder: col.sortOrder ?? col.sort_order ?? 0,
      sort_order: col.sort_order ?? col.sortOrder ?? 0,
    };
  });
  const [showStackMenu, setShowStackMenu] = useState(false);
  const [stackMenuPosition, _setStackMenuPosition] = useState({
    top: 0,
    left: 0,
  });
  const [activeStackForMenu, setActiveStackForMenu] = useState<string | null>(
    null
  );
  const stackMenuRef = useRef<HTMLDivElement>(null);
  const fileUploaderRef = useRef<KnowledgeFileUploaderRef>(null);
  // toast is now imported directly

  // Persist whichever collection the user is currently looking at, so the
  // next dialog open lands on the same one.
  useEffect(() => {
    uiState.setLastKnowledgeCollectionId(selectedStack);
  }, [selectedStack]);

  // Drop the restored selection only when we're sure the collection is gone
  // (deleted while the dialog was closed). Two guards:
  //   * `collectionsLoading` — wipe would race the initial fetch and reset
  //     a still-valid id back to null before the user even sees the dialog.
  //   * `hasMore` — the collections context paginates. The restored id may
  //     legitimately live on a later page; if we wipe just because page 1
  //     doesn't contain it, the persist effect below would then save `null`
  //     and the user's last selection is gone forever. Wait until every
  //     page is in memory before declaring the id stale.
  useEffect(() => {
    if (!selectedStack) return;
    if (collectionsLoading || hasMore) return;
    if (contextCollections.length === 0) return;
    if (!contextCollections.some(c => c.id === selectedStack)) {
      setSelectedStack(null);
    }
  }, [contextCollections, selectedStack, collectionsLoading, hasMore]);

  // Tab navigation state
  const [activeTab, setActiveTab] = useState<KnowledgeTab>(defaultTab ?? 'upload');

  // Honour a caller-requested tab each time the dialog opens (e.g. a share
  // deep-link asks for 'library'). Only fires on open so manual tab switches
  // while open are preserved.
  useEffect(() => {
    if (open && defaultTab) {
      setActiveTab(defaultTab);
    }
  }, [open, defaultTab]);

  // Maximize state
  const [isMaximized, setIsMaximized] = useState(false);

  // Touch swipe state for mobile tab navigation
  const [touchStart, setTouchStart] = useState<{ x: number; y: number } | null>(null);
  const [touchEnd, setTouchEnd] = useState<{ x: number; y: number } | null>(null);
  const [touchCurrent, setTouchCurrent] = useState<{ x: number; y: number } | null>(null);
  const [isAnimating, setIsAnimating] = useState(false);
  const [slideDirection, setSlideDirection] = useState<'left' | 'right' | null>(null);
  const [nextTab, setNextTab] = useState<KnowledgeTab | null>(null);
  const [dragOffset, setDragOffset] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const [isVerticalScroll, setIsVerticalScroll] = useState(false);

  // Add these to your existing useState declarations at the top of the component
  // Initialize to false since collections are pre-loaded in context
  const [isLoading, setIsLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [existingDocuments, setExistingDocuments] = useState<
    ExistingDocument[]
  >([]);
  const [isLoadingDocuments, setIsLoadingDocuments] = useState(false);

  // Pre-fetched library data (background loading when dialog opens)
  const [preloadedLibraryDocs, setPreloadedLibraryDocs] = useState<ProcessedDocument[]>([]);
  const [preloadedLibraryLoading, setPreloadedLibraryLoading] = useState(true);
  const preloadedLibraryFetched = useRef(false);

  // Fetch ALL pages of documents for a single collection (backend caps page_size at 100)
  const fetchAllPagesForCollection = useCallback(async (collection: { id: string; name: string }): Promise<ProcessedDocument[]> => {
    const docs: ProcessedDocument[] = [];
    let page = 1;
    let hasMore = true;
    while (hasMore) {
      try {
        const response = await getDocumentsByCollection(collection.id, page, 100);
        docs.push(...response.documents.map((doc: { id: string; filename: string; [key: string]: unknown }) => ({
          ...doc,
          collection_name: collection.name,
        })));
        hasMore = response.hasMore && response.documents.length > 0;
        page++;
      } catch {
        break;
      }
    }
    return docs;
  }, []);

  // Function to refresh library preloaded data (call when documents change)
  const refreshPreloadedLibrary = useCallback(async () => {
    if (contextCollections.length === 0) return;

    setPreloadedLibraryLoading(true);
    try {
      // Bounded fan-out: one /documents/collection/{id} request per collection,
      // capped so a large workspace doesn't fire 30+ parallel requests that
      // contend on the backend pool and blow past the 5s perf threshold.
      const results = await mapWithConcurrency(contextCollections, 6, fetchAllPagesForCollection);
      // Deduplicate by doc.id (multi-collection membership can return same doc from multiple collections)
      const unique = deduplicateById(results.flat());
      setPreloadedLibraryDocs(unique);
    } finally {
      setPreloadedLibraryLoading(false);
    }
  }, [contextCollections, fetchAllPagesForCollection]);

  // Get workspace context using the proper hook
  const { currentWorkspace, isLoading: workspaceLoading } = useWorkspace();

  // Add these new states
  const [isCleaningUpEmbeddings, setIsCleaningUpEmbeddings] = useState(false);

  // Workspace role and storage states
  const [, setWorkspaceRole] = useState<string | null>(null);
  const [canUpload, setCanUpload] = useState(true); // Default to true for backwards compatibility
  const [, setWorkspaceStorage] = useState<{
    storage_used_bytes: number;
    storage_used_gb: number;
    documents_count: number;
  } | null>(null);

  // Add these states for pagination
  const [currentPage, setCurrentPage] = useState(1);
  const [hasMoreDocuments, setHasMoreDocuments] = useState(false);
  const [isLoadingMoreDocuments, setIsLoadingMoreDocuments] = useState(false);
  const [localSearchQuery, setLocalSearchQuery] = useState('');
  const [uploadSearchMode, setUploadSearchMode] = useState<'local' | 'online'>('local');
  const [externalSearchTrigger, setExternalSearchTrigger] = useState(0);

  // Batch processing progress tracking
  const [batchProcessing, setBatchProcessing] = useState<{
    total: number;
    pending: number;
    collectionId: string;
  } | null>(null);
  const batchPollingRef = useRef<ReturnType<typeof setInterval> | null>(null);


  // Tab definitions
  const TABS: {
    id: KnowledgeTab;
    labelKey: string;
    icon: React.ElementType;
  }[] = [
    { id: 'upload', labelKey: 'knowledge.tabs.upload', icon: FileText },
    { id: 'library', labelKey: 'knowledge.tabs.library', icon: FileStack },
    { id: 'connectors', labelKey: 'knowledge.tabs.connectors', icon: Database },
  ];

  // Handle tab change with optional animation direction for swipe gestures
  const handleTabChange = useCallback((tabId: KnowledgeTab, direction?: 'left' | 'right') => {
    // Don't change tabs if already animating
    if (isAnimating) return;

    // If it's the same tab, don't animate
    if (activeTab === tabId) return;

    // Start animation on mobile
    if (effectiveNarrow && direction) {
      setIsAnimating(true);
      setSlideDirection(direction);
      setNextTab(tabId);
      setDragOffset(0);
      setIsDragging(false);

      // Change tab after a brief delay to allow animation setup
      setTimeout(() => {
        setActiveTab(tabId);
      }, 50);

      // End animation after transition completes
      setTimeout(() => {
        setIsAnimating(false);
        setSlideDirection(null);
        setNextTab(null);
      }, 350); // Match CSS transition duration + delay
    } else {
      setActiveTab(tabId);
    }

    // Auto-scroll to center the active tab on mobile
    if (effectiveNarrow) {
      setTimeout(() => {
        const tabElement = document.querySelector(`[data-knowledge-tab-id="${tabId}"]`);
        if (tabElement) {
          tabElement.scrollIntoView({
            behavior: 'smooth',
            block: 'nearest',
            inline: 'center',
          });
        }
      }, 100);
    }
  }, [isAnimating, activeTab, effectiveNarrow]);

  // Touch swipe handlers for mobile tab navigation
  const minSwipeDistance = 80;
  const maxDragDistance = typeof window !== 'undefined' ? window.innerWidth * 0.2 : 100;
  const minHorizontalMovement = 30;
  const maxVerticalToHorizontalRatio = 2;

  const onTouchStart = (e: React.TouchEvent) => {
    if (!effectiveNarrow || isAnimating) return;

    // Check if touch started on an interactive element that should not trigger sliding
    const target = e.target as HTMLElement;
    const interactiveElements = ['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'CANVAS', 'A'];
    const isInteractiveElement = interactiveElements.includes(target.tagName) ||
      target.closest('button, input, select, textarea, canvas, a, [role="button"]');

    // Don't start sliding if touching interactive elements
    if (isInteractiveElement) {
      return;
    }

    setTouchEnd(null);
    setTouchCurrent(null);
    setTouchStart({
      x: e.targetTouches[0].clientX,
      y: e.targetTouches[0].clientY
    });
    setDragOffset(0);
    setIsDragging(false);
    setIsVerticalScroll(false);
  };

  const onTouchMove = (e: React.TouchEvent) => {
    if (!effectiveNarrow || !touchStart || isAnimating) return;

    const currentX = e.targetTouches[0].clientX;
    const currentY = e.targetTouches[0].clientY;

    setTouchCurrent({ x: currentX, y: currentY });
    setTouchEnd({ x: currentX, y: currentY });

    const horizontalDistance = touchStart.x - currentX;
    const verticalDistance = Math.abs(touchStart.y - currentY);
    const horizontalDistanceAbs = Math.abs(horizontalDistance);

    // Detect if this is primarily a vertical scroll gesture
    if (!isVerticalScroll && (horizontalDistanceAbs > 5 || verticalDistance > 5)) {
      const isVertical = verticalDistance > horizontalDistanceAbs * maxVerticalToHorizontalRatio;
      if (isVertical) {
        setIsVerticalScroll(true);
        return;
      }
    }

    // If we've determined this is vertical scrolling, don't process horizontal gestures
    if (isVerticalScroll) return;

    // Only process horizontal gestures if horizontal movement is significant enough
    if (horizontalDistanceAbs < minHorizontalMovement) return;

    const currentIndex = TABS.findIndex(tab => tab.id === activeTab);

    // Only allow dragging if there's a valid next/previous tab
    const canGoNext = horizontalDistance > 0 && currentIndex < TABS.length - 1;
    const canGoPrev = horizontalDistance < 0 && currentIndex > 0;

    if (canGoNext || canGoPrev) {
      const clampedDistance = Math.max(-maxDragDistance, Math.min(maxDragDistance, horizontalDistance));
      setDragOffset(clampedDistance);
      setIsDragging(horizontalDistanceAbs > minHorizontalMovement);

      // Set next tab for preview during drag
      if (horizontalDistanceAbs > minHorizontalMovement) {
        if (canGoNext && horizontalDistance > 0) {
          setNextTab(TABS[currentIndex + 1].id);
          setSlideDirection('left');
        } else if (canGoPrev && horizontalDistance < 0) {
          setNextTab(TABS[currentIndex - 1].id);
          setSlideDirection('right');
        }
      }
    }
  };

  const onTouchEnd = () => {
    if (!effectiveNarrow || !touchStart) return;

    // If this was determined to be a vertical scroll, don't process as horizontal swipe
    if (isVerticalScroll) {
      setTouchStart(null);
      setTouchEnd(null);
      setTouchCurrent(null);
      setIsVerticalScroll(false);
      return;
    }

    // If already animating, don't start a new animation
    if (isAnimating) {
      setTouchStart(null);
      setTouchEnd(null);
      setTouchCurrent(null);
      return;
    }

    const currentPos = touchCurrent || touchEnd;
    const distance = currentPos ? touchStart.x - currentPos.x : 0;
    const isLeftSwipe = distance > minSwipeDistance;
    const isRightSwipe = distance < -minSwipeDistance;

    if (isLeftSwipe || isRightSwipe) {
      const currentIndex = TABS.findIndex(tab => tab.id === activeTab);

      if (isLeftSwipe && currentIndex < TABS.length - 1) {
        // Swipe left - go to next tab (slide from right to left)
        handleTabChange(TABS[currentIndex + 1].id, 'left');
      } else if (isRightSwipe && currentIndex > 0) {
        // Swipe right - go to previous tab (slide from left to right)
        handleTabChange(TABS[currentIndex - 1].id, 'right');
      }
    } else {
      // Reset drag state if no swipe occurred
      setDragOffset(0);
      setIsDragging(false);
      setSlideDirection(null);
      setNextTab(null);
    }

    // Always clean up touch state
    setTouchStart(null);
    setTouchEnd(null);
    setTouchCurrent(null);
    setIsVerticalScroll(false);
  };

  // Refresh documents when switching to Upload tab to show newly downloaded books
  useEffect(() => {
    if (activeTab === 'upload' && selectedStack && open) {
      console.log('📚 [Knowledge Stacks] Refreshing documents for Upload tab', {
        selectedStack,
        activeTab,
        open,
      });
      // Delay to ensure backend has completed download and database commit
      // Use silent mode if documents already loaded (no skeleton flash on tab switch)
      const refreshTimeout = setTimeout(() => {
        console.log('📚 [Knowledge Stacks] Fetching documents after 800ms delay');
        void fetchDocumentsForCollection(selectedStack, 1, false, '', existingDocuments.length > 0);
      }, 800);
      return () => clearTimeout(refreshTimeout);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, selectedStack, open]);

  // Focus the upload button when the Upload tab is active
  useEffect(() => {
    if (activeTab === 'upload' && open && selectedStack) {
      // Small delay to ensure the component is rendered
      const focusTimeout = setTimeout(() => {
        fileUploaderRef.current?.focusUploadButton();
      }, 100);
      return () => clearTimeout(focusTimeout);
    }
  }, [activeTab, open, selectedStack]);

  const collectionsContainerRef = useRef<HTMLDivElement>(null);

  // Add state for total documents in selected collection
  const [, setTotalDocumentsInCollection] = useState(0);

  // Add these states for embedding settings
  const [embeddingModel, setEmbeddingModel] = useState('');
  const [splitterType, setSplitterType] = useState('recursive');
  const [chunkSize, setChunkSize] = useState('medium');
  const [chunkOverlapping, setChunkOverlapping] = useState('medium');
  const [chunkSizesToIgnore, setChunkSizesToIgnore] = useState('50');

  // Add these new states for delete confirmation
  const [isDeleteConfirmationOpen, setIsDeleteConfirmationOpen] =
    useState(false);
  const [deletingStackId, setDeletingStackId] = useState<string | null>(null);

  // DOI import dialog state (Scite item #10): targets the collection the
  // user picked from the per-row dropdown menu so the action is unambiguous.
  const [doiImportTarget, setDoiImportTarget] =
    useState<{ id: string; name: string } | null>(null);

  // Podcast / NotebookLM-style audio overview dialog.
  const [podcastTarget, setPodcastTarget] =
    useState<{ id: string; name: string } | null>(null);

  // Add state for abort confirmation dialog
  const [isAbortConfirmationOpen, setIsAbortConfirmationOpen] = useState(false);
  const [isCancellingJobs, setIsCancellingJobs] = useState(false);

  // Add state to track if there are files to process
  const [, setHasUnprocessedFiles] = useState(false);
  const [selectedPendingCount, setSelectedPendingCount] = useState(0);

  // ============================================================================
  // PERSISTENT JOB SYNC HOOK - Replaces complex job tracking state management
  // ============================================================================
  const {
    ongoingJobs,           // Replaces: const [ongoingJobs, setOngoingJobs] = useState([])
    isLoading: jobsLoading,
    hasActiveJobs,         // Indicates if there are active jobs
    syncJobs,              // Manual sync function
    forceSync,             // Force sync bypassing backoff (for dialog open)
  } = usePersistentJobSync({
    onJobComplete: () => {
      // Refresh documents when a job completes
      if (selectedStack) {
        void fetchDocumentsForCollection(selectedStack);
      }
      void fetchCollections(); // Update collection metadata
      void refreshWorkspaceStorage(); // Update storage info
    },
    onJobProgress: (jobId, progress) => {
      console.log(`📊 Job ${jobId} progress: ${progress.progress}%`);

      // Update the document's job_progress and job_status in existingDocuments
      if (progress.documentId) {
        setExistingDocuments(prev => {
          return prev.map((doc): ExistingDocument => {
            if (doc.id === progress.documentId) {
              // Update the document with the latest progress
              return {
                ...doc,
                job_progress: progress.progress,
                job_status: (progress.status || doc.job_status) as ExistingDocument['job_status'],
              };
            }
            return doc;
          });
        });
      }
    },
    onDocumentAdded: (data) => {
      // Refresh documents when a new document is added (e.g., external book downloaded)
      console.log(`📚 Document added via WebSocket: ${data.title}`, data);
      if (selectedStack === data.collection_id) {
        // Refresh the current collection's document list
        void fetchDocumentsForCollection(selectedStack);
      }
      void fetchCollections(); // Update collection metadata (document counts)
      void refreshWorkspaceStorage(); // Update storage info
    },
  });

  // Derive isUploading from hasActiveJobs
  const isUploading = hasActiveJobs;

  // Check if there are any pending documents in the current collection
  const hasPendingDocuments = useMemo(() => {
    return existingDocuments.some(isDocumentPending);
  }, [existingDocuments]);

  // Count current pending documents for batch progress display
  const pendingDocumentCount = useMemo(() => {
    return existingDocuments.filter(isDocumentPending).length;
  }, [existingDocuments]);

  // Auto-detect batch processing: if there are active jobs and pending docs, show progress
  useEffect(() => {
    if (batchProcessing) return; // Already tracking
    if (!hasActiveJobs || pendingDocumentCount === 0 || !selectedStack) return;

    // Active jobs + pending docs = batch processing in progress
    // Use total documents as estimate (pending + processing + completed = total)
    const totalInCollection = existingDocuments.length;
    if (totalInCollection > 0 && pendingDocumentCount > 0) {
      setBatchProcessing({
        total: totalInCollection,
        pending: pendingDocumentCount,
        collectionId: selectedStack,
      });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasActiveJobs, pendingDocumentCount, selectedStack]);


  // Batch processing progress: poll for pending count while batch is active
  useEffect(() => {
    if (!batchProcessing) {
      if (batchPollingRef.current) {
        clearInterval(batchPollingRef.current);
        batchPollingRef.current = null;
      }
      return;
    }

    // Poll function: fetch all docs to count pending accurately (not paginated subset)
    const pollBatchProgress = async () => {
      if (!batchProcessing.collectionId) return;
      try {
        const response = await getDocumentsByCollection(
          batchProcessing.collectionId, 1, 1000, currentWorkspace?.id
        );
        if (response) {
          const allDocs = response.documents || [];
          const stillPending = allDocs.filter(isDocumentPending).length;

          // Update batch counts from actual data
          setBatchProcessing(prev => prev ? { ...prev, total: allDocs.length, pending: stillPending } : null);

          // Also refresh the visible document list
          void fetchDocumentsForCollection(batchProcessing.collectionId);

          // Check if batch is done
          if (stillPending === 0) {
            setBatchProcessing(null);
            if (batchPollingRef.current) {
              clearInterval(batchPollingRef.current);
              batchPollingRef.current = null;
            }
            toast({
              title: t('knowledge.batch.completed') || 'Batch Processing Complete',
              description: t('knowledge.batch.allDocumentsProcessed') || 'All documents have been processed.',
            });
          }
        }
      } catch (error) {
        console.error('Batch progress poll error:', error);
      }
    };

    // Poll immediately on mount, then every 8 seconds. STOMP
    // progress updates land live but don't always cover every row
    // under load (and briefly drop during reconnects); an 8-second
    // refetch keeps the list in sync with backend job_progress
    // without hammering the endpoint.
    void pollBatchProgress();
    batchPollingRef.current = setInterval(pollBatchProgress, 8000);

    return () => {
      if (batchPollingRef.current) {
        clearInterval(batchPollingRef.current);
        batchPollingRef.current = null;
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batchProcessing?.collectionId]);

  // ============================================================================
  // MOBILE BACK BUTTON & ESC KEY SUPPORT
  // ============================================================================
  useEffect(() => {
    if (!open) return;

    // Push a history state when dialog opens (for mobile back button)
    if (isMobile) {
      window.history.pushState({ dialogOpen: true }, '');
    }

    // Handle mobile back button
    const handlePopState = (event: PopStateEvent) => {
      if (open && isMobile) {
        event.preventDefault();
        onOpenChange?.(false);
      }
    };

    // Handle ESC key
    const handleEscKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && open) {
        event.preventDefault();
        onOpenChange?.(false);
      }
    };

    window.addEventListener('popstate', handlePopState);
    window.addEventListener('keydown', handleEscKey);

    return () => {
      window.removeEventListener('popstate', handlePopState);
      window.removeEventListener('keydown', handleEscKey);

      // Clean up history state when dialog closes
      if (isMobile && window.history.state?.dialogOpen) {
        window.history.back();
      }
    };
  }, [open, isMobile, onOpenChange]);

  // Resizable sidebar mouse event handlers
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      isResizing.current = true;
      startX.current = e.clientX;
      startWidth.current = sidebarWidth;
      document.body.style.cursor = 'ew-resize';
      document.body.style.userSelect = 'none';

      // Add event listeners for mouse move and mouse up
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are intentionally limited
    [sidebarWidth]
  );

  // Handle mouse move during resize
  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!isResizing.current) return;

    const deltaX = e.clientX - startX.current;
    let newWidth = startWidth.current + deltaX;

    // Apply constraints (min 250px, max 450px - can shrink 100px from default 350px)
    newWidth = Math.max(250, Math.min(450, newWidth));

    setSidebarWidth(newWidth);
  }, []);

  // Handle mouse up to end resizing
  const handleMouseUp = useCallback(() => {
    isResizing.current = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';

    // Remove event listeners
    document.removeEventListener('mousemove', handleMouseMove);
    document.removeEventListener('mouseup', handleMouseUp);
  }, [handleMouseMove]);

  // ============================================================================
  // SIMPLIFIED DIALOG SYNC - Defer job sync to not block dialog opening
  // ============================================================================
  useEffect(() => {
    if (open) {
      // Defer sync to allow dialog to open immediately (improves perceived performance)
      const syncTimeout = setTimeout(() => {
        void syncJobs();
      }, 300);

      // Refresh file uploader to show any ongoing uploads (deferred)
      const uploaderTimeout = setTimeout(() => {
        fileUploaderRef.current?.refreshUploads();
      }, 600);

      return () => {
        clearTimeout(syncTimeout);
        clearTimeout(uploaderTimeout);
      };
    } else {
      // Reset pre-fetch flag so Library tab reloads fresh data next time dialog opens
      preloadedLibraryFetched.current = false;
    }
  }, [open, syncJobs]);

  // ============================================================================
  // PRE-FETCH LIBRARY DATA - Load in background when dialog opens
  // ============================================================================
  useEffect(() => {
    // Only pre-fetch when dialog opens for the first time in this session
    if (!open || collectionsLoading || preloadedLibraryFetched.current) {
      return;
    }

    // No collections to fetch from
    if (contextCollections.length === 0) {
      setPreloadedLibraryLoading(false);
      return;
    }

    // Mark as fetched to prevent duplicate requests
    preloadedLibraryFetched.current = true;
    setPreloadedLibraryLoading(true);

    // Background fetch all documents from all collections
    const fetchLibraryData = async () => {
      try {
        // Fetch all pages for each collection in parallel (backend caps page_size at 100)
        // Bounded fan-out: one /documents/collection/{id} request per collection,
      // capped so a large workspace doesn't fire 30+ parallel requests that
      // contend on the backend pool and blow past the 5s perf threshold.
      const results = await mapWithConcurrency(contextCollections, 6, fetchAllPagesForCollection);
        // Deduplicate by doc.id (multi-collection membership can return same doc from multiple collections)
        const allDocuments = deduplicateById(results.flat());

        console.log(`[Library Pre-fetch] Loaded ${allDocuments.length} documents from ${contextCollections.length} collections`);
        setPreloadedLibraryDocs(allDocuments);
      } catch (err) {
        console.error('[Library Pre-fetch] Error:', err);
      } finally {
        setPreloadedLibraryLoading(false);
      }
    };

    // Defer fetch to not block dialog rendering
    const timeoutId = setTimeout(() => {
      void fetchLibraryData();
    }, 100);

    return () => clearTimeout(timeoutId);
  }, [open, contextCollections, collectionsLoading, fetchAllPagesForCollection]);

  // ============================================================================
  // REMOVED: Dead code - getAccessToken() and redirectToLogin() helper functions
  // These were only used in the removed complex initialization effect
  // ============================================================================

  // ============================================================================
  // REMOVED: Complex initialization and tracker check effects (300+ lines)
  // Now handled by usePersistentJobSync hook which:
  // - Manages WebSocket trackers globally (survive dialog close)
  // - Syncs with backend API and tracker registry
  // - Handles errors and retries automatically
  // - Provides simplified state (ongoingJobs, hasActiveJobs)
  // ============================================================================

  useEffect(() => {

    if (selectedStack) {
      void fetchDocumentsForCollection(selectedStack);
    } else {
      setExistingDocuments([]); // Clear documents if no stack is selected
      // Note: ongoingJobs managed by persistent hook, no need to clear manually
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are intentionally limited
  }, [selectedStack]);

  // Functions for stack management
  const handleAddNewStack = () => {
    // Wait for workspace to load
    if (workspaceLoading) {
      return;
    }

    // Check if we have a valid workspace ID before opening the modal
    if (!currentWorkspace?.id) {
      toast({
        title: t('chat.knowledgeStack.noWorkspaceAvailable'),
        description: t('chat.knowledgeStack.tryAgainLaterOrContact'),
        variant: 'destructive',
      });
      return;
    }

    // Default the parent selector to the collection the user is currently
    // looking at, so "Create" from the main button while a collection is
    // selected pre-fills it as the parent (the user's medicine → liver flow).
    // Falls back to top-level (null) when nothing is selected or the selected
    // collection is already at the max nesting depth (3). The selector inside
    // the modal still lets the user switch back to a top-level collection.
    const selected = selectedStack
      ? knowledgeStacks.find(s => s.id === selectedStack)
      : undefined;
    const defaultParent = selected && (selected.depth ?? 0) < 3 ? selected.id : null;

    // Only close parent dialog on actual small screens (not when just drawers are open)
    // This avoids nested dialog issues on mobile while allowing nested dialogs on desktop
    if (isSmallScreen) {
      onOpenChange(false);
      setShouldReopenParent(true);
      setTimeout(() => {
        setShowNewStackModal(true);
        setIsEditing(false);
        setNewStackName('');
        setNewStackDescription('');
        setNewStackCustomInstructions('');
        setNewStackGraphTier(null);
        setParentForSubcollection(defaultParent);
      }, 100);
    } else {
      // On large screens, show modal directly without closing parent
      setShowNewStackModal(true);
      setIsEditing(false);
      setNewStackName('');
      setNewStackDescription('');
      setNewStackCustomInstructions('');
      setNewStackGraphTier(null);
      setParentForSubcollection(defaultParent);
    }
  };

  const handleEditStack = (stackId: string) => {
    const stack = knowledgeStacks.find(s => s.id === stackId);
    const collection = contextCollections.find(c => c.id === stackId);
    setShowStackMenu(false);

    // Only close parent dialog on actual small screens (not when just drawers are open)
    // This avoids nested dialog issues on mobile while allowing nested dialogs on desktop
    if (isSmallScreen) {
      onOpenChange(false);
      setShouldReopenParent(true);
      setTimeout(() => {
        setShowNewStackModal(true);
        setIsEditing(true);
        setNewStackName(stack?.name || '');
        setNewStackDescription(collection?.description || '');
        setNewStackCustomInstructions(collection?.custom_instructions || collection?.customInstructions || '');
        // graph_tier (snake_case from the wire); null = inherit from parent. Use
        // ?? so an explicit 0 (no graph) is preserved instead of falling through.
        setNewStackGraphTier(collection?.graph_tier ?? collection?.graphTier ?? null);
        setActiveStackForMenu(stackId);
      }, 100);
    } else {
      // On large screens, show modal directly without closing parent
      setShowNewStackModal(true);
      setIsEditing(true);
      setNewStackName(stack?.name || '');
      setNewStackDescription(collection?.description || '');
      // Backend Jackson serializes to snake_case, so the API response
      // carries `custom_instructions`. Read it first, fall back to the
      // camelCase alias for any code path that pre-normalizes.
      setNewStackCustomInstructions(collection?.custom_instructions || collection?.customInstructions || '');
      setActiveStackForMenu(stackId);
    }
  };

  // Walk up parent_collection_id to find the tier a NULL (inherit) collection
  // would resolve to — mirrors the backend resolve_graph_tier. Root with no
  // explicit tier resolves to 0 (no graph).
  const resolveInheritedTier = (startParentId: string | null | undefined): number => {
    let pid = startParentId;
    const seen = new Set<string>();
    while (pid && !seen.has(pid)) {
      seen.add(pid);
      const parent = contextCollections.find(c => c.id === pid);
      if (!parent) break;
      const tier = parent.graph_tier ?? parent.graphTier;
      if (typeof tier === 'number') return tier;
      pid = parent.parentCollectionId || parent.parent_collection_id || null;
    }
    return 0;
  };

  // Ordered, depth-aware list of collections eligible to be a parent for a new
  // sub-collection. The backend caps nesting at depth 3, so only collections at
  // depth < 3 can take children. Walking the tree (not the flat list) keeps the
  // dropdown in visual hierarchy order; each entry carries its depth so the
  // label can be indented.
  const parentOptions = useMemo(() => {
    const tree = buildCollectionTree(contextCollections);
    const out: { id: string; name: string; depth: number }[] = [];
    const walk = (nodes: CollectionTreeNode[], depth: number) => {
      for (const n of nodes) {
        if (depth < 3) out.push({ id: n.id, name: n.name, depth });
        if (n.children.length) walk(n.children, depth + 1);
      }
    };
    walk(tree, 0);
    return out;
  }, [contextCollections]);

  const tierLabel = (n: number): string =>
    n === 2
      ? t('chat.knowledgeStack.graphTierFullShort', 'Full')
      : n === 1
        ? t('chat.knowledgeStack.graphTierLightShort', 'Light')
        : t('chat.knowledgeStack.graphTierNoneShort', 'None');

  // The tier a NULL (inherit) value resolves to for the collection currently in
  // the dialog — its parent's effective tier (or 0 at the root).
  const currentInheritedTier = (): number => {
    const editingCol = contextCollections.find(c => c.id === activeStackForMenu);
    const parentId = isEditing
      ? editingCol?.parentCollectionId || editingCol?.parent_collection_id || null
      : parentForSubcollection;
    return resolveInheritedTier(parentId);
  };

  const handleGenerateCustomInstructions = async () => {
    if (!isEditing || !activeStackForMenu) {
      return;
    }
    setIsGeneratingCustomInstructions(true);
    try {
      const result = await generateCollectionCustomInstructions(activeStackForMenu);
      setNewStackCustomInstructions(result.customInstructions);
      // when the AI had to invent a description because
      // the collection didn't have one, surface it in the description
      // textarea so the user can review (and the next save persists it
      // back to the collections table).
      if (result.descriptionGenerated && result.descriptionUsed) {
        setNewStackDescription(result.descriptionUsed);
      }
      toast({
        title: t('general.success'),
        description: t('chat.knowledgeStack.customInstructionsGenerated', 'Custom instructions generated'),
      });
    } catch (error) {
      console.error('Error generating custom instructions:', error);
      toast({
        title: t('general.error'),
        description:
          error instanceof Error
            ? error.message
            : t('chat.knowledgeStack.failedToGenerateCustomInstructions', 'Failed to generate custom instructions'),
        variant: 'destructive',
      });
    } finally {
      setIsGeneratingCustomInstructions(false);
    }
  };

  const handleGenerateDescription = async () => {
    // Check if collection name is provided
    if (!newStackName.trim()) {
      toast({
        title: t('general.error'),
        description: t('chat.knowledgeStack.stackNameEmpty'),
        variant: 'destructive',
      });
      return;
    }

    setIsGeneratingDescription(true);
    try {
      let generated: string;

      if (isEditing && activeStackForMenu) {
        // Edit mode: send the current (possibly user-edited) textarea text so the
        // backend refines it by merging in book summaries — preserving the user's
        // wording instead of overwriting it.
        generated = await generateCollectionDescription(activeStackForMenu, newStackDescription.trim());
      } else {
        // Create mode: use new endpoint with just the name
        generated = await generateCollectionDescriptionFromName(newStackName.trim());
      }

      setNewStackDescription(generated);
      toast({
        title: t('general.success'),
        description: t('chat.knowledgeStack.descriptionGenerated'),
      });
    } catch (error) {
      console.error('Error generating description:', error);
      toast({
        title: t('general.error'),
        description: error instanceof Error ? error.message : t('chat.knowledgeStack.failedToGenerateDescription'),
        variant: 'destructive',
      });
    } finally {
      setIsGeneratingDescription(false);
    }
  };

  const handleNewStackModalChange = (open: boolean) => {
    if (!open) {
      setShowNewStackModal(false);
      // Reopen parent dialog if we closed it
      if (shouldReopenParent) {
        setShouldReopenParent(false);
        setTimeout(() => {
          onOpenChange(true);
        }, 100);
      }
    }
  };

  // Placeholder functions for future implementation
  const handleViewChunks = () => {

    // Future implementation for viewing chunks
  };

  const handleTweakSettings = () => {

    // Future implementation for tweaking settings
  };

  const handleAddToBookmarks = () => {

    // Future implementation for adding to bookmarks
  };

  // ============================================================================
  // SIMPLIFIED handleComposeClick - Processes pending documents OR uploads new files
  // ============================================================================
  const handleComposeClick = async () => {
    if (!selectedStack) {
      toast({
        title: t('chat.knowledgeStack.noStackSelected'),
        description: t('chat.knowledgeStack.selectOrCreateStack'),
        variant: 'destructive',
      });
      return;
    }

    // Switch to the upload tab
    setActiveTab('upload');

    // Check if specific documents are selected — process only those
    const selectedIds = fileUploaderRef.current?.getSelectedDocumentIds?.() ?? [];
    if (selectedIds.length > 0) {
      try {
        for (const docId of selectedIds) {
          await processDocument(docId);
        }
        fileUploaderRef.current?.clearSelection?.();
        toast({
          title: t('chat.knowledgeStack.processingStarted') || 'Processing Started',
          description: `Processing ${selectedIds.length} selected document(s)`,
        });
        setTimeout(() => syncJobs(), 500);
        setTimeout(() => {
          if (selectedStack) fetchDocumentsForCollection(selectedStack);
        }, 1000);
      } catch (error) {
        console.error('Error processing selected documents:', error);
        toast({
          title: t('general.error'),
          description: t('chat.knowledgeStack.failedToProcessDocuments') || 'Failed to process pending documents',
          variant: 'destructive',
        });
      }
      return;
    }

    // Check if we have pending documents in the collection
    if (hasPendingDocuments) {
      try {
        // Call the new endpoint to process all pending documents
        const response = await apiClient.post(
          `/documents/process_pending_documents/${selectedStack}`
        );

        if (response.data) {
          const { documents_processed, message } = response.data;

          // Only show toast if we actually processed documents
          if (documents_processed > 0) {
            // Start batch progress tracking
            setBatchProcessing({
              total: documents_processed,
              pending: documents_processed,
              collectionId: selectedStack,
            });

            toast({
              title: t('chat.knowledgeStack.processingStarted') || 'Processing Started',
              description: message || `Processing ${documents_processed} pending documents`,
            });
          }

          // Sync jobs to track the new processing jobs
          setTimeout(() => syncJobs(), 500);

          // Refresh documents list
          setTimeout(() => {
            if (selectedStack) {
              void fetchDocumentsForCollection(selectedStack);
            }
          }, 1000);
        }
      } catch (error) {
        console.error('Error processing pending documents:', error);
        toast({
          title: t('general.error'),
          description: t('chat.knowledgeStack.failedToProcessDocuments') || 'Failed to process pending documents',
          variant: 'destructive',
        });
      }
      return;
    }

    // Fallback: Check if file uploader has unprocessed files
    if (!fileUploaderRef.current) {
      console.error('File uploader reference is not available');
      toast({
        title: t('chat.knowledgeStack.uploadError'),
        description: t('chat.knowledgeStack.uploaderNotReady'),
        variant: 'destructive',
      });
      return;
    }

    const hasFiles = fileUploaderRef.current.hasUnprocessedFiles?.();
    if (!hasFiles) {
      toast({
        title: t('chat.knowledgeStack.noFilesToUpload'),
        description: t('chat.knowledgeStack.addFilesBeforeCompose'),
        variant: 'destructive',
      });
      return;
    }

    // Trigger file upload
    setTimeout(() => {
      if (fileUploaderRef.current) {
        fileUploaderRef.current.uploadFiles();
        // Sync jobs after upload starts to detect new jobs
        setTimeout(() => syncJobs(), 1000);
      }
    }, 100);
  };

  // Handle abort upload with confirmation
  const handleAbortUpload = () => {
    // Open the confirmation dialog
    setIsAbortConfirmationOpen(true);
  };

  // ============================================================================
  // SIMPLIFIED confirmAbortUpload - Cancels all ongoing jobs on backend
  // ============================================================================
  const confirmAbortUpload = async () => {
    setIsAbortConfirmationOpen(false);
    setIsCancellingJobs(true);

    try {
      // Cancel all ongoing jobs on the backend
      if (ongoingJobs && ongoingJobs.length > 0) {
        console.log(`🛑 Cancelling ${ongoingJobs.length} ongoing job(s)...`);

        // Cancel each job in parallel
        const cancelPromises = ongoingJobs.map(async (job) => {
          try {
            const success = await cancelDocumentProcessing(job.jobId);
            if (success) {
              console.log(`Successfully cancelled job ${job.jobId}`);
            } else {
              console.warn(`⚠️ Failed to cancel job ${job.jobId}`);
            }
            return success;
          } catch (error) {
            console.error(`❌ Error cancelling job ${job.jobId}:`, error);
            return false;
          }
        });

        // Wait for all cancellations to complete
        const results = await Promise.all(cancelPromises);
        const successCount = results.filter(r => r).length;

        if (successCount > 0) {
          toast({
            title: t('general.success'),
            description: `Cancelled ${successCount} of ${ongoingJobs.length} job(s)`,
          });
        } else {
          toast({
            title: t('general.error'),
            description: 'Failed to cancel jobs. Please try again.',
            variant: 'destructive',
          });
        }
      }

      // Also abort any in-flight file uploads
      if (fileUploaderRef.current) {
        fileUploaderRef.current.abortUpload();
      }

      // Refresh the documents list and sync jobs after aborting
      if (selectedStack) {
        // Immediately sync jobs to update hasActiveJobs state
        void syncJobs();

        // Then fetch documents after a small delay
        setTimeout(() => {
          void fetchDocumentsForCollection(selectedStack);
        }, 300);
      }
    } catch (error) {
      console.error('Error during abort:', error);
      toast({
        title: t('general.error'),
        description: 'An error occurred while cancelling jobs',
        variant: 'destructive',
      });
    } finally {
      // Reset cancelling state after a small delay to ensure UI updates
      setTimeout(() => {
        setIsCancellingJobs(false);
      }, 100);
    }
  };

  // Simplified function to refresh collections from context
  const fetchCollections = async () => {
    try {
      await refreshCollections();
      setIsLoading(false);
    } catch (error) {
      console.error('❌ Error refreshing collections:', error);
      setIsLoading(false);
      toast({
        title: t('general.error'),
        description: t('chat.knowledgeStack.errorLoadingStacks'),
        variant: 'destructive',
      });
    }
  };

  // Function to fetch documents for a collection with pagination support
  const fetchDocumentsForCollection = async (
    collectionId: string,
    page: number = 1,
    append: boolean = false,
    searchQuery: string = '',
    silent: boolean = false
  ) => {
    if (append) {
      setIsLoadingMoreDocuments(true);
    } else if (!silent) {
      setIsLoadingDocuments(true);
      setCurrentPage(1);
    }

    try {
      const response = await getDocumentsByCollection(
        collectionId,
        page,
        10,
        currentWorkspace?.id,
        searchQuery
      );

      if (response) {
        const { documents, hasMore, total } = response;

        // Update total documents count if available
        if (typeof total === 'number') {
          setTotalDocumentsInCollection(total);
        }

        // Always preserve in-progress documents at the top, regardless of pagination.
        // Crucially, when a doc reappears in the new backend response, prefer the
        // BACKEND version over the prev in-memory copy — otherwise a doc that
        // just completed (now status=completed in backend) stays pinned at its
        // last in-progress snapshot in prev and the ring stays at e.g. 76 % long
        // after the worker moved on.
        setExistingDocuments(prev => {
          const newById = new Map(documents.map(d => [d.id, d] as const));

          // For each prev in-progress doc, take the newer backend version if
          // present; otherwise fall back to prev. Drops nothing — pure refresh.
          const prevInProgressDocs = prev
            .filter(isDocumentInProgress)
            .map(d => newById.get(d.id) ?? d);

          // New backend docs that are also in-progress and not yet in prev.
          const inProgressIds = new Set(prevInProgressDocs.map(doc => doc.id));
          const additionalInProgress = documents
            .filter(isDocumentInProgress)
            .filter(doc => !inProgressIds.has(doc.id));
          const allInProgressDocs = [...prevInProgressDocs, ...additionalInProgress];

          // Get all in-progress IDs to filter them out from completed docs
          const allInProgressIds = new Set(allInProgressDocs.map(doc => doc.id));

          if (append) {
            // For pagination: append new completed docs (excluding in-progress).
            // Replace prev completed entries with their new backend version when
            // the same id reappears — same freshness rule as in-progress.
            const prevCompleted = prev
              .filter(doc => !allInProgressIds.has(doc.id))
              .map(d => newById.get(d.id) ?? d);
            const prevIds = new Set(prevCompleted.map(d => d.id));
            const newCompleted = documents
              .filter(doc => !allInProgressIds.has(doc.id) && !prevIds.has(doc.id));

            return [...allInProgressDocs, ...prevCompleted, ...newCompleted];
          } else {
            // Initial load / silent refresh: replace completed docs with new ones
            const newCompleted = documents.filter(doc => !allInProgressIds.has(doc.id));
            return [...allInProgressDocs, ...newCompleted];
          }
        });

        setHasMoreDocuments(hasMore);
        setCurrentPage(page);
      } else {
        console.error(
          'Failed to fetch documents: Invalid response structure',
          response
        );
        toast({
          title: t('general.error'),
          description: t('chat.knowledgeStack.failedToFetchDocuments'),
          variant: 'destructive',
        });
      }
    } catch (error) {
      console.error('Error fetching documents:', error);
      toast({
        title: t('general.error'),
        description: t('chat.knowledgeStack.failedToFetchDocumentsTryAgain'),
        variant: 'destructive',
      });
    } finally {
      if (append) {
        setIsLoadingMoreDocuments(false);
      } else {
        setIsLoadingDocuments(false);
      }
    }
  };

  // Function to load more documents
  const loadMoreDocuments = () => {
    if (hasMoreDocuments && !isLoadingMoreDocuments && selectedStack) {
      void fetchDocumentsForCollection(selectedStack, currentPage + 1, true, localSearchQuery);
    }
  };

  // Add a useEffect to check for unprocessed files whenever files change
  useEffect(() => {
    // Check if the file uploader has unprocessed files
    if (fileUploaderRef.current) {
      const hasFiles = fileUploaderRef.current.hasUnprocessedFiles?.() || false;
      setHasUnprocessedFiles(hasFiles);
    }
  }, []);

  // Modified useEffect to fetch collections when the dialog opens or when workspace ID changes
  // Skip if collections are already loaded in context to avoid redundant API calls
  useEffect(() => {
    if (open && currentWorkspace?.id && !workspaceLoading) {
      // Force sync jobs when dialog opens (poll for active jobs in case WebSocket is broken)
      void forceSync();

      // Only fetch if we don't have collections yet or if it's a workspace change
      if (contextCollections.length === 0 && !collectionsLoading) {
        void fetchCollections();
      } else {
        // Collections already loaded, just mark as not loading
        setIsLoading(false);
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are intentionally limited
  }, [open, currentWorkspace?.id, workspaceLoading, contextCollections.length, collectionsLoading, forceSync]);

  // Fetch saved searches when dialog opens
  useEffect(() => {
    if (open && currentWorkspace?.id) {
      listSavedSearches(currentWorkspace.id).then(setSavedSearches).catch(() => {});
    }
  }, [open, currentWorkspace?.id]);

  // Auto-select first collection when collections are loaded and none is selected
  // OR when selected collection no longer exists (e.g., after deletion)
  useEffect(() => {
    // Skip auto-select if we just manually selected a collection
    if (isManualSelection.current) {
      isManualSelection.current = false;
      return;
    }

    if (!selectedStack && knowledgeStacks.length > 0) {
      // No selection - auto-select first stack
      setSelectedStack(knowledgeStacks[0].id);
    } else if (selectedStack && knowledgeStacks.length > 0) {
      // Check if selected stack still exists in the list
      const stillExists = knowledgeStacks.some(s => s.id === selectedStack);
      if (!stillExists) {
        // Selected stack was removed, select first available
        setSelectedStack(knowledgeStacks[0].id);
      }
    }
  }, [selectedStack, knowledgeStacks]);

  // Clear documents when switching collections to prevent stale data from previous collection
  useEffect(() => {
    setExistingDocuments([]);
    setHasMoreDocuments(false);
    setCurrentPage(1);
  }, [selectedStack]);

  // Reset the selected stack only on a REAL workspace transition. Firing on
  // initial mount would wipe the restored `lastKnowledgeCollectionId` and
  // force the auto-select effect above to land on `knowledgeStacks[0]`.
  useEffect(() => {
    const currentId = currentWorkspace?.id ?? null;
    const previousId = previousWorkspaceIdRef.current;
    previousWorkspaceIdRef.current = currentId;
    if (previousId === null) return; // initial mount — keep the restored selection
    if (previousId === currentId) return; // no actual change
    setSelectedStack(null);
    setExistingDocuments([]);
  }, [currentWorkspace?.id]);

  // Function to refresh workspace storage information
  const refreshWorkspaceStorage = async () => {
    if (!currentWorkspace?.id) return;

    try {
      const storageData = await getWorkspaceStorage(currentWorkspace.id);
      if (storageData) {
        setWorkspaceStorage({
          storage_used_bytes: storageData.storage_used_bytes,
          storage_used_gb: storageData.storage_used_gb,
          documents_count: storageData.documents_count,
        });
      }
    } catch (error) {
      console.error('❌ Failed to refresh storage:', error);
    }
  };

  // Fetch workspace role and storage information (deferred for faster dialog open)
  useEffect(() => {
    if (!currentWorkspace?.id || !open) return;

    // Defer workspace info fetch to not block dialog opening
    const timeoutId = setTimeout(async () => {
      // Fetch user's role in workspace
      try {
        const roleData = await getMyWorkspaceRole(currentWorkspace.id);
        if (roleData) {
          setWorkspaceRole(roleData.role);
          setCanUpload(roleData.permissions.can_edit); // Viewers cannot upload
        }
      } catch (error) {
        console.error('❌ Failed to fetch role:', error);
      }

      // Fetch workspace storage
      await refreshWorkspaceStorage();
    }, 500);

    return () => clearTimeout(timeoutId);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are intentionally limited
  }, [currentWorkspace?.id, open]);

  // Track expanded/collapsed state for collection tree
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => {
    try {
      const stored = localStorage.getItem('scrapalot_expanded_collections');
      return stored ? new Set(JSON.parse(stored)) : new Set<string>();
    } catch { return new Set<string>(); }
  });

  const toggleExpanded = useCallback((id: string) => {
    console.log('[TreeView] toggleExpanded called for:', id);
    setExpandedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      console.log('[TreeView] expandedIds now:', [...next]);
      try { localStorage.setItem('scrapalot_expanded_collections', JSON.stringify([...next])); } catch { /* ignore */ }
      return next;
    });
  }, []);

  // Scroll handler for loading more collections
  useEffect(() => {
    const handleCollectionsScroll = () => {
      const container = collectionsContainerRef.current;
      if (!container || !hasMore) return;

      const { scrollTop, scrollHeight, clientHeight } = container;
      if (scrollTop + clientHeight >= scrollHeight - 100) {
        void loadMoreCollections();
      }
    };

    const container = collectionsContainerRef.current;
    if (container && open) {
      container.addEventListener('scroll', handleCollectionsScroll);

      // Auto-load more if container is not scrollable (content shorter than viewport)
      // This handles cases where collapsed tree hides children, making container too short
      if (hasMore && container.scrollHeight <= container.clientHeight + 50) {
        void loadMoreCollections();
      }

      return () =>
        container.removeEventListener('scroll', handleCollectionsScroll);
    }
  }, [loadMoreCollections, open, hasMore, expandedIds]);

  // Then add this computed value before your return statement
  const filteredStacks = searchQuery
    ? knowledgeStacks.filter(stack =>
      stack.name.toLowerCase().includes(searchQuery.toLowerCase())
    )
    : knowledgeStacks;


  // Flatten tree to depth-aware list for rendering (respects expanded/collapsed state)
  const treeOrderedStacks = useMemo(() => {
    if (searchQuery) return filteredStacks; // During search, show flat filtered results
    const tree = buildCollectionTree(filteredStacks);
    const result: (typeof filteredStacks[0] & { _hasChildren: boolean })[] = [];
    const flatten = (nodes: CollectionTreeNode[]) => {
      for (const node of nodes) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- CollectionTreeNode spreads cleanly but TS can't verify the intersection matches the result type
        result.push({ ...node, _hasChildren: node.children.length > 0 } as any);
        if (node.children.length > 0 && expandedIds.has(node.id)) {
          flatten(node.children);
        }
      }
    };
    flatten(tree);
    return result;
  }, [filteredStacks, expandedIds, searchQuery]);

  // When the dialog opens, expand the restored selection's ancestor chain and
  // scroll it to the middle of the list, so the user always lands on their last
  // collection instead of having to scroll down to find it every time. Runs once
  // per open (the ref resets on close) so clicking another collection while the
  // dialog stays open doesn't yank the scroll position around.
  const didScrollToSelectedRef = useRef(false);
  useEffect(() => {
    if (!open) {
      didScrollToSelectedRef.current = false;
      return;
    }
    if (didScrollToSelectedRef.current) return;
    if (collectionsLoading || !selectedStack) return;
    if (!knowledgeStacks.some(s => s.id === selectedStack)) return;
    didScrollToSelectedRef.current = true;

    // Expand the ancestor chain so a nested selection is actually rendered.
    setExpandedIds(prev => {
      const next = new Set(prev);
      const seen = new Set<string>();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mapped stack carries both casings
      let cur: any = knowledgeStacks.find(s => s.id === selectedStack);
      while (cur) {
        const pid = cur.parentCollectionId || cur.parent_collection_id;
        if (!pid || seen.has(pid)) break;
        seen.add(pid);
        next.add(pid);
        cur = knowledgeStacks.find(s => s.id === pid);
      }
      return next;
    });

    // Defer past the expand re-render; retry once in case pagination/layout
    // settles a beat later.
    const scrollToSelected = () => {
      const container = collectionsContainerRef.current;
      const el = container?.querySelector(
        `[data-testid="knowledge-collection-item-${selectedStack}"]`
      );
      if (el) (el as HTMLElement).scrollIntoView({ block: 'center' });
      return !!el;
    };
    setTimeout(() => { if (!scrollToSelected()) setTimeout(scrollToSelected, 200); }, 100);
  }, [open, collectionsLoading, selectedStack, knowledgeStacks]);

  // Update existing functions to use API calls

  const handleCreateStack = async () => {
    if (!newStackName.trim()) {
      toast({
        title: t('general.error'),
        description: t('chat.knowledgeStack.stackNameEmpty'),
        variant: 'destructive',
      });
      return;
    }

    if (!currentWorkspace?.id) {
      toast({
        title: t('general.error'),
        description: t('chat.knowledgeStack.noWorkspaceSelected'),
        variant: 'destructive',
      });
      return;
    }
    setIsLoading(true);
    try {
      if (isEditing && activeStackForMenu) {
        // always send the current textarea value.
        // The previous "skip when unchanged vs contextCollections"
        // optimization was unreliable: if the merge after a prior save
        // didn't propagate to contextCollections in time (stale React
        // closure, refetch race), the next save would compare against
        // a stale value and decide nothing changed → field omitted →
        // user thinks save failed.
        // Wire convention (CollectionController): empty string is an
        // explicit wipe; "leave alone" requires the field to be absent
        // entirely, which we don't need from the dialog.
        const updatedCollection = await updateCollection(
          activeStackForMenu,
          {
            name: newStackName.trim(),
            description: newStackDescription.trim() || undefined,
            customInstructions: newStackCustomInstructions.trim(),
            // null = reset to inherit-from-parent; 0/1/2 = explicit tier.
            graphTier: newStackGraphTier,
          },
          currentWorkspace?.id || ''
        );

        // Check if update was successful
        if (updatedCollection) {
          // Immediately update in context for instant UI feedback
          updateCollectionInState(updatedCollection.id, updatedCollection);

          // Notify parent component about the change (dropdown will refresh and re-select)
          // Pass the updated collection ID to maintain selection in dropdown
          onCollectionChange?.(updatedCollection.id);

          // pull a fresh list so any component that
          // re-reads contextCollections (incl. the next dialog open)
          // sees the just-saved custom_instructions even if the
          // optimistic merge above left a stale field somewhere.
          // clearCache('/collections/') inside updateCollection() makes
          // sure this hits the BE, not the 60s cache.
          void refreshCollections();

          toast({
            title: t('general.success'),
            description: t('chat.knowledgeStack.stackUpdatedSuccessfully'),
          });
        } else {
          // If update failed, refresh from server to ensure consistency
          await refreshCollections();
        }

        // Close modal after successful update
        setShowNewStackModal(false);
        setNewStackName('');
        setNewStackDescription('');
        setNewStackCustomInstructions('');
        setNewStackGraphTier(null);
        setIsEditing(false);
      } else {
        // Create new stack with the current workspace ID
        const newCollection = await createCollection({
          workspace_id: currentWorkspace.id,
          name: newStackName.trim(),
          description: newStackDescription.trim() || undefined,
          parentCollectionId: parentForSubcollection || undefined,
          // null = inherit from parent (a sub-collection follows its parent's tier).
          graphTier: newStackGraphTier,
        });
        // Auto-expand parent so new subcollection is visible
        if (parentForSubcollection) {
          setExpandedIds(prev => {
            const next = new Set(prev);
            next.add(parentForSubcollection);
            try { localStorage.setItem('scrapalot_expanded_collections', JSON.stringify([...next])); } catch { /* ignore */ }
            return next;
          });
        }
        setParentForSubcollection(null);

        // Check if creation was successful before refreshing collections
        if (newCollection && newCollection.id) {
          // Immediately add to state for instant UI feedback (like update path does)
          addCollectionToState(newCollection);

          // Mark as manual selection to prevent auto-select from overriding
          isManualSelection.current = true;

          // Select the newly created collection locally
          setSelectedStack(newCollection.id);

          // Notify parent component about the change with the new collection ID for auto-selection
          // The callback will handle refreshCollections() and dropdown auto-selection
          onCollectionChange?.(newCollection.id);

          // Close modal after adding to state
          setShowNewStackModal(false);
          setNewStackName('');
          setNewStackDescription('');
          setNewStackCustomInstructions('');
        setNewStackGraphTier(null);
          setIsEditing(false);

          toast({
            title: t('general.success'),
            description: t('chat.knowledgeStack.stackCreatedSuccessfully'),
          });
        }
      }
    } catch (error) {
      console.error('Failed to create/update knowledge stack:', error);
      toast({
        title: t('general.error'),
        description: t('chat.knowledgeStack.failedToCreateUpdateStack'),
        variant: 'destructive',
      });
      // Close modal on error too
      setShowNewStackModal(false);
      setNewStackName('');
      setNewStackDescription('');
      setNewStackCustomInstructions('');
      setIsEditing(false);
    } finally {
      setIsLoading(false);
    }
  };

  const deletingIdsRef = useRef(new Set<string>());

  const handleDeleteStack = async (stackId: string) => {
    // Guard against duplicate deletes (rapid clicks or stale UI)
    if (deletingIdsRef.current.has(stackId)) return;
    deletingIdsRef.current.add(stackId);

    try {
      // Optimistically remove from state FIRST (no skeleton, no blink)
      removeCollectionFromState(stackId);

      // Update selection using contextCollections (fresh from context, not stale knowledgeStacks)
      if (selectedStack === stackId) {
        const remaining = contextCollections.filter(col => col.id !== stackId && !deletingIdsRef.current.has(col.id));
        setSelectedStack(remaining.length > 0 ? remaining[0].id : null);
      }

      // Then delete on backend (if it fails, we'll refresh to restore)
      await deleteCollection(stackId);
    } catch (error) {
      console.error('Error deleting collection:', error);
      toast({
        title: t('general.error'),
        description: t('chat.knowledgeStack.failedToDeleteStack'),
        variant: 'destructive',
      });
      // Restore state on error
      await refreshCollections();
    } finally {
      deletingIdsRef.current.delete(stackId);
      setShowStackMenu(false);
      setIsDeleteConfirmationOpen(false);
      setDeletingStackId(null);
    }
  };


  // Add handleDeleteDocument function to handle document deletion
  const handleDeleteDocument = async (documentId: string) => {
    if (!documentId || !selectedStack) {
      toast({
        title: t('general.error'),
        description: t('chat.knowledgeStack.cannotDeleteDocument'),
        variant: 'destructive',
      });
      return;
    }

    try {
      // Pass only the documentId now
      await deleteDocument(documentId);

      // Remove the document from local state immediately (optimistic update)
      // No need to refresh from backend - the deletion was successful
      setExistingDocuments(prev => prev.filter(doc => doc.id !== documentId));
    } catch (error: unknown) {
      console.error('Error deleting document:', error);
      const axiosErr = error as { response?: { status?: number } };

      // If document is already deleted (404), still remove from local state
      if (axiosErr?.response?.status === 404) {
        // Remove the document from local state immediately
        setExistingDocuments(prev => prev.filter(doc => doc.id !== documentId));
      } else {
        toast({
          title: t('general.error'),
          description: t('chat.knowledgeStack.failedToDeleteDocument'),
          variant: 'destructive',
        });
      }
    }
  };

  // Add handleCleanupEmbeddings function
  const handleCleanupEmbeddings = async (stackId: string) => {
    setIsCleaningUpEmbeddings(true);
    try {
      // Call the cleanup API api_base
      const response = await fetch(
        `${API_BASE_URL}/api/documents/cleanup-embeddings/${stackId}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${localStorage.getItem('auth_tokens') ? JSON.parse(localStorage.getItem('auth_tokens') || '{}').access_token : ''}`,
          },
        }
      );

      if (!response.ok) {
        console.error('Error cleaning up embeddings:', response.statusText);
        toast({
          title: t('general.error'),
          description: `${t('chat.knowledgeStack.failedToCleanupEmbeddings')}: ${response.statusText}`,
          variant: 'destructive',
        });
        return;
      }

      const result = await response.json();

      // Refresh documents for this collection if it's selected
      if (selectedStack === stackId) {
        void fetchDocumentsForCollection(stackId);
      }

      toast({
        title: t('chat.knowledgeStack.embeddingsCleaned'),
        description: t('chat.knowledgeStack.embeddingsCleanedDescription', { count: result.deleted_count }),
      });
    } catch (error) {
      console.error('Error cleaning up embeddings:', error);
      toast({
        title: t('general.error'),
        description: `${t('chat.knowledgeStack.failedToCleanupEmbeddings')}: ${error instanceof Error ? error.message : String(error)}`,
        variant: 'destructive',
      });
    } finally {
      setIsCleaningUpEmbeddings(false);
    }
  };

  // Render tab content based on active tab (or specified tab for sliding animation)
  const renderTabContent = (tabId: KnowledgeTab = activeTab) => {
    switch (tabId) {
      case 'upload':
        return (
          <div className='h-full flex flex-col bg-white dark:bg-black'>
            {/* Unified search bar — toggle between local files and online books */}
            <div className={cn('shrink-0', isMobile ? 'px-3 pt-2' : 'px-4 pt-4')}>
              <div className={cn(
                'relative flex gap-2 p-1.5',
                'bg-background/80 dark:bg-background/60',
                'backdrop-blur-md',
                'border border-border/50',
                'shadow-lg shadow-black/5 dark:shadow-black/20',
              )}>
                <div className='relative flex-1'>
                  <Search className='absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground' />
                  <Input
                    type='text'
                    placeholder={uploadSearchMode === 'online'
                      ? t('knowledge.externalBooks.searchPlaceholder', 'Search books online...')
                      : t('knowledge.files.searchPlaceholder', 'Search files...')
                    }
                    value={localSearchQuery}
                    onChange={(e) => {
                      const query = e.target.value;
                      setLocalSearchQuery(query);
                      if (uploadSearchMode === 'local' && selectedStack) {
                        void fetchDocumentsForCollection(selectedStack, 1, false, query);
                      }
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && uploadSearchMode === 'online') {
                        setExternalSearchTrigger(prev => prev + 1);
                      }
                    }}
                    className='pl-9 pr-10 h-11 border-0 bg-transparent focus-visible:ring-0 focus-visible:ring-offset-0 text-base'
                  />
                  {localSearchQuery && (
                    <button
                      onClick={() => {
                        setLocalSearchQuery('');
                        if (uploadSearchMode === 'local' && selectedStack) {
                          void fetchDocumentsForCollection(selectedStack, 1, false, '');
                        }
                      }}
                      className={cn(
                        'absolute right-3 top-1/2 -translate-y-1/2',
                        'h-5 w-5 flex items-center justify-center',
                        'text-muted-foreground/40 hover:text-muted-foreground',
                        'transition-all duration-200 ease-out',
                        'hover:bg-muted/30',
                        'rounded-sm'
                      )}
                    >
                      <X className='h-4 w-4' />
                    </button>
                  )}
                </div>
                {/* Online mode with a query → submit button (triggers the search on click).
                    Otherwise → mode toggle between local files and online books. */}
                {selectedStack && uploadSearchMode === 'online' && localSearchQuery.trim() ? (
                  <button
                    onClick={() => setExternalSearchTrigger(prev => prev + 1)}
                    title={t('knowledge.externalBooks.search', 'Search')}
                    aria-label={t('knowledge.externalBooks.search', 'Search')}
                    className={cn(
                      'shrink-0 h-11 w-11 flex items-center justify-center',
                      'border border-primary bg-primary text-primary-foreground',
                      'transition-all duration-200 hover:bg-primary/90'
                    )}
                  >
                    <CornerDownLeft className='h-4 w-4' />
                  </button>
                ) : selectedStack && (
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          onClick={() => {
                            setUploadSearchMode(prev => prev === 'local' ? 'online' : 'local');
                            setLocalSearchQuery('');
                          }}
                          className={cn(
                            'shrink-0 h-11 w-11 flex items-center justify-center',
                            'border transition-all duration-200',
                            uploadSearchMode === 'online'
                              ? 'bg-primary/10 border-primary/30 text-primary'
                              : 'bg-transparent border-border/50 text-muted-foreground hover:text-foreground hover:border-border'
                          )}
                        >
                          <Globe className='h-4 w-4' />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent>
                        {uploadSearchMode === 'online'
                          ? t('knowledge.files.searchLocal', 'Search local files')
                          : t('knowledge.externalBooks.title', 'Find books online')
                        }
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                )}
              </div>
            </div>

            {/* Single scroll container for everything below the search bar */}
            <div className='flex-1 overflow-y-auto'>
              {/* Online search results — shown only in online mode */}
              {uploadSearchMode === 'online' && selectedStack && (
                <ExternalBooksSearch
                  collectionId={selectedStack}
                  embedded
                  externalQuery={localSearchQuery}
                  externalSearchTrigger={externalSearchTrigger}
                  onBookDownloaded={() => {
                    toast.success(t('knowledge.downloadedBooks.bookDownloaded', 'Book downloaded! Ready for processing.'));
                    if (selectedStack) {
                      void fetchDocumentsForCollection(selectedStack, 1, false, '');
                    }
                    void refreshPreloadedLibrary();
                  }}
                />
              )}

              {/* File Upload Section */}
              <div className='p-4 space-y-4'>
                <KnowledgeFileUploader
                  ref={fileUploaderRef}
                  collectionId={selectedStack || ''}
                  existingDocuments={existingDocuments}
                  isLoading={isLoadingDocuments}
                  hasMore={hasMoreDocuments}
                  onLoadMore={loadMoreDocuments}
                  isLoadingMore={isLoadingMoreDocuments}
                  ongoingJobs={ongoingJobs}
                  ongoingJobsLoaded={!jobsLoading}
                  readOnly={!canUpload}
                  onUploadComplete={() => {
                    if (selectedStack) {
                      void fetchDocumentsForCollection(selectedStack, 1, false, localSearchQuery);
                    }
                    void refreshPreloadedLibrary();
                  }}
                  onDeleteDocument={canUpload ? async (documentId) => {
                    await handleDeleteDocument(documentId);
                    void refreshPreloadedLibrary();
                  } : undefined}
                  onSelectionChange={(ids) => setSelectedPendingCount(ids.length)}
                />
              </div>
            </div>
          </div>
        );

      case 'library':
        return (
          <LibraryView
            preloadedDocuments={preloadedLibraryDocs}
            preloadedLoading={preloadedLibraryLoading}
            initialCollection={selectedStack || undefined}
            readOnly={!canUpload}
            savedSearchDocIds={savedSearchDocIds}
            onCollectionChange={(id) => { setSelectedStack(id); setActiveSavedSearchId(null); setSavedSearchDocIds(null); }}
            onRefresh={refreshPreloadedLibrary}
            onRequestCloseStacks={() => onOpenChange?.(false)}
          />
        );

      case 'connectors':
        return (
          <div className='h-full flex flex-col'>
            <div className='flex-1 overflow-y-auto p-4 space-y-4 bg-white dark:bg-black'>
              {/* Header - matching Files tab structure */}
              <div className='flex items-center gap-2'>
                <Plug2 className='h-5 w-5 text-zinc-600 dark:text-zinc-400' />
                <h3 className='text-lg font-semibold text-zinc-800 dark:text-white'>
                  {t('knowledge.tabs.connectors')}
                </h3>
              </div>

              <KnowledgeConnectors
                isNarrowScreen={effectiveNarrow}
                collectionId={selectedStack || ''}
                workspaceId={currentWorkspace?.id}
                embedded={true}
                onConnectorConfigured={() => {
                  if (selectedStack) {
                    void fetchDocumentsForCollection(selectedStack);
                  }
                }}
              />
            </div>
          </div>
        );

      default:
        return null;
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange} modal={!isAnyDrawerOpen}>
      <DialogContent
        data-knowledge-stacks-dialog="true"
        className={cn(
          'flex flex-col border-zinc-300 dark:border-zinc-800 bg-white dark:bg-black overflow-visible z-[1050]',
          isNarrowScreen
            ? 'h-full max-h-[100vh] max-w-full p-0 rounded-none !inset-0 !left-0 !top-0 !translate-x-0 !translate-y-0 !transform-none'
            : isSplitScreen
              ? cn(
                  'h-full max-h-[100vh] !max-w-none p-0 rounded-none !top-0 !bottom-0 !translate-x-0 !translate-y-0 !transform-none',
                  isDrawerOnLeft
                    ? '!left-[50vw] !w-[50vw]'
                    : '!left-[70px] !w-[calc(50vw-70px)]'
                )
              : isMaximized
                ? '!max-w-none !max-h-none p-0'
                : 'w-[80vw] min-w-[1400px] max-w-[95vw] h-[90vh] p-0'
        )}
        overlayZIndex="1000"
        overlayClassName={isSplitScreen ? '!bg-transparent' : undefined}
        disablePointerEvents={false}
        onOpenChange={onOpenChange}
        disableBackdropClose={true}
        hideCloseButton={effectiveNarrow}
        forceMobileBackButton={effectiveNarrow}
        dialogOpen={open}
        allowMaximize={!isNarrowScreen && !isSplitScreen}
        isMaximized={isMaximized}
        onMaximizeChange={setIsMaximized}
      >
        <DialogTitle className="sr-only">{t('chat.knowledgeStack.managerTitle')}</DialogTitle>
        <DialogDescription className="sr-only">
          {t('chat.knowledgeStack.managerDescription')}
        </DialogDescription>

        {/* Tablet Top Controls - Search Only (Hidden on Mobile and Split-Screen) */}
        {/* Removed - each tab has its own search functionality */}

        <div
          className={cn(
            'flex h-full overflow-hidden',
            effectiveNarrow ? 'flex-col w-full' : 'flex-row'
          )}
        >
          {/* Left Sidebar - Hidden on Narrow Screens */}
          <div
            style={!effectiveNarrow ? { width: `${sidebarWidth}px` } : undefined}
            className={cn(
              'bg-zinc-100 dark:bg-zinc-800 h-full p-4 md:p-6 flex flex-col border-zinc-300 dark:border-zinc-800 relative',
              effectiveNarrow
                ? 'hidden'
                : 'border-r-0 md:border-r'
            )}
          >
            {/* Resize handle - hidden on narrow screens */}
            {!effectiveNarrow && (
              <div
                className='absolute top-0 right-0 w-1 h-full cursor-ew-resize bg-transparent hover:bg-blue-400/50 z-10'
                onMouseDown={handleMouseDown}
              />
            )}
            <div className='flex items-center justify-between mb-2 md:mb-4'>
              <h2 className='text-lg font-semibold text-zinc-800 dark:text-white'>
                {t('knowledge.stacks.title')}
              </h2>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button className='p-1.5 text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors'>
                    {sortBy === 'name' ? (
                      sortOrder === 'asc' ? <ArrowDownAZ className='h-4 w-4' /> : <ArrowUpAZ className='h-4 w-4' />
                    ) : (
                      sortOrder === 'desc' ? <CalendarArrowDown className='h-4 w-4' /> : <CalendarArrowUp className='h-4 w-4' />
                    )}
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align='end' className='w-40 z-[1001]'>
                  <DropdownMenuItem
                    onClick={() => setSort('name', 'asc')}
                    className={cn(sortBy === 'name' && sortOrder === 'asc' && 'bg-zinc-100 dark:bg-zinc-800')}
                  >
                    <ArrowDownAZ className='h-4 w-4 mr-2' />
                    {t('common.sortNameAZ', 'Name A-Z')}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => setSort('name', 'desc')}
                    className={cn(sortBy === 'name' && sortOrder === 'desc' && 'bg-zinc-100 dark:bg-zinc-800')}
                  >
                    <ArrowUpAZ className='h-4 w-4 mr-2' />
                    {t('common.sortNameZA', 'Name Z-A')}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => setSort('created_at', 'desc')}
                    className={cn(sortBy === 'created_at' && sortOrder === 'desc' && 'bg-zinc-100 dark:bg-zinc-800')}
                  >
                    <CalendarArrowDown className='h-4 w-4 mr-2' />
                    {t('common.sortNewest', 'Newest first')}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => setSort('created_at', 'asc')}
                    className={cn(sortBy === 'created_at' && sortOrder === 'asc' && 'bg-zinc-100 dark:bg-zinc-800')}
                  >
                    <CalendarArrowUp className='h-4 w-4 mr-2' />
                    {t('common.sortOldest', 'Oldest first')}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>

            <div className='relative mb-2 md:mb-4'>
              <Search className='absolute left-2 top-2.5 h-4 w-4 text-zinc-400' />
              <Input
                placeholder={t('knowledge.stacks.searchPlaceholder')}
                className='pl-8 py-5 bg-white dark:bg-zinc-800 border-zinc-300 dark:border-zinc-700'
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
              />
              {searchQuery && (
                <button
                  className='absolute right-2 top-2 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300'
                  onClick={() => setSearchQuery('')}
                >
                  <X className='h-4 w-4' />
                </button>
              )}
            </div>

            <div
              ref={collectionsContainerRef}
              className={cn(
                'flex-1 overflow-y-auto min-h-0'
              )}
            >
              {(isLoading || collectionsLoading) ? (
                /* Skeleton UI for loading knowledge stacks */
                <div className='space-y-2'>
                  {[1, 2, 3, 4, 5].map(i => (
                    <div
                      key={i}
                      className='skeleton-shimmer flex items-center justify-between p-2'
                    >
                      <div className='flex items-center space-x-2'>
                        <div className='w-2 h-2 rounded-full bg-zinc-300 dark:bg-zinc-700'></div>
                        <div className='h-4 w-40 bg-zinc-300 dark:bg-zinc-700 rounded'></div>
                      </div>
                      <div className='h-4 w-4 bg-zinc-300 dark:bg-zinc-700 rounded-full'></div>
                    </div>
                  ))}
                </div>
              ) : filteredStacks.length === 0 ? (
                <div className='text-center py-8 text-zinc-500 dark:text-zinc-400'>
                  {searchQuery
                    ? t('knowledge.stacks.noMatchingStacks')
                    : t('knowledge.stacks.noStacksFound')}
                </div>
              ) : (
                treeOrderedStacks.map((stack, index) => {
                  // Generate a consistent color based on the index
                  const colors = [
                    'bg-yellow-500',
                    'bg-green-500',
                    'bg-blue-500',
                    'bg-purple-500',
                    'bg-red-500',
                  ];
                  const colorClass = colors[index % colors.length];
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- depth/_hasChildren added dynamically in treeOrderedStacks flatten
                  const depth = (stack as any).depth ?? 0;
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
                  const hasChildren = (stack as any)._hasChildren ?? false;
                  const isExpanded = expandedIds.has(stack.id);
                  return (
                    <div
                      key={stack.id}
                      data-testid={`knowledge-collection-item-${stack.id}`}
                      className={`group flex items-center justify-between p-2 cursor-pointer ${selectedStack === stack.id ? `bg-zinc-200 dark:bg-zinc-800 ${accentBorder(true)}` : `hover:bg-zinc-200 dark:hover:bg-zinc-800 ${accentBorder(false, true)}`}`}
                      style={{ paddingLeft: `${8 + depth * 20}px` }}
                      onClick={() => { setSelectedStack(stack.id); setActiveSavedSearchId(null); setSavedSearchDocIds(null); }}
                    >
                      <div className='flex items-center'>
                        {hasChildren ? (
                          <button
                            className="w-4 h-4 mr-1 flex items-center justify-center text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300"
                            onMouseDown={(e) => e.stopPropagation()}
                            onClick={(e) => { e.stopPropagation(); e.preventDefault(); toggleExpanded(stack.id); }}
                          >
                            <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                              style={{ transform: isExpanded ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }}>
                              <polyline points="9 18 15 12 9 6"></polyline>
                            </svg>
                          </button>
                        ) : (
                          <div className="w-4 mr-1" />
                        )}
                        {depth === 0 ? (
                        <div
                          className={`w-2 h-2 rounded-full ${colorClass} mr-2`}
                        ></div>
                        ) : (
                        <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="mr-1.5 text-muted-foreground/60 flex-shrink-0">
                          <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>
                        </svg>
                        )}
                        <span className='text-sm font-medium text-zinc-800 dark:text-white'>
                          {stack.name}
                        </span>
                      </div>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <button
                            data-testid={`knowledge-collection-menu-${stack.id}`}
                            className='text-zinc-400 hover:text-zinc-600 dark:text-zinc-500 dark:hover:text-zinc-300
                            opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer'
                            onClick={e => {
                              e.stopPropagation();
                            }}
                          >
                            <svg
                              xmlns='http://www.w3.org/2000/svg'
                              width='16'
                              height='16'
                              viewBox='0 0 24 24'
                              fill='none'
                              stroke='currentColor'
                              strokeWidth='2'
                              strokeLinecap='round'
                              strokeLinejoin='round'
                            >
                              <circle cx='12' cy='12' r='1'></circle>
                              <circle cx='19' cy='12' r='1'></circle>
                              <circle cx='5' cy='12' r='1'></circle>
                            </svg>
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align='end' className='w-48 z-[1200]'>
                          {canUpload && depth < 3 && (
                          <DropdownMenuItem
                            onClick={() => {
                              setParentForSubcollection(stack.id);
                              setNewStackName('');
                              setNewStackDescription('');
                              setNewStackCustomInstructions('');
        setNewStackGraphTier(null);
                              setIsEditing(false);
                              setShowNewStackModal(true);
                            }}
                            className='flex items-center gap-2'
                          >
                            <FolderPlus className='h-4 w-4' />
                            {t('knowledge.stacks.createSubcollection', 'Create subcollection')}
                          </DropdownMenuItem>
                          )}
                          {canUpload && (
                          <DropdownMenuItem
                            data-testid={`knowledge-collection-edit-${stack.id}`}
                            onClick={() => {
                              handleEditStack(stack.id);
                            }}
                            className='flex items-center gap-2'
                          >
                            <FileText className='h-4 w-4' />
                            {t('knowledge.stacks.edit')}
                          </DropdownMenuItem>
                          )}
                          {canUpload && depth > 0 && (
                          <DropdownMenuItem
                            onClick={async () => {
                              try {
                                const { moveCollection } = await import('@/lib/api-collections');
                                // Optimistic update — move to root in local state
                                updateCollectionInState(stack.id, { parentCollectionId: null, parent_collection_id: null, depth: 0 });
                                await moveCollection(stack.id, null);
                                toast.success(t('knowledge.stacks.movedToRoot', 'Moved to root'));
                              } catch (e) {
                                toast.error(String(e instanceof Error ? e.message : 'Move failed'));
                                await refreshCollections();
                              }
                            }}
                            className='flex items-center gap-2'
                          >
                            <FolderPlus className='h-4 w-4' />
                            {t('knowledge.stacks.moveToRoot', 'Move to root')}
                          </DropdownMenuItem>
                          )}
                          <DropdownMenuItem
                            onClick={() => {
                            }}
                            className='flex items-center gap-2'
                          >
                            <Cog className='h-4 w-4' />
                            {t('knowledge.stacks.tweakSettings')}
                          </DropdownMenuItem>
                          {canUpload && (
                          <DropdownMenuItem
                            data-testid={`knowledge-collection-doi-import-${stack.id}`}
                            onClick={() => setDoiImportTarget({ id: stack.id, name: stack.name })}
                            className='flex items-center gap-2'
                          >
                            <Link2 className='h-4 w-4' />
                            {t('doiImport.menuItem', 'Import DOIs')}
                          </DropdownMenuItem>
                          )}
                          <DropdownMenuItem
                            data-testid={`knowledge-collection-podcast-${stack.id}`}
                            onClick={() => setPodcastTarget({ id: stack.id, name: stack.name })}
                            className='flex items-center gap-2'
                          >
                            <Headphones className='h-4 w-4' />
                            {t('podcast.menuItem', 'Audio overview')}
                          </DropdownMenuItem>
                          {canUpload && (
                          <DropdownMenuItem
                            onClick={() => {
                              setDeletingStackId(stack.id);
                              setIsDeleteConfirmationOpen(true);
                            }}
                            className='flex items-center gap-2 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20'
                          >
                            <Trash2 className='h-4 w-4' />
                            {t('knowledge.stacks.delete')}
                          </DropdownMenuItem>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  );
                })
              )}
              {hasMore && !collectionsLoading && (
                <div className='flex justify-center py-2'>
                  <Loader2 className='h-4 w-4 animate-spin text-zinc-400' />
                </div>
              )}
            </div>

            {/* Combined create button — collection or smart collection */}
            {canUpload && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    data-testid='knowledge-create-collection-button'
                    className='mt-2 flex items-center gap-2 px-3 py-2 text-sm text-zinc-800 dark:text-white bg-zinc-200 dark:bg-zinc-800 hover:bg-zinc-300 dark:hover:bg-zinc-700 transition-colors w-full justify-center'
                  >
                    <PlusCircle className='h-4 w-4' />
                    <span>{t('knowledge.stacks.create', 'Create')}</span>
                    <ChevronDown className='h-3.5 w-3.5 ml-auto' />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align='center' className='w-56 z-[1200]'>
                  <DropdownMenuItem
                    onClick={handleAddNewStack}
                    className='flex items-center gap-2'
                  >
                    <Database className='h-4 w-4' />
                    {t('knowledge.stacks.addNewStack')}
                  </DropdownMenuItem>
                  {currentWorkspace?.id && (
                    <DropdownMenuItem
                      data-testid='knowledge-create-saved-search'
                      onClick={() => setShowCreateSavedSearch(true)}
                      className='flex items-center gap-2'
                    >
                      <Sparkles className='h-4 w-4' />
                      {t('knowledge.stacks.savedSearches', 'Smart Collections')}
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            )}

            {/* Desktop Tabs - In Sidebar */}
            <div className='mt-3 pt-3 border-t border-zinc-300 dark:border-zinc-700'>
              <div className='flex flex-col space-y-1'>
                {TABS.map(tab => (
                  <div
                    key={tab.id}
                    role='tab'
                    aria-selected={activeTab === tab.id}
                    data-testid={`knowledge-tab-${tab.id}`}
                    className={cn(
                      'flex items-center gap-3 px-3 py-2.5 cursor-pointer transition-colors rounded-md',
                      activeTab === tab.id
                        ? 'text-zinc-800 dark:text-white bg-zinc-300 dark:bg-zinc-950 font-medium'
                        : 'text-zinc-600 dark:text-gray-300 hover:bg-zinc-200 dark:hover:bg-zinc-700'
                    )}
                    onClick={() => handleTabChange(tab.id)}
                  >
                    <tab.icon className='w-4 h-4 flex-shrink-0' />
                    <span className='text-sm'>{t(tab.labelKey)}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Main Content */}
          <div
            className={cn(
              'flex-1 overflow-hidden flex flex-col h-full',
              effectiveNarrow ? 'w-full' : ''
            )}
          >
            {/* Header - Hidden on Narrow Screens and on Library/Search tabs */}
            <div
              className={cn(
                'px-4 md:px-6 py-4 border-b border-zinc-300 dark:border-black flex items-center justify-between bg-white dark:bg-black',
                (effectiveNarrow || activeTab === 'library') ? 'hidden' : ''
              )}
            >
              {(isLoading || collectionsLoading) ? (
                <div className='skeleton-shimmer h-6 w-48 bg-zinc-300 dark:bg-zinc-700 rounded'></div>
              ) : (
                <div className='flex items-center gap-3'>
                  <h1 className='text-lg md:text-xl font-semibold text-zinc-800 dark:text-white truncate'>
                    {selectedStack
                      ? knowledgeStacks.find(
                        stack => stack.id === selectedStack
                      )?.name || t('knowledge.stacks.untitledStack')
                      : t('knowledge.stacks.noStackSelected')}
                  </h1>
                </div>
              )}
              <div className='flex items-center gap-1 md:gap-2'>
                {(isLoading || collectionsLoading) ? (
                  <div className='flex space-x-2'>
                    <div className='skeleton-shimmer h-8 w-24 bg-zinc-300 dark:bg-zinc-700 rounded'></div>
                    <div className='skeleton-shimmer h-8 w-24 bg-zinc-300 dark:bg-zinc-700 rounded'></div>
                  </div>
                ) : (
                  <>
                    <div className='flex gap-1'>
                      <button
                        className='p-1.5 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors'
                        onClick={handleViewChunks}
                        title={t('knowledge.stacks.viewChunks')}
                      >
                        <FileStack className='h-4 w-4 md:h-5 md:w-5' />
                      </button>
                      <button
                        className='p-1.5 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors'
                        onClick={() => { }}
                        title={t('knowledge.stacks.searchInStack')}
                      >
                        <svg
                          xmlns='http://www.w3.org/2000/svg'
                          width='20'
                          height='20'
                          viewBox='0 0 24 24'
                          fill='none'
                          stroke='currentColor'
                          strokeWidth='2'
                          strokeLinecap='round'
                          strokeLinejoin='round'
                          className='h-4 w-4 md:h-5 md:w-5'
                        >
                          <circle cx='11' cy='11' r='8'></circle>
                          <line x1='21' y1='21' x2='16.65' y2='16.65'></line>
                          <line x1='11' y1='8' x2='11' y2='14'></line>
                          <line x1='8' y1='11' x2='14' y2='11'></line>
                        </svg>
                      </button>
                      {canUpload && (
                      <button
                        className='p-1.5 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors'
                        onClick={() => {
                          if (selectedStack) {
                            void handleCleanupEmbeddings(selectedStack);
                          }
                        }}
                        disabled={isCleaningUpEmbeddings}
                        title='Clean up low-quality embeddings'
                      >
                        {isCleaningUpEmbeddings ? (
                          <Loader2 className='h-4 w-4 md:h-5 md:w-5 animate-spin' />
                        ) : (
                          <svg
                            xmlns='http://www.w3.org/2000/svg'
                            width='20'
                            height='20'
                            viewBox='0 0 24 24'
                            fill='none'
                            stroke='currentColor'
                            strokeWidth='2'
                            strokeLinecap='round'
                            strokeLinejoin='round'
                            className='h-4 w-4 md:h-5 md:w-5'
                          >
                            <path d='M3 11l5-5 5 5' />
                            <path d='M13 18l5-5 5 5' />
                            <path d='M8 6v12' />
                            <path d='M18 13v7' />
                          </svg>
                        )}
                      </button>
                      )}
                      <button
                        className='p-1.5 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors'
                        onClick={handleAddToBookmarks}
                        title='Add to bookmarks'
                      >
                        <svg
                          xmlns='http://www.w3.org/2000/svg'
                          width='20'
                          height='20'
                          viewBox='0 0 24 24'
                          fill='none'
                          stroke='currentColor'
                          strokeWidth='2'
                          strokeLinecap='round'
                          strokeLinejoin='round'
                          className='h-5 w-5'
                        >
                          <path d='M17.5 5H20C21.1 5 22 5.9 22 7V19C22 20.1 21.1 21 20 21H4C2.9 21 2 20.1 2 19V7C2 5.9 2.9 5 4 5H6.5'></path>
                          <path d='M12 19V5'></path>
                          <path d='M12 5L7 10'></path>
                          <path d='M12 5L17 10'></path>
                        </svg>
                      </button>
                      {canUpload && (
                      <button
                        className='p-1.5 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors'
                        onClick={() => {
                          if (selectedStack) {
                            setIsDeleteConfirmationOpen(true);
                            setDeletingStackId(selectedStack);
                          }
                        }}
                        title={t('knowledge.stacks.deleteStack')}
                      >
                        <Trash2 className='h-5 w-5' />
                      </button>
                      )}
                      <button
                        className='p-1.5 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors'
                        onClick={handleTweakSettings}
                        title={t('knowledge.stacks.tweakSettings')}
                      >
                        <Cog className='h-5 w-5' />
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>


            {/* Mobile/Tablet Horizontal Tabs (visible below lg breakpoint) */}
            {effectiveNarrow && (
              <div className='bg-zinc-100 dark:bg-zinc-800 border-b border-zinc-300 dark:border-black'>
                <div className='flex gap-2 overflow-x-auto scrollbar-hide scroll-smooth'>
                  {TABS.map(tab => (
                    <div
                      key={tab.id}
                      role='tab'
                      aria-selected={activeTab === tab.id}
                      data-knowledge-tab-id={tab.id}
                      data-testid={`knowledge-tab-${tab.id}`}
                      className={cn(
                        'flex items-center gap-2 px-2 py-2 h-14 cursor-pointer transition-colors whitespace-nowrap flex-shrink-0 rounded-md',
                        activeTab === tab.id
                          ? 'text-zinc-800 dark:text-white bg-zinc-300 dark:bg-zinc-950 font-medium'
                          : 'text-zinc-600 dark:text-gray-300 hover:bg-zinc-200 dark:hover:bg-zinc-700'
                      )}
                      onClick={() => handleTabChange(tab.id)}
                    >
                      <tab.icon className='w-4 h-4 flex-shrink-0' />
                      <span className='text-sm'>{t(tab.labelKey)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Tab Content */}
            <div
              className={cn('flex-1 overflow-hidden relative', effectiveNarrow && activeTab === 'upload' && 'pb-[80px]')}
              onTouchStart={effectiveNarrow ? onTouchStart : undefined}
              onTouchMove={effectiveNarrow ? onTouchMove : undefined}
              onTouchEnd={effectiveNarrow ? onTouchEnd : undefined}
              style={effectiveNarrow ? { touchAction: 'pan-y pinch-zoom' } : undefined}
            >
              {effectiveNarrow ? (
                <div className='relative w-full h-full overflow-hidden'>
                  {/* Container that slides horizontally */}
                  <div
                    className={cn(
                      'flex w-full h-full',
                      isAnimating ? 'transition-transform duration-300 ease-out' : '',
                      isDragging ? 'transition-none' : ''
                    )}
                    style={{
                      transform: (() => {
                        if (isDragging) {
                          // Follow finger during drag
                          return `translateX(${-dragOffset}px)`;
                        } else if (isAnimating && slideDirection) {
                          // Animate to show new tab
                          return slideDirection === 'left'
                            ? 'translateX(-100%)' // Slide left to show next tab
                            : 'translateX(100%)';  // Slide right to show previous tab
                        }
                        return 'translateX(0)';
                      })()
                    }}
                  >
                    {/* Previous tab (for right swipe) */}
                    {((isAnimating || isDragging) && slideDirection === 'right' && nextTab) && (
                      <div className='w-full h-full flex-shrink-0 overflow-y-auto'>
                        {renderTabContent(nextTab)}
                      </div>
                    )}

                    {/* Current tab */}
                    <div className='w-full h-full flex-shrink-0 overflow-y-auto'>
                      {renderTabContent()}
                    </div>

                    {/* Next tab (for left swipe) */}
                    {((isAnimating || isDragging) && slideDirection === 'left' && nextTab) && (
                      <div className='w-full h-full flex-shrink-0 overflow-y-auto'>
                        {renderTabContent(nextTab)}
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                renderTabContent()
              )}
            </div>

            {/* Batch Processing Progress Banner */}
            {batchProcessing && activeTab === 'upload' && (
              <div className='px-4 py-2 border-t border-primary/20 bg-primary/5'>
                <div className='flex items-center justify-between text-sm mb-1'>
                  <div className='flex items-center gap-2'>
                    <Loader2 className='h-3.5 w-3.5 animate-spin text-primary' />
                    <span className='font-medium text-primary'>
                      {t('knowledge.batch.processing') || 'Batch Processing'}
                    </span>
                  </div>
                  <span className='text-xs text-muted-foreground'>
                    {batchProcessing.total - batchProcessing.pending}/{batchProcessing.total} {t('knowledge.batch.completed') || 'completed'}
                  </span>
                </div>
                <div className='w-full h-1.5 bg-primary/10 overflow-hidden'>
                  <div
                    className='h-full bg-primary transition-all duration-500'
                    style={{
                      width: `${batchProcessing.total > 0 ? ((batchProcessing.total - batchProcessing.pending) / batchProcessing.total) * 100 : 0}%`,
                    }}
                  />
                </div>
              </div>
            )}

            {/* Footer - Desktop Only - Upload Tab Only - Hidden for viewers */}
            <div
              className={cn(
                'mt-auto p-4 flex items-center justify-between border-t border-zinc-300 dark:border-zinc-800 bg-white/80 dark:bg-black/80 backdrop-blur-xl',
                (effectiveNarrow || activeTab !== 'upload' || !canUpload) ? 'hidden' : ''
              )}
            >
              <div className='flex items-center gap-2 text-sm text-zinc-500 dark:text-zinc-400'>
                <span>{t('knowledge.stacks.selectStackToManage')}</span>
              </div>

              <PopoverEmbeddingSettings
                embeddingModel={embeddingModel}
                setEmbeddingModel={setEmbeddingModel}
                splitterType={splitterType}
                setSplitterType={setSplitterType}
                chunkSize={chunkSize}
                setChunkSize={setChunkSize}
                chunkOverlapping={chunkOverlapping}
                setChunkOverlapping={setChunkOverlapping}
                chunkSizesToIgnore={chunkSizesToIgnore}
                setChunkSizesToIgnore={setChunkSizesToIgnore}
              />
              <div className='flex items-center gap-2'>
                <Button
                  variant='outline'
                  className='px-4 py-2 text-zinc-600 dark:text-zinc-400 bg-transparent hover:bg-zinc-100 dark:hover:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 text-sm flex items-center gap-1'
                  onClick={() => {
                    // Refresh documents for the selected collection
                    if (selectedStack) {
                      void fetchDocumentsForCollection(selectedStack);
                    }

                    // Refresh the collections list to update document counts and metadata
                    void fetchCollections();

                    // Refresh workspace storage to update file size display
                    void refreshWorkspaceStorage();

                    // Also refresh the uploads if the file uploader exists
                    if (fileUploaderRef.current) {
                      fileUploaderRef.current.refreshUploads();
                    }
                  }}
                  disabled={!selectedStack}
                >
                  <RefreshCw className='mr-1 h-4 w-4' />
                  {t('general.refresh')}
                </Button>
                <Button
                  variant='default'
                  className={`px-4 py-2 text-sm flex items-center gap-2 font-medium rounded-md transition-colors disabled:pointer-events-none disabled:opacity-50 ${
                    isUploading || isCancellingJobs
                      ? 'bg-red-600 hover:bg-red-700 dark:bg-red-600 dark:hover:bg-red-700 text-white'
                      : 'bg-zinc-800 dark:bg-zinc-700 hover:bg-zinc-700 dark:hover:bg-zinc-600 text-white'
                  }`}
                  onClick={isUploading ? handleAbortUpload : handleComposeClick}
                  disabled={isCancellingJobs || (isUploading ? false : (selectedPendingCount === 0 && !hasPendingDocuments))}
                >
                  {isCancellingJobs ? (
                    <>
                      <Loader2 className='h-4 w-4 animate-spin flex-shrink-0' />
                      Cancelling...
                    </>
                  ) : isUploading ? (
                    <>
                      <Loader2 className='h-4 w-4 animate-spin flex-shrink-0' />
                      {t('chat.knowledgeStack.abort')}
                    </>
                  ) : (
                    <>{t('chat.knowledgeStack.compose')}</>
                  )}
                </Button>
              </div>
            </div>

            {/* Mobile Bottom Toolbar - Fixed at bottom - Files Tab Only.
                Shown for viewers too: a read-only shared-workspace user still
                needs the collection dropdown (the ONLY collection picker on
                narrow/mobile/split-screen, since the desktop sidebar is hidden)
                to browse books per collection. Only the mutation/upload controls
                inside are gated by canUpload. */}
            {effectiveNarrow && activeTab === 'upload' && (
              <div className='fixed bottom-0 left-0 right-0 flex items-center justify-between gap-2 px-3 py-3 border-t border-zinc-300 dark:border-zinc-800 bg-white dark:bg-black mobile-chat-toolbar shadow-[0_-4px_12px_rgba(0,0,0,0.15)] z-[1200]'>
                <div className='flex items-center gap-1 min-w-0 flex-1'>
                  {/* Collection Dropdown Selector */}
                  <DropdownMenu
                    onOpenChange={(isOpen) => {
                      if (!isOpen || !selectedStack) return;
                      // Expand the selected collection's ancestor chain so a
                      // nested selection is actually rendered, then scroll it
                      // into view — so the user lands on the current collection
                      // instead of having to scroll down to find it every time.
                      setExpandedIds(prev => {
                        const next = new Set(prev);
                        const seen = new Set<string>();
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mapped stack carries both casings
                        let cur: any = knowledgeStacks.find(s => s.id === selectedStack);
                        while (cur) {
                          const pid = cur.parentCollectionId || cur.parent_collection_id;
                          if (!pid || seen.has(pid)) break;
                          seen.add(pid);
                          next.add(pid);
                          cur = knowledgeStacks.find(s => s.id === pid);
                        }
                        return next;
                      });
                      // Defer past the portal mount + expand re-render; retry once
                      // in case pagination/layout settles a beat later.
                      const scrollToSelected = () => {
                        const el = document.querySelector(
                          `[data-testid="knowledge-mobile-collection-item-${selectedStack}"]`
                        );
                        if (el) el.scrollIntoView({ block: 'center' });
                        return !!el;
                      };
                      setTimeout(() => { if (!scrollToSelected()) setTimeout(scrollToSelected, 200); }, 100);
                    }}
                  >
                    <DropdownMenuTrigger asChild>
                      <button data-testid='knowledge-mobile-collection-trigger' className='inline-flex items-center justify-between gap-1 whitespace-nowrap font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-0 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 min-h-[40px] px-2 text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 rounded-md min-w-0 flex-1 max-w-[210px]'>
                        <div className='flex items-center gap-2 min-w-0 flex-1'>
                          {selectedStack ? (
                            <>
                              {(() => {
                                const selectedIndex = filteredStacks.findIndex(s => s.id === selectedStack);
                                const colors = ['bg-yellow-500', 'bg-green-500', 'bg-blue-500', 'bg-purple-500', 'bg-red-500'];
                                const colorClass = colors[selectedIndex >= 0 ? selectedIndex % colors.length : 2];
                                return <div className={`w-2 h-2 rounded-full ${colorClass} flex-shrink-0`}></div>;
                              })()}
                              <span className='font-medium text-zinc-800 dark:text-white truncate text-left'>
                                {knowledgeStacks.find(stack => stack.id === selectedStack)?.name || 'Select Collection'}
                              </span>
                            </>
                          ) : (
                            <span className='font-medium text-zinc-500 dark:text-zinc-400 truncate text-left'>
                              {t('chat.knowledgeStack.selectCollection')}
                            </span>
                          )}
                        </div>
                        <ChevronDown className='h-4 w-4 text-zinc-500 dark:text-zinc-400 flex-shrink-0' />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent
                      align='start'
                      className='w-[200px] max-h-[300px] overflow-y-auto z-[1300]'
                      onScroll={(e) => {
                        const target = e.currentTarget;
                        if (target.scrollTop + target.clientHeight >= target.scrollHeight - 50) {
                          void loadMoreCollections();
                        }
                      }}
                    >
                      {filteredStacks.length === 0 ? (
                        <div className='px-3 py-2 text-xs text-zinc-500 dark:text-zinc-400 text-center'>
                          {searchQuery ? 'No matching collections' : 'No collections found'}
                        </div>
                      ) : (
                        treeOrderedStacks.map((stack, index) => {
                          const colors = ['bg-yellow-500', 'bg-green-500', 'bg-blue-500', 'bg-purple-500', 'bg-red-500'];
                          const colorClass = colors[index % colors.length];
                          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- depth/_hasChildren added dynamically in treeOrderedStacks flatten
                          const mobileDepth = (stack as any).depth ?? 0;
                          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
                          const mobileHasChildren = (stack as any)._hasChildren ?? false;
                          const mobileIsExpanded = expandedIds.has(stack.id);
                          return (
                            <DropdownMenuItem
                              key={stack.id}
                              data-testid={`knowledge-mobile-collection-item-${stack.id}`}
                              onClick={(e) => {
                                if (mobileHasChildren) {
                                  // Expand to reveal sub-collections AND keep the
                                  // dropdown open. Previously a parent click only
                                  // expanded and never selected, so books uploaded
                                  // directly to the parent collection were
                                  // unreachable. Select it too so its own books show.
                                  e.preventDefault();
                                  toggleExpanded(stack.id);
                                }
                                setSelectedStack(stack.id);
                                setActiveSavedSearchId(null);
                                setSavedSearchDocIds(null);
                              }}
                              className='flex items-center gap-1 py-2 cursor-pointer'
                              style={{ paddingLeft: `${12 + mobileDepth * 16}px` }}
                            >
                              {mobileHasChildren ? (
                                <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                                  className="flex-shrink-0 text-muted-foreground/60"
                                  style={{ transform: mobileIsExpanded ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }}>
                                  <polyline points="9 18 15 12 9 6"></polyline>
                                </svg>
                              ) : mobileDepth > 0 ? (
                                <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="flex-shrink-0 text-muted-foreground/50">
                                  <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>
                                </svg>
                              ) : null}
                              {mobileDepth === 0 && !mobileHasChildren && (
                                <div className={`w-2 h-2 rounded-full ${colorClass} flex-shrink-0`}></div>
                              )}
                              {mobileDepth === 0 && mobileHasChildren && (
                                <div className={`w-2 h-2 rounded-full ${colorClass} flex-shrink-0`}></div>
                              )}
                              <span className={`text-xs truncate flex-1 ${mobileDepth === 0 ? 'font-medium' : 'text-muted-foreground'}`}>{stack.name}</span>
                              {selectedStack === stack.id && (
                                <div className='w-1.5 h-1.5 rounded-full bg-accent-600 dark:bg-accent-400 flex-shrink-0'></div>
                              )}
                            </DropdownMenuItem>
                          );
                        })
                      )}
                      {hasMore && (
                        <div className='flex justify-center py-1'>
                          <Loader2 className='h-3 w-3 animate-spin text-zinc-400' />
                        </div>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>

                  {/* Icon Action Buttons */}
                  <div className='flex items-center gap-0.5 flex-shrink-0'>
                    {canUpload && (
                      <Button
                        variant='ghost'
                        className='h-9 w-9 p-0 text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded-md flex items-center justify-center'
                        onClick={handleAddNewStack}
                        title={t('knowledge.stacks.addStack')}
                      >
                        <PlusCircle className='h-4 w-4' />
                      </Button>
                    )}
                    <Button
                      variant='ghost'
                      className='h-9 w-9 p-0 text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded-md flex items-center justify-center disabled:opacity-50'
                      onClick={() => {
                        if (selectedStack) {
                          void fetchDocumentsForCollection(selectedStack);
                        }
                        // Refresh the collections list to update document counts and metadata
                        void fetchCollections();
                        // Refresh workspace storage to update file size display
                        void refreshWorkspaceStorage();
                        if (fileUploaderRef.current) {
                          fileUploaderRef.current.refreshUploads();
                        }
                      }}
                      disabled={!selectedStack}
                      title='Refresh'
                    >
                      <RefreshCw className='h-5 w-5' />
                    </Button>
                    {canUpload && (
                      <PopoverEmbeddingSettings
                        embeddingModel={embeddingModel}
                        setEmbeddingModel={setEmbeddingModel}
                        splitterType={splitterType}
                        setSplitterType={setSplitterType}
                        chunkSize={chunkSize}
                        setChunkSize={setChunkSize}
                        chunkOverlapping='64'
                        setChunkOverlapping={() => { }}
                        chunkSizesToIgnore='20'
                        setChunkSizesToIgnore={() => { }}
                      />
                    )}
                  </div>
                </div>

                {/* Compose Button - Right Side (upload action — viewers can't upload) */}
                {canUpload && (
                <Button
                  className={`flex-shrink-0 flex items-center justify-center gap-2 min-h-[40px] px-3 font-medium rounded-md transition-colors disabled:pointer-events-none disabled:opacity-50 ${
                    isUploading || isCancellingJobs
                      ? 'bg-red-600 hover:bg-red-700 dark:bg-red-600 dark:hover:bg-red-700 text-white'
                      : 'bg-zinc-800 dark:bg-zinc-700 hover:bg-zinc-700 dark:hover:bg-zinc-600 text-white'
                  }`}
                  onClick={isUploading ? handleAbortUpload : handleComposeClick}
                  disabled={isCancellingJobs || (isUploading ? false : (selectedPendingCount === 0 && !hasPendingDocuments))}
                >
                  {isCancellingJobs ? (
                    <>
                      <Loader2 className='h-4 w-4 animate-spin flex-shrink-0' />
                      <span className='text-sm font-medium'>Cancelling...</span>
                    </>
                  ) : isUploading ? (
                    <>
                      <Loader2 className='h-4 w-4 animate-spin flex-shrink-0' />
                      <span className='text-sm font-medium'>{t('chat.knowledgeStack.abort')}</span>
                    </>
                  ) : (
                    <span className='text-sm font-medium'>{t('chat.knowledgeStack.compose')}</span>
                  )}
                </Button>
                )}
              </div>
            )}
          </div>
        </div>
      </DialogContent>

      {/* Stack menu overlay */}
      {showStackMenu && (
        <div
          className='fixed inset-0 z-50'
          onClick={() => setShowStackMenu(false)}
        >
          <div
            ref={stackMenuRef}
            className='absolute bg-white dark:bg-zinc-900 shadow-lg border border-zinc-300 dark:border-zinc-700 w-48 py-1'
            style={{
              top: `${stackMenuPosition.top + 20}px`,
              left: `${stackMenuPosition.left - 170}px`,
            }}
            onClick={e => e.stopPropagation()}
          >
            <button
              className='w-full text-left px-4 py-2 text-sm text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800'
              onClick={() => handleEditStack(activeStackForMenu || '')}
            >
              Edit
            </button>
            <button
              className='w-full text-left px-4 py-2 text-red-600 dark:text-red-400 hover:bg-zinc-100 dark:hover:bg-zinc-800'
              onClick={() => handleDeleteStack(activeStackForMenu || '')}
            >
              Delete
            </button>
          </div>
        </div>
      )}

      {/* Create Saved Search Dialog */}
      {currentWorkspace?.id && (
        <SavedSearchCreateDialog
          open={showCreateSavedSearch}
          onOpenChange={setShowCreateSavedSearch}
          workspaceId={currentWorkspace.id}
          onCreated={() => {
            listSavedSearches(currentWorkspace.id).then(setSavedSearches).catch(() => {});
          }}
        />
      )}

      {/* New Stack Modal - opens after parent is closed to avoid nested dialog issues */}
      <Dialog open={showNewStackModal} onOpenChange={handleNewStackModalChange}>
        <DialogContent
          // widened from max-w-[400px] to fit the
          // long Custom AI Instructions textarea + helper text without
          // wrapping the description awkwardly. Mobile still uses 90vw.
          className='border-zinc-300 dark:border-zinc-800 bg-white dark:bg-black w-[90vw] max-w-[640px] p-4 sm:p-6 rounded-lg z-[1250]'
          overlayZIndex="1220"
          onOpenChange={handleNewStackModalChange}
          disableBackdropClose={true}
          disableFullscreenOnMobile={true}
        >
          <DialogTitle className='sr-only'>
            {isEditing ? t('chat.knowledgeStack.editStack') : t('chat.knowledgeStack.newStack')}
          </DialogTitle>
          <DialogDescription className='sr-only'>
            {isEditing ? 'Edit knowledge collection details' : 'Create a new knowledge collection'}
          </DialogDescription>
          <div className='space-y-6'>
            <h2 className='text-xl font-semibold text-zinc-800 dark:text-white'>
              {isEditing ? t('chat.knowledgeStack.editStack') : t('chat.knowledgeStack.newStack')}
            </h2>

            <div className='space-y-4'>
              <div className='space-y-2'>
                <label className='text-sm font-medium text-zinc-800 dark:text-white'>
                  {t('chat.knowledgeStack.title')}
                </label>
                <input
                  type='text'
                  autoFocus
                  data-testid='knowledge-collection-name-input'
                  value={newStackName}
                  onChange={e => setNewStackName(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && newStackName.trim()) {
                      e.preventDefault();
                      void handleCreateStack();
                    }
                  }}
                  className='w-full p-3 bg-white dark:bg-transparent border border-zinc-300 dark:border-zinc-700 text-sm text-zinc-800 dark:text-white focus:outline-none focus:ring-1 focus:ring-zinc-400 dark:focus:ring-zinc-700 rounded-md'
                  placeholder={t('chat.knowledgeStack.placeholder')}
                />
              </div>

              <div className='space-y-2'>
                <label className='text-sm font-medium text-zinc-800 dark:text-white'>
                  {t('chat.knowledgeStack.description')}
                </label>
                <div className='relative'>
                  <textarea
                    value={newStackDescription}
                    onChange={e => setNewStackDescription(e.target.value)}
                    rows={3}
                    className='w-full p-3 pr-10 bg-white dark:bg-transparent border border-zinc-300 dark:border-zinc-700 text-sm text-zinc-800 dark:text-white focus:outline-none focus:ring-1 focus:ring-zinc-400 dark:focus:ring-zinc-700 resize-y'
                    placeholder={t('chat.knowledgeStack.descriptionPlaceholder')}
                  />
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          type='button'
                          variant='ghost'
                          size='icon'
                          onClick={handleGenerateDescription}
                          disabled={isGeneratingDescription || !newStackName.trim()}
                          className='absolute top-2 right-2 h-6 w-6 hover:bg-zinc-100 dark:hover:bg-zinc-800'
                        >
                          {isGeneratingDescription ? (
                            <Loader2 className='h-3.5 w-3.5 animate-spin' />
                          ) : (
                            <Sparkles className='h-3.5 w-3.5' />
                          )}
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>
                        <p>{t('chat.knowledgeStack.generateWithAI')}</p>
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                </div>
              </div>

              {/* Parent collection — lets the user create this as a
                  sub-collection (e.g. "liver" under "medicine") directly from
                  the create dialog. Edit mode hides this: re-parenting an
                  existing collection goes through the row's Move actions. */}
              {!isEditing && (
                <div className='space-y-2'>
                  <label className='text-sm font-medium text-zinc-800 dark:text-white'>
                    {t('chat.knowledgeStack.parentCollection', 'Parent collection')}
                  </label>
                  <p className='text-xs text-muted-foreground'>
                    {t(
                      'chat.knowledgeStack.parentCollectionHelp',
                      'Choose a parent to create this as a sub-collection, or leave as a top-level collection.',
                    )}
                  </p>
                  <Select
                    value={parentForSubcollection ?? 'none'}
                    onValueChange={v => setParentForSubcollection(v === 'none' ? null : v)}
                  >
                    <SelectTrigger className='w-full' data-testid='knowledge-stack-parent'>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className='z-[1300]'>
                      <SelectItem value='none'>
                        {t('chat.knowledgeStack.parentCollectionNone', 'None — top-level collection')}
                      </SelectItem>
                      {parentOptions.map(o => (
                        <SelectItem key={o.id} value={o.id}>
                          {'    '.repeat(o.depth) + o.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}

              {/* Knowledge-graph build tier — decides how heavy a Neo4j graph
                  each book in this collection builds at ingestion. */}
              <div className='space-y-2'>
                <label className='text-sm font-medium text-zinc-800 dark:text-white'>
                  {t('chat.knowledgeStack.graphTier', 'Knowledge graph')}
                </label>
                <p className='text-xs text-muted-foreground'>
                  {t(
                    'chat.knowledgeStack.graphTierHelp',
                    'How much knowledge graph each book in this collection builds. Higher tiers give richer relationship-aware answers at a higher storage and processing cost. Sub-collections inherit their parent unless overridden.',
                  )}
                </p>
                <Select
                  value={newStackGraphTier === null ? 'inherit' : String(newStackGraphTier)}
                  onValueChange={v => setNewStackGraphTier(v === 'inherit' ? null : Number(v))}
                >
                  <SelectTrigger className='w-full' data-testid='knowledge-stack-graph-tier'>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className='z-[1300]'>
                    <SelectItem value='inherit'>
                      {t('chat.knowledgeStack.graphTierInherit', 'Inherited')} ({tierLabel(currentInheritedTier())})
                    </SelectItem>
                    <SelectItem value='0'>{t('chat.knowledgeStack.graphTierNone', 'No graph — embeddings only')}</SelectItem>
                    <SelectItem value='1'>{t('chat.knowledgeStack.graphTierLight', 'Light graph — entities only')}</SelectItem>
                    <SelectItem value='2'>{t('chat.knowledgeStack.graphTierFull', 'Full graph — entities + relationships')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/*
                per-collection AI system-prompt addendum.
                Only shown when editing an existing collection: the
                Generate button calls GenerateCustomInstructions on the
                Python side, which needs a real collection_id. On create,
                the user can set this immediately after via Edit.
              */}
              {isEditing && (
                <div className='space-y-2'>
                  <label className='text-sm font-medium text-zinc-800 dark:text-white'>
                    {t('chat.knowledgeStack.customInstructions', 'Custom AI Instructions')}
                  </label>
                  <p className='text-xs text-muted-foreground'>
                    {t(
                      'chat.knowledgeStack.customInstructionsHelp',
                      'Anything written here is appended to the AI assistant\'s system prompt for chats targeting this collection. Click ✨ to have AI draft a baseline tailored to the collection — you can then edit it freely.',
                    )}
                  </p>
                  <div className='relative'>
                    <textarea
                      data-testid='knowledge-stack-custom-instructions'
                      value={newStackCustomInstructions}
                      onChange={e => setNewStackCustomInstructions(e.target.value)}
                      rows={6}
                      maxLength={2000}
                      className='w-full p-3 pr-10 bg-white dark:bg-transparent border border-zinc-300 dark:border-zinc-700 text-sm text-zinc-800 dark:text-white focus:outline-none focus:ring-1 focus:ring-zinc-400 dark:focus:ring-zinc-700 resize-y'
                      placeholder={t(
                        'chat.knowledgeStack.customInstructionsPlaceholder',
                        'e.g. Always answer in Croatian. Treat sources as legal precedent — quote verbatim and cite section numbers.',
                      )}
                    />
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            type='button'
                            variant='ghost'
                            size='icon'
                            onClick={handleGenerateCustomInstructions}
                            disabled={isGeneratingCustomInstructions}
                            className='absolute top-2 right-2 h-6 w-6 hover:bg-zinc-100 dark:hover:bg-zinc-800'
                          >
                            {isGeneratingCustomInstructions ? (
                              <Loader2 className='h-3.5 w-3.5 animate-spin' />
                            ) : (
                              <Sparkles className='h-3.5 w-3.5' />
                            )}
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>
                          <p>{t('chat.knowledgeStack.generateCustomInstructionsTooltip', 'Draft with AI')}</p>
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  </div>
                  <div className='flex justify-end text-xs text-muted-foreground'>
                    {newStackCustomInstructions.length} / 2000
                  </div>
                </div>
              )}

              <div className='pt-4 flex justify-end space-x-2'>
                <Button
                  className='bg-white dark:bg-transparent border border-zinc-300 dark:border-zinc-700 text-zinc-800 dark:text-white hover:bg-zinc-100 dark:hover:bg-zinc-900'
                  onClick={() => setShowNewStackModal(false)}
                >
                  {t('general.cancel')}
                </Button>
                <Button
                  data-testid='knowledge-create-collection-submit'
                  className='bg-zinc-800 hover:bg-zinc-700 dark:bg-white dark:hover:bg-zinc-200 dark:text-black text-white'
                  onClick={handleCreateStack}
                  disabled={!newStackName.trim()}
                >
                  {isEditing ? t('chat.knowledgeStack.update') : t('chat.knowledgeStack.create')}
                </Button>
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* DOI → Virtual Collection import (Scite #10) */}
      <DOIImportDialog
        open={doiImportTarget !== null}
        onOpenChange={(o) => { if (!o) setDoiImportTarget(null); }}
        collectionId={doiImportTarget?.id ?? null}
        collectionName={doiImportTarget?.name}
        onImported={() => { void refreshCollections(); }}
      />

      {/* NotebookLM-style audio overview (Podcast) */}
      <PodcastDialog
        open={podcastTarget !== null}
        onOpenChange={(o) => { if (!o) setPodcastTarget(null); }}
        collectionId={podcastTarget?.id ?? null}
        collectionName={podcastTarget?.name}
      />

      {/* Delete Confirmation Dialog */}
      <AlertDialog
        open={isDeleteConfirmationOpen}
        onOpenChange={open => {
          if (!open) {
            setIsDeleteConfirmationOpen(false);
            setDeletingStackId(null);
          }
        }}
      >
        <AlertDialogContent className='z-[1200]'>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('knowledge.stacks.deleteDialog.title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('knowledge.stacks.deleteDialog.description')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              {t('general.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              className='bg-red-600 hover:bg-red-700 dark:bg-red-600 dark:hover:bg-red-700 text-white'
              onClick={() => {
                if (deletingStackId) {
                  void handleDeleteStack(deletingStackId);
                }
              }}
            >
              {t('general.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Abort Confirmation Dialog */}
      <AlertDialog
        open={isAbortConfirmationOpen}
        onOpenChange={open => {
          if (!open && !isCancellingJobs) {
            setIsAbortConfirmationOpen(false);
          }
        }}
      >
        <AlertDialogContent className='z-[1200]'>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('knowledge.stacks.abortDialog.title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {ongoingJobs && ongoingJobs.length > 0
                ? `This will cancel ${ongoingJobs.length} ongoing job${ongoingJobs.length > 1 ? 's' : ''}. ${t('knowledge.stacks.abortDialog.description')}`
                : t('knowledge.stacks.abortDialog.description')
              }
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              className='bg-white dark:bg-transparent border border-zinc-300 dark:border-zinc-700 text-zinc-800 dark:text-white hover:bg-zinc-100 dark:hover:bg-zinc-900'
              disabled={isCancellingJobs}
            >
              {t('general.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              className='bg-red-600 hover:bg-red-700 dark:bg-red-600 dark:hover:bg-red-700 text-white flex items-center gap-2 disabled:opacity-50'
              onClick={confirmAbortUpload}
              disabled={isCancellingJobs}
            >
              {isCancellingJobs && <Loader2 className='h-4 w-4 animate-spin' />}
              {isCancellingJobs ? 'Cancelling...' : t('knowledge.stacks.abort')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  );
};

export default KnowledgeStacksDialog;

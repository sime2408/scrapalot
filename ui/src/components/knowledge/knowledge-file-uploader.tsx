import React, {
  forwardRef,
  ForwardRefRenderFunction,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Loader2, X, FileText, Clock, StopCircle, RefreshCw, Eye, Zap, Check, Upload, MoreVertical, Trash2, SlidersHorizontal, HardDrive, GitBranch, FileSearch, PauseCircle, AlertTriangle, ChevronDown, ChevronUp, Maximize2, Minimize2 } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { AnimatedTitle } from '@/components/ui/animated-title';
import { useIsMobile } from '@/hooks/use-mobile';
import { toast } from '@/lib/toast-compat';
import { refreshToken, prepareForBulkProcessing } from '@/lib/auth';
import { translateBackendStatus as translateBackendStatusUtil } from '@/lib/translate-backend-status';
import {
  ExistingDocument,
  JobStatus,
  KnowledgeFileUploaderProps,
  KnowledgeFileUploaderRef,
  ProcessingStatus,
  ViewMode,
  SortField,
  SortDirection,
} from '@/types/file-attachments';
import { userPrefs } from '@/lib/storage-utils';
import { ViewModeSelector } from './view-mode-selector';
import { DocumentThumbnail } from './document-thumbnail';
import {
  DocumentProcessingTracker,
  getMyActiveJobs,
  getDocumentsByCollection,
  cancelDocumentProcessing,
  reprocessDocument,
  processDocument,
  deleteDocument,
  buildDocumentGraph,
  getCollectionStats,
  CollectionStats,
} from '@/lib/api-documents';
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
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import { Checkbox } from '@/components/ui/checkbox';
import { useWorkspace } from '@/hooks/use-workspace';
import { useAuth } from '@/hooks/use-auth';
import { api, API_BASE_URL } from '@/lib/api';
import { checkStorageQuota, formatBytes } from '@/lib/api-storage';
import { usePDFViewer } from '@/contexts/pdf-viewer-context';
import { useEpubViewer } from '@/contexts/epub-viewer-context';
import { useDocxViewer } from '@/contexts/docx-viewer-context';

// Get API base URL from environment
// to Add a helper function to sanitize filename, matching the backend logic
const sanitizeFilename = (filename: string): string => {
  // Get the basename without an extension
  const basename = filename.substring(0, filename.lastIndexOf('.'));
  // Get the extension
  const extension = filename.substring(filename.lastIndexOf('.'));

  // Replace special characters with underscores and convert to lowercase
  const sanitized = basename
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');

  // Return the sanitized name with an original extension
  return `${sanitized}${extension}`;
};

// Define the type for active polling intervals
type PollingInterval =
  | NodeJS.Timeout
  | { statusPoll?: NodeJS.Timeout; simulation?: NodeJS.Timeout };

const KnowledgeFileUploaderComponent: ForwardRefRenderFunction<
  KnowledgeFileUploaderRef,
  KnowledgeFileUploaderProps
> = (
  {
    collectionId,
    onUploadComplete,
    onUploadStatusChange,
    className = '',
    existingDocuments = [],
    isLoading = false,
    onDeleteDocument,
    hasMore = false,
    onLoadMore,
    isLoadingMore = false,
    ongoingJobs = [],
    ongoingJobsLoaded = false,
    onSelectionChange,
    readOnly = false,
  },
  ref
) => {
    const { t } = useTranslation();
    const isMobile = useIsMobile();
    const { dispatch: pdfDispatch } = usePDFViewer();
    const { dispatch: epubDispatch } = useEpubViewer();
    const { dispatch: docxDispatch } = useDocxViewer();

    // CLAUDE.md rule #16: backend emits camelCase codes (plain or
    // parametrized), frontend translates via `knowledge.uploader.<code>`.
    // Implementation extracted to @/lib/translate-backend-status so the
    // chat header / stats panel can reuse the same parser.
    const translateBackendStatus = (raw: string | undefined | null): string | null =>
      translateBackendStatusUtil(raw, t);

    // Same convention for processing_error column.
    const translateProcessingError = (raw: string | undefined | null): string => {
      if (!raw) return t('knowledge.uploader.processingFailed');
      const translated = translateBackendStatus(raw);
      return translated ?? t('knowledge.uploader.processingFailed');
    };

    // Pick the highest progress value across all sources (live STOMP frame,
    // polled backend `doc.job_progress`, drag-drop uploader tracker).
    // Progress is monotonic, so MAX is correct — and crucially, it skips
    // an early STOMP frame that arrives with progress=0 from poisoning the
    // ring while later signals already report 70 %. Replaces the previous
    // `??` chain which stopped at the first non-nullish value (including 0).
    const pickProgress = (...candidates: Array<number | null | undefined>): number => {
      const nums = candidates.filter((v): v is number => typeof v === 'number');
      return nums.length > 0 ? Math.max(...nums) : 0;
    };

    // Helper function to extract consistent progress percentage
    const getActualProgress = (progressData: { message?: string; progress?: number }) => {
      // Try to extract percentage from message first (more accurate)
      const messageMatch = progressData?.message?.match(/\((\d+)%\)/);
      const messageProgress = messageMatch ? parseInt(messageMatch[1], 10) : null;

      // Use message percentage if available, otherwise fall back to progress.progress
      return messageProgress !== null ? messageProgress : progressData?.progress;
    };

    const [files, setFiles] = useState<File[]>([]);
    const [isDragging, setIsDragging] = useState(false);
    const [isUploading, setIsUploading] = useState(false);
    const [shouldAutoUpload, setShouldAutoUpload] = useState(false);
    // Background jobs polled from /jobs/active — includes entity_extraction +
    // sync_document_hierarchy that don't touch documents.processing_status.
    // Drives the "Live activity banner" so users see graph rebuild progress
    // for their already-completed docs (previously banner was invariably
    // "Nema aktivnog workera" during background rebuilds).
    const [backgroundJobs, setBackgroundJobs] = useState<Array<{ job_id: string; document_id?: string; collection_id?: string; progress: number; message: string; filename?: string; task_name?: string }>>([]);
    const [storeFile, setStoreFile] = useState(false); // false = process without saving physical file
    const [buildGraph, setBuildGraph] = useState(false); // build knowledge graph after upload
    const [generateSummary, setGenerateSummary] = useState(false); // generate document summary after upload
    const [allProblemDocs, setAllProblemDocs] = useState<ExistingDocument[]>([]); // all docs with graph/processing issues (fetched separately)
    const [isDeletingSelected, setIsDeletingSelected] = useState(false); // batch delete in progress
    const [uploaderStats, setUploaderStats] = useState<CollectionStats | null>(null);
    const [uploadProgress, setUploadProgress] = useState<
      Record<
        string,
        {
          progress: number;
          message: string;
          isComplete?: boolean;
          error?: string;
          lastUpdated?: number;
          jobId?: string;
        }
      >
    >({});
    const fileInputRef = useRef<HTMLInputElement>(null);
    const browseButtonRef = useRef<HTMLButtonElement>(null);
    const abortControllerRef = useRef<AbortController | null>(null);
    // toast is now imported directly
    const [deletingDocIds, setDeletingDocIds] = useState<string[]>([]);
    const [abortingDocIds, setAbortingDocIds] = useState<string[]>([]);
    const [retryingDocIds] = useState<string[]>([]);
    const [processingDocIds, setProcessingDocIds] = useState<string[]>([]);
    const [noFileDoc, setNoFileDoc] = useState<{ id: string; filename: string } | null>(null);
    const [activePollingIntervals] = useState<{ [key: string]: PollingInterval }>(
      {}
    );
    const ongoingTrackersRef = useRef<Record<string, DocumentProcessingTracker>>(
      {}
    );
    const [isAbortConfirmationOpen, setIsAbortConfirmationOpen] = useState(false);
    const [isDeleteConfirmationOpen, setIsDeleteConfirmationOpen] = useState(false);
    const [deletingDocumentId, setDeletingDocumentId] = useState<string | null>(null);
    const { currentWorkspace, isLoading: isLoadingWorkspace } = useWorkspace();
    const { tokens } = useAuth();
    const [, setIsRefreshingStatus] = useState(false);
    const scrollContainerRef = useRef<HTMLDivElement>(null); // Ref for the scrollable container
    const loadMoreTriggerRef = useRef<HTMLDivElement>(null); // Ref for infinite scroll trigger sentinel
    const progressAnimationRef = useRef<Record<string, NodeJS.Timeout>>({});  // Track animation intervals
    const progressValuesRef = useRef<Record<string, number>>({});  // Track current progress values (prevents race conditions)

    // Selection state for per-document Compose
    const [selectedDocumentIds, setSelectedDocumentIds] = useState<Set<string>>(new Set());
    const [isSelectionMode, setIsSelectionMode] = useState(false); // mobile long-press selection mode
    // Activity panel acts as a single tab strip across the document list.
    // The earlier design stacked four full-width orange/yellow/red collapsible
    // cards plus an unlabeled top counter — visually catastrophic and the
    // counts duplicated. One status filter replaces all of that: the strip
    // shows counts, the list below filters in place. Failed > 0 lands the
    // user there immediately; otherwise default to "all".
    type StatusFilter = 'all' | 'processing' | 'pending' | 'failed' | 'ready';
    const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
    const longPressTimerRef = useRef<NodeJS.Timeout | null>(null);

    // Notify parent when selection changes
    useEffect(() => {
      onSelectionChange?.(Array.from(selectedDocumentIds));
    }, [selectedDocumentIds, onSelectionChange]);

    // Poll /jobs/active every 7 s for background graph rebuild tasks
    // (entity_extraction, sync_document_hierarchy) that don't surface in
    // documents.processing_status. Result feeds the "Live activity banner"
    // so users see ongoing graph rebuilds instead of "No active worker".
    // We don't reuse `usePersistentJobSync` here because it module-locks the
    // STOMP subscription to its first-mounted instance — a second instance
    // (this component) would only get poll-driven updates, never STOMP
    // events. Polling alone is sufficient for banner visibility; STOMP
    // push remains the canonical channel for the stacks dialog hook.
    useEffect(() => {
      let cancelled = false;
      const pull = async () => {
        try {
          const data = await getMyActiveJobs(true);
          if (cancelled) return;
          const jobs = data?.active_jobs || {};
          const list = Object.values(jobs)
            .filter((j: unknown): j is Record<string, unknown> => !!j && typeof j === 'object')
            .map((j) => ({
              job_id: String(j.job_id || ''),
              document_id: j.document_id ? String(j.document_id) : undefined,
              collection_id: j.collection_id ? String(j.collection_id) : undefined,
              progress: typeof j.progress === 'number' ? j.progress : Number(j.progress) || 0,
              message: String(j.message || ''),
              filename: j.filename ? String(j.filename) : undefined,
              task_name: j.task_name ? String(j.task_name) : undefined,
            }))
            // Drop entries whose underlying document is already in
            // existingDocuments — those are surfaced by the main loop with
            // richer data. Background-only jobs (graph rebuild on docs
            // outside the current page) are what this poll adds.
            .filter((j) => !!j.document_id);
          setBackgroundJobs(list);
        } catch {
          // network blips shouldn't blank the banner; keep previous state
        }
      };
      void pull();
      const id = setInterval(pull, 7000);
      return () => {
        cancelled = true;
        clearInterval(id);
      };
    }, []);

    const toggleDocumentSelection = useCallback((docId: string) => {
      setSelectedDocumentIds(prev => {
        const next = new Set(prev);
        if (next.has(docId)) { next.delete(docId); } else { next.add(docId); }
        if (next.size === 0) setIsSelectionMode(false);
        return next;
      });
    }, []);

    const getLongPressHandlers = useCallback((docId: string) => ({
      onTouchStart: () => {
        longPressTimerRef.current = setTimeout(() => {
          setIsSelectionMode(true);
          setSelectedDocumentIds(prev => {
            const next = new Set(prev);
            next.add(docId);
            return next;
          });
        }, 500);
      },
      onTouchEnd: () => { if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current); },
      onTouchMove: () => { if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current); },
    }), []);

    // Count of active processing options (for badge display)
    const activeProcessingOptions = useMemo(() => {
      let count = 0;
      if (storeFile) count++;
      if (buildGraph) count++;
      if (generateSummary) count++;
      return count;
    }, [storeFile, buildGraph, generateSummary]);

    // Deferred documents — classified as heavy at upload time (>20 MB
    // PDF, or scanned PDF with no text layer) and waiting for user
    // confirmation to actually run the pipeline. Kept as a memo so
    // the banner below it only re-renders when the list actually
    // changes.
    const deferredDocuments = useMemo(() => (
      existingDocuments.filter(d => d.processing_status === ProcessingStatus.DEFERRED)
    ), [existingDocuments]);

    // Track which deferred docs have a confirm-in-flight — guards the
    // banner "Process all" button from double-dispatch and shows
    // per-doc spinner while each reprocess call is resolving.
    const [confirmingDeferred, setConfirmingDeferred] = useState<Set<string>>(new Set());

    // View mode and sorting state
    const [viewMode, setViewMode] = useState<ViewMode>(() => userPrefs.getDocumentViewMode());
    const [sortField, setSortField] = useState<SortField>(() => userPrefs.getDocumentSortField());
    const [sortDirection, setSortDirection] = useState<SortDirection>(() => userPrefs.getDocumentSortDirection());

    // Handle view mode change with persistence
    const handleViewModeChange = useCallback((mode: ViewMode) => {
      setViewMode(mode);
      userPrefs.setDocumentViewMode(mode);
    }, []);

    // Handle sort change with persistence
    const handleSortChange = useCallback((field: SortField, direction: SortDirection) => {
      setSortField(field);
      setSortDirection(direction);
      userPrefs.setDocumentSortField(field);
      userPrefs.setDocumentSortDirection(direction);
    }, []);

    // Sort documents based on current sort settings
    const sortedDocuments = useMemo(() => {
      // Merge paginated existingDocuments with full allProblemDocs list (dedup by id)
      const seenIds = new Set<string>();
      const merged: ExistingDocument[] = [];
      for (const doc of existingDocuments) {
        if (!seenIds.has(doc.id)) { seenIds.add(doc.id); merged.push(doc); }
      }
      for (const doc of allProblemDocs) {
        if (!seenIds.has(doc.id)) { seenIds.add(doc.id); merged.push(doc); }
      }

      // Show documents that need attention: not yet processed OR live graph
      // build in flight. graph_status === 'failed' is intentionally NOT a
      // reason to surface a doc here — see the `allProblemDocs` fetch above
      // for the rationale. The doc itself is fine; the optional graph job
      // simply was never requested or got pruned by the recoverer.
      const unprocessed = merged.filter(doc =>
        doc.processing_status !== ProcessingStatus.COMPLETED ||
        doc.graph_status === 'entity_running' ||
        doc.graph_status === 'hierarchy_done'
      );

      // Pin the doc Celery is currently chewing on (processing_status='processing'
      // or a live non-zero job_progress) to the very top, then pending, then
      // graph-only post-processing, then the long tail, and leave failed docs
      // at the bottom so the broken pile doesn't push the rest off-screen.
      // Keeps the user's selected sort as the secondary key within each bucket.
      const statusBucket = (d: ExistingDocument): number => {
        const ps = d.processing_status;
        // A doc only counts as "live" when the JOBS row says processing AND
        // progress is non-zero. The previous heuristic also accepted any
        // pending doc with job_progress > 0, which kept the row's progress
        // ring lit for hours after the worker had failed (job_status went
        // from 'processing' to 'failed' but the historic progress value
        // stayed in the row).
        const isLive = ps === 'processing'
          || (ps === 'pending' && d.job_status === 'processing' && typeof d.job_progress === 'number' && d.job_progress > 0);
        if (isLive) return 0;
        if (ps === 'pending') return 1;
        if (d.graph_status === 'entity_running' || d.graph_status === 'hierarchy_done') return 2;
        // graph_status === 'failed' is no longer a "failed" signal because
        // graph build was never necessarily requested. Only the document's
        // own processing_status drives the failed bucket.
        if (ps === 'failed') return 4;
        return 3;
      };

      // Within the LIVE bucket, the user sees ~50 docs all dispatched but only
      // 2 actually running through PyMuPDF. The dispatched ones sit pinned to
      // the early progress tick (~1–10%) for minutes; the running ones tick
      // upward visibly. Surface the running ones first so "progres se ne miče"
      // doesn't visually drown the 2 that ARE moving.
      const liveProgressOrder = (d: ExistingDocument): number => {
        const p = typeof d.job_progress === 'number' ? d.job_progress : 0;
        return p;
      };

      return [...unprocessed].sort((a, b) => {
        // When sortField is 'status', status bucket IS the primary sort and
        // filename is the tiebreaker. For every other sortField, status
        // bucket still pins live processing to the top (can't hide the
        // active worker behind a name/date sort) but the chosen field
        // drives the visible order inside each bucket.
        const bucketDelta = statusBucket(a) - statusBucket(b);
        if (sortField === 'status') {
          if (bucketDelta !== 0) {
            return sortDirection === 'asc' ? -bucketDelta : bucketDelta;
          }
          // Inside live bucket: higher progress first (rows actually moving).
          if (statusBucket(a) === 0) {
            const progressDelta = liveProgressOrder(b) - liveProgressOrder(a);
            if (progressDelta !== 0) return progressDelta;
          }
          const nameCmp = (a.filename || '').localeCompare(b.filename || '');
          return sortDirection === 'asc' ? nameCmp : -nameCmp;
        }

        if (bucketDelta !== 0) return bucketDelta;
        // Inside live bucket regardless of chosen sortField: surface movers.
        if (statusBucket(a) === 0) {
          const progressDelta = liveProgressOrder(b) - liveProgressOrder(a);
          if (progressDelta !== 0) return progressDelta;
        }

        let comparison = 0;
        switch (sortField) {
          case 'name':
            comparison = (a.filename || '').localeCompare(b.filename || '');
            break;
          case 'date':
            comparison = new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime();
            break;
          case 'size':
            comparison = (a.file_size || 0) - (b.file_size || 0);
            break;
          case 'type': {
            const extA = (a.filename || '').split('.').pop()?.toLowerCase() || '';
            const extB = (b.filename || '').split('.').pop()?.toLowerCase() || '';
            comparison = extA.localeCompare(extB);
            break;
          }
        }
        return sortDirection === 'asc' ? comparison : -comparison;
      });
    }, [existingDocuments, allProblemDocs, sortField, sortDirection]);

    // Helper function to format file size
    const formatFileSize = (bytes: number | undefined): string => {
      if (bytes === undefined || bytes === null) return '-';
      if (bytes === 0) return '0 B';
      const k = 1024;
      const sizes = ['B', 'KB', 'MB', 'GB'];
      const i = Math.floor(Math.log(bytes) / Math.log(k));
      return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
    };

    // Clear upload state when collection changes
    useEffect(() => {
      setFiles([]);
      setUploadProgress({});
      progressValuesRef.current = {};
      setAllProblemDocs([]);
      setUploaderStats(null);
    }, [collectionId]);

    // Prune stale uploadProgress entries once their documents land in
    // sortedDocuments. Without this the map grows unbounded across upload
    // sessions — the dialog stays mounted, finished entries linger, and
    // every subsequent render iterates a longer Object.entries(uploadProgress)
    // even though only a fraction is still relevant. We keep a 30s grace
    // window so "Upload complete" banners still flash before being cleaned.
    useEffect(() => {
      if (sortedDocuments.length === 0) return;
      setUploadProgress(prev => {
        const keys = Object.keys(prev);
        if (keys.length === 0) return prev;
        const docFilenames = new Set(sortedDocuments.map(d => d.filename));
        const now = Date.now();
        const next: typeof prev = {};
        let changed = false;
        for (const fname of keys) {
          const entry = prev[fname];
          const docPresent = docFilenames.has(sanitizeFilename(fname));
          const stale =
            entry?.isComplete === true &&
            docPresent &&
            (!entry.lastUpdated || now - entry.lastUpdated > 30000);
          if (stale) {
            changed = true;
            delete progressValuesRef.current[fname];
            continue;
          }
          next[fname] = entry;
        }
        return changed ? next : prev;
      });
    }, [sortedDocuments]);

    // Poll collection stats every 30s for processing progress indicator
    useEffect(() => {
      if (!collectionId) return;
      const fetchStats = () => {
        getCollectionStats(collectionId).then(s => { if (s) setUploaderStats(s); });
      };
      fetchStats();
      const interval = setInterval(fetchStats, 30000);
      return () => clearInterval(interval);
    }, [collectionId]);

    // Fetch ALL documents with graph/processing issues (bypasses pagination) + auto-poll every 30s
    useEffect(() => {
      if (!collectionId || !currentWorkspace?.id) return;
      let cancelled = false;
      const fetchProblems = () => {
        getDocumentsByCollection(collectionId, 1, 9999, currentWorkspace.id)
          .then(response => {
            if (cancelled || !response?.documents) return;
            // graph_status === 'failed' is intentionally excluded: most uploads
            // never requested graph build, and a stale/orphan failed row should
            // not parade an otherwise completed doc as "needs attention". Live
            // graph progress (`entity_running`, `hierarchy_done`) IS surfaced
            // because the user explicitly kicked off Build Graph from the
            // dropdown when they want it.
            const problems = response.documents.filter((doc: ExistingDocument) =>
              doc.processing_status !== ProcessingStatus.COMPLETED ||
              doc.graph_status === 'entity_running' || doc.graph_status === 'hierarchy_done'
            );
            setAllProblemDocs(problems);
          })
          .catch(err => console.warn('Failed to fetch problem docs:', err));
      };
      fetchProblems();
      // Auto-poll while there are problem docs
      const interval = setInterval(() => {
        if (allProblemDocs.length > 0) fetchProblems();
      }, 30000);
      return () => { cancelled = true; clearInterval(interval); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are intentionally limited
    }, [collectionId, currentWorkspace?.id]);

    // Ensure workspace is loaded when component mounts
    useEffect(() => {
      if (!currentWorkspace && !isLoadingWorkspace) {
        console.warn('KnowledgeFileUploader: No workspace loaded on mount. This should not happen - triggering workspace refresh.');
        // The workspace context should handle this automatically, but log it for debugging
      }
    }, [currentWorkspace, isLoadingWorkspace]);

    // Update a parent component with upload status
    useEffect(() => {
      if (onUploadStatusChange) {
        onUploadStatusChange(isUploading);
      }
    }, [isUploading, onUploadStatusChange]);

    // Auto-upload when files are added via file picker or drag-drop
    useEffect(() => {
      if (shouldAutoUpload && files.length > 0 && !isUploading) {
        setShouldAutoUpload(false); // Reset flag
        void handleUpload(); // Trigger upload (tries streaming first, falls back to standard)
      }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are intentionally limited
    }, [shouldAutoUpload, files.length, isUploading]);

    // Initialize WebSocket tracking for ongoing jobs that were detected when loading the component
    useEffect(() => {
      // Get the static map of active trackers
      const activeTrackers = DocumentProcessingTracker.getActiveJobs();

      // Set up trackers for each ongoing job
      ongoingJobs.forEach(job => {
        if (!job.jobId || !job.documentId) return;

        // Check if a tracker already exists in the static Map (from previous dialog open)
        const existingTracker = activeTrackers.get(job.jobId);

        if (existingTracker) {
          // Reuse the existing tracker - just update our local ref and reconnect callbacks
          ongoingTrackersRef.current[job.jobId] = existingTracker;

          // CRITICAL: Clear old handlers to avoid stale closures from previous component instances
          // This fixes the bug where progress updates went to old, stale setUploadProgress references
          existingTracker.clearAllHandlers();

          // Restore last known progress from the tracker (fixes hot-reload losing state)
          // PRIORITY: Use ongoingJobs.progress (from backend API) first, as it's always up-to-date
          // Fall back to tracker's internal state (might be stale if tracker was just created)
          const lastProgress = existingTracker.getLastProgress();
          const initialProgress = job.progress ?? lastProgress?.progress ?? 0;
          const initialMessage = job.status === 'processing' && lastProgress?.message
            ? lastProgress.message
            : t('knowledge.uploader.processing');
          const initialStatus = job.status ?? lastProgress?.status ?? 'processing';

          console.log(`🔄 Restoring progress for ${job.filename}: ${initialProgress}% (${initialStatus}) [from ${job.progress ? 'ongoingJobs API' : 'tracker state'}]`);

          // Initialize uploadProgress state immediately so UI shows the file
          setUploadProgress(prev => ({
            ...prev,
            [job.filename]: {
              progress: initialProgress,
              message: initialMessage,
              isComplete: initialStatus === 'completed',
              error: initialStatus === 'failed' ? t('knowledge.uploader.processingFailed') : undefined,
              jobId: job.jobId,
              lastUpdated: Date.now(),
            },
          }));

          // Re-register progress handlers with current component instance's state updaters
          existingTracker.onProgress((progressData: {
            progress: number;
            message: string;
            status: string;
          }) => {
            console.log(`📡 Existing tracker progress for ${job.filename}: ${progressData.progress}%`);
            setUploadProgress(prev => ({
              ...prev,
              [job.filename]: {
                progress: progressData.progress,
                message: progressData.message,
                isComplete: progressData.status === 'completed',
                error:
                  progressData.status === 'failed'
                    ? t('knowledge.uploader.processingFailed')
                    : undefined,
                jobId: job.jobId,
                lastUpdated: Date.now(),
              },
            }));
          });

          // Re-register complete handler
          existingTracker.onComplete(() => {
            console.log(`Existing tracker complete for ${job.filename}`);
            setUploadProgress(prev => ({
              ...prev,
              [job.filename]: {
                progress: 100,
                message: t('knowledge.uploader.processingComplete'),
                isComplete: true,
                jobId: job.jobId,
                lastUpdated: Date.now(),
              },
            }));

            // Clean up tracker
            if (ongoingTrackersRef.current[job.jobId]) {
              delete ongoingTrackersRef.current[job.jobId];
            }

            // Refresh document list
            if (onUploadComplete) {
              setTimeout(() => {
                onUploadComplete();
                setTimeout(() => onUploadComplete(), 2000);
              }, 500);
            }
          });

          // Re-register error handler
          existingTracker.onError((error) => {
            console.error(`❌ Existing tracker error for ${job.filename}:`, error);
            setUploadProgress(prev => ({
              ...prev,
              [job.filename]: {
                progress: prev[job.filename]?.progress || 0,
                message: `Error: ${error.message}`,
                isComplete: false,
                error: error.message,
                jobId: job.jobId,
                lastUpdated: Date.now(),
              },
            }));

            // Clean up tracker
            if (ongoingTrackersRef.current[job.jobId]) {
              delete ongoingTrackersRef.current[job.jobId];
            }
          });

          return; // Skip creating a new tracker
        }

        // Find the document in the existing documents
        // If not found, create a synthetic entry so the file still appears in the UI
        const document = existingDocuments.find(doc => doc.id === job.documentId);

        const documentMessage = document?.doc_metadata?.message || t('knowledge.uploader.processing');

        console.log(`📡 Creating new tracker for ongoing job: ${job.jobId} (${job.filename})${!document ? ' [synthetic entry]' : ''}`);

        // Set initial progress state (start from 0, will be updated immediately by fetchCurrentStatus)
        // This ensures the file appears in the UI even if document isn't in existingDocuments yet
        setUploadProgress(prev => ({
          ...prev,
          [job.filename]: {
            progress: 0,
            message: documentMessage,
            isComplete: false,
            jobId: job.jobId,
            lastUpdated: Date.now(),
          },
        }));

        // Create a new tracker for this job
        const tracker = new DocumentProcessingTracker({
          jobId: job.jobId,
          documentId: job.documentId,
          onProgress: (progressData: {
            progress: number;
            message: string;
            status: string;
          }) => {
            console.log(`📡 New tracker progress for ${job.filename}: ${progressData.progress}%`);
            setUploadProgress(prev => ({
              ...prev,
              [job.filename]: {
                progress: progressData.progress,
                message: progressData.message,
                isComplete: progressData.status === 'completed',
                error:
                  progressData.status === 'failed'
                    ? t('knowledge.uploader.processingFailed')
                    : undefined,
                jobId: job.jobId,
                lastUpdated: Date.now(),
              },
            }));
          },
          onComplete: () => {
            console.log(`New tracker complete for ${job.filename}`);
            setUploadProgress(prev => ({
              ...prev,
              [job.filename]: {
                progress: 100,
                message: t('knowledge.uploader.processingComplete'),
                isComplete: true,
                jobId: job.jobId,
                lastUpdated: Date.now(),
              },
            }));

            // Clean up the tracker (this will remove it from the static Map)
            if (ongoingTrackersRef.current[job.jobId]) {
              ongoingTrackersRef.current[job.jobId].cleanup();
              delete ongoingTrackersRef.current[job.jobId];
            }

            // Refresh the document list
            if (onUploadComplete) {
              // Add a short delay to ensure the backend has completed all operations
              setTimeout(() => {
                onUploadComplete();
                // Make a second refresh after a longer delay to catch any backend lag
                setTimeout(() => {
                  onUploadComplete();
                }, 2000);
              }, 500);
            }

            checkIfAllProcessingComplete(); // Check if this was the last one
          },
          onError: error => {
            console.error(
              `❌ New tracker error for ${job.filename}:`,
              error
            );
            setUploadProgress(prev => ({
              ...prev,
              [job.filename]: {
                progress: 2,
                message: `Error: ${error.message}`,
                isComplete: false,
                error: error.message,
                jobId: job.jobId,
                lastUpdated: Date.now(),
              },
            }));

            // Clean up the tracker (this will remove it from the static Map)
            if (ongoingTrackersRef.current[job.jobId]) {
              ongoingTrackersRef.current[job.jobId].cleanup();
              delete ongoingTrackersRef.current[job.jobId];
            }
          },
        });

        // Store the tracker in the ref
        ongoingTrackersRef.current[job.jobId] = tracker;

        // Immediately fetch current status from backend (handles page reload case)
        // This runs async - the UI will update when it returns
        tracker.fetchCurrentStatus().then(status => {
          if (status) {
            setUploadProgress(prev => ({
              ...prev,
              [job.filename]: {
                progress: status.progress,
                message: status.message,
                isComplete: status.status === 'completed',
                error: status.status === 'failed' ? t('knowledge.uploader.processingFailed') : undefined,
                jobId: job.jobId,
                lastUpdated: Date.now(),
              },
            }));
          }
        });
      });

      // Clean up function - DON'T cleanup trackers on unmount, let them persist
      // They will be cleaned up when jobs complete or fail
      return () => {
        // Only clear the local ref, don't call cleanup() on trackers
        // This allows them to persist across dialog close/reopen
        ongoingTrackersRef.current = {};
      };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are intentionally limited
    }, [ongoingJobs, existingDocuments, onUploadComplete, currentWorkspace?.id]);

    // When existingDocuments changes, update the progress state to mark them as complete
    useEffect(() => {
      // Wait for ongoing jobs to load before marking documents as complete
      // This prevents a race condition where documents load before job status
      if (!ongoingJobsLoaded) return;

      if (existingDocuments && existingDocuments.length > 0) {
        // Create a map of existing documents with complete status
        const existingProgress: {
          [key: string]: {
            progress: number;
            message: string;
            isComplete: boolean;
          };
        } = {};

        existingDocuments.forEach(doc => {
          // Skip documents that are being tracked by WebSockets
          const isBeingTracked = ongoingJobs.some(
            job => job.documentId === doc.id
          );
          if (!isBeingTracked) {
            const isFailed = doc.processing_status === ProcessingStatus.FAILED;
            existingProgress[doc.filename] = {
              progress: isFailed ? 0 : 100,
              message: isFailed
                ? translateProcessingError(doc.processing_error)
                : t('knowledge.uploader.alreadyUploaded'),
              isComplete: !isFailed,
              error: isFailed ? translateProcessingError(doc.processing_error) : undefined,
            };
          }
        });

        // Update the progress state
        setUploadProgress(prev => ({
          ...prev,
          ...existingProgress,
        }));

        // Log existing documents for debugging
      }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are intentionally limited
    }, [existingDocuments, ongoingJobs, ongoingJobsLoaded]);

    // When files are added or removed, update the uploading status
    useEffect(() => {
      // Always notify parent about file changes
      if (onUploadStatusChange) {
        const hasFiles = files.length > 0;

        // Check if files are in progress or just added (unprocessed)
        const anyInProgress =
          hasFiles &&
          files.some(file => {
            const progress = uploadProgress[file.name];
            return progress && !progress.isComplete && progress.progress < 100;
          });

        // Pass both states: whether we have files and whether we're actively uploading
        onUploadStatusChange(hasFiles, anyInProgress);

        // Update internal uploading state if we're actively processing
        if (anyInProgress !== isUploading) {
          setIsUploading(anyInProgress);
        }
      }
    }, [files.length, isUploading, onUploadStatusChange, uploadProgress, files]);

    // Helper function to check if a file's processing is complete
    const isFileProcessingComplete = (file: File): boolean => {
      const progress = uploadProgress[file.name];
      if (!progress) return false;

      // Consider a file complete if:
      // 1. It has isComplete=true (success)
      // 2. It has error defined (failure, but still "complete" for UI purposes)
      return progress.isComplete === true || progress.error !== undefined;
    };

    // Function with the actual abort logic
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are intentionally limited
    const confirmAbortUpload = (showToast = true) => {
      // 1. Abort the initial fetch request (if still running)
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null; // Reset the controller
      }
      // No action needed if controller was already null

      // 2. Find files that need to be aborted
      const filesToAbort = files.filter(file => {
        // Abort if not yet complete or failed/cancelled (allow re-aborting failed ones if needed)
        return !isFileProcessingComplete(file);
      });

      // 3. Abort each file and update state
      filesToAbort.forEach(file => {
        // Clean up the tracker for this file if it exists
        const tracker = ongoingTrackersRef.current[file.name];
        if (tracker) {
          // Use our new cancelProcessing method which will notify the backend
          tracker.cancelProcessing().catch(error => {
            console.error(`Error cancelling processing for ${file.name}:`, error);
          });
          delete ongoingTrackersRef.current[file.name]; // Remove tracker reference
        }

        // Update progress state to cancelled
        setUploadProgress(prev => ({
          ...prev,
          [file.name]: {
            ...prev[file.name],
            progress: 2,
            status: 'cancelled',
            message: t('knowledge.uploader.cancelled'),
            error: t('knowledge.uploader.cancelled'), // Mark as error state
          },
        }));
      });

      // Also check for any job-based trackers that might not be linked to files by name
      Object.keys(ongoingTrackersRef.current).forEach(key => {
        // Check if this could be a job ID (has a UUID format) rather than a filename
        if (key.length === 36 && key.includes('-')) {
          const tracker = ongoingTrackersRef.current[key];
          tracker.cancelProcessing().catch(error => {
            console.error(`Error cancelling processing for job ${key}:`, error);
          });
          delete ongoingTrackersRef.current[key];
        }
      });

      // Reset overall state
      setFiles([]); // Clear the file list for future uploads
      setIsUploading(false);
      if (onUploadStatusChange) {
        onUploadStatusChange(false, false);
      }

      // Close the confirmation dialog
      setIsAbortConfirmationOpen(false);

      // Notify parent to refresh document list
      setTimeout(() => {
        if (onUploadComplete) {
          onUploadComplete();
        }
      }, 500);

      // Show a toast notification only if requested
      if (showToast) {
        toast({
          title: t('knowledge.uploader.uploadAborted'),
          description: t('knowledge.uploader.uploadAbortedDescription'),
        });
      }
    };

    // Add a manual refresh function
    const refreshAllJobStatus = useCallback(async () => {
      setIsRefreshingStatus(true);
      // Get trackers as entries - keys may be filenames OR job_ids depending on how stored
      const trackerEntries = Object.entries(ongoingTrackersRef.current);

      if (trackerEntries.length === 0) {
        setIsRefreshingStatus(false);
        return;
      }

      try {
        // Refresh each job status manually using the api instance
        const refreshPromises = trackerEntries.map(async ([refKey, tracker]) => {
          // Use tracker.getJobId() to get the actual job_id, not the ref key
          const jobId = tracker.getJobId();
          try {
            // Use the api instance which includes interceptors for correct auth
            // header. `api` already has baseURL = API_BASE_URL, so the path must
            // be relative — prefixing API_BASE_URL again produced a doubled-base
            // URL in error logs.
            const response = await api.get(
              `/documents/processing_status/${jobId}`
            );

            if (response.status === 200 && ongoingTrackersRef.current[refKey]) {
              // Process the update using the tracker's handler
              ongoingTrackersRef.current[refKey].processProgressEvent(
                response.data
              );
            }
          } catch (error) {
            // Axios errors have response data on error.response
            const status = (error as { response?: { status?: number } }).response?.status;
            if (status === 401) {
              console.warn(
                `Auth error refreshing job status for ${jobId}. Token might be expired.`
              );
              // Optionally trigger logout or token refresh here
            } else if (status === 404) {
              // Benign: the job finished (and was unregistered) between the
              // /jobs/active snapshot and this poll, or expired from the
              // registry. Not an error — just stop noisy logging.
              console.debug(`Job ${jobId} no longer active (404), skipping.`);
            } else {
              console.error(`Error refreshing job status for ${jobId}:`, error);
            }
          }
        });

        await Promise.all(refreshPromises);
      } catch (error) {
        console.error('Error refreshing job statuses:', error);
      } finally {
        // Delay turning off the refresh state to ensure spinner is visible
        setTimeout(() => {
          setIsRefreshingStatus(false);
        }, 500);
      }
    }, []); // Dependencies for useCallback

    // Define handleUpload before using it in useImperativeHandle
    // File upload handler
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are intentionally limited
    const handleUpload = async () => {
      if (!collectionId) {
        toast({
          variant: 'destructive',
          title: t('knowledge.uploader.error'),
          description: t('knowledge.uploader.noCollectionSelected'),
        });
        return;
      }

      // Wait for workspace to load if it's still loading
      if (isLoadingWorkspace) {
        toast({
          title: t('knowledge.uploader.pleaseWait'),
          description: t('knowledge.uploader.loadingWorkspaceInfo'),
        });
        return;
      }

      if (!currentWorkspace?.id) {
        toast({
          variant: 'destructive',
          title: t('knowledge.uploader.error'),
          description: t('knowledge.uploader.failedToLoadWorkspace'),
        });
        console.error('No workspace available. This should never happen - every user should have a default workspace.');
        return;
      }

      if (files.length === 0) {
        toast({
          title: t('knowledge.uploader.noFiles'),
          description: t('knowledge.uploader.pleaseSelectFiles'),
        });
        return;
      }

      // Check storage quota before starting upload
      try {
        const totalFileSize = files.reduce((sum, file) => sum + file.size, 0);
        const quotaCheck = await checkStorageQuota(totalFileSize, collectionId);

        if (!quotaCheck.allowed) {
          toast({
            variant: 'destructive',
            title: t('knowledge.uploader.storageQuotaExceeded'),
            description: quotaCheck.message,
            duration: 10000,
          });

          // Show detailed quota info
          toast({
            title: t('knowledge.uploader.uploadSize'),
            description: t('knowledge.uploader.uploadSizeMessage', { size: formatBytes(totalFileSize), message: quotaCheck.message }),
            variant: 'warning',
            duration: 10000,
          });
          return;
        }
      } catch (error) {
        console.error('Error checking storage quota:', error);
        // Check-endpoint failure is not a quota verdict — proceed; the server
        // hard-enforces the quota inside every upload path anyway (streaming
        // emits a storageQuotaExceeded error packet, multipart returns 413).
      }

      // Prepare authentication for bulk processing to prevent cutoffs during upload
      const authPreparation = await prepareForBulkProcessing(files.length);

      if (!authPreparation.success) {
        toast({
          variant: 'destructive',
          title: t('fileAttachment.errors.authenticationError'),
          description: t('fileAttachment.errors.authenticationFailed'),
        });
        return;
      }

      // Store cleanup function to stop auth monitoring when upload completes
      const authCleanup = authPreparation.cleanup;

      // Always try to use streaming upload first for better progress tracking
      try {
        await handleStreamingUpload();
        return; // Success - exit early
      } catch (error) {
        console.warn('Streaming upload failed, falling back to standard upload. Details:', error);
        // Continue with standard upload as fallback
      }

      // Standard upload flow continues here as fallback
      setIsUploading(true);
      if (onUploadStatusChange) onUploadStatusChange(true, true);

      // Initialize AbortController for this upload batch
      abortControllerRef.current = new AbortController();
      const { signal } = abortControllerRef.current;

      // Provide immediate user feedback before the first API call
      for (const file of files) {
        // Set the initial "Preparing" status for all files
        setUploadProgress(prev => ({
          ...prev,
          [file.name]: {
            progress: 2,
            message: t('knowledge.uploader.preparingUpload'),
            isComplete: false,
          },
        }));
      }

      // Add a small delay to ensure UI updates before starting the upload process
      await new Promise(resolve => setTimeout(resolve, 100));

      // Pre-upload: fetch ALL filenames in this collection to detect duplicates
      // (existingDocuments is paginated and may not contain all docs)
      const allExistingFilenames: Set<string> = new Set();
      try {
        const allDocsResponse = await getDocumentsByCollection(collectionId, 1, 9999, currentWorkspace?.id);
        if (allDocsResponse?.documents) {
          for (const doc of allDocsResponse.documents) {
            if (doc.filename && doc.processing_status !== 'failed') {
              allExistingFilenames.add(doc.filename);
            }
          }
        }
      } catch (err) {
        console.warn('Failed to pre-fetch document list for duplicate check, falling back to loaded documents', err);
        for (const doc of existingDocuments) {
          if (doc.filename && doc.processing_status !== 'failed') {
            allExistingFilenames.add(doc.filename);
          }
        }
      }

      // Filter out files that already exist or are invalid types
      const filesToUpload = files.filter(file => {
        const sanitizedName = sanitizeFilename(file.name);

        // Check against full collection filename list
        const existsInCollection = allExistingFilenames.has(sanitizedName);

        const existingDoc = existingDocuments.find(
          doc => doc.filename === sanitizedName
        );

        const existsAndCompleted = existsInCollection || (existingDoc &&
          existingDoc.doc_metadata?.status === 'completed' &&
          existingDoc.job_status !== 'failed' &&
          existingDoc.processing_status !== 'failed');

        if (existsAndCompleted) {
          setUploadProgress(prev => ({
            ...prev,
            [file.name]: {
              progress: 100,
              message: t('knowledge.uploader.alreadyExists'),
              isComplete: true,
            },
          }));
        }

        // If file exists AND has explicitly failed, automatically delete it before re-upload
        const hasExplicitlyFailed = existingDoc && (
          existingDoc.doc_metadata?.status === 'failed' ||
          existingDoc.job_status === 'failed' ||
          existingDoc.processing_status === 'failed'
        );

        if (hasExplicitlyFailed && onDeleteDocument) {
          console.log(`Auto-deleting failed document: ${existingDoc.filename} (ID: ${existingDoc.id})`);
          onDeleteDocument(existingDoc.id).catch(err => {
            console.error('Failed to auto-delete failed document:', err);
          });
        }
        // Add file type validation if required
        const validTypes = [
          'application/pdf',
          'application/epub+zip',
          'application/x-mobipocket-ebook',
          'text/plain',
          'text/markdown',
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        ];
        const isValidType =
          validTypes.includes(file.type) ||
          file.type.startsWith('audio/') ||
          file.type.startsWith('video/') ||
          !!file.name.match(
            /\.(pdf|epub|mobi|txt|md|csv|rtf|docx|mp3|wav|m4a|ogg|webm|flac|aac|opus|wma|aiff|amr|mp4|mov|mkv|avi|m4v|mpeg|mpg|flv|wmv)$/i
          );
        if (!isValidType) {
          console.warn(`Skipping invalid file type: ${file.name} (${file.type})`);
          setUploadProgress(prev => ({
            ...prev,
            [file.name]: {
              progress: 2,
              message: 'Invalid file type',
              error: 'Invalid type',
              isComplete: false,
            },
          }));
        }
        return !existsAndCompleted && isValidType;
      });

      if (filesToUpload.length === 0 && files.length > 0) {

        setIsUploading(false); // No actual upload needed
        if (onUploadStatusChange) onUploadStatusChange(false, false);
        // Clear the file list if only existing/invalid files were selected
        setFiles([]);
        toast({
          title: 'No new files',
          description:
            'All selected files either already exist or are not valid PDFs.',
        });
        return;
      }

      let allUploadsSuccessful = true;
      let activeTrackersCount = 0; // Count trackers started in this batch

      for (const file of filesToUpload) {
        // Check if aborted before starting next file upload
        if (signal.aborted) {

          allUploadsSuccessful = false; // Mark as unsuccessful due to abort
          break; // Exit the loop
        }

        const sanitizedFilename = sanitizeFilename(file.name);
        setUploadProgress(prev => ({
          ...prev,
          [file.name]: {
            progress: 2,
            message: t('knowledge.uploader.preparingUpload'),
            isComplete: false,
          },
        }));

        const formData = new FormData();
        formData.append('file', file, sanitizedFilename); // Send sanitized name
        formData.append('collection_id', collectionId);
        formData.append('workspace_id', currentWorkspace.id); // Add workspace ID
        formData.append('auto_process', 'false'); // Do NOT auto-process - wait for user to click "Compose"
        formData.append('store_file', storeFile ? 'true' : 'false');
        formData.append('build_graph', buildGraph ? 'true' : 'false');
        formData.append('generate_summary', generateSummary ? 'true' : 'false');

        try {
          setUploadProgress(prev => ({
            ...prev,
            [file.name]: {
              progress: 5,
              message: t('knowledge.uploader.uploading'),
              isComplete: false,
            },
          }));

          const token = await getRefreshedToken();
          const response = await fetch(`${API_BASE_URL}/documents/upload_async`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              // 'Content-Type': 'multipart/form-data' // Fetch handles this
            },
            body: formData,
            signal: signal, // Pass the abort signal
          });

          if (!response.ok) {
            let errorData;
            try {
              errorData = await response.json();
            } catch (e) {
              errorData = { detail: response.statusText };
            }
            console.error(
              `Upload failed for ${file.name}: ${response.status}`,
              errorData
            );

            // Check for specific conflict error
            if (response.status === 409) {
              setUploadProgress(prev => ({
                ...prev,
                [file.name]: {
                  progress: 100,
                  message: t('knowledge.uploader.alreadyExists'),
                  error: 'Conflict',
                  isComplete: true,
                },
              }));
              toast({
                variant: 'default',
                title: t('knowledge.uploader.fileExists'),
                description: t('knowledge.uploader.fileAlreadyExists', { filename: sanitizedFilename }),
              });
            } else if (response.status === 429) {
              // Handle rate limiting / concurrent job limit
              setUploadProgress(prev => ({
                ...prev,
                [file.name]: {
                  progress: 2,
                  message: t('knowledge.uploader.limitReached'),
                  error: errorData?.detail || 'Too many concurrent jobs',
                  isComplete: false,
                },
              }));
              toast({
                variant: 'destructive',
                title: t('knowledge.uploader.processingLimitReached'),
                description: errorData?.detail || t('knowledge.uploader.waitForOngoingJobs'),
              });
              allUploadsSuccessful = false; // Stop further uploads if limit is hit
              break; // Exit loop on rate limit
            } else {
              setUploadProgress(prev => ({
                ...prev,
                [file.name]: {
                  progress: 2,
                  message: 'Upload failed',
                  error: errorData?.detail || response.statusText,
                  isComplete: false,
                },
              }));

              // Special handling for single file uploads
              const isSingleFileUpload = filesToUpload.length === 1;
              if (isSingleFileUpload) {
                // Clear the file from the upload list since it failed
                setFiles(prev => prev.filter(f => f.name !== file.name));
              }

              // Stop uploading state immediately when error occurs
              setIsUploading(false);
              if (onUploadStatusChange) {
                onUploadStatusChange(false, false);
              }
            }
            allUploadsSuccessful = false;
            break; // Stop an entire upload process on error
          }

          // Upload successfully, start tracking processing
          const result = await response.json();

          // Extract job_id and document_id (snake_case from backend)
          const { job_id, document_id } = result;

          if (!job_id || !document_id) {
            console.error(
              'Missing job_id or document_id in upload response:',
              result
            );
            setUploadProgress(prev => ({
              ...prev,
              [file.name]: {
                progress: 2,
                message: 'Invalid response from server',
                error: 'Missing job ID or document ID',
                isComplete: false,
              },
            }));
            continue; // Skip to next file
          }

          // Set initial progress to 0% and wait for real backend updates
          setUploadProgress(prev => ({
            ...prev,
            [file.name]: {
              progress: 2,
              message: 'Starting document processing...',
              isComplete: false,
            },
          }));

          // Start WebSocket tracking
          ongoingTrackersRef.current[file.name] = new DocumentProcessingTracker({
            jobId: job_id,
            documentId: document_id,
            onProgress: progressData => {
              setUploadProgress(prev => ({
                ...prev,
                [file.name]: {
                  progress: progressData.progress,
                  message: progressData.message,
                  isComplete: progressData.status === 'completed',
                  error:
                    progressData.status === 'failed'
                      ? progressData.message
                      : undefined,
                  lastUpdated: Date.now(), // Add timestamp for each update
                },
              }));
            },
            onComplete: () => {
              setUploadProgress(prev => ({
                ...prev,
                [file.name]: {
                  progress: 100,
                  message: 'Processing complete',
                  isComplete: true,
                  lastUpdated: Date.now(),
                },
              }));
              delete ongoingTrackersRef.current[file.name]; // Clean up tracker ref

              // Immediately refresh the document list when processing completes
              if (onUploadComplete) {

                // Add a short delay to ensure backend has completed all operations
                setTimeout(() => {
                  onUploadComplete();
                  // Make a second refresh after a longer delay to catch any backend lag
                  setTimeout(() => {

                    onUploadComplete();
                  }, 2000);
                }, 500);
              }

              checkIfAllProcessingComplete(); // Check if this was the last one
            },
            onError: error => {
              console.error(
                `Error tracking job ${job_id} for document ${file.name}:`,
                error
              );
              setUploadProgress(prev => ({
                ...prev,
                [file.name]: {
                  progress: 2,
                  message: `Error: ${error.message || 'Tracking failed'}`,
                  isComplete: false,
                  error: error.message || 'Tracking failed',
                },
              }));

              // Notify user of error through toast
              toast({
                title: 'Processing Error',
                description: `Error processing ${file.name}: ${error.message || 'Tracking failed'}`,
                variant: 'destructive',
              });

              delete ongoingTrackersRef.current[file.name]; // Clean up tracker ref
              checkIfAllProcessingComplete(); // Check if this was the last one
            },
          });

          activeTrackersCount++; // Increment count for this batch

          // No need to call trackExistingJob since we provided jobId and documentId in constructor

        } catch (error) {
          if ((error as Error).name === 'AbortError') {

            // Progress is updated by confirmAbortUpload
            allUploadsSuccessful = false;
            break; // Exit loop if fetch was aborted
          } else {
            console.error(
              `Unhandled error during upload for ${file.name}:`,
              error
            );
            setUploadProgress(prev => ({
              ...prev,
              [file.name]: {
                progress: 2,
                message: 'Network or unexpected error',
                error: (error as Error).message,
                isComplete: false,
              },
            }));
            toast({
              variant: 'destructive',
              title: 'Upload Error',
              description: `An unexpected error occurred: ${(error as Error).message}`,
            });
            allUploadsSuccessful = false;
            // Clean up tracker if created but fetch failed unexpectedly
            if (ongoingTrackersRef.current[file.name]) {
              ongoingTrackersRef.current[file.name].cleanup();
              delete ongoingTrackersRef.current[file.name];
            }
          }
        }
      } // End of for loop



      // Check if the process was aborted after the loop finished but before final checks
      if (abortControllerRef.current === null) {

        // loadingContext.hideLoading("uploading"); // Removed
        // State reset is handled by confirmAbortUpload
        return;
      }

      // Final check: Update loading state only if no trackers were started or if all started trackers are already done
      if (activeTrackersCount === 0 && !signal.aborted) {
        setIsUploading(false);
        if (onUploadStatusChange) onUploadStatusChange(false, false);

        // Clear API cache to ensure fresh data
        try {
          // Import clearCache from the lib index to avoid circular dependencies
          const { clearCache } = await import('@/lib/api');
          // Clear any cached responses for document collections to ensure fresh data
          clearCache('/documents/collection/');
          clearCache('/collections/');

        } catch (error) {
          console.warn('Failed to clear API cache:', error);
        }

        // Always clear files — failed files should not persist in UI
        setFiles([]);
        // isUploading state will be managed by checkIfAllProcessingComplete via callbacks
        // Do not hide global loader yet, wait for trackers
      } else if (!signal.aborted) {
        // isUploading state will be managed by checkIfAllProcessingComplete via callbacks
        // Do not hide global loader yet, wait for trackers
      } else {
        // If aborted, loading state is handled by confirmAbortUpload
        // loadingContext.hideLoading("uploading"); // Removed
      }

      // Call this in case all uploads failed or were skipped but some *existing* trackers might still be running
      checkIfAllProcessingComplete();

      // Clean up authentication monitoring when upload process completes
      authCleanup();
    };

    // Smooth progress animation - increments by 1% every 100ms
    const animateProgress = useCallback((fileName: string, targetProgress: number, message: string, status?: string) => {
      // Validate targetProgress is a valid number
      if (typeof targetProgress !== 'number' || isNaN(targetProgress) || targetProgress < 0) {
        console.error(`❌ Invalid progress value for ${fileName}: ${targetProgress}, ignoring update`);
        return;
      }

      // Ensure progress is within 0-100 range
      const validTargetProgress = Math.max(0, Math.min(100, targetProgress));

      // Clear any existing animation for this file
      if (progressAnimationRef.current[fileName]) {
        clearInterval(progressAnimationRef.current[fileName]);
        delete progressAnimationRef.current[fileName];
      }

      // Get current progress from ref (NOT state) to avoid race conditions
      const currentProgress = progressValuesRef.current[fileName] || 0;
      console.log(`📊 Progress update for ${fileName}: current=${currentProgress}%, target=${validTargetProgress}%, message="${message}"`);

      // CRITICAL: Prevent backwards progress (ignore lower values unless it's an error/completion state)
      if (currentProgress > validTargetProgress && status !== 'failed' && status !== 'completed') {
        console.warn(`⚠️ Ignoring backwards progress for ${fileName}: ${currentProgress}% -> ${validTargetProgress}%`);
        return; // Don't animate backwards
      }

      // Use the validated target progress
      const targetProgressToUse = validTargetProgress;

      // If already at or past target, update immediately
      if (currentProgress >= targetProgressToUse) {
        // Update ref first (synchronous)
        progressValuesRef.current[fileName] = targetProgressToUse;

        setUploadProgress(prev => ({
          ...prev,
          [fileName]: {
            progress: targetProgressToUse,
            message,
            isComplete: status === 'completed' || targetProgressToUse >= 100,
            error: status === 'failed' ? message : undefined,
            lastUpdated: Date.now(),
          },
        }));
        return;
      }

      // Start animation interval to increment by 1% every 100ms
      let animatedProgress = currentProgress;
      const interval = setInterval(() => {
        animatedProgress += 1;

        if (animatedProgress >= targetProgressToUse) {
          // Reached target - stop animation
          clearInterval(interval);
          delete progressAnimationRef.current[fileName];

          // Update ref first (synchronous)
          progressValuesRef.current[fileName] = targetProgressToUse;

          setUploadProgress(prev => ({
            ...prev,
            [fileName]: {
              progress: targetProgressToUse,
              message,
              isComplete: status === 'completed' || targetProgressToUse >= 100,
              error: status === 'failed' ? message : undefined,
              lastUpdated: Date.now(),
            },
          }));
        } else {
          // Increment progress and update ref
          progressValuesRef.current[fileName] = animatedProgress;

          setUploadProgress(prev => ({
            ...prev,
            [fileName]: {
              progress: animatedProgress,
              message,
              isComplete: false,
              error: status === 'failed' ? message : undefined,
              lastUpdated: Date.now(),
            },
          }));
        }
      }, 100); // 100ms per 1% = 10 seconds for 0-100%

      // Store interval reference
      progressAnimationRef.current[fileName] = interval;
    }, []);

    // Cleanup function for progress animations
    useEffect(() => {
      return () => {
        // Clear all animations on unmount
        Object.values(progressAnimationRef.current).forEach(interval => clearInterval(interval));
        progressAnimationRef.current = {};
        progressValuesRef.current = {};
      };
    }, []);

    // New streaming upload handler
    const handleStreamingUpload = async () => {
      // Prepare authentication for bulk processing to prevent cutoffs during upload
      const authPreparation = await prepareForBulkProcessing(files.length);

      if (!authPreparation.success) {
        toast({
          variant: 'destructive',
          title: t('fileAttachment.errors.authenticationError'),
          description: t('fileAttachment.errors.authenticationFailed'),
        });
        throw new Error('Authentication preparation failed for streaming upload');
      }

      // Store cleanup function to stop auth monitoring when upload completes
      const authCleanup = authPreparation.cleanup;

      setIsUploading(true);
      if (onUploadStatusChange) onUploadStatusChange(true, true);

      // Initialize AbortController for this upload batch
      abortControllerRef.current = new AbortController();
      const { signal } = abortControllerRef.current;

      // Provide immediate user feedback before the first API call
      for (const file of files) {
        // Set the initial "Preparing" status for all files
        // Update ref first (synchronous) to prevent race conditions
        progressValuesRef.current[file.name] = 1;

        setUploadProgress(prev => ({
          ...prev,
          [file.name]: {
            progress: 1,
            message: t('knowledge.uploader.preparingUpload'),
            isComplete: false,
          },
        }));
      }

      // Add a small delay to ensure UI updates before starting the upload process
      await new Promise(resolve => setTimeout(resolve, 100));

      // Pre-upload: fetch ALL filenames in this collection to detect duplicates
      // (existingDocuments is paginated and may not contain all docs)
      const allExistingFilenames: Set<string> = new Set();
      try {
        const allDocsResponse = await getDocumentsByCollection(collectionId, 1, 9999, currentWorkspace?.id);
        if (allDocsResponse?.documents) {
          for (const doc of allDocsResponse.documents) {
            if (doc.filename && doc.processing_status !== 'failed') {
              allExistingFilenames.add(doc.filename);
            }
          }
        }
      } catch (err) {
        console.warn('Failed to pre-fetch document list for duplicate check, falling back to loaded documents', err);
        // Fallback: use whatever is in existingDocuments
        for (const doc of existingDocuments) {
          if (doc.filename && doc.processing_status !== 'failed') {
            allExistingFilenames.add(doc.filename);
          }
        }
      }

      // Filter out files that already exist or are invalid types
      const filesToUpload = files.filter(file => {
        const sanitizedName = sanitizeFilename(file.name);

        // Check against full collection filename list (not just paginated existingDocuments)
        const existsInCollection = allExistingFilenames.has(sanitizedName);

        // Also check local existingDocuments for more detailed status info
        const existingDoc = existingDocuments.find(
          doc => doc.filename === sanitizedName
        );

        const existsAndCompleted = existsInCollection || (existingDoc &&
          existingDoc.doc_metadata?.status === 'completed' &&
          existingDoc.job_status !== 'failed' &&
          existingDoc.processing_status !== 'failed');

        if (existsAndCompleted) {
          // Skip completed duplicates client-side
          setUploadProgress(prev => ({
            ...prev,
            [file.name]: {
              progress: 100,
              message: t('knowledge.uploader.alreadyExists'),
              isComplete: true,
            },
          }));
        }

        // If file exists AND has explicitly failed, automatically delete it before re-upload
        const hasExplicitlyFailed = existingDoc && (
          existingDoc.doc_metadata?.status === 'failed' ||
          existingDoc.job_status === 'failed' ||
          existingDoc.processing_status === 'failed'
        );

        if (hasExplicitlyFailed && onDeleteDocument) {
          console.log(`Auto-deleting failed document: ${existingDoc.filename} (ID: ${existingDoc.id})`);
          onDeleteDocument(existingDoc.id).catch(err => {
            console.error('Failed to auto-delete failed document:', err);
          });
        }
        // Add file type validation
        const validTypes = [
          'application/pdf',
          'application/epub+zip',
          'application/x-mobipocket-ebook',
          'text/plain',
          'text/markdown',
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        ];
        const isValidType =
          validTypes.includes(file.type) ||
          file.type.startsWith('audio/') ||
          file.type.startsWith('video/') ||
          !!file.name.match(
            /\.(pdf|epub|mobi|txt|md|csv|rtf|docx|mp3|wav|m4a|ogg|webm|flac|aac|opus|wma|aiff|amr|mp4|mov|mkv|avi|m4v|mpeg|mpg|flv|wmv)$/i
          );
        if (!isValidType) {
          console.warn(`Skipping invalid file type: ${file.name} (${file.type})`);
          setUploadProgress(prev => ({
            ...prev,
            [file.name]: {
              progress: 2,
              message: 'Invalid file type',
              error: 'Invalid type',
              isComplete: false,
            },
          }));
        }
        // Skip files exceeding max upload size (200MB when storing on disk, no limit for memory-only)
        if (storeFile) {
          const MAX_UPLOAD_SIZE = 200 * 1024 * 1024;
          if (file.size > MAX_UPLOAD_SIZE) {
            console.warn(`Skipping oversized file: ${file.name} (${(file.size / 1024 / 1024).toFixed(1)}MB)`);
            setUploadProgress(prev => ({
              ...prev,
              [file.name]: {
                progress: 0,
                message: t('knowledge.uploader.fileTooLarge', { maxSize: '200MB' }),
                error: t('knowledge.uploader.fileTooLarge', { maxSize: '200MB' }),
                isComplete: false,
              },
            }));
            return false;
          }
        }
        return !existsAndCompleted && isValidType;
      });

      if (filesToUpload.length === 0 && files.length > 0) {

        setIsUploading(false);
        if (onUploadStatusChange) onUploadStatusChange(false, false);
        setFiles([]);
        toast({
          title: 'No new files',
          description:
            'All selected files either already exist or are not valid PDFs.',
        });
        return;
      }

      let allUploadsSuccessful = true;

      // Log the API api_base we'll be using
      const streamingEndpoint = `${API_BASE_URL}/documents/upload_stream`;


      for (const file of filesToUpload) {
        // Check if aborted before starting next file upload
        if (signal.aborted) {

          allUploadsSuccessful = false;
          break;
        }

        const sanitizedFilename = sanitizeFilename(file.name);

        // Update ref first (synchronous) to prevent race conditions
        progressValuesRef.current[file.name] = 2;

        setUploadProgress(prev => ({
          ...prev,
          [file.name]: {
            progress: 2,
            message: 'Starting upload...',
            isComplete: false,
          },
        }));

        const formData = new FormData();
        formData.append('file', file, sanitizedFilename);
        formData.append('collection_id', collectionId);
        formData.append('workspace_id', currentWorkspace.id); // Add workspace ID
        formData.append('auto_process', 'true'); // Always auto-process on normal upload. Store-on-disk must still be indexed (heavy files get deferred backend-side via the heaviness classifier); the only intentional no-auto-process path is Compose staging, which sets its own auto_process=false.
        formData.append('store_file', storeFile ? 'true' : 'false');
        formData.append('build_graph', buildGraph ? 'true' : 'false');
        formData.append('generate_summary', generateSummary ? 'true' : 'false');

        try {
          const token = await getRefreshedToken();


          // Create AbortController with extended timeout for document uploads
          const uploadController = new AbortController();
          const timeoutId = setTimeout(() => {
            uploadController.abort();
          }, 300000); // 5-minute timeout for document uploads

          // Combine user abort signal with timeout signal
          const combinedSignal = signal.aborted ? signal : uploadController.signal;

          const response = await fetch(streamingEndpoint, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
            },
            body: formData,
            signal: combinedSignal,
          });

          // Clear timeout on successful response
          clearTimeout(timeoutId);



          if (!response.ok) {
            let errorData;
            try {
              errorData = await response.json();
              console.error('Streaming upload error response:', errorData);
            } catch (e) {
              errorData = { detail: response.statusText };
              console.error('Failed to parse error response:', e);
            }

            console.error(
              `Streaming upload failed for ${file.name}: ${response.status}`,
              errorData
            );

            // Handle specific errors
            if (response.status === 409) {
              setUploadProgress(prev => ({
                ...prev,
                [file.name]: {
                  progress: 100,
                  message: t('knowledge.uploader.alreadyExists'),
                  error: 'Conflict',
                  isComplete: true,
                },
              }));
            } else if (response.status === 404) {
              const notFoundMsg = `Streaming api_base not found: ${streamingEndpoint}. This suggests the backend doesn't support streaming uploads yet.`;
              setUploadProgress(prev => ({
                ...prev,
                [file.name]: {
                  progress: 0,
                  message: notFoundMsg,
                  error: notFoundMsg,
                  isComplete: false,
                },
              }));
            } else {
              // Mark this file as failed but continue with remaining files
              const errorMsg = response.status === 413
                ? t('knowledge.uploader.fileTooLarge', { maxSize: '500MB', defaultValue: 'File too large (max 500MB)' })
                : (errorData?.message || errorData?.detail || response.statusText);
              setUploadProgress(prev => ({
                ...prev,
                [file.name]: {
                  progress: 0,
                  message: errorMsg,
                  error: errorMsg,
                  isComplete: false,
                },
              }));
            }
            allUploadsSuccessful = false;
            continue; // Skip this file, continue with remaining files
          }



          // Process the streaming response
          const reader = response.body?.getReader();
          if (!reader) {
            const noReaderMsg = 'Stream reader not available';
            setUploadProgress(prev => ({
              ...prev,
              [file.name]: {
                progress: 0,
                message: noReaderMsg,
                error: noReaderMsg,
                isComplete: false,
              },
            }));
            allUploadsSuccessful = false;
            continue;
          }

          const decoder = new TextDecoder();
          let documentId = null;
          let streamMessages = 0;

          // Process the stream in chunks
          while (true) {
            const { done, value } = await reader.read();
            if (done) {

              break;
            }

            // Convert bytes to text
            const chunk = decoder.decode(value, { stream: true });


            // Split by newlines to get individual JSON messages
            const lines = chunk.split('\n').filter(line => line.trim());


            for (const line of lines) {
              try {
                const data = JSON.parse(line);
                streamMessages++;


                if (data.type === 'status') {
                  const status = data.content;

                  // Validate and extract progress value
                  const rawProgress = status.progress;
                  const targetProgress = typeof rawProgress === 'number' && !isNaN(rawProgress)
                    ? Math.min(100, Math.max(0, rawProgress))
                    : 0;

                  console.log(`📊 Progress update for ${file.name}: ${targetProgress}% (raw: ${rawProgress})`);

                  // Animate progress smoothly to target
                  animateProgress(file.name, targetProgress, status.message, status.status);
                  // Save document ID if provided
                  if (status.document_id && !documentId) {
                    documentId = status.document_id;
                  }

                  // Set up the WebSocket tracker to continue receiving progress updates
                  // after the streaming phase completes (streaming provides 0-10%, WebSocket provides 10-100%)
                  if (status.job_id && status.document_id && !ongoingTrackersRef.current[file.name]) {
                    console.log(`📡 Setting up WebSocket tracker for ${file.name} (job_id: ${status.job_id})`);

                    ongoingTrackersRef.current[file.name] = new DocumentProcessingTracker({
                      jobId: status.job_id,
                      documentId: status.document_id,
                      onProgress: (progressData: { progress: number; message: string; status: string; }) => {
                        const actualProgress = getActualProgress(progressData);
                        console.log(`📡 WebSocket progress for ${file.name}: ${actualProgress}%`);

                        // Validate progress is numeric
                        if (typeof actualProgress === 'number' && !isNaN(actualProgress)) {
                          animateProgress(file.name, actualProgress, progressData.message, progressData.status);
                        }
                      },
                      onComplete: () => {
                        console.log(`WebSocket tracking complete for ${file.name}`);
                        setUploadProgress(prev => ({
                          ...prev,
                          [file.name]: {
                            progress: 100,
                            message: 'Processing complete',
                            isComplete: true,
                            lastUpdated: Date.now(),
                          },
                        }));

                        // Clean up tracker
                        if (ongoingTrackersRef.current[file.name]) {
                          delete ongoingTrackersRef.current[file.name];
                        }

                        // Refresh document list
                        if (onUploadComplete) {
                          setTimeout(() => {
                            onUploadComplete();
                            setTimeout(() => onUploadComplete(), 2000);
                          }, 500);
                        }
                      },
                      onError: (error) => {
                        console.error(`❌ WebSocket tracking error for ${file.name}:`, error);
                        setUploadProgress(prev => ({
                          ...prev,
                          [file.name]: {
                            progress: 2,
                            message: `Error: ${error.message || 'Tracking failed'}`,
                            error: error.message || 'Tracking failed',
                            isComplete: false,
                            lastUpdated: Date.now(),
                          },
                        }));

                        // Clean up tracker
                        if (ongoingTrackersRef.current[file.name]) {
                          delete ongoingTrackersRef.current[file.name];
                        }
                      },
                    });
                  }
                } else if (data.type === 'error') {
                  console.error(`Stream error for ${file.name}:`, data.content);

                  // Check if it's a duplicate document error
                  const isDuplicateError = data.content.detail?.includes('already exists');
                  const isQuotaError = data.content.code === 'storageQuotaExceeded';
                  const errorMessage = isQuotaError
                    ? `${t('knowledge.uploader.storageQuotaExceeded')}: ${data.content.message || ''}`
                    : isDuplicateError
                      ? t('knowledge.upload.duplicateDocument', 'This document already exists in the collection. Delete the existing file first or rename before uploading.')
                      : data.content.detail || data.content.message || t('fileAttachment.errors.unknownError');

                  setUploadProgress(prev => ({
                    ...prev,
                    [file.name]: {
                      progress: 2,
                      message: `${t('common.error')}: ${errorMessage}`,
                      error: data.content.detail,
                      isComplete: false,
                      lastUpdated: Date.now(),
                    },
                  }));
                  allUploadsSuccessful = false;

                  // Special handling for single file uploads - abort immediately
                  const isSingleFileUpload = filesToUpload.length === 1;
                  if (isSingleFileUpload) {
                    // Show error toast for single file failure
                    toast({
                      title: isDuplicateError ? t('knowledge.upload.duplicateTitle', 'Duplicate Document') : 'Upload Failed',
                      description: errorMessage,
                      variant: 'destructive',
                    });

                    // Clear the file from the upload list since it failed
                    setFiles(prev => prev.filter(f => f.name !== file.name));

                    // Stop uploading state immediately
                    setIsUploading(false);
                    if (onUploadStatusChange) {
                      onUploadStatusChange(false, false);
                    }

                    // Break out of the stream processing
                    return;
                  }

                  // For multi-file uploads, just stop uploading state
                  setIsUploading(false);
                  if (onUploadStatusChange) {
                    onUploadStatusChange(false, false);
                  }
                }
              } catch (e) {
                console.error(`Error parsing stream line: ${line}`, e);
              }
            }
          }
          if (streamMessages === 0) {
            const noStreamMsg = 'No streaming messages received - backend may not be sending proper stream data';
            setUploadProgress(prev => ({
              ...prev,
              [file.name]: {
                progress: 2,
                message: `${t('common.error')}: ${noStreamMsg}`,
                error: noStreamMsg,
                isComplete: false,
                lastUpdated: Date.now(),
              },
            }));
            allUploadsSuccessful = false;
            continue;
          }

          // Only mark as complete when stream ends IF we're NOT tracking via WebSocket
          // If a tracker was started (background worker case), let the WebSocket handle completion
          if (!ongoingTrackersRef.current[file.name]) {
            setUploadProgress(prev => ({
              ...prev,
              [file.name]: {
                progress: 100,
                message: 'Upload and processing complete',
                isComplete: true,
                lastUpdated: Date.now(),
              },
            }));
          } else {
            console.log(`📡 Stream ended for ${file.name}, WebSocket tracker will handle completion`);
          }


        } catch (error) {
          console.error(`Error during streaming upload for ${file.name}:`, error);

          // Handle timeout errors specifically
          let errorMessage = error.message || t('fileAttachment.errors.unknownError');
          if (error.name === 'AbortError') {
            errorMessage = t('fileAttachment.errors.uploadTimeout');
          }

          setUploadProgress(prev => ({
            ...prev,
            [file.name]: {
              progress: 2,
              message: `${t('common.error')}: ${errorMessage}`,
              error: errorMessage,
              isComplete: false,
              lastUpdated: Date.now(),
            },
          }));

          // Show toast notification for the error
          toast({
            title: t('fileAttachment.errors.uploadError'),
            description: t('fileAttachment.errors.uploadFailed', {
              fileName: file.name,
              error: errorMessage
            }),
            variant: 'destructive',
          });

          // Special handling for single file uploads
          const isSingleFileUpload = filesToUpload.length === 1;
          if (isSingleFileUpload) {


            // Clear the file from the upload list since it failed
            setFiles(prev => prev.filter(f => f.name !== file.name));
          }

          // Stop uploading state immediately when error occurs
          setIsUploading(false);
          if (onUploadStatusChange) {
            onUploadStatusChange(false, false);
          }

          // Throw the error to trigger fallback if it's a critical issue
          if (
            error.message?.includes('not found') ||
            error.message?.includes('No streaming messages received')
          ) {
            throw error; // This will cause fallback to standard upload
          }

          allUploadsSuccessful = false;

          // For single file uploads, break out of the loop
          if (isSingleFileUpload) {
            break;
          }
        }
      }

      // All files have been processed
      setIsUploading(false);
      if (onUploadStatusChange) onUploadStatusChange(false, allUploadsSuccessful);

      // Clear API cache to ensure fresh data
      try {
        // Import clearCache from the lib index to avoid circular dependencies
        const { clearCache } = await import('@/lib/api');
        // Clear any cached responses for document collections to ensure fresh data
        clearCache('/documents/collection/');
        clearCache('/collections/');

      } catch (error) {
        console.warn('Failed to clear API cache:', error);
      }

      // Refresh the document list
      if (onUploadComplete) {

        onUploadComplete();

        // Add a second refresh after a delay to ensure all backend operations complete
        setTimeout(() => {

          onUploadComplete();
        }, 2000);
      }

      // Always clear the files list — failed files should not persist in UI
      setFiles([]);
      if (allUploadsSuccessful) {
        toast({
          variant: 'default',
          title: 'Upload Complete',
          description: `Successfully uploaded ${filesToUpload.length} document(s).`,
        });
      }

      // Clean up authentication monitoring when streaming upload completes
      authCleanup();
    };

    // Expose methods to a parent component through ref
    useImperativeHandle(
      ref,
      () => ({
        uploadFiles: handleUpload,
        abortUpload: confirmAbortUpload,
        refreshUploads: () => {
          // Trigger the onUploadComplete callback to refresh the document list
          if (onUploadComplete) {
            onUploadComplete();
          }

          // Refresh status of ongoing jobs
          void refreshAllJobStatus();
        },
        hasUnprocessedFiles: () => {
          // Return true if there are files that haven't been processed yet
          return files.length > 0;
        },
        focusUploadButton: () => {
          // Focus the browse files button
          browseButtonRef.current?.focus();
        },
        getSelectedDocumentIds: () => Array.from(selectedDocumentIds),
        clearSelection: () => {
          setSelectedDocumentIds(new Set());
          setIsSelectionMode(false);
        },
      }),
      [
        files,
        handleUpload,
        confirmAbortUpload,
        onUploadComplete,
        refreshAllJobStatus,
        selectedDocumentIds,
      ]
    );

    // Add this function to better handle token refresh results
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are intentionally limited
    const getRefreshedToken = async (): Promise<string> => {
      // First check if we have tokens in the auth context
      if (tokens?.access_token) {
        return tokens.access_token;
      }

      const result = await refreshToken();
      if (!result) {
        throw new Error('Session expired. Please log in again.');
      }

      // First check if we have auth_tokens (new format)
      const authTokens = localStorage.getItem('auth_tokens');

      // If not found, check if we have auth_token (old format)
      if (!authTokens) {
        const authToken = localStorage.getItem('auth_token');
        if (authToken) {
          // We're using the old token format
          return authToken;
        }
        throw new Error('Session expired. Please log in again.');
      }

      // Parse and verify the tokens from auth_tokens
      const tokenData = JSON.parse(authTokens) as { access_token?: string };
      if (!tokenData.access_token) {
        throw new Error('Session expired. Please log in again.');
      }

      return tokenData.access_token;
    };

    // Handle file drop - upload immediately to create pending documents
    const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragging(false);

      if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        const newFiles = Array.from(e.dataTransfer.files);
        setFiles(prevFiles => [...prevFiles, ...newFiles]);

        // Set flag to trigger auto-upload via useEffect
        // This creates documents with "pending" status to enable the Compose button
        setShouldAutoUpload(true);
      }
    };

    // Handle file selection - upload immediately to create pending documents
    const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
      if (e.target.files && e.target.files.length > 0) {
        // Add files to state
        const newFiles = Array.from(e.target.files);
        setFiles(prevFiles => [...prevFiles, ...newFiles]);

        // Set flag to trigger auto-upload via useEffect
        // This creates documents with "pending" status to enable the Compose button
        setShouldAutoUpload(true);
      }

      // Clear the input to allow re-selecting the same file
      e.target.value = '';
    };

    // Handle file browse button click
    const handleBrowseFiles = () => {
      fileInputRef.current?.click();
    };

    // Handle file removal
    const handleRemoveFile = (index: number) => {
      const fileToRemove = files[index];
      const remainingFiles = files.filter((_, i) => i !== index);
      setFiles(remainingFiles);

      // Also remove from progress tracking if it exists
      if (fileToRemove && uploadProgress[fileToRemove.name]) {
        // Get the progress data
        const progress = uploadProgress[fileToRemove.name];

        // If this file has an active tracker or is in processing, cancel it
        if (ongoingTrackersRef.current[fileToRemove.name]) {

          ongoingTrackersRef.current[fileToRemove.name].cancelProcessing?.();
          ongoingTrackersRef.current[fileToRemove.name].cleanup?.();
          delete ongoingTrackersRef.current[fileToRemove.name];
        }

        // Remove from global DocumentProcessingTracker if jobId exists
        if (progress?.jobId) {
          DocumentProcessingTracker.removeJob(progress.jobId);
        }

        // Remove from upload progress state and ref
        setUploadProgress(prev => {
          const newProgress = { ...prev };
          delete newProgress[fileToRemove.name];
          return newProgress;
        });

        // Clean up progress ref
        delete progressValuesRef.current[fileToRemove.name];

        // If the file had an error, show a toast confirming removal
        if (progress?.error) {
          toast({
            title: 'File Removed',
            description: `Failed file "${fileToRemove.name}" has been removed.`,
          });
        }
      }

      // If no files remain, reset upload state completely
      if (remainingFiles.length === 0) {
        setIsUploading(false);
        setUploadProgress({});
        progressValuesRef.current = {};  // Clear progress ref
        // Notify parent that we're no longer uploading
        if (onUploadStatusChange) {
          onUploadStatusChange(false, false);
        }
      } else {
        // Check if all remaining files are now processed after this removal
        setTimeout(() => checkIfAllProcessingComplete(), 100);
      }
    };

    // Handle drag events
    const handleDragEnter = (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragging(true);
    };

    const handleDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragging(false);
    };

    const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
    };

    // Check if all *tracked* jobs (from this batch or previous) are done
    const checkIfAllProcessingComplete = useCallback(() => {
      // Check trackers associated with current file names first
      const currentFileTrackersRunning = files.some(file => {
        const tracker = ongoingTrackersRef.current[file.name];
        // Consider it running if the tracker exists and isn't explicitly marked complete/error in progress state
        const progress = uploadProgress[file.name];
        return tracker && progress && !progress.isComplete && !progress.error;
      });

      // Check trackers associated with job IDs (for pre-existing jobs)
      const existingJobTrackersRunning = Object.keys(
        ongoingTrackersRef.current
      ).some(key => {
        // Basic check for UUID format - assumes job IDs are UUIDs
        if (key.length === 36 && key.includes('-')) {
          const tracker = ongoingTrackersRef.current[key];
          // Need a reliable way to know if the tracker is active. Add `isTracking()` to DocumentProcessingTracker if possible.
          // Fallback: check if the tracker exists in the ref.
          return !!tracker;
        }
        return false;
      });

      const stillProcessing =
        currentFileTrackersRunning || existingJobTrackersRunning;
      if (!stillProcessing) {

        setIsUploading(false);

        // Check if there are any remaining unprocessed files
        const hasRemainingUnprocessedFiles = files.some(file => {
          const progress = uploadProgress[file.name];
          // A file is considered unprocessed if it doesn't have progress state yet
          return !progress || (!progress.isComplete && !progress.error);
        });

        // Notify parent of upload status and any remaining unprocessed files
        if (onUploadStatusChange) {
          onUploadStatusChange(hasRemainingUnprocessedFiles, false);
        }

        abortControllerRef.current = null; // Safe to reset abort controller now

        // Clear API cache to ensure fresh data when all processing is complete
        try {
          // Import clearCache from the lib index to avoid circular dependencies
          import('@/lib/api').then(({ clearCache }) => {
            // Clear any cached responses for document collections to ensure fresh data
            clearCache('/documents/collection/');
            clearCache('/collections/');
          });
        } catch (error) {
          console.warn('Failed to clear API cache:', error);
        }

        // Notify parent that all processing is complete to refresh document list
        if (onUploadComplete) {
          onUploadComplete();

          // Make a second refresh call after a short delay to ensure backend consistency
          setTimeout(() => {

            onUploadComplete();
          }, 1500);
        }

        // Clear all files regardless of success or error status
        if (files.length > 0) {

          // Show a toast for any files with errors
          const filesWithErrors = files.filter(file => {
            const progress = uploadProgress[file.name];
            return progress?.error && progress.error !== 'Conflict';
          });

          if (filesWithErrors.length > 0) {
            toast({
              title: 'Upload Issues',
              description: `${filesWithErrors.length} file(s) had errors and were cleared. Check the console for details.`,
              variant: 'destructive',
            });

            // Log detailed errors to console for debugging
            console.error(
              'Files with errors that were cleared:',
              filesWithErrors.map(f => ({
                name: f.name,
                error: uploadProgress[f.name]?.error,
                message: uploadProgress[f.name]?.message,
              }))
            );
          }

          // Delay clearing slightly to allow user to see final status
          setTimeout(() => setFiles([]), 1500);
        }
      } else {

        // Ensure isUploading stays true if trackers are active
        if (!isUploading && onUploadStatusChange) {
          setIsUploading(true);
          onUploadStatusChange(true, true);
        }
        // Ensure global loader stays active if we think we are still uploading/processing
        // Removed loadingContext manipulation
      }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are intentionally limited
    }, [
      files,
      uploadProgress,
      onUploadStatusChange,
      isUploading,
      onUploadComplete,
      toast,
    ]);

    // Get file icon based on extension
    const getFileIcon = (filename: string | undefined) => {
      if (!filename) {
        // Return default icon for documents without filename
        return (
          <FileText className='w-8 h-8 mr-2 text-zinc-400' />
        );
      }
      const extension = filename.split('.').pop()?.toLowerCase();
      const iconPath = (ext: string) => `${import.meta.env.BASE_URL}icons/documents/${ext}.png`;

      // Check if we have a specific icon for this file type
      switch (extension) {
        case 'pdf':
          return (
            <img
              src={iconPath('pdf')}
              alt='PDF'
              className='w-8 h-8 mr-2 object-contain'
            />
          );
        case 'txt':
        case 'md': // Markdown files use the text icon
          return (
            <img
              src={iconPath('txt')}
              alt='Text'
              className='w-8 h-8 mr-2 object-contain'
            />
          );
        case 'epub':
          return (
            <img
              src={iconPath('epub')}
              alt='ePub'
              className='w-8 h-8 mr-2 object-contain'
            />
          );
        case 'doc':
        case 'docx':
        case 'rtf':
          return (
            <img
              src={iconPath('doc')}
              alt='Document'
              className='w-8 h-8 mr-2 object-contain'
            />
          );
        case 'xls':
        case 'xlsx':
        case 'csv':
        case 'json':
        case 'jsonl':
          return (
            <img
              src={iconPath('xls')}
              alt='Spreadsheet'
              className='w-8 h-8 mr-2 object-contain'
            />
          );
        case 'mp4':
        case 'avi':
        case 'mov':
        case 'mkv':
          return (
            <img
              src={iconPath('video')}
              alt='Video'
              className='w-8 h-8 mr-2 object-contain'
            />
          );
        default:
          return (
            <img
              src={iconPath('default')}
              alt='File'
              className='w-8 h-8 mr-2 object-contain'
            />
          );
      }
    };

    // Helper: does the document have a physical file on disk?
    const hasFileOnDisk = useCallback((doc: ExistingDocument): boolean =>
      doc.file_stored !== false && !!doc.file_size && doc.file_size !== 0
    , []);

    // State + ref for re-uploading a file to an existing pending document
    const [reuploadingDocId, setReuploadingDocId] = useState<string | null>(null);
    const reuploadInputRef = useRef<HTMLInputElement>(null);

    // Handle picking a file to replace an existing pending document record
    const handleReuploadFile = useCallback((docId: string) => {
      setReuploadingDocId(docId);
      // Trigger hidden file input
      setTimeout(() => reuploadInputRef.current?.click(), 0);
    }, []);

    // Process the re-upload: delete old record, upload new file
    const handleReuploadFileChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = ''; // allow re-selecting same file

      if (!file || !reuploadingDocId) {
        setReuploadingDocId(null);
        return;
      }

      try {
        // Delete old pending record first
        if (onDeleteDocument) {
          await onDeleteDocument(reuploadingDocId);
        }

        // Add file to the upload queue and auto-upload
        setFiles(prev => [...prev, file]);
        setShouldAutoUpload(true);

        toast({
          title: t('knowledge.uploader.reuploadStarted', 'Upload started'),
          description: t('knowledge.uploader.reuploadStartedDescription', 'Replacing document record with uploaded file.'),
        });
      } catch (error) {
        console.error('Error re-uploading file:', error);
        toast({
          title: t('general.error'),
          description: t('knowledge.uploader.reuploadFailed', 'Failed to replace document. Please try again.'),
          variant: 'destructive',
        });
      } finally {
        setReuploadingDocId(null);
      }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are intentionally limited
    }, [reuploadingDocId, onDeleteDocument, t, toast]);

    // Add a handler for document preview
    const handlePreviewDocument = useCallback((documentId: string, filename: string) => {
      const fileExtension = filename.split('.').pop()?.toLowerCase();
      const documentUrl = `/documents/${documentId}/file`;

      if (fileExtension === 'pdf') {
        // Open PDF viewer
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
        // Open EPUB viewer
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
        // Open DOCX viewer
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are intentionally limited
    }, [pdfDispatch, epubDispatch, docxDispatch]);

    // Open delete confirmation dialog
    const handleDeleteDocument = (
      documentId: string,
      event: React.MouseEvent
    ) => {
      event.stopPropagation(); // Prevent event bubbling
      setDeletingDocumentId(documentId);
      setIsDeleteConfirmationOpen(true);
    };

    // Confirm and execute document deletion
    const confirmDeleteDocument = async () => {
      if (!deletingDocumentId || !onDeleteDocument) return;

      try {
        // Add document to deleting state
        setDeletingDocIds(prev => [...prev, deletingDocumentId]);

        // Call the parent's delete function
        await onDeleteDocument(deletingDocumentId);
      } catch (error) {
        console.error('Error deleting document:', error);
        toast({
          title: t('fileAttachment.errors.deleteFailed'),
          description: t('fileAttachment.errors.deleteFailedDescription'),
          variant: 'destructive',
        });
      } finally {
        // Remove from deleting state
        setDeletingDocIds(prev => prev.filter(id => id !== deletingDocumentId));
        // Close dialog and reset state
        setIsDeleteConfirmationOpen(false);
        setDeletingDocumentId(null);
      }
    };

    // Handle aborting document processing
    const handleAbortDocument = async (
      documentId: string,
      jobId: string | undefined,
      event: React.MouseEvent
    ) => {
      event.stopPropagation(); // Prevent event bubbling

      // If no job_id (pending document not yet processing), show delete confirmation instead
      if (!jobId) {
        if (onDeleteDocument) {
          handleDeleteDocument(documentId, event);
        } else {
          toast({
            title: t('knowledge.uploader.errors.abortFailed', 'Abort failed'),
            description: t('knowledge.uploader.errors.noJobId', 'No job ID found for this document'),
            variant: 'destructive',
          });
        }
        return;
      }

      try {
        // Add document to aborting state
        setAbortingDocIds(prev => [...prev, documentId]);

        // Cancel the processing job
        const success = await cancelDocumentProcessing(jobId);

        if (success) {
          toast({
            title: t('knowledge.uploader.abortSuccess', 'Processing aborted'),
            description: t('knowledge.uploader.abortSuccessDescription', 'Document processing has been cancelled'),
          });

          // Refresh the document list to reflect the updated status
          if (onUploadStatusChange) {
            onUploadStatusChange(false, false);
          }
        } else {
          toast({
            title: t('knowledge.uploader.errors.abortFailed', 'Abort failed'),
            description: t('knowledge.uploader.errors.abortFailedDescription', 'Failed to cancel document processing'),
            variant: 'destructive',
          });
        }
      } catch (error) {
        console.error('Error aborting document processing:', error);
        toast({
          title: t('knowledge.uploader.errors.abortFailed', 'Abort failed'),
          description: t('knowledge.uploader.errors.abortFailedDescription', 'Failed to cancel document processing'),
          variant: 'destructive',
        });
      } finally {
        // Remove from aborting state
        setAbortingDocIds(prev => prev.filter(id => id !== documentId));
      }
    };

    // Handle retrying failed document processing
    const handleRetryDocument = async (
      documentId: string,
      event: React.MouseEvent
    ) => {
      event.stopPropagation(); // Prevent event bubbling

      try {
        // Call the reprocess API endpoint
        const result = await reprocessDocument(documentId);

        // Find the document in existingDocuments to get its filename
        const document = existingDocuments.find(doc => doc.id === documentId);
        if (!document) {
          console.error('Document not found in existingDocuments:', documentId);
          return;
        }

        const filename = document.filename;

        // Initialize progress state immediately to show loading circle
        setUploadProgress(prev => ({
          ...prev,
          [filename]: {
            progress: 0,
            message: t('knowledge.uploader.processing'),
            isComplete: false,
            jobId: result.job_id,
          },
        }));

        // Set up WebSocket tracker for reprocessing
        ongoingTrackersRef.current[result.job_id] = new DocumentProcessingTracker({
          jobId: result.job_id,
          documentId: result.document_id,
          onProgress: (progressData: {
            progress: number;
            message: string;
            status: string;
          }) => {
            setUploadProgress(prev => ({
              ...prev,
              [filename]: {
                progress: progressData.progress,
                message: progressData.message,
                isComplete: progressData.status === 'completed',
                error:
                  progressData.status === 'failed'
                    ? t('knowledge.uploader.processingFailed')
                    : undefined,
                jobId: result.job_id,
              },
            }));
          },
          onComplete: () => {
            setUploadProgress(prev => ({
              ...prev,
              [filename]: {
                progress: 100,
                message: t('knowledge.uploader.processingComplete'),
                isComplete: true,
                jobId: result.job_id,
              },
            }));

            // Clean up the tracker
            if (ongoingTrackersRef.current[result.job_id]) {
              ongoingTrackersRef.current[result.job_id].cleanup();
              delete ongoingTrackersRef.current[result.job_id];
            }

            // Refresh the document list
            if (onUploadComplete) {
              setTimeout(() => {
                onUploadComplete();
                setTimeout(() => {
                  onUploadComplete();
                }, 2000);
              }, 500);
            }
          },
          onError: error => {
            console.error(
              `Error tracking job ${result.job_id} for document ${filename}:`,
              error
            );
            setUploadProgress(prev => ({
              ...prev,
              [filename]: {
                progress: 2,
                message: `Error: ${error.message}`,
                isComplete: false,
                error: error.message,
                jobId: result.job_id,
              },
            }));

            // Clean up the tracker
            if (ongoingTrackersRef.current[result.job_id]) {
              ongoingTrackersRef.current[result.job_id].cleanup();
              delete ongoingTrackersRef.current[result.job_id];
            }

            // Show error toast
            toast({
              title: t('knowledge.uploader.errors.retryFailed', 'Retry failed'),
              description: error.message,
              variant: 'destructive',
            });
          },
        });

        console.log('Reprocessing started with job_id:', result.job_id);
      } catch (error: unknown) {
        console.error('Error retrying document processing:', error);
        toast({
          title: t('knowledge.uploader.errors.retryFailed', 'Retry failed'),
          description: error instanceof Error ? error.message : t('knowledge.uploader.errors.retryFailedDescription', 'Failed to restart document processing'),
          variant: 'destructive',
        });
      }
    };

    // Handle processing a single pending document
    const handleProcessDocument = async (
      documentId: string,
      event: React.MouseEvent
    ) => {
      event.stopPropagation(); // Prevent event bubbling

      try {
        // Add to processing state
        setProcessingDocIds(prev => [...prev, documentId]);

        // Call the process API endpoint
        const result = await processDocument(documentId);

        // Find the document in existingDocuments to get its filename
        const document = existingDocuments.find(doc => doc.id === documentId);
        if (!document) {
          console.error('Document not found in existingDocuments:', documentId);
          return;
        }

        const filename = document.filename;

        // Handle documents that have no file and no content (memory-only without data)
        if (result.status === 'failed') {
          setProcessingDocIds(prev => prev.filter(id => id !== documentId));
          setNoFileDoc({ id: documentId, filename });
          return;
        }

        // Initialize progress state immediately to show loading circle
        setUploadProgress(prev => ({
          ...prev,
          [filename]: {
            progress: 0,
            message: t('knowledge.uploader.processing'),
            isComplete: false,
            jobId: result.job_id,
          },
        }));

        // Set up WebSocket tracker for processing
        const tracker = new DocumentProcessingTracker({
          jobId: result.job_id,
          documentId: result.document_id,
          onProgress: (progressData: {
            progress: number;
            message: string;
            status: string;
          }) => {
            setUploadProgress(prev => ({
              ...prev,
              [filename]: {
                progress: progressData.progress,
                message: progressData.message,
                isComplete: progressData.status === 'completed',
                error:
                  progressData.status === 'failed'
                    ? t('knowledge.uploader.processingFailed')
                    : undefined,
                jobId: result.job_id,
              },
            }));
          },
          onComplete: () => {
            setUploadProgress(prev => ({
              ...prev,
              [filename]: {
                progress: 100,
                message: t('knowledge.uploader.processingComplete'),
                isComplete: true,
                jobId: result.job_id,
              },
            }));

            // Clean up the tracker
            if (ongoingTrackersRef.current[result.job_id]) {
              ongoingTrackersRef.current[result.job_id].cleanup();
              delete ongoingTrackersRef.current[result.job_id];
            }

            // Remove from processing state
            setProcessingDocIds(prev => prev.filter(id => id !== documentId));

            // Refresh the document list
            if (onUploadComplete) {
              setTimeout(() => {
                onUploadComplete();
                setTimeout(() => {
                  onUploadComplete();
                }, 2000);
              }, 500);
            }
          },
          onError: error => {
            console.error(
              `Error tracking job ${result.job_id} for document ${filename}:`,
              error
            );
            setUploadProgress(prev => ({
              ...prev,
              [filename]: {
                progress: 2,
                message: `Error: ${error.message}`,
                isComplete: false,
                error: error.message,
                jobId: result.job_id,
              },
            }));

            // Clean up the tracker
            if (ongoingTrackersRef.current[result.job_id]) {
              ongoingTrackersRef.current[result.job_id].cleanup();
              delete ongoingTrackersRef.current[result.job_id];
            }

            // Remove from processing state
            setProcessingDocIds(prev => prev.filter(id => id !== documentId));

            // Show error toast
            toast({
              title: t('knowledge.uploader.errors.processFailed', 'Process failed'),
              description: error.message,
              variant: 'destructive',
            });
          },
        });

        // Store tracker by job ID
        ongoingTrackersRef.current[result.job_id] = tracker;

        console.log('Processing started with job_id:', result.job_id);

        // Immediately fetch current status to catch any progress sent while setting up tracker
        // This fixes race condition where first WebSocket message (e.g., 30%) is missed
        tracker.fetchCurrentStatus().then(status => {
          console.log(`📡 Initial status fetch for ${filename}:`, status);
          if (status && status.progress > 0) {
            setUploadProgress(prev => ({
              ...prev,
              [filename]: {
                progress: status.progress,
                message: status.message,
                isComplete: status.status === 'completed',
                error: status.status === 'failed' ? t('knowledge.uploader.processingFailed') : undefined,
                jobId: result.job_id,
              },
            }));
          }
        });
      } catch (error: unknown) {
        console.error('Error processing document:', error);
        // Remove from processing state
        setProcessingDocIds(prev => prev.filter(id => id !== documentId));
        toast({
          title: t('knowledge.uploader.errors.processFailed', 'Process failed'),
          description: error instanceof Error ? error.message : t('knowledge.uploader.errors.processFailedDescription', 'Failed to start document processing'),
          variant: 'destructive',
        });
      }
    };

    // Add component cleanup in the main component (add after other useEffect hooks)
    // Clean up any progress timers when component unmounts
    useEffect(() => {
      return () => {
        // Cleanup all active polling intervals
        Object.values(activePollingIntervals).forEach(interval => {
          if (
            typeof interval === 'object' &&
            interval !== null &&
            'statusPoll' in interval
          ) {
            const typedInterval = interval as {
              statusPoll?: NodeJS.Timeout;
              simulation?: NodeJS.Timeout;
            };
            if (typedInterval.statusPoll) clearInterval(typedInterval.statusPoll);
            if (typedInterval.simulation) clearInterval(typedInterval.simulation);
          } else if (interval) {
            clearInterval(interval as NodeJS.Timeout);
          }
        });
      };
    }, [activePollingIntervals]);

    // Add a function to check for stale updates and refresh if needed
    const checkForStaleUpdates = useCallback(() => {
      const now = Date.now();
      let hasStaleUpdates = false;

      // Check if any progress updates are stale (no updates for 10 seconds)
      Object.entries(uploadProgress).forEach(([, progress]) => {
        if (
          !progress.isComplete &&
          progress.lastUpdated &&
          now - progress.lastUpdated > 10000
        ) {
          hasStaleUpdates = true;
        }
      });

      if (hasStaleUpdates) {
        void refreshAllJobStatus();
      }
    }, [uploadProgress, refreshAllJobStatus]);

    // Add periodic check for stale updates
    useEffect(() => {
      if (isUploading) {
        const staleCheckInterval = setInterval(checkForStaleUpdates, 10000);

        return () => {
          clearInterval(staleCheckInterval);
        };
      }
    }, [isUploading, checkForStaleUpdates]);

    // --- Infinite Scroll Logic with Intersection Observer --- START
    useEffect(() => {
      // Only set up observer if we have more documents to load
      if (!hasMore || !onLoadMore || isLoadingMore) {
        return;
      }

      const sentinel = loadMoreTriggerRef.current;
      const container = scrollContainerRef.current;

      if (!sentinel || !container) {
        return;
      }

      // Create Intersection Observer to detect when sentinel becomes visible
      const observer = new IntersectionObserver(
        (entries) => {
          const [entry] = entries;
          // Trigger load more when sentinel is visible and we have more to load
          if (entry.isIntersecting && hasMore && !isLoadingMore) {
            onLoadMore();
          }
        },
        {
          // Use the scroll container as the root for the observation
          root: container,
          // Trigger when 50% of the sentinel is visible
          threshold: 0.5,
          // Start observing 100px before the sentinel comes into view
          rootMargin: '100px',
        }
      );

      observer.observe(sentinel);

      // Cleanup observer on unmount or when dependencies change
      return () => {
        observer.disconnect();
      };
    }, [hasMore, onLoadMore, isLoadingMore, existingDocuments.length]);
    // --- Infinite Scroll Logic --- END

    // Add a periodic check for job completion using the active jobs API
    useEffect(() => {
      if (!isUploading || Object.keys(uploadProgress).length === 0) {
        return;
      }

      // Flag to prevent overlapping requests
      let isCheckingJobs = false;

      const checkJobCompletion = async () => {
        // Skip if a previous request is still in progress
        if (isCheckingJobs) {
          console.debug('Skipping job completion check - previous request still in progress');
          return;
        }

        isCheckingJobs = true;
        try {
          // Check if any files have errors - if so, stop checking for single file uploads
          const progressEntries = Object.entries(uploadProgress);
          const hasErrors = progressEntries.some(
            ([, progress]) => progress?.error
          );
          const isSingleFile = progressEntries.length === 1;

          if (hasErrors && isSingleFile) {
            setIsUploading(false);
            return;
          }

          // Get active jobs using the existing API function
          const activeJobsData = await getMyActiveJobs(false);
          const activeJobs = activeJobsData.active_jobs || {};

          // Check each file's progress
          setUploadProgress(prev => {
            const updated = { ...prev };
            let hasChanges = false;

            Object.keys(prev).forEach(fileName => {
              const fileProgress = prev[fileName];

              // Skip if already complete or has error
              if (fileProgress?.isComplete || fileProgress?.error) return;

              // If progress is at 100% but not marked complete, force completion
              if (fileProgress?.progress >= 100) {
                updated[fileName] = {
                  ...fileProgress,
                  progress: 100,
                  message: 'Processing complete',
                  isComplete: true,
                  lastUpdated: Date.now(),
                };
                hasChanges = true;
                return;
              }

              // Check if this file's job is no longer in active jobs
              const jobStillActive = Object.values(activeJobs).some(
                (job: { job_id?: string }) =>
                  job.job_id && (fileProgress as { jobId?: string })?.jobId === job.job_id
              );

              // If job is not active and progress is very high (>= 98%), force completion
              // NOTE: Use 98% threshold because embedding phase runs from 85-95%,
              // so 80% was too aggressive and caused premature completion when WebSocket dropped
              if (!jobStillActive && fileProgress?.progress >= 98) {
                updated[fileName] = {
                  ...fileProgress,
                  progress: 100,
                  message: 'Processing complete',
                  isComplete: true,
                  lastUpdated: Date.now(),
                };
                hasChanges = true;
              }
            });

            return hasChanges ? updated : prev;
          });
        } catch (error) {
          console.error('Error checking job completion:', error);
          // Don't fail the upload on timeout errors - just log and continue
          // The streaming progress updates are the source of truth
          if (error instanceof Error && error.message?.includes('timeout')) {
            console.warn('Job completion check timed out - this is normal during processing');
          } else {
            // For other errors on single file uploads, stop processing
            const progressEntries = Object.entries(uploadProgress);
            const isSingleFile = progressEntries.length === 1;
            if (isSingleFile) {
              setIsUploading(false);
            }
          }
        } finally {
          // Reset the flag to allow the next check
          isCheckingJobs = false;
        }
      };

      // Run immediate check when upload progress changes
      void checkJobCompletion();

      // Check every 2 seconds for job completion
      const completionCheckInterval = setInterval(checkJobCompletion, 2000);

      return () => {
        clearInterval(completionCheckInterval);
      };
    }, [isUploading, uploadProgress, getRefreshedToken]);

    return (
      <div className={`space-y-4 ${className}`}>
        {/* Hidden file input. The `hidden` HTML attribute (not just the
            `.hidden` class) is required — parent wrapper has `space-y-4`
            whose Tailwind selector is `:not([hidden]) ~ :not([hidden])`,
            which checks the attribute. Without it these inputs count as
            previous siblings and push the drop area down by 1rem. */}
        <input
          type='file'
          ref={fileInputRef}
          data-testid='knowledge-file-input'
          onChange={handleFileChange}
          hidden
          multiple
          accept='.pdf,.csv,.tsv,.xlsx,.xls,.md,.epub,.docx,.rtf,.txt,.mp3,.wav,.m4a,.ogg,.webm,.flac,.aac,.opus,.wma,.aiff,.amr,.mp4,.mov,.mkv,.avi,.m4v,.mpeg,.mpg,.flv,.wmv'
        />
        {/* Hidden file input for re-uploading to an existing pending document */}
        <input
          type='file'
          ref={reuploadInputRef}
          onChange={handleReuploadFileChange}
          hidden
          accept='.pdf,.csv,.tsv,.xlsx,.xls,.md,.epub,.docx,.rtf,.txt,.mp3,.wav,.m4a,.ogg,.webm,.flac,.aac,.opus,.wma,.aiff,.amr,.mp4,.mov,.mkv,.avi,.m4v,.mpeg,.mpg,.flv,.wmv'
        />

        {/* Drop area - hidden for read-only (viewer) users. */}
        {!readOnly && (
        <div
          className={`border ${isDragging ? 'border-blue-400 bg-blue-50 dark:bg-blue-900/20' : 'border-zinc-200 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-900/50'} ${isMobile ? 'p-4 min-h-48' : 'p-8 min-h-64'} rounded-lg flex flex-col items-center justify-center transition-colors`}
          onDragEnter={handleDragEnter}
          onDragLeave={handleDragLeave}
          onDragOver={handleDragOver}
          onDrop={handleDrop}
        >
          <p className='text-sm text-zinc-600 dark:text-zinc-400 text-center'>
            {isDragging ? t('knowledge.uploader.dropFilesHere') : t('knowledge.uploader.dragAndDropFiles')}
          </p>
          <p className='mt-2 text-xs text-zinc-400 dark:text-zinc-600 text-center'>
            {t('knowledge.uploader.supportedFormats')}
          </p>
          <div className={`flex items-center gap-2 ${isMobile ? 'mt-3' : 'mt-4'}`}>
            <Button
              ref={browseButtonRef}
              data-testid='knowledge-browse-button'
              variant='outline'
              size='sm'
              onClick={handleBrowseFiles}
            >
              {t('knowledge.uploader.browseFiles')}
            </Button>

            {/* Processing options popover */}
            <Popover>
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <PopoverTrigger asChild>
                      <Button
                        variant='ghost'
                        size='sm'
                        className='relative h-8 px-2 text-muted-foreground hover:text-foreground'
                        data-testid='knowledge-processing-options-button'
                      >
                        <SlidersHorizontal className='h-3.5 w-3.5' />
                        {activeProcessingOptions > 0 && (
                          <span className='absolute -top-0.5 -right-0.5 flex h-3.5 min-w-[14px] items-center justify-center bg-primary text-primary-foreground text-[9px] font-medium rounded-full px-0.5'>
                            {activeProcessingOptions}
                          </span>
                        )}
                      </Button>
                    </PopoverTrigger>
                  </TooltipTrigger>
                  <TooltipContent side='bottom'>
                    <p className='text-xs'>{t('knowledge.uploader.processingOptions')}</p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
              <PopoverContent align='start' className='w-[260px] p-0' style={{ zIndex: 1100 }}>
                <div className='px-3 py-2 border-b border-border'>
                  <p className='text-xs font-medium text-foreground'>{t('knowledge.uploader.processingOptions')}</p>
                </div>
                <div className='p-2 space-y-1'>
                  {/* Store file on disk */}
                  <label className='flex items-center gap-2.5 px-2 py-1.5 cursor-pointer hover:bg-muted/50 transition-colors group'>
                    <Checkbox
                      checked={storeFile}
                      onCheckedChange={(checked) => setStoreFile(checked === true)}
                      className='h-3.5 w-3.5'
                    />
                    <HardDrive className='h-3.5 w-3.5 text-muted-foreground group-hover:text-foreground transition-colors shrink-0' />
                    <div className='min-w-0'>
                      <p className='text-xs font-medium text-foreground leading-tight'>{t('knowledge.uploader.optionStoreFile')}</p>
                      <p className='text-[10px] text-muted-foreground leading-tight mt-0.5'>{t('knowledge.uploader.optionStoreFileDesc')}</p>
                    </div>
                  </label>
                  {/* Build knowledge graph */}
                  <label className='flex items-center gap-2.5 px-2 py-1.5 cursor-pointer hover:bg-muted/50 transition-colors group'>
                    <Checkbox
                      checked={buildGraph}
                      onCheckedChange={(checked) => setBuildGraph(checked === true)}
                      className='h-3.5 w-3.5'
                    />
                    <GitBranch className='h-3.5 w-3.5 text-muted-foreground group-hover:text-foreground transition-colors shrink-0' />
                    <div className='min-w-0'>
                      <p className='text-xs font-medium text-foreground leading-tight'>{t('knowledge.uploader.optionBuildGraph')}</p>
                      <p className='text-[10px] text-muted-foreground leading-tight mt-0.5'>{t('knowledge.uploader.optionBuildGraphDesc')}</p>
                    </div>
                  </label>
                  {/* Generate summary */}
                  <label className='flex items-center gap-2.5 px-2 py-1.5 cursor-pointer hover:bg-muted/50 transition-colors group'>
                    <Checkbox
                      checked={generateSummary}
                      onCheckedChange={(checked) => setGenerateSummary(checked === true)}
                      className='h-3.5 w-3.5'
                    />
                    <FileSearch className='h-3.5 w-3.5 text-muted-foreground group-hover:text-foreground transition-colors shrink-0' />
                    <div className='min-w-0'>
                      <p className='text-xs font-medium text-foreground leading-tight'>{t('knowledge.uploader.optionGenerateSummary')}</p>
                      <p className='text-[10px] text-muted-foreground leading-tight mt-0.5'>{t('knowledge.uploader.optionGenerateSummaryDesc')}</p>
                    </div>
                  </label>
                </div>
              </PopoverContent>
            </Popover>
          </div>
        </div>
        )}

        {/* Live activity banner — what workers are actually chewing on
            right now. Without this you see "350 pending" and have no
            idea which file is in-flight. Counts come from the already-
            loaded existingDocuments, so no extra API round-trip. */}
        {(() => {
          const active: Array<{ id: string; name: string; pct: number }> = [];
          let pendingCount = 0;
          let failedCount = 0;
          let scanDeferredCount = 0;
          for (const d of existingDocuments) {
            const ps = d.processing_status;
            // Same tightened liveness check as statusBucket — also require
            // job_status === 'processing' so historic progress on a row
            // whose job has since failed doesn't keep counting as active.
            const isLive = ps === 'processing'
              || (ps === 'pending' && d.job_status === 'processing' && typeof d.job_progress === 'number' && d.job_progress > 0);
            if (isLive) {
              active.push({
                id: d.id,
                name: d.filename || d.id.slice(0, 8),
                pct: typeof d.job_progress === 'number' ? d.job_progress : 0,
              });
            } else if (ps === 'pending') {
              pendingCount += 1;
            } else if (ps === 'failed') {
              failedCount += 1;
              if (d.processing_error?.startsWith('Scanned PDF')) scanDeferredCount += 1;
            }
          }
          // Merge background jobs (entity_extraction, sync_document_hierarchy)
          // — these don't touch documents.processing_status so the loop above
          // never sees them. Without this merge the banner shows "No active
          // worker" even when entity extraction has been running for the
          // user's docs for 8 minutes. Dedupe by document_id (a doc actively
          // being reprocessed AND having background entity extraction would
          // otherwise appear twice).
          const seenDocIds = new Set(active.map(a => a.id));
          for (const bg of backgroundJobs) {
            if (!bg.document_id || seenDocIds.has(bg.document_id)) continue;
            active.push({
              id: bg.document_id,
              name: bg.filename || (bg.task_name ? `${bg.task_name} (${bg.document_id.slice(0, 8)})` : bg.document_id.slice(0, 8)),
              pct: typeof bg.progress === 'number' ? bg.progress : 0,
            });
            seenDocIds.add(bg.document_id);
          }
          const hasActivity = active.length > 0 || pendingCount > 0 || failedCount > 0;
          if (!hasActivity) return null;
          return (
            <div className='flex flex-wrap items-center gap-x-3 gap-y-1 px-2 py-1.5 mb-1 bg-muted/30 border border-border text-[11px] text-muted-foreground'>
              {active.length > 0 ? (
                <>
                  <Loader2 className='h-3 w-3 animate-spin shrink-0 text-orange-400' />
                  {active.slice(0, 2).map(a => (
                    <span key={a.id} className='flex items-center gap-1 max-w-[260px]'>
                      <span className='truncate font-medium text-foreground'>{a.name}</span>
                      <span className='shrink-0 tabular-nums'>{a.pct}%</span>
                    </span>
                  ))}
                  {active.length > 2 && <span>+{active.length - 2}</span>}
                </>
              ) : (
                <span className='flex items-center gap-1'>
                  <Loader2 className='h-3 w-3 text-muted-foreground/40 shrink-0' />
                  <span>{t('knowledge.library.idle', 'No active worker')}</span>
                </span>
              )}
              <span className='ml-auto flex items-center gap-2'>
                {pendingCount > 0 && (
                  <span className='flex items-center gap-1'>
                    <span className='w-1.5 h-1.5 rounded-full bg-yellow-400' />
                    {pendingCount}
                  </span>
                )}
                {failedCount > 0 && (
                  <span className='flex items-center gap-1'>
                    <span className='w-1.5 h-1.5 rounded-full bg-red-400' />
                    {failedCount}{scanDeferredCount > 0 ? ` (${scanDeferredCount} OCR)` : ''}
                  </span>
                )}
                {uploaderStats && uploaderStats.total_documents > 0 && (
                  <>
                    <span className='hidden md:flex items-center gap-1'>
                      <GitBranch className='h-3 w-3' />
                      {uploaderStats.graph_completed}/{uploaderStats.total_documents}
                    </span>
                    <span className='hidden md:flex items-center gap-1'>
                      <Eye className='h-3 w-3' />
                      {uploaderStats.docs_with_thumbnails}/{uploaderStats.total_documents}
                    </span>
                  </>
                )}
              </span>
            </div>
          );
        })()}

        {/* Files and documents section */}
        <div className='flex flex-col'>
          {/* Deferred-upload confirmation banner — surfaces heavy docs
              the upload classifier parked at processing_status='deferred'
              (scanned PDFs needing OCR, or files >20 MB). Clicking
              "Process all" dispatches the existing reprocess endpoint
              for each, which transitions them through the normal
              pipeline. Hidden when no such docs exist. */}
          {!isLoading && deferredDocuments.length > 0 && (
            <div className='flex items-start gap-3 mb-3 px-3 py-2.5 border border-amber-500/40 bg-amber-500/5 rounded-sm'>
              <AlertTriangle className='h-4 w-4 text-amber-500 shrink-0 mt-0.5' />
              <div className='flex-1 min-w-0'>
                <p className='text-xs font-medium text-foreground'>
                  {t('knowledge.library.deferredBannerTitle', {
                    count: deferredDocuments.length,
                    defaultValue: '{{count}} documents need confirmation',
                  })}
                </p>
                <p className='text-[11px] text-muted-foreground leading-snug mt-0.5'>
                  {t('knowledge.library.deferredBannerBody', {
                    defaultValue: 'These files are large or scanned PDFs that need OCR — processing them uses significant memory and time.',
                  })}
                </p>
                {/* Per-file list — never make the user guess "which one?".
                    Show all titles with the deferral reason next to each;
                    cap at 8 to keep the banner compact, link to the full
                    list via the existing failed/pending sections below. */}
                <ul className='mt-1.5 flex flex-col gap-0.5 text-[11px] text-foreground/85'>
                  {deferredDocuments.slice(0, 8).map(d => {
                    const stats = d.processing_stats as { deferral_reason?: string; page_count?: number } | undefined;
                    const reason = stats?.deferral_reason;
                    const pages = stats?.page_count;
                    const reasonText = reason === 'pdf_over_1000_pages'
                      ? t('knowledge.uploader.deferralReasonPagesOver1000', { count: pages ?? 0, defaultValue: `${pages ?? '1000+'} pages` })
                      : reason === 'scanned_pdf_no_text_layer'
                        ? t('knowledge.uploader.deferralReasonScanned', 'scanned, needs OCR')
                        : reason === 'file_size_over_20mb'
                          ? t('knowledge.uploader.deferralReasonLargeFile', 'large file (>20 MB)')
                          : null;
                    return (
                      <li key={d.id} className='flex items-baseline gap-2 truncate'>
                        <span className='truncate'>{d.title || d.filename}</span>
                        {reasonText && (
                          <span className='shrink-0 text-amber-600 dark:text-amber-400 italic'>· {reasonText}</span>
                        )}
                      </li>
                    );
                  })}
                  {deferredDocuments.length > 8 && (
                    <li className='italic text-muted-foreground'>
                      {t('knowledge.uploader.sectionMore', { count: deferredDocuments.length - 8 })}
                    </li>
                  )}
                </ul>
              </div>
              <Button
                size='sm'
                variant='outline'
                className='h-7 text-xs shrink-0'
                disabled={confirmingDeferred.size > 0}
                onClick={async () => {
                  const ids = deferredDocuments.map(d => d.id);
                  setConfirmingDeferred(new Set(ids));
                  try {
                    // Kick the existing reprocess endpoint per doc.
                    // Sequential (not Promise.all) so Celery's 2-slot
                    // pool isn't asked to take on 50 reprocess tasks
                    // at once — the queue would just pile up.
                    for (const id of ids) {
                      try {
                        await reprocessDocument(id);
                      } catch (err) {
                        console.error('Failed to confirm deferred doc', id, err);
                      }
                    }
                  } finally {
                    setConfirmingDeferred(new Set());
                  }
                }}
              >
                {confirmingDeferred.size > 0 ? (
                  <>
                    <Loader2 className='h-3 w-3 animate-spin mr-1.5' />
                    {t('knowledge.library.deferredProcessing', 'Processing...')}
                  </>
                ) : (
                  t('knowledge.library.deferredProcessAll', 'Process all')
                )}
              </Button>
            </div>
          )}
          {/* View mode selector header - only show when there are documents.
              Render during isLoading too — we now keep the prior list
              visible while refetches are in flight. */}
          {sortedDocuments.length > 0 && (
            <div className='flex items-center justify-between mb-2 px-1'>
              <span className='text-xs text-zinc-500 dark:text-zinc-400 flex items-center gap-1.5'>
                {sortedDocuments.length} {sortedDocuments.length === 1 ? t('knowledge.files.file') : t('knowledge.files.files')}
                {isLoading && (
                  <Loader2
                    className='h-3 w-3 animate-spin text-muted-foreground/70'
                    aria-label={t('common.refreshing', 'Refreshing')}
                  />
                )}
              </span>
              <ViewModeSelector
                viewMode={viewMode}
                onViewModeChange={handleViewModeChange}
                sortField={sortField}
                sortDirection={sortDirection}
                onSortChange={handleSortChange}
              />
            </div>
          )}

          <div
            ref={scrollContainerRef}
            className='space-y-2 max-h-[calc(100svh-260px)] overflow-y-auto'
          >
          {/* Loading indicator */}
          {isLoading && (
            <div className='flex items-center justify-center py-4'>
              <Loader2 className='h-5 w-5 animate-spin mr-2' />
              <span className='text-sm text-zinc-500'>Loading documents...</span>
            </div>
          )}

          {/* Files selected for upload — hidden in thumbnails mode (grid handles them via pendingFiles/syntheticFromProgress) */}
          {viewMode !== 'thumbnails' && files.map((file, index) => {
            const progress = uploadProgress[file.name];
            const isComplete = progress?.isComplete === true;

            // Check if this file has a sanitized version in the existingDocuments
            const sanitizedName = sanitizeFilename(file.name);
            const hasSanitizedVersion = existingDocuments.some(
              doc => doc.filename === sanitizedName
            );

            // If this file has been uploaded and now exists as a sanitized version, don't show it
            if (isComplete && hasSanitizedVersion) {
              return null;
            }

            return (
              <div
                key={`file-${index}`}
                className={`flex items-center justify-between p-2
                                ${progress?.error
                    ? 'bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800'
                    : 'bg-zinc-100 dark:bg-zinc-800'
                  }`}
              >
                <div className='flex items-center overflow-hidden'>
                  {/* Show file icon with the appropriate indicator */}
                  {progress?.error ? (
                    // Error state
                    <div className='relative mr-2'>
                      {getFileIcon(file.name)}
                      <div className='absolute -right-1 -bottom-1 w-4 h-4 bg-red-500 rounded-full flex items-center justify-center'>
                        <svg
                          xmlns='http://www.w3.org/2000/svg'
                          className='h-3 w-3 text-white'
                          viewBox='0 0 20 20'
                          fill='currentColor'
                        >
                          <path
                            fillRule='evenodd'
                            d='M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z'
                            clipRule='evenodd'
                          />
                        </svg>
                      </div>
                    </div>
                  ) : !isComplete ? (
                    // Processing state (no indicator)
                    <div className='relative mr-2'>
                      {getFileIcon(file.name)}
                    </div>
                  ) : (
                    // Completed state
                    <div className='relative mr-2'>
                      {getFileIcon(file.name)}
                      <div className='absolute -right-1 -bottom-1 w-4 h-4 bg-green-500 rounded-full flex items-center justify-center'>
                        <svg
                          xmlns='http://www.w3.org/2000/svg'
                          className='h-3 w-3 text-white'
                          viewBox='0 0 20 20'
                          fill='currentColor'
                        >
                          <path
                            fillRule='evenodd'
                            d='M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z'
                            clipRule='evenodd'
                          />
                        </svg>
                      </div>
                    </div>
                  )}

                  <div className='overflow-hidden flex-1 min-w-0'>
                    <span className='text-sm text-zinc-800 dark:text-white truncate block'>
                      {file.name}
                    </span>
                    <span
                      className={`text-xs ${progress?.error ? 'text-red-500 dark:text-red-400 font-medium' : 'text-zinc-500 dark:text-zinc-400'}`}
                    >
                      {(() => {
                        const translated = translateBackendStatus(progress?.message);
                        if (progress?.error) {
                          return <>{t('knowledge.uploader.error', 'Error')}: {translated || progress.message}</>;
                        }
                        return translated || formatFileSize(file.size);
                      })()}
                    </span>
                  </div>
                </div>

                {/* Progress indicator if uploading/processing */}
                {progress && !isComplete && !progress?.error ? (
                  <div className='relative w-8 h-8 flex items-center justify-center'>
                    <svg className='w-8 h-8' viewBox='0 0 36 36'>
                      <circle
                        cx='18'
                        cy='18'
                        r='16'
                        fill='none'
                        className='stroke-zinc-200 dark:stroke-zinc-700'
                        strokeWidth='3'
                      />
                      {/* Progress circle with smooth transition */}
                      <circle
                        cx='18'
                        cy='18'
                        r='16'
                        fill='none'
                        className='stroke-blue-500 transition-all duration-300'
                        strokeWidth='3'
                        strokeDasharray='100'
                        strokeDashoffset={(() => {
                          const actualProgress = getActualProgress(progress);
                          return Number.isFinite(actualProgress) &&
                            actualProgress >= 0 &&
                            actualProgress <= 100
                            ? 100 - actualProgress
                            : 100;
                        })()}
                        strokeLinecap='round'
                        transform='rotate(-90 18 18)'
                      />
                    </svg>
                    {/* Progress percentage */}
                    <span className='absolute text-xs font-medium'>
                      {(() => {
                        const actualProgress = getActualProgress(progress);
                        return Number.isFinite(actualProgress)
                          ? Math.min(100, Math.max(0, Math.round(actualProgress)))
                          : 0;
                      })()}
                      %
                    </span>
                  </div>
                ) : isComplete ? (
                  // Show green check for completed files
                  <div className='w-8 h-8 flex items-center justify-center'>
                    <div className='bg-green-500 rounded-full flex items-center justify-center w-6 h-6'>
                      <svg
                        xmlns='http://www.w3.org/2000/svg'
                        className='h-4 w-4 text-white'
                        viewBox='0 0 20 20'
                        fill='currentColor'
                      >
                        <path
                          fillRule='evenodd'
                          d='M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z'
                          clipRule='evenodd'
                        />
                      </svg>
                    </div>
                  </div>
                ) : progress?.error ? (
                  // Show red error icon for failed files
                  <div className='w-8 h-8 flex items-center justify-center'>
                    <div className='bg-red-500 rounded-full flex items-center justify-center w-6 h-6'>
                      <svg
                        xmlns='http://www.w3.org/2000/svg'
                        className='h-4 w-4 text-white'
                        viewBox='0 0 20 20'
                        fill='currentColor'
                      >
                        <path
                          fillRule='evenodd'
                          d='M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z'
                          clipRule='evenodd'
                        />
                      </svg>
                    </div>
                  </div>
                ) : (
                  // Show remove button for files that:
                  // 1. Are not yet uploaded (no progress)
                  // 2. Are completed but can be removed
                  (!isComplete || progress?.error) &&
                  (progress?.error ? (
                    // Special more prominent remove button for error state
                    <button
                      className='text-red-500 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300 bg-red-50 dark:bg-red-900/30 px-2 py-1 rounded text-xs font-medium'
                      onClick={() => handleRemoveFile(index)}
                      title='Remove failed file'
                    >
                      Remove
                    </button>
                  ) : (
                    // Normal remove button for other states
                    <button
                      className='text-zinc-500 hover:text-red-500 dark:text-zinc-400 dark:hover:text-red-500'
                      onClick={() => handleRemoveFile(index)}
                      title='Remove file'
                    >
                      <X className='h-4 w-4' />
                    </button>
                  ))
                )}
              </div>
            );
          })}

          {/* Skeleton loading while documents are being fetched.
              Only render when we have nothing to show — reopening the
              dialog re-triggers `isLoading=true` while the refetch is
              in flight, and previously that wiped the already-known
              list to full skeletons for however long the stats / list
              gRPC calls took (15 s per retry on a saturated backend).
              Keep the prior list visible; the "refreshing" spinner in
              the view-mode header signals that fresh data is coming. */}
          {isLoading && sortedDocuments.length === 0 && ongoingJobs.length === 0 && (() => {
            const skeletonCount = 6; // Show 6 skeleton items

            // Thumbnails View Skeleton
            if (viewMode === 'thumbnails') {
              return (
                <div className='grid grid-cols-4 sm:grid-cols-5 md:grid-cols-7 lg:grid-cols-9 xl:grid-cols-10 gap-2 mt-2'>
                  {Array.from({ length: skeletonCount }).map((_, index) => (
                    <div key={`skeleton-thumb-${index}`} className='flex flex-col items-center p-2'>
                      <Skeleton className='w-16 h-20 mb-2 rounded' />
                      <Skeleton className='h-3 w-full rounded' />
                    </div>
                  ))}
                </div>
              );
            }

            // Details View (Table) Skeleton
            if (viewMode === 'details') {
              return (
                <div className='w-full'>
                  {/* Table header */}
                  <div className='grid grid-cols-12 gap-2 px-2 py-1 text-xs font-medium text-zinc-500 dark:text-zinc-400 border-b border-zinc-200 dark:border-zinc-700'>
                    <div className='col-span-6 sm:col-span-5'>{t('knowledge.details.name')}</div>
                    <div className='col-span-2 hidden sm:block'>{t('knowledge.details.size')}</div>
                    <div className='col-span-2 hidden sm:block'>{t('knowledge.details.date')}</div>
                    <div className='col-span-4 sm:col-span-3'>{t('knowledge.details.type')}</div>
                  </div>
                  {/* Skeleton rows */}
                  {Array.from({ length: skeletonCount }).map((_, index) => (
                    <div key={`skeleton-detail-${index}`} className='grid grid-cols-12 gap-2 px-2 py-2 items-center border-b border-zinc-100 dark:border-zinc-800'>
                      <div className='col-span-6 sm:col-span-5 flex items-center overflow-hidden gap-2'>
                        <Skeleton className='w-7 h-7 rounded flex-shrink-0' />
                        <Skeleton className='h-4 flex-1 rounded' />
                      </div>
                      <div className='col-span-2 hidden sm:block'>
                        <Skeleton className='h-3 w-16 rounded' />
                      </div>
                      <div className='col-span-2 hidden sm:block'>
                        <Skeleton className='h-3 w-20 rounded' />
                      </div>
                      <div className='col-span-3 sm:col-span-1'>
                        <Skeleton className='h-3 w-10 rounded' />
                      </div>
                      <div className='col-span-3 sm:col-span-2 flex justify-end gap-1'>
                        <Skeleton className='w-6 h-6 rounded' />
                        <Skeleton className='w-6 h-6 rounded' />
                      </div>
                    </div>
                  ))}
                </div>
              );
            }

            // List View (Default) Skeleton
            return Array.from({ length: skeletonCount }).map((_, index) => (
              <div key={`skeleton-list-${index}`} className='flex items-center justify-between p-2'>
                <div className='flex items-center overflow-hidden gap-2 flex-1'>
                  <Skeleton className='w-8 h-8 rounded flex-shrink-0' />
                  <div className='flex-1 min-w-0'>
                    <Skeleton className='h-4 w-3/4 mb-1 rounded' />
                    <Skeleton className='h-3 w-1/2 rounded' />
                  </div>
                </div>
                <div className='flex items-center gap-1'>
                  <Skeleton className='w-7 h-7 rounded' />
                  <Skeleton className='w-7 h-7 rounded' />
                </div>
              </div>
            ));
          })()}

          {/* Already uploaded documents - with view mode support */}
          {/* Also render when ongoingJobs exist (even if no documents yet) to show synthetic entries */}
          {/* Intentionally drops the !isLoading guard — isLoading is true
              whenever a refetch is in flight (dialog reopen, tab focus
              restore, post-upload refresh) and hiding the list here made
              the UI flash to full skeletons every time. The list content
              stays mounted and the small spinner next to the file count
              signals "fresh data incoming". */}
          {(sortedDocuments.length > 0 || ongoingJobs.length > 0 || Object.keys(uploadProgress).some(k => uploadProgress[k]?.jobId && !uploadProgress[k]?.isComplete)) && (() => {
            // Helper to get status info for a document
            const getDocStatusInfo = (doc: ExistingDocument) => {
              const uploadProgressData = uploadProgress[doc.filename];
              const processingStatus = doc.processing_status || ProcessingStatus.COMPLETED;
              const jobStatus = doc.job_status;
              const ongoingJob = ongoingJobs.find(job => job.documentId === doc.id || job.filename === doc.filename);
              // Prefer the backend-fresh jobs-row snapshot (doc.job_progress)
              // over the STOMP uploadProgress state whenever the backend
              // says the job is still running. The uploadProgress slot was
              // being seeded with the 100 emitted by upload_stream at the
              // "Upload complete — processing..." frame and sticking there
              // forever, so every actively-processing row showed 100 %
              // instead of its real parse/chunk/embed percentage. Fallback
              // chain stays for completeness but backend value wins when
              // it's present and the job is not yet done.
              const backendProgress =
                typeof doc.job_progress === 'number' &&
                doc.job_status &&
                doc.job_status !== JobStatus.COMPLETED &&
                doc.job_status !== JobStatus.FAILED
                  ? doc.job_progress
                  : null;
              const jobProgress = pickProgress(
                typeof ongoingJob?.progress === 'number' ? ongoingJob.progress : null,
                backendProgress,
                uploadProgressData?.progress,
                typeof doc.job_progress === 'number' ? doc.job_progress : null,
              );
              const jobMessage = doc.job_message || uploadProgressData?.message;
              const jobErrors = doc.job_errors;
              const isDownloadedBook = !!doc.file_metadata?.book_source;

              // Check if document is being reprocessed via uploadProgress
              // Don't consider completed documents as "reprocessing" even if WebSocket progress is stale
              const isReprocessing = uploadProgressData && !uploadProgressData.isComplete && !uploadProgressData.error
                && processingStatus !== ProcessingStatus.COMPLETED;

              if ((processingStatus === ProcessingStatus.FAILED || jobStatus === JobStatus.FAILED) && !isReprocessing) {
                // Backend now emits camelCase status codes for failure
                // (CLAUDE.md rule #3); each candidate must pass through
                // translateBackendStatus before falling through. Without
                // this, a coded jobError ("errorWorkerDied") wins the OR
                // chain and is rendered raw, bypassing the i18n key
                // `knowledge.uploader.errorWorkerDied`.
                const failureMessage =
                  translateBackendStatus(jobErrors)
                  ?? translateBackendStatus(jobMessage)
                  ?? translateProcessingError(doc.processing_error);
                return {
                  color: 'bg-red-500',
                  icon: (
                    <svg xmlns='http://www.w3.org/2000/svg' className='h-3 w-3 text-white' viewBox='0 0 20 20' fill='currentColor'>
                      <path fillRule='evenodd' d='M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z' clipRule='evenodd' />
                    </svg>
                  ),
                  message: failureMessage,
                  isProcessing: false,
                  jobProgress,
                };
              } else if (processingStatus === ProcessingStatus.DEFERRED && !isReprocessing) {
                // Upload classifier decided this file is too heavy to
                // auto-process (scanned PDF needs OCR, or file > 20 MB).
                // Status stays at 'deferred' until the user clicks
                // "Process anyway" in the banner above the list.
                const reasonCode = (doc.processing_stats as { deferral_reason?: string } | undefined)?.deferral_reason;
                return {
                  color: 'bg-amber-500',
                  icon: <PauseCircle className='h-3 w-3 text-white' />,
                  message: t(
                    reasonCode === 'scanned_pdf_no_text_layer'
                      ? 'knowledge.library.deferredScanned'
                      : reasonCode === 'file_size_over_20mb'
                        ? 'knowledge.library.deferredLarge'
                        : 'knowledge.library.deferredGeneric',
                  ),
                  isProcessing: false,
                  jobProgress: 0,
                };
              } else if (
                isReprocessing ||
                processingStatus === ProcessingStatus.PENDING ||
                processingStatus === ProcessingStatus.PROCESSING ||
                jobStatus === JobStatus.PENDING ||
                jobStatus === JobStatus.PROCESSING
              ) {
                // Active processing requires the JOBS row to actually be
                // 'processing'. The earlier rule "(job_id && jobProgress>0)"
                // wrongly counted historic progress on failed jobs as live
                // — frequencies of 47/65/70 % stuck circles for hours after
                // the worker had moved on.
                const isActuallyProcessing = isReprocessing ||
                  processingStatus === ProcessingStatus.PROCESSING ||
                  jobStatus === JobStatus.PROCESSING ||
                  (ongoingJob?.status === 'processing');

                // Backend emits status codes (CLAUDE.md rule #3) — translate
                // before display so the in-progress subtitle reads
                // "Embedding batch 9/22" instead of "embeddingBatch:9:22".
                const translatedJobMessage = translateBackendStatus(jobMessage);
                const fallbackProgress = `Processing... ${jobProgress}%`;
                return {
                  color: 'bg-orange-500',
                  icon: <Clock className='h-3 w-3 text-white' />,
                  message: isReprocessing
                    ? translatedJobMessage || fallbackProgress
                    : (jobStatus === JobStatus.PROCESSING || processingStatus === ProcessingStatus.PROCESSING || ongoingJob?.status === 'processing'
                      // Active job: show real progress message, not "Pending processing".
                      // The documents.processing_status stays 'pending' until the
                      // task commits at the very end, so checking only that lit
                      // every active row as "Pending".
                      ? (translatedJobMessage || fallbackProgress)
                      : (processingStatus === ProcessingStatus.PENDING || jobStatus === JobStatus.PENDING
                        ? (isDownloadedBook
                            ? t('knowledge.uploader.downloadedReady', 'Downloaded - Ready to process')
                            : (doc.id.startsWith('pending-')
                              ? t('knowledge.uploader.waitingToCompose', 'Waiting to compose')
                              : t('knowledge.uploader.pendingProcessing', 'Pending processing')))
                        : translatedJobMessage || fallbackProgress)),
                  isProcessing: isActuallyProcessing,
                  jobProgress,
                };
              } else if (doc.graph_status === 'failed') {
                return {
                  color: 'bg-red-400',
                  icon: <GitBranch className='h-3 w-3 text-white' />,
                  message: t('knowledge.library.showFailed', 'Graph failed'),
                  isProcessing: false,
                  jobProgress: 100,
                  graphRetry: true,
                };
              } else if (doc.graph_status === 'entity_running') {
                return {
                  color: 'bg-orange-400',
                  icon: <GitBranch className='h-3 w-3 text-white' />,
                  message: t('knowledge.library.showRunning', 'Graph running'),
                  isProcessing: false,
                  jobProgress: 100,
                  graphRetry: true,
                };
              } else if (doc.graph_status === 'hierarchy_done') {
                return {
                  color: 'bg-yellow-500',
                  icon: <GitBranch className='h-3 w-3 text-white' />,
                  message: t('knowledge.library.showHierarchy', 'Hierarchy only'),
                  isProcessing: false,
                  jobProgress: 100,
                  graphRetry: true,
                };
              } else if (
                // Bug D fix — a completed document with NO graph_sync_status
                // row at all should still expose the "Build graph" retry
                // option. Before this, the dropdown only showed when
                // graph_status was one of failed / entity_running /
                // hierarchy_done, so docs whose graph integration was
                // never dispatched were invisible to the retry flow.
                processingStatus === ProcessingStatus.COMPLETED &&
                !doc.graph_status
              ) {
                return {
                  color: 'bg-zinc-400',
                  icon: <GitBranch className='h-3 w-3 text-white' />,
                  message: t('knowledge.library.showNoGraph', 'No graph — click to build'),
                  isProcessing: false,
                  jobProgress: 100,
                  graphRetry: true,
                };
              } else {
                // Completed status
                return {
                  color: 'bg-green-500',
                  icon: (
                    <svg xmlns='http://www.w3.org/2000/svg' className='h-3 w-3 text-white' viewBox='0 0 20 20' fill='currentColor'>
                      <path fillRule='evenodd' d='M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z' clipRule='evenodd' />
                    </svg>
                  ),
                  message: 'Ready for search',
                  isProcessing: false,
                  jobProgress,
                };
              }
            };

            // Create pending documents from files that haven't started uploading yet
            const pendingFiles: ExistingDocument[] = files
              .filter(file => {
                // Exclude files that have started uploading or are in progress
                const hasProgress = !!uploadProgress[file.name];
                // Exclude files that already exist in the document list (by sanitized filename)
                const alreadyExists = sortedDocuments.some(doc => doc.filename === sanitizeFilename(file.name));
                return !hasProgress && !alreadyExists;
              })
              .map((file, index) => ({
                id: `pending-${index}-${file.name}-${Date.now()}`, // Unique ID with timestamp
                filename: file.name,
                file_size: file.size,
                file_path: '', // Empty for pending files
                collection_id: collectionId, // Use current collection ID
                created_at: new Date().toISOString(),
                processing_status: ProcessingStatus.PENDING,
                job_status: JobStatus.PENDING,
                job_progress: 0,
                thumbnail: undefined,
                file_metadata: undefined,
              }));

            // Filter documents
            const filteredDocs = sortedDocuments.filter((doc) => {
              const hasOriginalVersionUploading = files.some(file =>
                sanitizeFilename(file.name) === doc.filename && uploadProgress[file.name]?.isComplete === true
              );
              const inProgress = files.some(file =>
                sanitizeFilename(file.name) === doc.filename && uploadProgress[file.name] && !uploadProgress[file.name].isComplete
              );
              return !hasOriginalVersionUploading && !inProgress;
            });

            // Create synthetic entries for ongoing jobs that aren't in existingDocuments
            // This ensures files appear in UI even when backend hasn't returned the document yet
            const syntheticOngoingDocs: ExistingDocument[] = ongoingJobs
              .filter(job => {
                // Only create synthetic entry if:
                // 1. Job isn't already in existingDocuments (by document ID or filename)
                // 2. Job isn't in pendingFiles
                // Note: Don't require uploadProgress - show the job even if useEffect hasn't run yet
                const inExistingById = sortedDocuments.some(doc => doc.id === job.documentId);
                const inExistingByName = sortedDocuments.some(doc => doc.filename === job.filename);
                const inPending = pendingFiles.some(doc => doc.filename === job.filename);
                const shouldInclude = !inExistingById && !inExistingByName && !inPending;
                console.log(`🔎 Synthetic filter for ${job.filename}: inExistingById=${inExistingById}, inExistingByName=${inExistingByName}, inPending=${inPending}, shouldInclude=${shouldInclude}`);
                return shouldInclude;
              })
              .map(job => {
                const progressData = uploadProgress[job.filename];
                console.log(`🏗️ Creating synthetic entry for ongoing job: ${job.filename}, progress: ${progressData?.progress ?? 0}%`);
                return {
                  id: job.documentId || `ongoing-${job.jobId}`,
                  filename: job.filename,
                  name: job.filename,
                  file_size: 0,
                  file_path: '',
                  collection_id: collectionId,
                  created_at: new Date().toISOString(),
                  processing_status: ProcessingStatus.PROCESSING,
                  job_status: JobStatus.PROCESSING,
                  job_id: job.jobId,
                  job_progress: progressData?.progress ?? 0,
                  thumbnail: undefined,
                  file_metadata: undefined,
                  doc_metadata: {
                    message: progressData?.message || t('knowledge.uploader.processing'),
                  },
                };
              });

            // ALSO create synthetic entries from uploadProgress when:
            // - We have progress data with a jobId
            // - The job is still processing (not complete)
            // - The file isn't already in existing documents, pending files, or ongoingJobs synthetic entries
            // This handles the case where WebSocket progress arrives before /jobs/active API returns
            const syntheticFromProgress: ExistingDocument[] = Object.entries(uploadProgress)
              .filter(([filename, progress]) => {
                // Only include active, non-complete jobs with a jobId
                if (!progress.jobId || progress.isComplete || progress.error) return false;
                // Skip if already in existing documents
                const inExisting = sortedDocuments.some(doc => doc.filename === filename);
                // Skip if in pending files
                const inPending = pendingFiles.some(doc => doc.filename === filename);
                // Skip if already in syntheticOngoingDocs (from ongoingJobs)
                const inSynthetic = syntheticOngoingDocs.some(doc => doc.filename === filename);
                const shouldInclude = !inExisting && !inPending && !inSynthetic;
                if (shouldInclude) {
                  console.log(`🏗️ Creating synthetic entry from uploadProgress: ${filename}, progress: ${progress.progress}%`);
                }
                return shouldInclude;
              })
              .map(([filename, progress]) => ({
                id: `progress-${progress.jobId}`,
                filename: filename,
                name: filename,
                file_size: 0,
                file_path: '',
                collection_id: collectionId,
                created_at: new Date().toISOString(),
                processing_status: ProcessingStatus.PROCESSING,
                job_status: JobStatus.PROCESSING,
                job_id: progress.jobId,
                job_progress: progress.progress,
                thumbnail: undefined,
                file_metadata: undefined,
                doc_metadata: {
                  message: progress.message || t('knowledge.uploader.processing'),
                },
              }));

            // Combine pending files, synthetic ongoing docs, synthetic from progress, and existing documents
            const allDocuments = [...syntheticFromProgress, ...syntheticOngoingDocs, ...pendingFiles, ...filteredDocs];

            // Pending or graph-failed document IDs eligible for selection
            const pendingDocumentIds = allDocuments
              .filter(d => (
                (d.processing_status === ProcessingStatus.PENDING || d.job_status === JobStatus.PENDING) ||
                d.graph_status === 'failed' || d.graph_status === 'entity_running' || d.graph_status === 'hierarchy_done'
              ) && !d.id.startsWith('pending-'))
              .map(d => d.id);

            const allDocumentIds = existingDocuments
              .filter(d => !d.id.startsWith('pending-'))
              .map(d => d.id);

            const handleSelectAllPending = () => {
              setSelectedDocumentIds(new Set(pendingDocumentIds));
              if (pendingDocumentIds.length > 0) setIsSelectionMode(true);
            };

            const handleSelectAll = () => {
              setSelectedDocumentIds(new Set(allDocumentIds));
              if (allDocumentIds.length > 0) setIsSelectionMode(true);
            };

            const handleClearSelection = () => {
              setSelectedDocumentIds(new Set());
              setIsSelectionMode(false);
            };

            const handleDeleteSelected = async () => {
              if (selectedDocumentIds.size === 0 || !onDeleteDocument) return;
              setIsDeletingSelected(true);
              const ids = Array.from(selectedDocumentIds);
              let failed = 0;
              for (const docId of ids) {
                try {
                  setDeletingDocIds(prev => [...prev, docId]);
                  await onDeleteDocument(docId);
                } catch {
                  failed++;
                } finally {
                  setDeletingDocIds(prev => prev.filter(id => id !== docId));
                }
              }
              setSelectedDocumentIds(new Set());
              setIsSelectionMode(false);
              setIsDeletingSelected(false);
              if (failed > 0) {
                toast({ title: t('general.error'), description: `${failed}/${ids.length} failed`, variant: 'destructive' });
              }
              // Refresh parent to update stats (Knowledge Graph, Summaries counters)
              onUploadComplete?.();
            };

            // Group existing documents by status so each bucket can be its own
            // collapsible section. Pending bucket follows the same liveness
            // rules as statusBucket (matches the right column in the row), so
            // counts here line up with what the user sees in the list below.
            const processingDocs = existingDocuments.filter(d => {
              const ps = d.processing_status;
              return ps === ProcessingStatus.PROCESSING
                || (ps === ProcessingStatus.PENDING && d.job_status === JobStatus.PROCESSING && typeof d.job_progress === 'number' && d.job_progress > 0);
            });
            const processingIds = new Set(processingDocs.map(d => d.id));
            const pendingDocs = existingDocuments.filter(d =>
              d.processing_status === ProcessingStatus.PENDING && !processingIds.has(d.id)
            );
            const failedDocs = existingDocuments.filter(d => d.processing_status === ProcessingStatus.FAILED);

            const handleSelectStatus = (docs: typeof existingDocuments) => {
              const ids = docs.map(d => d.id);
              setSelectedDocumentIds(new Set(ids));
              if (ids.length > 0) setIsSelectionMode(true);
            };

            // "Ready" = completed and not stuck in some intermediate state.
            const readyDocs = existingDocuments.filter(d =>
              d.processing_status === ProcessingStatus.COMPLETED
              && d.job_status !== JobStatus.PROCESSING
              && d.job_status !== JobStatus.FAILED
            );

            // Single predicate that maps a document to whichever status tab it
            // belongs to. The list rendering below filters through this so the
            // active tab determines what the user sees — no duplicated state,
            // no per-status collapse panels.
            const matchesStatusFilter = (d: typeof existingDocuments[number]): boolean => {
              if (statusFilter === 'all') return true;
              const isPendingFile = d.id.startsWith('pending-');
              const ps = d.processing_status;
              const js = d.job_status;
              const inFlightProcessing = ps === ProcessingStatus.PROCESSING
                || (ps === ProcessingStatus.PENDING && js === JobStatus.PROCESSING && typeof d.job_progress === 'number' && d.job_progress > 0);
              if (statusFilter === 'processing') return isPendingFile || inFlightProcessing;
              if (statusFilter === 'pending')    return !isPendingFile && ps === ProcessingStatus.PENDING && !inFlightProcessing;
              if (statusFilter === 'failed')     return !isPendingFile && ps === ProcessingStatus.FAILED;
              if (statusFilter === 'ready')      return !isPendingFile && ps === ProcessingStatus.COMPLETED && js !== JobStatus.PROCESSING && js !== JobStatus.FAILED;
              return true;
            };

            // Compact reusable chip — semantic colors only on the icon, neutral
            // chrome on the chip itself so the strip reads as one elegant row
            // instead of four shouting traffic-light bars.
            const renderStatusChip = (
              key: StatusFilter,
              icon: React.ReactNode | null,
              label: string,
              count: number,
            ) => {
              const active = statusFilter === key;
              return (
                <button
                  type='button'
                  key={key}
                  onClick={() => setStatusFilter(key)}
                  className={`inline-flex items-center gap-1.5 px-2 py-1 border transition-colors ${
                    active
                      ? 'border-primary bg-primary/5 text-foreground'
                      : 'border-border bg-background text-muted-foreground hover:text-foreground hover:bg-muted/50'
                  }`}
                >
                  {icon}
                  <span>{label}</span>
                  <span className='tabular-nums font-medium text-foreground/80'>{count}</span>
                </button>
              );
            };

            const hasActivity = processingDocs.length > 0 || pendingDocs.length > 0 || failedDocs.length > 0
              || selectedDocumentIds.size > 0 || allDocumentIds.length > 0;

            const selectionToolbar = hasActivity ? (
              <div className='flex flex-col gap-2 mb-2'>
                {/* Status filter strip — replaces the four stacked colored
                    cards plus the cryptic top counter. Each chip is a tab
                    that filters the document list below. The overflow menu
                    on the right consolidates every bulk action that used to
                    repeat as inline links inside each pill. */}
                <div className='flex items-center gap-1 text-xs flex-wrap'>
                  {renderStatusChip('all', null, t('knowledge.uploader.tabAll', 'Sve'), allDocumentIds.length)}
                  {processingDocs.length > 0 && renderStatusChip(
                    'processing',
                    <Loader2 className='h-3.5 w-3.5 animate-spin text-orange-500' />,
                    t('knowledge.uploader.tabProcessing', 'U obradi'),
                    processingDocs.length,
                  )}
                  {pendingDocs.length > 0 && renderStatusChip(
                    'pending',
                    <Clock className='h-3.5 w-3.5 text-yellow-500' />,
                    t('knowledge.uploader.tabPending', 'Na čekanju'),
                    pendingDocs.length,
                  )}
                  {failedDocs.length > 0 && renderStatusChip(
                    'failed',
                    <AlertTriangle className='h-3.5 w-3.5 text-red-500' />,
                    t('knowledge.uploader.tabFailed', 'Neuspjelo'),
                    failedDocs.length,
                  )}
                  {readyDocs.length > 0 && renderStatusChip(
                    'ready',
                    <Check className='h-3.5 w-3.5 text-emerald-500' />,
                    t('knowledge.uploader.tabReady', 'Spremno'),
                    readyDocs.length,
                  )}

                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        type='button'
                        className='ml-auto p-1 text-muted-foreground hover:text-foreground'
                        aria-label={t('knowledge.uploader.bulkActions', 'Skupne akcije')}
                      >
                        <MoreVertical className='h-4 w-4' />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align='end' className='min-w-[200px] z-[1300] text-xs'>
                      {pendingDocs.length > 0 && (
                        <DropdownMenuItem onClick={() => handleSelectStatus(pendingDocs)}>
                          <Zap className='h-3.5 w-3.5 mr-2 text-yellow-500' />
                          {t('knowledge.uploader.selectPendingDocs', { count: pendingDocs.length })}
                        </DropdownMenuItem>
                      )}
                      {failedDocs.length > 0 && (
                        <DropdownMenuItem onClick={() => handleSelectStatus(failedDocs)}>
                          <RefreshCw className='h-3.5 w-3.5 mr-2 text-red-500' />
                          {t('knowledge.uploader.selectFailedDocs', { count: failedDocs.length })}
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuItem onClick={handleSelectAll}>
                        <Check className='h-3.5 w-3.5 mr-2' />
                        {t('knowledge.uploader.selectAll')}
                      </DropdownMenuItem>
                      {selectedDocumentIds.size > 0 && (
                        <>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem onClick={handleClearSelection}>
                            <X className='h-3.5 w-3.5 mr-2' />
                            {t('knowledge.uploader.clearSelection')}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={handleDeleteSelected}
                            disabled={isDeletingSelected}
                            className='text-destructive focus:text-destructive'
                          >
                            {isDeletingSelected
                              ? <Loader2 className='h-3.5 w-3.5 mr-2 animate-spin' />
                              : <Trash2 className='h-3.5 w-3.5 mr-2' />}
                            {t('knowledge.uploader.deleteSelected')}
                          </DropdownMenuItem>
                        </>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>

                {/* Slim selection summary — only when something is selected,
                    no longer redundant with the strip. */}
                {selectedDocumentIds.size > 0 && (
                  <div className='flex items-center gap-2 px-2 py-1 bg-primary/5 border border-primary/20 text-xs'>
                    <Check className='h-3.5 w-3.5 text-primary flex-shrink-0' />
                    <span className='text-primary font-medium'>
                      {t('knowledge.uploader.selected', { count: selectedDocumentIds.size })}
                    </span>
                    <button
                      className='ml-auto text-muted-foreground hover:text-foreground'
                      onClick={handleClearSelection}
                    >
                      {t('knowledge.uploader.clearSelection')}
                    </button>
                  </div>
                )}
              </div>
            ) : null;

            // Thumbnails View
            if (viewMode === 'thumbnails') {
              return (
                <div>
                  {selectionToolbar}
                <div className='grid grid-cols-4 sm:grid-cols-5 md:grid-cols-7 lg:grid-cols-9 xl:grid-cols-10 gap-2 p-1'>
                  {allDocuments.filter(matchesStatusFilter).map((doc, docIndex) => {
                    const statusInfo = getDocStatusInfo(doc);
                    const isPendingFile = doc.id.startsWith('pending-');
                    const shouldRenderSentinel = docIndex === 6 && hasMore && !isLoadingMore && allDocuments.length > 7;

                    // Pick highest progress across sources — see pickProgress
                    // helper for the rationale (progress is monotonic).
                    const uploadProgressData = uploadProgress[doc.filename];
                    const ongoingJob = ongoingJobs.find(job => job.documentId === doc.id || job.filename === doc.filename);
                    const _backendProgress = typeof doc.job_progress === 'number' && doc.job_status && doc.job_status !== JobStatus.COMPLETED && doc.job_status !== JobStatus.FAILED ? doc.job_progress : null;
                    const jobProgress = pickProgress(
                      typeof ongoingJob?.progress === 'number' ? ongoingJob.progress : null,
                      _backendProgress,
                      uploadProgressData?.progress,
                      typeof doc.job_progress === 'number' ? doc.job_progress : null,
                    );
                    const processingStatus = doc.processing_status || ProcessingStatus.COMPLETED;
                    const jobStatus = doc.job_status;
                    const isDocPending = ((processingStatus === ProcessingStatus.PENDING || jobStatus === JobStatus.PENDING) || doc.graph_status === 'entity_running' || doc.graph_status === 'hierarchy_done') && !isPendingFile && !statusInfo.isProcessing;
                    const isSelected = selectedDocumentIds.has(doc.id);
                    // `showCheckbox` used to also be true on any desktop view
              // (`|| !isMobile`), which hid the pending/processing status
              // indicator for every row on wide screens — the checkbox
              // placeholder takes the same corner slot as the status dot.
              // Limit it to explicit selection intent so the orange clock
              // / red X / green check stays visible during an upload.
              const showCheckbox = isDocPending && (isSelectionMode || selectedDocumentIds.size > 0);

                    const statusTooltipText = (processingStatus === ProcessingStatus.FAILED || jobStatus === JobStatus.FAILED)
                      ? translateProcessingError(doc.processing_error)
                      : statusInfo.isProcessing
                        ? t('knowledge.uploader.processing', 'Processing...')
                        : (processingStatus === ProcessingStatus.PENDING || jobStatus === JobStatus.PENDING)
                          ? t('knowledge.uploader.pendingProcessing', 'Pending processing')
                          : t('knowledge.uploader.readyForSearch', 'Ready for search');

                    return (
                      <div key={`doc-${doc.id}`} className="contents">
                        <TooltipProvider>
                          <Tooltip>
                            <TooltipTrigger asChild>
                        <div
                          className={`relative group flex flex-col items-center ${isSelected ? 'ring-2 ring-primary' : ''}`}
                          {...(isDocPending ? getLongPressHandlers(doc.id) : {})}
                        >
                          <DocumentThumbnail
                            documentId={doc.id}
                            filename={doc.filename}
                            hasThumbnail={doc.thumbnail?.has_thumbnail}
                            hasCustomThumbnail={doc.thumbnail?.has_custom}
                            coverDownloaded={doc.thumbnail?.cover_downloaded === true || doc.file_metadata?.thumbnail?.cover_downloaded === true}
                            coverUrl={doc.file_metadata?.cover_url}
                            className='cursor-pointer'
                            onThumbnailUpdate={onUploadComplete}
                            onPreview={hasFileOnDisk(doc) ? handlePreviewDocument : undefined}
                          />
                          {/* Processing progress overlay */}
                          {statusInfo.isProcessing && (
                            <div className='absolute inset-0 flex items-center justify-center bg-black/30 z-20'>
                              <div className='w-10 h-10 relative flex items-center justify-center'>
                                <svg className='w-10 h-10' viewBox='0 0 36 36'>
                                  <circle cx='18' cy='18' r='16' fill='none' className='stroke-white/30' strokeWidth='3' />
                                  <circle cx='18' cy='18' r='16' fill='none' className='stroke-white transition-all duration-300'
                                    strokeWidth='3' strokeDasharray='100'
                                    strokeDashoffset={100 - Math.min(100, Math.max(0, jobProgress))}
                                    strokeLinecap='round' transform='rotate(-90 18 18)'
                                  />
                                </svg>
                                <span className='absolute text-xs font-bold text-white'>
                                  {Math.min(100, Math.max(0, Math.round(jobProgress)))}%
                                </span>
                              </div>
                            </div>
                          )}
                          {/* Action buttons: hover overlay on desktop, always-visible compact on mobile */}
                          {!statusInfo.isProcessing && !isMobile && (
                            <div className='absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity bg-black/20 z-20 flex items-start justify-end gap-1 p-1'>
                              {/* Selection checkbox for pending docs */}
                              {showCheckbox && (
                                <button
                                  className={`w-5 h-5 rounded-full flex items-center justify-center border-2 ${isSelected ? 'bg-primary border-primary' : 'bg-white/80 border-zinc-400'}`}
                                  onClick={e => { e.stopPropagation(); toggleDocumentSelection(doc.id); }}
                                  onMouseDown={e => e.preventDefault()}
                                >
                                  {isSelected && <Check className='h-3 w-3 text-white' />}
                                </button>
                              )}
                              {/* Spacer to push action buttons to the right */}
                              <div className='flex-1' />
                              {/* Upload file button for pending documents without a file on disk */}
                              {(processingStatus === ProcessingStatus.PENDING || jobStatus === JobStatus.PENDING) && !hasFileOnDisk(doc) && !isPendingFile && (
                                <button
                                  className='w-6 h-6 rounded-full flex items-center justify-center bg-blue-500 hover:bg-blue-600 shadow-md'
                                  onClick={e => { e.stopPropagation(); handleReuploadFile(doc.id); }}
                                  disabled={reuploadingDocId === doc.id}
                                  title={t('knowledge.uploader.uploadFile', 'Upload file')}
                                  onMouseDown={e => e.preventDefault()}
                                >
                                  {reuploadingDocId === doc.id
                                    ? <Loader2 className='h-3 w-3 animate-spin text-white' />
                                    : <Upload className='h-3 w-3 text-white' />}
                                </button>
                              )}
                              {/* Process button for pending documents */}
                              {(processingStatus === ProcessingStatus.PENDING || jobStatus === JobStatus.PENDING) && (
                                <button
                                  className='w-6 h-6 rounded-full flex items-center justify-center bg-green-500 hover:bg-green-600 shadow-md'
                                  onClick={e => { e.stopPropagation(); void handleProcessDocument(doc.id, e); }}
                                  disabled={processingDocIds.includes(doc.id)}
                                  title={t('knowledge.uploader.startProcessing', 'Start processing')}
                                  onMouseDown={e => e.preventDefault()}
                                >
                                  {processingDocIds.includes(doc.id)
                                    ? <Loader2 className='h-3 w-3 animate-spin text-white' />
                                    : <Zap className='h-3 w-3 text-white' />}
                                </button>
                              )}
                              {/* Delete/Remove button */}
                              <button
                                className='w-6 h-6 rounded-full flex items-center justify-center bg-red-500 hover:bg-red-600 shadow-md'
                                onClick={e => {
                                  e.stopPropagation();
                                  if (isPendingFile) {
                                    const fileIndex = files.findIndex(f => f.name === doc.filename);
                                    if (fileIndex !== -1) handleRemoveFile(fileIndex);
                                  } else {
                                    handleDeleteDocument(doc.id, e);
                                  }
                                }}
                                disabled={!isPendingFile && deletingDocIds.includes(doc.id)}
                                title={isPendingFile ? 'Remove file' : 'Delete document'}
                                onMouseDown={e => e.preventDefault()}
                              >
                                {!isPendingFile && deletingDocIds.includes(doc.id)
                                  ? <Loader2 className='h-3 w-3 animate-spin text-white' />
                                  : <X className='h-3 w-3 text-white' />}
                              </button>
                            </div>
                          )}
                          {/* Mobile: compact always-visible buttons (no hover on touch) */}
                          {!statusInfo.isProcessing && isMobile && (
                            <>
                              {/* Delete button — always visible top-right */}
                              <button
                                className='absolute top-1 right-1 w-5 h-5 rounded-full flex items-center justify-center bg-red-500/80 shadow-sm z-20'
                                onClick={e => {
                                  e.stopPropagation();
                                  if (isPendingFile) {
                                    const fileIndex = files.findIndex(f => f.name === doc.filename);
                                    if (fileIndex !== -1) handleRemoveFile(fileIndex);
                                  } else {
                                    handleDeleteDocument(doc.id, e);
                                  }
                                }}
                                disabled={!isPendingFile && deletingDocIds.includes(doc.id)}
                                onMouseDown={e => e.preventDefault()}
                              >
                                {!isPendingFile && deletingDocIds.includes(doc.id)
                                  ? <Loader2 className='h-2.5 w-2.5 animate-spin text-white' />
                                  : <X className='h-2.5 w-2.5 text-white' />}
                              </button>
                              {/* Process/Upload button — bottom-right for pending docs */}
                              {(processingStatus === ProcessingStatus.PENDING || jobStatus === JobStatus.PENDING) && (
                                hasFileOnDisk(doc) ? (
                                  <button
                                    className='absolute bottom-1 right-1 w-5 h-5 rounded-full flex items-center justify-center bg-green-500/80 shadow-sm z-20'
                                    onClick={e => { e.stopPropagation(); void handleProcessDocument(doc.id, e); }}
                                    disabled={processingDocIds.includes(doc.id)}
                                    onMouseDown={e => e.preventDefault()}
                                  >
                                    {processingDocIds.includes(doc.id)
                                      ? <Loader2 className='h-2.5 w-2.5 animate-spin text-white' />
                                      : <Zap className='h-2.5 w-2.5 text-white' />}
                                  </button>
                                ) : !isPendingFile && (
                                  <button
                                    className='absolute bottom-1 right-1 w-5 h-5 rounded-full flex items-center justify-center bg-blue-500/80 shadow-sm z-20'
                                    onClick={e => { e.stopPropagation(); handleReuploadFile(doc.id); }}
                                    disabled={reuploadingDocId === doc.id}
                                    onMouseDown={e => e.preventDefault()}
                                  >
                                    {reuploadingDocId === doc.id
                                      ? <Loader2 className='h-2.5 w-2.5 animate-spin text-white' />
                                      : <Upload className='h-2.5 w-2.5 text-white' />}
                                  </button>
                                )
                              )}
                            </>
                          )}
                          {/* Title with memory-only dot indicator */}
                          <span className='text-xs text-zinc-600 dark:text-zinc-400 mt-1 truncate w-full text-center px-1 flex items-center justify-center gap-1' title={doc.title || doc.filename}>
                            {doc.file_stored === false && (
                              <span className='w-1.5 h-1.5 shrink-0 rounded-full bg-amber-500' title={t('knowledge.uploader.memoryOnlyDoc')} />
                            )}
                            {(doc.title || doc.filename).length > 12 ? (doc.title || doc.filename).substring(0, 10) + '...' : (doc.title || doc.filename)}
                          </span>
                        </div>
                            </TooltipTrigger>
                            <TooltipContent side="bottom" className="z-[1300]">
                              <p className="text-xs">{statusTooltipText}</p>
                            </TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                        {shouldRenderSentinel && <div ref={loadMoreTriggerRef} className='h-1 w-full col-span-full' aria-hidden='true' />}
                      </div>
                    );
                  })}
                </div>
                </div>
              );
            }

            // Details View (table)
            if (viewMode === 'details') {
              return (
                <div className='w-full'>
                  {selectionToolbar}
                  <>
                  {/* Table header */}
                  <div className='grid grid-cols-12 gap-2 px-2 py-1 text-xs font-medium text-zinc-500 dark:text-zinc-400 border-b border-zinc-200 dark:border-zinc-700'>
                    <div className='col-span-6 sm:col-span-5'>{t('knowledge.details.name')}</div>
                    <div className='col-span-2 hidden sm:block'>{t('knowledge.details.size')}</div>
                    <div className='col-span-2 hidden sm:block'>{t('knowledge.details.date')}</div>
                    <div className='col-span-4 sm:col-span-3'>{t('knowledge.details.type')}</div>
                  </div>
                  {/* Table rows */}
                  {allDocuments.filter(matchesStatusFilter).map((doc, docIndex) => {
                    const statusInfo = getDocStatusInfo(doc);
                    const isPendingFile = doc.id.startsWith('pending-');
                    const shouldRenderSentinel = docIndex === 6 && hasMore && !isLoadingMore && allDocuments.length > 7;
                    const ext = doc.filename.split('.').pop()?.toUpperCase() || '-';
                    const dateStr = doc.created_at ? new Date(doc.created_at).toLocaleDateString() : '-';
                    const processingStatus = doc.processing_status || ProcessingStatus.COMPLETED;
                    const jobStatus = doc.job_status;
                    // pickProgress = MAX across sources, see helper top of file.
                    const uploadProgressData = uploadProgress[doc.filename];
                    const ongoingJob = ongoingJobs.find(job => job.documentId === doc.id || job.filename === doc.filename);
                    const _backendProgress = typeof doc.job_progress === 'number' && doc.job_status && doc.job_status !== JobStatus.COMPLETED && doc.job_status !== JobStatus.FAILED ? doc.job_progress : null;
                    const jobProgress = pickProgress(
                      typeof ongoingJob?.progress === 'number' ? ongoingJob.progress : null,
                      _backendProgress,
                      uploadProgressData?.progress,
                      typeof doc.job_progress === 'number' ? doc.job_progress : null,
                    );
                    const isDocPending = ((processingStatus === ProcessingStatus.PENDING || jobStatus === JobStatus.PENDING) || doc.graph_status === 'entity_running' || doc.graph_status === 'hierarchy_done') && !isPendingFile && !statusInfo.isProcessing;
                    const isSelected = selectedDocumentIds.has(doc.id);
                    // `showCheckbox` used to also be true on any desktop view
              // (`|| !isMobile`), which hid the pending/processing status
              // indicator for every row on wide screens — the checkbox
              // placeholder takes the same corner slot as the status dot.
              // Limit it to explicit selection intent so the orange clock
              // / red X / green check stays visible during an upload.
              const showCheckbox = isDocPending && (isSelectionMode || selectedDocumentIds.size > 0);
                    // Debug: Log why circular might not show
                    if (statusInfo.isProcessing || jobProgress > 0) {
                      console.log(`🔵 Details view: ${doc.filename}`);
                      console.log(`  - isProcessing=${statusInfo.isProcessing}`);
                      console.log(`  - jobProgress=${jobProgress}`);
                      console.log(`  - uploadProgress=${uploadProgressData?.progress}`);
                      console.log(`  - ongoingJob=${JSON.stringify(ongoingJob)}`);
                      console.log(`  - doc.processing_status=${doc.processing_status}`);
                      console.log(`  - doc.job_status=${doc.job_status}`);
                      console.log(`  - doc.job_id=${doc.job_id}`);
                    }
                    return (
                      <div key={`doc-${doc.id}`} className="contents">
                        <div className={`grid grid-cols-12 gap-2 px-2 py-2 items-center hover:bg-zinc-50 dark:hover:bg-zinc-800/50 border-b border-zinc-100 dark:border-zinc-800 group${isSelected ? ' bg-primary/5' : ''}`}
                          {...(isDocPending ? getLongPressHandlers(doc.id) : {})}
                        >
                          <div className='col-span-6 sm:col-span-5 flex items-center overflow-hidden'>
                            {statusInfo.isProcessing ? (
                              // Show circular progress for processing documents (even at 0%)
                              <div className='relative w-7 h-7 flex items-center justify-center mr-2 flex-shrink-0'>
                                <svg className='w-7 h-7' viewBox='0 0 36 36'>
                                  <circle
                                    cx='18'
                                    cy='18'
                                    r='16'
                                    fill='none'
                                    className='stroke-zinc-200 dark:stroke-zinc-700'
                                    strokeWidth='3'
                                  />
                                  <circle
                                    cx='18'
                                    cy='18'
                                    r='16'
                                    fill='none'
                                    className='stroke-orange-500 transition-all duration-300'
                                    strokeWidth='3'
                                    strokeDasharray='100'
                                    strokeDashoffset={100 - Math.min(100, Math.max(0, jobProgress))}
                                    strokeLinecap='round'
                                    transform='rotate(-90 18 18)'
                                  />
                                </svg>
                                <span className='absolute text-[10px] font-bold text-zinc-800 dark:text-white'>
                                  {Math.min(100, Math.max(0, Math.round(jobProgress)))}%
                                </span>
                              </div>
                            ) : (
                              <div
                                className='relative mr-2 flex-shrink-0 cursor-pointer'
                                onClick={e => { e.stopPropagation(); if (showCheckbox) toggleDocumentSelection(doc.id); }}
                              >
                                {getFileIcon(doc.filename)}
                                {showCheckbox ? (
                                  <div className={`absolute right-0 bottom-0 w-4 h-4 rounded-full flex items-center justify-center border-2 border-white dark:border-zinc-800 z-10 ${isSelected ? 'bg-primary border-primary' : 'bg-white dark:bg-zinc-800 border-zinc-400'}`}>
                                    {isSelected && <Check className='h-2 w-2 text-white' />}
                                  </div>
                                ) : (
                                  <div className={`absolute right-0 bottom-0 w-4 h-4 ${statusInfo.color} rounded-full flex items-center justify-center border-2 border-white dark:border-zinc-800 z-10`}>
                                    {React.cloneElement(statusInfo.icon as React.ReactElement, { className: 'h-2 w-2 text-white' })}
                                  </div>
                                )}
                              </div>
                            )}
                            <AnimatedTitle
                              title={doc.title || doc.filename}
                              className="text-sm text-zinc-800 dark:text-white"
                            />
                          </div>
                          <div className='col-span-2 hidden sm:block text-xs text-zinc-500 dark:text-zinc-400'>
                            {formatFileSize(doc.file_size)}
                          </div>
                          <div className='col-span-2 hidden sm:block text-xs text-zinc-500 dark:text-zinc-400'>
                            {dateStr}
                          </div>
                          <div className='col-span-3 sm:col-span-1 text-xs text-zinc-500 dark:text-zinc-400'>
                            {ext}
                          </div>
                          <div className='col-span-3 sm:col-span-2 flex justify-end gap-1.5 items-center'>
                            {/* Memory-only tooltip icon */}
                            {doc.file_stored === false && (
                              <TooltipProvider>
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <span className='w-5 h-5 flex items-center justify-center bg-amber-100 dark:bg-amber-900/30 border border-amber-300 dark:border-amber-700 rounded-sm cursor-help'>
                                      <FileText className='h-3 w-3 text-amber-600 dark:text-amber-400' />
                                    </span>
                                  </TooltipTrigger>
                                  <TooltipContent side='left' className='z-[1300]'>
                                    <p className='text-xs'>{t('knowledge.uploader.memoryOnlyDoc')}</p>
                                  </TooltipContent>
                                </Tooltip>
                              </TooltipProvider>
                            )}
                            {statusInfo.isProcessing && (doc.job_id || ongoingJob?.jobId) ? (
                              <button
                                className='w-6 h-6 rounded-full flex items-center justify-center bg-orange-500 hover:bg-orange-600 hover:scale-110 transition-all shadow-md'
                                onClick={e => handleAbortDocument(doc.id, doc.job_id || ongoingJob?.jobId, e)}
                                disabled={abortingDocIds.includes(doc.id)}
                                title={t('knowledge.uploader.abortProcessing', 'Abort processing')}
                              >
                                {abortingDocIds.includes(doc.id) ? (
                                  <Loader2 className='h-3 w-3 animate-spin text-white' />
                                ) : (
                                  <StopCircle className='h-3 w-3 text-white' />
                                )}
                              </button>
                            ) : isPendingFile ? (
                              <button
                                className='w-6 h-6 rounded-full flex items-center justify-center bg-red-500 hover:bg-red-600 opacity-0 group-hover:opacity-100 hover:scale-110 transition-all shadow-md'
                                onClick={e => {
                                  e.stopPropagation();
                                  const fileIndex = files.findIndex(f => f.name === doc.filename);
                                  if (fileIndex !== -1) handleRemoveFile(fileIndex);
                                }}
                                title='Remove file'
                              >
                                <X className='h-3 w-3 text-white' />
                              </button>
                            ) : (
                              <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                  <button
                                    className='w-6 h-6 flex items-center justify-center text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200 opacity-0 group-hover:opacity-100 transition-all'
                                    onClick={e => e.stopPropagation()}
                                  >
                                    <MoreVertical className='h-4 w-4' />
                                  </button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align='end' className='min-w-[160px] z-[1300]'>
                                  {(processingStatus === ProcessingStatus.FAILED || jobStatus === JobStatus.FAILED) && (
                                    <DropdownMenuItem
                                      onClick={e => handleRetryDocument(doc.id, e as unknown as React.MouseEvent)}
                                      disabled={retryingDocIds.includes(doc.id)}
                                    >
                                      {retryingDocIds.includes(doc.id) ? (
                                        <Loader2 className='h-4 w-4 mr-2 animate-spin' />
                                      ) : (
                                        <RefreshCw className='h-4 w-4 mr-2' />
                                      )}
                                      {t('knowledge.uploader.retryProcessing', 'Retry processing')}
                                    </DropdownMenuItem>
                                  )}
                                  {(processingStatus === ProcessingStatus.PENDING || jobStatus === JobStatus.PENDING) && !statusInfo.isProcessing && !hasFileOnDisk(doc) && !doc.id.startsWith('pending-') && (
                                    <DropdownMenuItem
                                      onClick={() => handleReuploadFile(doc.id)}
                                      disabled={reuploadingDocId === doc.id}
                                    >
                                      {reuploadingDocId === doc.id ? (
                                        <Loader2 className='h-4 w-4 mr-2 animate-spin' />
                                      ) : (
                                        <Upload className='h-4 w-4 mr-2' />
                                      )}
                                      {t('knowledge.uploader.uploadFile', 'Upload file')}
                                    </DropdownMenuItem>
                                  )}
                                  {(processingStatus === ProcessingStatus.PENDING || jobStatus === JobStatus.PENDING) && !statusInfo.isProcessing && (
                                    <DropdownMenuItem
                                      onClick={e => void handleProcessDocument(doc.id, e as unknown as React.MouseEvent)}
                                      disabled={processingDocIds.includes(doc.id)}
                                    >
                                      {processingDocIds.includes(doc.id) ? (
                                        <Loader2 className='h-4 w-4 mr-2 animate-spin' />
                                      ) : (
                                        <Zap className='h-4 w-4 mr-2' />
                                      )}
                                      {t('knowledge.uploader.startProcessing', 'Start processing')}
                                    </DropdownMenuItem>
                                  )}
                                  {(() => {
                                    const fileExt = doc.filename.split('.').pop()?.toLowerCase();
                                    const isPreviewable = fileExt === 'pdf' || fileExt === 'epub' || fileExt === 'docx';
                                    const isFailed = processingStatus === ProcessingStatus.FAILED || jobStatus === JobStatus.FAILED;
                                    const isActivelyProcessing = processingStatus === ProcessingStatus.PROCESSING || jobStatus === JobStatus.PROCESSING;
                                    const canPreview = isPreviewable && !isActivelyProcessing && !isFailed && hasFileOnDisk(doc);
                                    return canPreview ? (
                                      <DropdownMenuItem onClick={() => handlePreviewDocument(doc.id, doc.filename)}>
                                        <Eye className='h-4 w-4 mr-2' />
                                        {t('knowledge.downloadedBooks.preview', 'Preview')}
                                      </DropdownMenuItem>
                                    ) : null;
                                  })()}
                                  <DropdownMenuSeparator />
                                  <DropdownMenuItem
                                    onClick={e => handleDeleteDocument(doc.id, e as unknown as React.MouseEvent)}
                                    disabled={deletingDocIds.includes(doc.id)}
                                    className='text-red-600 dark:text-red-400 focus:text-red-600 dark:focus:text-red-400'
                                  >
                                    {deletingDocIds.includes(doc.id) ? (
                                      <Loader2 className='h-4 w-4 mr-2 animate-spin' />
                                    ) : (
                                      <Trash2 className='h-4 w-4 mr-2' />
                                    )}
                                    {t('knowledge.uploader.delete', 'Delete')}
                                  </DropdownMenuItem>
                                </DropdownMenuContent>
                              </DropdownMenu>
                            )}
                          </div>
                        </div>
                        {shouldRenderSentinel && <div ref={loadMoreTriggerRef} className='h-1 w-full' aria-hidden='true' />}
                      </div>
                    );
                  })}
                  </>
                </div>
              );
            }

            // List View (default - compact)
            return (
              <>
                {selectionToolbar}
                {filteredDocs.filter(matchesStatusFilter).map((doc, docIndex) => {
              const statusInfo = getDocStatusInfo(doc);
              const shouldRenderSentinel = docIndex === 6 && hasMore && !isLoadingMore && filteredDocs.length > 7;
              const processingStatus = doc.processing_status || ProcessingStatus.COMPLETED;
              const jobStatus = doc.job_status;

              // pickProgress = MAX across sources, see helper top of file.
              // ongoingJobs matches by documentId even if the row hasn't
              // received its job_id yet from the next poll.
              const uploadProgressData = uploadProgress[doc.filename];
              const ongoingJob = ongoingJobs.find(job => job.documentId === doc.id);
              const _backendProgressList = typeof doc.job_progress === 'number' && doc.job_status && doc.job_status !== JobStatus.COMPLETED && doc.job_status !== JobStatus.FAILED ? doc.job_progress : null;
              const jobProgress = pickProgress(
                typeof ongoingJob?.progress === 'number' ? ongoingJob.progress : null,
                _backendProgressList,
                uploadProgressData?.progress,
                typeof doc.job_progress === 'number' ? doc.job_progress : null,
              );
              const jobErrors = doc.job_errors;
              // Translate backend `JOB_ERR_*` status codes (set by
              // _format_job_error in document_extras_service.py) into
              // the user's locale via i18next. Non-coded raw strings
              // pass through unchanged.
              const translatedJobErrors = jobErrors?.startsWith('JOB_ERR_')
                ? t(`knowledge.jobErrors.${jobErrors}`, { defaultValue: jobErrors })
                : jobErrors;
              const isDocPending = ((processingStatus === ProcessingStatus.PENDING || jobStatus === JobStatus.PENDING) || doc.graph_status === 'failed' || doc.graph_status === 'entity_running' || doc.graph_status === 'hierarchy_done') && !doc.id.startsWith('pending-') && !statusInfo.isProcessing;
              const isSelected = selectedDocumentIds.has(doc.id);
              // `showCheckbox` used to also be true on any desktop view
              // (`|| !isMobile`), which hid the pending/processing status
              // indicator for every row on wide screens — the checkbox
              // placeholder takes the same corner slot as the status dot.
              // Limit it to explicit selection intent so the orange clock
              // / red X / green check stays visible during an upload.
              const showCheckbox = isDocPending && (isSelectionMode || selectedDocumentIds.size > 0);


              return (
                <div key={`doc-${doc.id}`} className="contents">
                  <div
                    className={`flex items-center justify-between p-2 bg-zinc-100 dark:bg-zinc-800${isSelected ? ' bg-primary/10 dark:bg-primary/10' : ''}`}
                    {...(isDocPending ? getLongPressHandlers(doc.id) : {})}
                  >
                    <div className='flex items-center overflow-hidden flex-1 min-w-0'>
                      <TooltipProvider>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <div
                                className='relative mr-2 cursor-pointer'
                                onClick={e => { e.stopPropagation(); if (showCheckbox) toggleDocumentSelection(doc.id); }}
                              >
                                {getFileIcon(doc.filename)}
                                {showCheckbox ? (
                                  // Selection checkbox overlaid on file icon
                                  <div className={`absolute right-0 bottom-0 w-5 h-5 rounded-full flex items-center justify-center border-2 border-white dark:border-zinc-800 z-10 ${isSelected ? 'bg-primary border-primary' : 'bg-white dark:bg-zinc-700 border-zinc-400'}`}>
                                    {isSelected && <Check className='h-3 w-3 text-white' />}
                                  </div>
                                ) : (
                                  <div className={`absolute right-0 bottom-0 w-5 h-5 ${statusInfo.color} rounded-full flex items-center justify-center border-2 border-white dark:border-zinc-800 z-10`}>
                                    {statusInfo.icon}
                                  </div>
                                )}
                              </div>
                            </TooltipTrigger>
                            <TooltipContent side="right" className="max-w-sm">
                              {(processingStatus === ProcessingStatus.FAILED || jobStatus === JobStatus.FAILED) ? (
                                <>
                                  <p className="text-sm font-semibold mb-1 text-red-600 dark:text-red-400">{t('knowledge.uploader.processingFailed', 'Processing failed')}</p>
                                  {(() => {
                                    const tooltipMessage =
                                      translateBackendStatus(doc.job_errors)
                                      ?? translateBackendStatus(doc.job_message);
                                    return tooltipMessage ? <p className="text-xs">{tooltipMessage}</p> : null;
                                  })()}
                                </>
                              ) : processingStatus === ProcessingStatus.PENDING || jobStatus === JobStatus.PENDING ? (
                                <p className="text-sm">{t('knowledge.uploader.pendingProcessing', 'Pending processing')}</p>
                              ) : processingStatus === ProcessingStatus.COMPLETED ? (
                                <p className="text-sm text-green-600 dark:text-green-400">{t('knowledge.uploader.readyForSearch', 'Ready for search')}</p>
                              ) : (
                                <p className="text-sm">{statusInfo.message}</p>
                              )}
                            </TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      <div className='overflow-hidden flex-1 min-w-0'>
                        <span className='text-sm text-zinc-800 dark:text-white truncate block'>
                          {doc.title || doc.filename}
                        </span>
                        <span className='text-xs text-zinc-500 dark:text-zinc-400'>
                          {statusInfo.message}
                        </span>
                      </div>
                    </div>
                    {statusInfo.isProcessing && (doc.job_id || ongoingJob?.jobId) ? (
                      // One single visual slot during processing: the progress
                      // ring with % in the middle, AND it's the abort affordance
                      // (click to stop). No more separate stop-button + circle
                      // duo. At 100 % the ring becomes a green check ("YES").
                      <button
                        type='button'
                        className='relative w-8 h-8 flex items-center justify-center shrink-0 hover:opacity-80 transition-opacity group'
                        onClick={e => handleAbortDocument(doc.id, doc.job_id || ongoingJob?.jobId, e)}
                        disabled={abortingDocIds.includes(doc.id)}
                        title={
                          abortingDocIds.includes(doc.id)
                            ? t('knowledge.uploader.aborting', 'Aborting…')
                            : jobProgress >= 100
                              ? t('knowledge.uploader.readyForSearch', 'Ready')
                              : t('knowledge.uploader.abortProcessing', 'Abort processing')
                        }
                      >
                        {abortingDocIds.includes(doc.id) ? (
                          <Loader2 className='h-4 w-4 animate-spin text-orange-500' />
                        ) : jobProgress >= 100 ? (
                          <Check className='h-5 w-5 text-green-500' />
                        ) : (
                          <>
                            <svg className='w-8 h-8' viewBox='0 0 36 36'>
                              <circle
                                cx='18'
                                cy='18'
                                r='16'
                                fill='none'
                                className='stroke-zinc-200 dark:stroke-zinc-700'
                                strokeWidth='3'
                              />
                              <circle
                                cx='18'
                                cy='18'
                                r='16'
                                fill='none'
                                className='stroke-blue-500 transition-all duration-300 group-hover:stroke-orange-500'
                                strokeWidth='3'
                                strokeDasharray='100'
                                strokeDashoffset={100 - Math.min(100, Math.max(0, jobProgress))}
                                strokeLinecap='round'
                                transform='rotate(-90 18 18)'
                              />
                            </svg>
                            <span className='absolute text-[10px] font-medium text-zinc-800 dark:text-white group-hover:hidden'>
                              {Math.min(100, Math.max(0, Math.round(jobProgress)))}%
                            </span>
                            <StopCircle className='absolute h-4 w-4 text-orange-500 hidden group-hover:block' />
                          </>
                        )}
                      </button>
                    ) : onDeleteDocument ? (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <button
                            className='w-7 h-7 flex items-center justify-center text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200 transition-colors'
                            onClick={e => e.stopPropagation()}
                          >
                            <MoreVertical className='h-4 w-4' />
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align='end' className='min-w-[160px] z-[1300]'>
                          {/* Retry for failed documents */}
                          {(processingStatus === ProcessingStatus.FAILED || jobStatus === JobStatus.FAILED) && (
                            <DropdownMenuItem
                              onClick={e => handleRetryDocument(doc.id, e as unknown as React.MouseEvent)}
                              disabled={retryingDocIds.includes(doc.id)}
                            >
                              {retryingDocIds.includes(doc.id) ? (
                                <Loader2 className='h-4 w-4 mr-2 animate-spin' />
                              ) : (
                                <RefreshCw className='h-4 w-4 mr-2' />
                              )}
                              {t('knowledge.uploader.retryProcessing', 'Retry processing')}
                            </DropdownMenuItem>
                          )}
                          {/* Retry graph build for failed/interrupted graph steps */}
                          {(statusInfo as { graphRetry?: boolean }).graphRetry && (
                            <DropdownMenuItem
                              onClick={async (e) => {
                                e.stopPropagation();
                                const ok = await buildDocumentGraph(doc.id, doc.collection_id);
                                toast(ok
                                  ? { title: t('knowledge.library.actionDispatched') }
                                  : { variant: 'destructive', title: t('knowledge.library.actionFailed') }
                                );
                                if (ok) onUploadComplete?.();
                              }}
                            >
                              <GitBranch className='h-4 w-4 mr-2' />
                              {t('knowledge.library.buildGraph', 'Build graph')}
                            </DropdownMenuItem>
                          )}
                          {/* Upload file for pending documents without a file on disk */}
                          {(processingStatus === ProcessingStatus.PENDING || jobStatus === JobStatus.PENDING) && !statusInfo.isProcessing && !hasFileOnDisk(doc) && !doc.id.startsWith('pending-') && (
                            <DropdownMenuItem
                              onClick={() => handleReuploadFile(doc.id)}
                              disabled={reuploadingDocId === doc.id}
                            >
                              {reuploadingDocId === doc.id ? (
                                <Loader2 className='h-4 w-4 mr-2 animate-spin' />
                              ) : (
                                <Upload className='h-4 w-4 mr-2' />
                              )}
                              {t('knowledge.uploader.uploadFile', 'Upload file')}
                            </DropdownMenuItem>
                          )}
                          {/* Process pending documents */}
                          {(processingStatus === ProcessingStatus.PENDING || jobStatus === JobStatus.PENDING) && !statusInfo.isProcessing && (
                            <DropdownMenuItem
                              onClick={e => void handleProcessDocument(doc.id, e as unknown as React.MouseEvent)}
                              disabled={processingDocIds.includes(doc.id)}
                            >
                              {processingDocIds.includes(doc.id) ? (
                                <Loader2 className='h-4 w-4 mr-2 animate-spin' />
                              ) : (
                                <Zap className='h-4 w-4 mr-2' />
                              )}
                              {t('knowledge.uploader.startProcessing', 'Start processing')}
                            </DropdownMenuItem>
                          )}
                          {/* Preview for PDF/EPUB/DOCX */}
                          {(() => {
                            const fileExt = doc.filename.split('.').pop()?.toLowerCase();
                            const isPreviewable = fileExt === 'pdf' || fileExt === 'epub' || fileExt === 'docx';
                            const isFailed = processingStatus === ProcessingStatus.FAILED || jobStatus === JobStatus.FAILED;
                            const isActivelyProcessing = processingStatus === ProcessingStatus.PROCESSING || jobStatus === JobStatus.PROCESSING;
                            const canPreview = isPreviewable && !isActivelyProcessing && !isFailed && hasFileOnDisk(doc);
                            return canPreview ? (
                              <DropdownMenuItem onClick={() => handlePreviewDocument(doc.id, doc.filename)}>
                                <Eye className='h-4 w-4 mr-2' />
                                {t('knowledge.downloadedBooks.preview', 'Preview')}
                              </DropdownMenuItem>
                            ) : null;
                          })()}
                          <DropdownMenuSeparator />
                          {/* Delete */}
                          <DropdownMenuItem
                            onClick={e => handleDeleteDocument(doc.id, e as unknown as React.MouseEvent)}
                            disabled={deletingDocIds.includes(doc.id)}
                            className='text-red-600 dark:text-red-400 focus:text-red-600 dark:focus:text-red-400'
                          >
                            {deletingDocIds.includes(doc.id) ? (
                              <Loader2 className='h-4 w-4 mr-2 animate-spin' />
                            ) : (
                              <Trash2 className='h-4 w-4 mr-2' />
                            )}
                            {t('knowledge.uploader.delete', 'Delete')}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    ) : null}
                  </div>
                  {shouldRenderSentinel && <div ref={loadMoreTriggerRef} className='h-1 w-full' aria-hidden='true' />}
                </div>
              );
            })}
              </>
            );
          })()}

          {/* Show empty state when no files, documents, OR ongoing jobs */}
          {!isLoading && files.length === 0 && sortedDocuments.length === 0 && ongoingJobs.length === 0 && (
            <div className='flex flex-col items-center justify-center py-4 text-center'>
              <p className='text-sm text-zinc-500 dark:text-zinc-400'>
                {t('knowledge.uploader.noFilesUploaded')}
              </p>
              <p className='text-xs text-zinc-400 dark:text-zinc-500 mt-1'>
                {t('knowledge.uploader.addFilesInstruction')}
              </p>
            </div>
          )}

          {/* Load More button (moved inside this div) */}
          {hasMore && onLoadMore && (
            <div className='mt-4 flex justify-center'>
              <button
                onClick={onLoadMore}
                disabled={isLoadingMore}
                className='text-sm text-zinc-600 dark:text-zinc-400 px-3 py-2 border border-zinc-300 dark:border-zinc-700 rounded hover:bg-zinc-100 dark:hover:bg-zinc-800'
              >
                {isLoadingMore ? (
                  <div className='flex items-center'>
                    <Loader2 className='h-4 w-4 animate-spin mr-2' />
                    <span>Loading more...</span>
                  </div>
                ) : (
                  'Load more files'
                )}
              </button>
            </div>
          )}
          </div>
        </div>

        {/* Abort Confirmation Dialog (placed near the end, inside main div) */}
        <AlertDialog
          open={isAbortConfirmationOpen}
          onOpenChange={setIsAbortConfirmationOpen}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t('knowledge.uploader.abortDialog.title')}</AlertDialogTitle>
              <AlertDialogDescription>
                {t('knowledge.uploader.abortDialog.description')}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel onClick={() => console.log('Abort cancelled.')}>
                {t('general.cancel')}
              </AlertDialogCancel>
              <AlertDialogAction
                onClick={() => confirmAbortUpload()}
                className='bg-destructive text-destructive-foreground hover:bg-destructive/90'
              >
                {t('knowledge.uploader.confirmAbort')}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        {/* Delete Confirmation Dialog */}
        <AlertDialog
          open={isDeleteConfirmationOpen}
          onOpenChange={(open) => {
            if (!open) {
              setIsDeleteConfirmationOpen(false);
              setDeletingDocumentId(null);
            }
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t('knowledge.uploader.deleteDialog.title', 'Delete Document?')}</AlertDialogTitle>
              <AlertDialogDescription>
                {t('knowledge.uploader.deleteDialog.description', 'Are you sure you want to delete this document? This action cannot be undone.')}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>
                {t('general.cancel', 'Cancel')}
              </AlertDialogCancel>
              <AlertDialogAction
                className='bg-red-600 hover:bg-red-700 dark:bg-red-600 dark:hover:bg-red-700 text-white'
                onClick={confirmDeleteDocument}
              >
                {t('general.delete', 'Delete')}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        {/* No File on Disk Dialog — offers to delete unprocessable documents */}
        <AlertDialog
          open={!!noFileDoc}
          onOpenChange={(open) => { if (!open) setNoFileDoc(null); }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t('knowledge.uploader.noFileDialog.title', 'Document cannot be processed')}</AlertDialogTitle>
              <AlertDialogDescription className='break-words'>
                <span className='mb-1 block break-all font-medium text-foreground'>{noFileDoc?.filename}</span>
                {t(
                  'knowledge.uploader.noFileDialog.description',
                  "Its original content is no longer available, so it can't be reprocessed. Delete it and upload the file again.",
                )}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>
                {t('general.keep', 'Keep')}
              </AlertDialogCancel>
              <AlertDialogAction
                className='bg-red-600 hover:bg-red-700 dark:bg-red-600 dark:hover:bg-red-700 text-white'
                onClick={async () => {
                  if (!noFileDoc) return;
                  try {
                    await deleteDocument(noFileDoc.id);
                    toast({
                      title: t('knowledge.uploader.documentDeleted', 'Document deleted'),
                      description: noFileDoc.filename,
                    });
                    if (onUploadComplete) onUploadComplete();
                  } catch (err: unknown) {
                    toast({
                      variant: 'destructive',
                      title: t('general.error', 'Error'),
                      description: err instanceof Error ? err.message : String(err),
                    });
                  }
                  setNoFileDoc(null);
                }}
              >
                {t('general.delete', 'Delete')}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    );
  };

export const KnowledgeFileUploader = forwardRef<
  KnowledgeFileUploaderRef,
  KnowledgeFileUploaderProps
>(KnowledgeFileUploaderComponent);

KnowledgeFileUploader.displayName = 'KnowledgeFileUploader';

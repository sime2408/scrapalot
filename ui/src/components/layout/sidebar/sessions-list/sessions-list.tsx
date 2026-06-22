import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Session } from '@/types';
import { ChevronsDown, Edit3, FolderInput, Loader2, Check, Copy, Link2, ArrowDownUp } from 'lucide-react';
import { uiState } from '@/lib/storage-utils';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from '@/lib/toast-compat';
import {
  deleteSession,
  listSessions,
  clearSessionsCache,
  renameSession,
  setSessionMarker,
  setSessionPin,
  sessionMarkerRank,
} from '@/lib/api-sessions';
import {
  createSessionShare,
  revokeSessionShare,
  getSessionShare,
  type SessionShareDTO,
} from '@/lib/api-session-shares';
import { useAuth } from '@/hooks/use-auth';
import { navigateToLogin } from '@/lib/navigation';
import { authState, apiClient } from '@/lib/api';
import { useTranslation } from 'react-i18next';

import { useNavigate } from 'react-router-dom';
import { SessionItem } from './session-item';
import type { SessionFolder } from '@/lib/api-session-folders';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

interface SessionFolderUpdate {
  sessionId: string;
  folderId: string | null;
  _ts: number;
}

interface SessionsListProps {
  selectedSessionId: string | null;
  onSelectSession: (session: Session) => void;
  onNewSession: () => void;
  refreshSessions?: (forceRefresh?: boolean) => Promise<void>;
  mobileMenuOpen?: boolean;
  onCloseMobileMenu?: () => void;
  // Folder support
  onSessionsLoaded?: (sessions: Session[]) => void;
  filterFn?: (session: Session) => boolean;
  isSecondaryList?: boolean;
  externalSessions?: Session[];
  folders?: SessionFolder[];
  onMoveSession?: (sessionId: string, targetFolderId: string | null) => Promise<void>;
  onSessionDeleted?: () => void;
  // Lift a pin toggle up to the parent so it can update its shared session list
  // (secondary/folder lists render from the parent's externalSessions, so their
  // own optimistic state change would otherwise be invisible).
  onSessionPinned?: (sessionId: string, pinned: boolean) => void;
  sessionFolderUpdate?: SessionFolderUpdate | null;
  // Pagination coordination between primary and secondary lists
  onLoadMoreReady?: (fn: () => void) => void; // Primary: expose loadMore to parent
  onHasMoreChange?: (hasMore: boolean) => void; // Primary: notify parent of hasMore state
  onTotalChange?: (total: number) => void;     // Primary: notify parent of total session count
  onRequestLoad?: () => void;                   // Secondary: request more data from primary
  hasMoreSessions?: boolean;                    // Secondary: whether primary has more pages
  refreshTrigger?: number;                      // Primary: increment to force re-fetch and re-sort
  hasFolders?: boolean;                         // Primary (unfiled): true when user has folders (affects page size)
}

export const SessionsList = ({
  selectedSessionId,
  onSelectSession,
  onNewSession,
  refreshSessions: _refreshSessions,
  mobileMenuOpen,
  onCloseMobileMenu,
  onSessionsLoaded,
  filterFn,
  isSecondaryList = false,
  externalSessions,
  folders = [],
  onMoveSession,
  onSessionDeleted,
  onSessionPinned,
  sessionFolderUpdate,
  onLoadMoreReady,
  onHasMoreChange,
  onTotalChange,
  onRequestLoad,
  hasMoreSessions = false,
  refreshTrigger,
  hasFolders = false,
}: SessionsListProps) => {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(!isSecondaryList); // Secondary lists don't load
  const [error, setError] = useState<string | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);
  const [initialLoad, setInitialLoad] = useState(!isSecondaryList);
  const [processingAction, setProcessingAction] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const [maxRetries] = useState(3);
  const [renameDialogOpen, setRenameDialogOpen] = useState(false);
  const [sessionToRename, setSessionToRename] = useState<Session | null>(null);
  const [newSessionName, setNewSessionName] = useState('');
  const [moveDialogOpen, setMoveDialogOpen] = useState(false);
  const [sessionToMove, setSessionToMove] = useState<Session | null>(null);
  const [targetFolderId, setTargetFolderId] = useState<string>('__unfiled__');
  const [shareDialogOpen, setShareDialogOpen] = useState(false);
  const [confirmDeleteSession, setConfirmDeleteSession] = useState<Session | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [sessionToShare, setSessionToShare] = useState<Session | null>(null);
  const [activeShare, setActiveShare] = useState<SessionShareDTO | null>(null);
  const [shareLoading, setShareLoading] = useState(false);
  const [shareCopied, setShareCopied] = useState(false);
  const { t } = useTranslation();
  const { isAuthenticated } = useAuth();
  const authReady = authState.authReady;

  const lastLoadTimeRef = useRef<number>(0);
  const MIN_LOAD_INTERVAL = 3000;
  const loadAttemptedRef = useRef<boolean>(false);
  const loadingRef = useRef<boolean>(false);
  const folderMoveCooldownRef = useRef<number>(0);

  // Container ref + resize tick — used to detect when the scroll
  // container has empty space below the rendered sessions and auto-
  // trigger "Load more". On tall viewports (1440p, ultra-wide,
  // expanded sidebar) the initial 20-item page leaves a gap; on
  // short viewports (laptops, split-screen) the page already
  // overflows and no auto-fill happens.
  const containerRef = useRef<HTMLDivElement>(null);
  const [resizeTick, setResizeTick] = useState(0);

  // Apply filter if provided — secondary lists use externalSessions from parent
  const sessionSource = externalSessions || sessions;
  const [sortByMarker, setSortByMarker] = useState<boolean>(() => uiState.get().sortSessionsByMarker ?? false);

  const toggleSortByMarker = useCallback(() => {
    setSortByMarker(prev => {
      const next = !prev;
      uiState.set({ sortSessionsByMarker: next });
      return next;
    });
  }, []);

  const displayedSessions = useMemo(() => {
    const base = filterFn ? sessionSource.filter(filterFn) : sessionSource;
    // Within-group order: marker priority (if the toggle is on) over recency.
    const ordered = sortByMarker
      ? [...base].sort((a, b) => sessionMarkerRank(a.marker_icon) - sessionMarkerRank(b.marker_icon))
      : base;
    // Pin tier sits ABOVE everything: pinned sessions float to the top of this
    // group (folder or unfiled) regardless of marker/recency. Stable partition
    // preserves each side's relative order.
    const pinned = ordered.filter(s => s.is_pinned);
    if (pinned.length === 0) return ordered;
    const rest = ordered.filter(s => !s.is_pinned);
    return [...pinned, ...rest];
  }, [sessionSource, filterFn, sortByMarker]);


  const setAuthTokenFromStorage = useCallback(() => {
    const storedTokens = localStorage.getItem('auth_tokens') || sessionStorage.getItem('auth_tokens');
    if (storedTokens) {
      try {
        const tokens = JSON.parse(storedTokens);
        if (tokens?.access_token) {
          apiClient.defaults.headers.common['Authorization'] = `Bearer ${tokens.access_token}`;
          return true;
        }
      } catch (e) {
        console.error('Error parsing tokens:', e);
      }
    }
    return false;
  }, []);

  const prepareSession = useCallback((session: Session): Session => {
    return {
      ...session,
      title: session.conversation_name || t('sessionsList.untitledSession'),
      createdAt: new Date(session.created_at),
      updatedAt: new Date(session.updated_at),
      modelId: session.model_name || '',
      messages: session.messages || [],
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are intentionally limited
  }, []);

  const loadSessions = useCallback(
    async (pageNum: number, reset = false, forceRefresh = false): Promise<boolean> => {
      // Secondary lists don't load their own data
      if (isSecondaryList) return false;

      const now = Date.now();
      if (!forceRefresh && now - lastLoadTimeRef.current < MIN_LOAD_INTERVAL) {
        return false;
      }

      if (loadingRef.current) {
        return false;
      }

      if (!hasMore && !reset) {
        return false;
      }

      lastLoadTimeRef.current = now;

      try {
        loadingRef.current = true;
        setLoading(true);
        setError(null);

        const justLoggedIn = sessionStorage.getItem('just_logged_in') === 'true';
        const lastTokenRefresh = parseInt(localStorage.getItem('last_token_refresh') || '0');
        const tokenRefreshTooRecent = now - lastTokenRefresh < 10000;

        if (
          localStorage.getItem('token_refresh_needed') === 'true' &&
          !justLoggedIn &&
          !tokenRefreshTooRecent
        ) {
          try {
            const { refreshToken } = await import('@/lib/api');
            const newTokens = await refreshToken();
            if (newTokens?.access_token) {
              localStorage.removeItem('token_refresh_needed');
              localStorage.setItem('last_token_refresh', now.toString());
            } else {
              setAuthTokenFromStorage();
            }
          } catch (refreshError) {
            console.warn('Token refresh error, continuing:', refreshError);
          }
        }

        const timeoutPromise = new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error('Sessions request timeout')), 30000);
        });

        let paginatedResponse;
        try {
          paginatedResponse = await Promise.race([
            listSessions(pageNum, 20, forceRefresh),
            timeoutPromise
          ]);
        } catch (timeoutError) {
          console.error('Sessions request timed out:', timeoutError);
          setError(t('sessionsList.errors.failedToLoad'));
          return false;
        }

        const sessions = paginatedResponse?.sessions;
        if (!sessions || !Array.isArray(sessions)) {
          setError(t('sessionsList.errors.invalidSessionsResponse'));
          return false;
        }

        const sessionsData = sessions.map(prepareSession);

        setSessions(prev => {
          if (reset) {
            return sessionsData.map(newSession => {
              const existing = prev.find(s => s.id === newSession.id);
              if (existing && existing.messages && existing.messages.length > 0) {
                return { ...newSession, messages: existing.messages, lastMessageFetchTime: existing.lastMessageFetchTime };
              }
              return newSession;
            });
          }
          const existingIds = new Set(prev.map(s => s.id));
          const newItems = sessionsData.filter(s => !existingIds.has(s.id));
          return [...prev, ...newItems];
        });

        setHasMore(pageNum < (paginatedResponse.totalPages || 1));
        onTotalChange?.(paginatedResponse.total || 0);
        setPage(reset ? 2 : pageNum + 1);
        setInitialLoad(false);
        setRetryCount(0);
        return true;
      } catch (error) {
        console.error('Error fetching sessions:', error);

        if (error.response && error.response.status === 401) {
          localStorage.setItem('token_refresh_needed', 'true');
          try {
            const { refreshToken } = await import('@/lib/api');
            const newTokens = await refreshToken();
            if (newTokens?.access_token) {
              localStorage.removeItem('token_refresh_needed');
              setRetryCount(0);
              setTimeout(() => loadSessions(pageNum, reset, true), 500);
              return false;
            }
          } catch (refreshError) {
            console.error('Token refresh error after 401:', refreshError);
          }
        }

        setError(t('sessionsList.errors.failedToLoad'));

        if (retryCount < maxRetries) {
          const nextRetryCount = retryCount + 1;
          setRetryCount(nextRetryCount);
          const retryDelay = Math.pow(2, nextRetryCount) * 1000;
          setTimeout(() => loadSessions(pageNum, reset, true), retryDelay);
        }
      } finally {
        loadingRef.current = false;
        setLoading(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are intentionally limited
    [hasMore, retryCount, maxRetries, prepareSession, setAuthTokenFromStorage, isSecondaryList]
  );

  // Notify parent of all loaded sessions
  useEffect(() => {
    if (onSessionsLoaded && sessions.length > 0) {
      onSessionsLoaded(sessions);
    }
  }, [sessions, onSessionsLoaded]);

  // Primary list: expose loadMore function to parent for external scroll triggers (global sentinel)
  useEffect(() => {
    if (isSecondaryList || !onLoadMoreReady) return;
    onLoadMoreReady(() => {
      if (!loadingRef.current && hasMore) {
        void loadSessions(page);
      }
    });
  }, [page, hasMore, loadSessions, isSecondaryList, onLoadMoreReady]);

  // Primary list: notify parent when hasMore changes
  useEffect(() => {
    if (isSecondaryList) return;
    onHasMoreChange?.(hasMore);
  }, [hasMore, isSecondaryList, onHasMoreChange]);

  // Per-list display limit: folders=20, unfiled=20 (no folders) or 10 (has folders)
  const LIST_PAGE_SIZE = isSecondaryList ? 20 : (hasFolders ? 10 : 20);
  const [displayLimit, setDisplayLimit] = useState(LIST_PAGE_SIZE);
  const prevPageSizeRef = useRef(LIST_PAGE_SIZE);
  useEffect(() => {
    if (prevPageSizeRef.current !== LIST_PAGE_SIZE) {
      prevPageSizeRef.current = LIST_PAGE_SIZE;
      setDisplayLimit(LIST_PAGE_SIZE);
    }
  }, [LIST_PAGE_SIZE]);
  const [loadMoreLoading, setLoadMoreLoading] = useState(false);

  // Sessions visible in this list (capped by displayLimit)
  const visibleSessions = displayedSessions.slice(0, displayLimit);

  // Show "Load more" when there are hidden local sessions OR backend has more pages
  const hasMoreToShow = isSecondaryList
    ? (displayLimit < displayedSessions.length || hasMoreSessions)
    : (displayLimit < displayedSessions.length || hasMore);

  const handleLoadMore = useCallback(() => {
    setDisplayLimit(prev => prev + LIST_PAGE_SIZE);
    if (isSecondaryList) {
      // Folder: if local sessions exhausted, request more from primary
      if (displayLimit >= displayedSessions.length && hasMoreSessions && onRequestLoad) {
        setLoadMoreLoading(true);
        onRequestLoad();
      }
    } else {
      // Unfiled: if local sessions exhausted, fetch next backend page
      if (displayLimit >= displayedSessions.length && hasMore && !loading) {
        setLoadMoreLoading(true);
        void loadSessions(page);
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are intentionally limited
  }, [displayLimit, displayedSessions.length, hasMoreSessions, onRequestLoad, isSecondaryList, hasMore, loading, loadSessions, page]);

  // Reset loading spinner when new data arrives
  useEffect(() => {
    setLoadMoreLoading(false);
  }, [displayedSessions.length]);

  // Auto-fill: detect when the scroll container has empty space below
  // the rendered sessions and chain "Load more" until the container is
  // full (or no more sessions exist). On a 1440p screen the initial 20-
  // item page leaves a noticeable gap below the list — the user has to
  // click "Load more" manually to fill it. This effect makes that
  // automatic by comparing scrollHeight (content) to clientHeight
  // (container's available height): when content fits inside the
  // container with room to spare, more pages are pulled.
  //
  // Termination: stops as soon as `hasMoreToShow` flips false (the
  // backend has nothing left) OR `scrollHeight > clientHeight` (the
  // list now overflows). loadSessions is called with `forceRefresh=true`
  // because the manual debounce (`MIN_LOAD_INTERVAL = 3 s`) would
  // otherwise block the immediate follow-up fetch right after the
  // initial page load — that debounce is meant to prevent rapid manual
  // re-clicks, not viewport-driven auto-fill.
  useEffect(() => {
    if (isSecondaryList) return;
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setResizeTick(t => t + 1));
    ro.observe(el);
    return () => ro.disconnect();
  }, [isSecondaryList]);

  useEffect(() => {
    if (isSecondaryList) return;
    if (initialLoad || loading || loadMoreLoading) return;
    if (!hasMoreToShow) return;
    if (!containerRef.current) return;
    // Defer one frame so React's commit + layout settles before we
    // measure scrollHeight; otherwise we read the previous render's
    // size and miscount the gap.
    const raf = requestAnimationFrame(() => {
      const e = containerRef.current;
      if (!e) return;
      // 4 px buffer absorbs sub-pixel rounding on fractional viewports.
      const isUnderfilled = e.scrollHeight <= e.clientHeight + 4;
      if (!isUnderfilled) return;
      setDisplayLimit(prev => prev + LIST_PAGE_SIZE);
      if (displayLimit >= displayedSessions.length && hasMore) {
        setLoadMoreLoading(true);
        void loadSessions(page, false, true);
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [
    isSecondaryList,
    initialLoad,
    loading,
    loadMoreLoading,
    hasMoreToShow,
    displayedSessions.length,
    displayLimit,
    hasMore,
    page,
    loadSessions,
    LIST_PAGE_SIZE,
    resizeTick,
  ]);

  // Apply folder updates from parent (drag-and-drop moves)
  useEffect(() => {
    if (!sessionFolderUpdate) return;
    // Suppress infinite scroll for 2s so shrinking the list doesn't trigger a load
    folderMoveCooldownRef.current = Date.now() + 2000;
    setSessions(prev =>
      prev.map(s =>
        s.id === sessionFolderUpdate.sessionId
          ? { ...s, session_folder_id: sessionFolderUpdate.folderId }
          : s
      )
    );
  }, [sessionFolderUpdate]);

  // Single consolidated useEffect for loading sessions (primary list only)
  useEffect(() => {
    if (isSecondaryList) return;

    let mounted = true;
    let timeoutId: NodeJS.Timeout;
    const loadingTimeoutId: NodeJS.Timeout = setTimeout(() => {
      if (mounted && loading && sessions.length === 0) {
        setLoading(false);
        setInitialLoad(false);
        loadAttemptedRef.current = false;
        loadingRef.current = false;
      }
    }, 10000);

    const loadData = async () => {
      if (loadAttemptedRef.current && sessions.length > 0) {
        const urlSessionMissing = selectedSessionId && !sessions.find(s => s.id === selectedSessionId);
        if (urlSessionMissing) {
          loadAttemptedRef.current = false;
        } else {
          setLoading(false);
          setInitialLoad(false);
          return;
        }
      }

      const hasTokens = !!(localStorage.getItem('auth_tokens') || sessionStorage.getItem('auth_tokens'));
      const justLoggedIn = sessionStorage.getItem('just_logged_in') === 'true';

      if (!hasTokens && !isAuthenticated && authReady && !justLoggedIn) {
        loadAttemptedRef.current = true;
        setInitialLoad(false);
        setLoading(false);
        return;
      }

      if (!authReady && !hasTokens && !justLoggedIn) {
        setLoading(true);
        return;
      }

      const canProceed = hasTokens || isAuthenticated || justLoggedIn;
      if (!canProceed) {
        timeoutId = setTimeout(() => {
          if (mounted && !sessions.length) {
            loadAttemptedRef.current = true;
            setInitialLoad(false);
            setLoading(false);
            setError('Authentication timeout. Please try refreshing the page.');
          }
        }, 10000);
        return;
      }

      if (sessions.length > 0) {
        const urlSessionMissing = selectedSessionId && !sessions.find(s => s.id === selectedSessionId);
        if (!urlSessionMissing) {
          setInitialLoad(false);
          setLoading(false);
          return;
        }
      }

      loadAttemptedRef.current = true;
      setLoading(true);

      try {
        if (!authState.authReady) {
          try {
            await authState.waitForAuthReady(2000);
          } catch (e) {
            // continue
          }
        }

        setAuthTokenFromStorage();
        const didLoad = await loadSessions(1, true, true);
        sessionStorage.removeItem('just_logged_in');

        if (mounted && didLoad) {
          setInitialLoad(false);
          setLoading(false);
        }
      } catch (error) {
        console.error('Error loading sessions:', error);
        if (error?.response?.status === 401) {
          setError(t('sessionsList.errors.sessionExpired'));
        } else {
          setError(t('sessionsList.errors.failedToLoad'));
        }
      } finally {
        if (mounted && !loadingRef.current) {
          setInitialLoad(false);
          setLoading(false);
        }
      }
    };

    const shouldLoad = !loadAttemptedRef.current || (loadAttemptedRef.current && sessions.length === 0);
    if (shouldLoad) {
      void loadData();
    }

    return () => {
      mounted = false;
      if (timeoutId) clearTimeout(timeoutId);
      if (loadingTimeoutId) clearTimeout(loadingTimeoutId);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are intentionally limited
  }, [isAuthenticated, authReady, sessions.length, loadSessions, apiClient, selectedSessionId, isSecondaryList]);

  // Reset load attempt flag when user logs out
  useEffect(() => {
    if (!isAuthenticated) {
      loadAttemptedRef.current = false;
      setSessions([]);
      setInitialLoad(!isSecondaryList);
    }
  }, [isAuthenticated, isSecondaryList]);

  // Auto-load when all sessions are in folders so the unfiled list is empty but
  // the backend still has more pages — folders need data to populate.
  useEffect(() => {
    if (isSecondaryList) return;
    if (Date.now() < folderMoveCooldownRef.current) return;
    if (displayedSessions.length === 0 && hasMore && !loading) {
      void loadSessions(page);
    }
  }, [hasMore, loading, page, displayedSessions.length, loadSessions, isSecondaryList]);

  // Re-fetch and re-sort when refreshTrigger increments (e.g. after chat response)
  const prevRefreshTriggerRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (isSecondaryList) return;
    if (refreshTrigger === undefined) return;
    if (prevRefreshTriggerRef.current === undefined) {
      prevRefreshTriggerRef.current = refreshTrigger;
      return;
    }
    if (refreshTrigger !== prevRefreshTriggerRef.current) {
      prevRefreshTriggerRef.current = refreshTrigger;

      // Optimistic re-sort: immediately move the active session to the top so the
      // sidebar updates without waiting for a round-trip to the backend.
      if (selectedSessionId) {
        setSessions(prev => {
          const idx = prev.findIndex(s => s.id === selectedSessionId);
          if (idx <= 0) return prev; // already at top or not found
          const moved = { ...prev[idx], updatedAt: new Date() };
          return [moved, ...prev.slice(0, idx), ...prev.slice(idx + 1)];
        });
      }

      // Clear cache and fetch fresh server data to confirm the final order.
      clearSessionsCache();
      void loadSessions(1, true, true);
    }
  }, [refreshTrigger, isSecondaryList, selectedSessionId, loadSessions]);


  // Deleting a conversation is irreversible (hard delete, messages
  // cascade) — the menu click only OPENS the confirmation; the actual
  // API call lives in performDeleteSession below.
  const handleDeleteSession = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const session = sessionSource.find(s => s.id === id);
    if (session) {
      setConfirmDeleteSession(session);
    }
  };

  const performDeleteSession = async () => {
    if (!confirmDeleteSession) return;
    const id = confirmDeleteSession.id;
    setDeleteLoading(true);
    setProcessingAction(id);
    try {
      await deleteSession(id);
      setSessions(prev => prev.filter(session => session.id !== id));
      onSessionDeleted?.();
      setConfirmDeleteSession(null);
      if (selectedSessionId === id) {
        navigate('/dashboard');
        onNewSession();
      }
    } catch (error) {
      console.error('Error deleting session:', error);
      toast({
        title: t('general.error'),
        description: t('sessionsList.errors.failedToDelete'),
        variant: 'destructive',
      });
    } finally {
      setDeleteLoading(false);
      setProcessingAction(null);
    }
  };

  // Shared between the primary and secondary list render branches.
  const deleteConfirmDialog = (
    <ConfirmDialog
      open={!!confirmDeleteSession}
      onOpenChange={open => {
        if (!open) setConfirmDeleteSession(null);
      }}
      title={t('sessionsList.deleteConfirmTitle', 'Delete conversation?')}
      description={t('sessionsList.deleteConfirmDescription', {
        name:
          confirmDeleteSession?.conversation_name ||
          t('sessionsList.untitledSession'),
      })}
      confirmLabel={t('common.delete', 'Delete')}
      onConfirm={performDeleteSession}
      isDangerous
      isLoading={deleteLoading}
      confirmButtonTestId='sidebar-session-delete-confirm'
    />
  );

  const handleCloneSession = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    toast({
      title: t('sessionsList.comingSoon.title'),
      description: t('sessionsList.comingSoon.clone'),
    });
  };

  const handleShareSession = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const session = sessionSource.find(s => s.id === id);
    if (!session) return;
    setSessionToShare(session);
    setShareDialogOpen(true);
    setShareLoading(true);
    setActiveShare(null);
    setShareCopied(false);
    try {
      const existing = await getSessionShare(id);
      setActiveShare(existing);
    } catch {
      // No active share — that's fine
    } finally {
      setShareLoading(false);
    }
  };

  const handleSetMarker = async (id: string, icon: string | null, color: string | null) => {
    // Optimistic update so the marker appears instantly; revert label on failure.
    setSessions(prev => prev.map(s => (s.id === id ? { ...s, marker_icon: icon, marker_color: color } : s)));
    try {
      await setSessionMarker(id, icon, color);
    } catch (error) {
      console.error('Error setting session marker:', error);
      toast({ title: t('general.error'), description: t('sessionsList.markers.error'), variant: 'destructive' });
    }
  };

  const handleTogglePin = async (id: string, pinned: boolean) => {
    // Optimistic update so the pin floats/sinks instantly. The local setSessions
    // covers the primary list; onSessionPinned lifts it to the parent so folder
    // (secondary) lists — which render from externalSessions — update too.
    setSessions(prev => prev.map(s => (s.id === id ? { ...s, is_pinned: pinned } : s)));
    onSessionPinned?.(id, pinned);
    try {
      await setSessionPin(id, pinned);
    } catch (error) {
      console.error('Error toggling session pin:', error);
      setSessions(prev => prev.map(s => (s.id === id ? { ...s, is_pinned: !pinned } : s)));
      onSessionPinned?.(id, !pinned);
      toast({ title: t('general.error'), description: t('sessionsList.pin.error'), variant: 'destructive' });
    }
  };

  const handleCreateShare = async () => {
    if (!sessionToShare) return;
    setShareLoading(true);
    try {
      const share = await createSessionShare(sessionToShare.id);
      setActiveShare(share);
      toast({ title: t('general.success'), description: t('share.created') });
    } catch (error) {
      console.error('Error creating share:', error);
      toast({ title: t('general.error'), description: t('share.errorCreating'), variant: 'destructive' });
    } finally {
      setShareLoading(false);
    }
  };

  const handleRevokeShare = async () => {
    if (!sessionToShare) return;
    setShareLoading(true);
    try {
      await revokeSessionShare(sessionToShare.id);
      setActiveShare(null);
      toast({ title: t('general.success'), description: t('share.revoked') });
    } catch (error) {
      console.error('Error revoking share:', error);
      toast({ title: t('general.error'), description: t('share.errorRevoking'), variant: 'destructive' });
    } finally {
      setShareLoading(false);
    }
  };

  const handleCopyShareLink = async () => {
    if (!activeShare) return;
    const baseUrl = window.location.origin;
    const url = `${baseUrl}/shared/${activeShare.share_token}`;
    await navigator.clipboard.writeText(url);
    setShareCopied(true);
    setTimeout(() => setShareCopied(false), 2000);
  };

  const handleEditSession = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const session = sessionSource.find(s => s.id === id);
    if (session) {
      setSessionToRename(session);
      setNewSessionName(session.conversation_name || session.title || '');
      setRenameDialogOpen(true);
    }
  };

  const handleRenameSubmit = async () => {
    if (!sessionToRename || !newSessionName.trim()) return;
    setProcessingAction(sessionToRename.id);
    try {
      const updatedSession = await renameSession(sessionToRename.id, newSessionName.trim());
      setSessions(prev =>
        prev.map(session =>
          session.id === sessionToRename.id
            ? { ...session, conversation_name: updatedSession.conversation_name, title: updatedSession.conversation_name }
            : session
        )
      );
      toast({
        title: t('general.success'),
        description: t('sessionsList.success.renamed'),
      });
      setRenameDialogOpen(false);
      setSessionToRename(null);
      setNewSessionName('');
    } catch (error) {
      console.error('Error renaming session:', error);
      toast({
        title: t('general.error'),
        description: t('sessionsList.errors.failedToRename'),
        variant: 'destructive',
      });
    } finally {
      setProcessingAction(null);
    }
  };

  const handleMoveSession = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (onMoveSession && folders.length > 0) {
      const session = sessionSource.find(s => s.id === id);
      if (session) {
        setSessionToMove(session);
        setTargetFolderId(session.session_folder_id || '__unfiled__');
        setMoveDialogOpen(true);
      }
    } else if (!folders.length) {
      toast({
        title: t('sessionFolders.noFolders'),
        description: t('sessionFolders.createFolderFirst'),
      });
    }
  };

  const handleMoveSubmit = async () => {
    if (!sessionToMove || !onMoveSession) return;
    const folderId = targetFolderId === '__unfiled__' ? null : targetFolderId;
    await onMoveSession(sessionToMove.id, folderId);
    // Update local state
    setSessions(prev =>
      prev.map(s => s.id === sessionToMove.id ? { ...s, session_folder_id: folderId } : s)
    );
    setMoveDialogOpen(false);
    setSessionToMove(null);
  };

  // For secondary lists: don't show loading/error states, just show filtered items
  if (isSecondaryList) {
    if (displayedSessions.length === 0) {
      return (
        <div className='sessions-list py-1 px-4'>
          <p className='text-xs text-zinc-400 dark:text-zinc-500'>{t('sessionsList.noSessionsFound')}</p>
        </div>
      );
    }

    return (
      <div className='sessions-list py-1' data-testid="sidebar-sessions-folder-list">
        <ul className='mb-2' role='list'>
          {visibleSessions.map(session => (
            <li key={session.id}>
              <SessionItem
                session={session}
                isSelected={selectedSessionId === session.id}
                processingAction={processingAction}
                onSelectSession={onSelectSession}
                onDeleteSession={handleDeleteSession}
                onCloneSession={handleCloneSession}
                onEditSession={handleEditSession}
                onMoveSession={handleMoveSession}
                onShareSession={handleShareSession}
                onSetMarker={handleSetMarker}
                onTogglePin={handleTogglePin}
                mobileMenuOpen={mobileMenuOpen}
                onCloseMobileMenu={onCloseMobileMenu}
              />
            </li>
          ))}
        </ul>

        {/* Per-folder "Load more" button */}
        {hasMoreToShow && (
          <button
            data-testid="sidebar-sessions-folder-load-more"
            onClick={handleLoadMore}
            disabled={loadMoreLoading}
            className='w-full py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors flex items-center justify-center gap-1 disabled:opacity-50'
          >
            {loadMoreLoading ? (
              <Loader2 className='h-3 w-3 animate-spin' />
            ) : (
              <ChevronsDown className='h-3 w-3' />
            )}
            {t('sessionsList.loadMore')}
          </button>
        )}

        {deleteConfirmDialog}

        {/* Move Session Dialog (secondary) */}
        <Dialog open={moveDialogOpen} onOpenChange={setMoveDialogOpen}>
          <DialogContent dialogOpen={moveDialogOpen} onOpenChange={setMoveDialogOpen} data-testid="sidebar-session-move-dialog">
            <DialogHeader>
              <div className='flex items-center gap-3'>
                <div className='p-2 bg-primary/10 text-primary'>
                  <FolderInput className='h-5 w-5' />
                </div>
                <div>
                  <DialogTitle>{t('sessionFolders.moveToFolder')}</DialogTitle>
                  <DialogDescription>{t('sessionFolders.moveToFolderDescription')}</DialogDescription>
                </div>
              </div>
            </DialogHeader>
            <div className='py-4'>
              <Label className='text-sm font-medium mb-2 block'>{t('sessionFolders.selectFolder')}</Label>
              <Select value={targetFolderId} onValueChange={setTargetFolderId}>
                <SelectTrigger data-testid="sidebar-session-move-folder-select">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value='__unfiled__'>{t('sessionFolders.unfiled')}</SelectItem>
                  {folders.map(f => (
                    <SelectItem key={f.id} value={f.id}>{f.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <DialogFooter>
              <Button variant='outline' onClick={() => setMoveDialogOpen(false)} data-testid="sidebar-session-move-cancel">
                {t('general.cancel')}
              </Button>
              <Button onClick={handleMoveSubmit} data-testid="sidebar-session-move-submit">
                {t('sessionFolders.move')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Rename Session Dialog (secondary) */}
        <Dialog open={renameDialogOpen} onOpenChange={setRenameDialogOpen}>
          <DialogContent dialogOpen={renameDialogOpen} onOpenChange={setRenameDialogOpen} disableFullscreenOnMobile data-testid="sidebar-session-rename-dialog">
            <DialogHeader>
              <div className='flex items-center gap-3'>
                <div className='p-2 bg-primary/10 text-primary'>
                  <Edit3 className='h-5 w-5' />
                </div>
                <div>
                  <DialogTitle>{t('sessionsList.renameSession')}</DialogTitle>
                  <DialogDescription>{t('sessionsList.renameSessionDescription')}</DialogDescription>
                </div>
              </div>
            </DialogHeader>
            <div className='py-4'>
              <Label htmlFor='session-name-sec' className='text-sm font-medium mb-2 block'>
                {t('sessionsList.sessionName')}
              </Label>
              <Input
                id='session-name-sec'
                data-testid="sidebar-session-rename-input"
                value={newSessionName}
                onChange={e => setNewSessionName(e.target.value)}
                placeholder={t('sessionsList.enterSessionName')}
                onKeyDown={e => { if (e.key === 'Enter') void handleRenameSubmit(); }}
              />
            </div>
            <DialogFooter>
              <Button variant='outline' onClick={() => { setRenameDialogOpen(false); setSessionToRename(null); setNewSessionName(''); }} data-testid="sidebar-session-rename-cancel">
                {t('sessionsList.cancel')}
              </Button>
              <Button onClick={handleRenameSubmit} disabled={!newSessionName.trim() || processingAction === sessionToRename?.id} data-testid="sidebar-session-rename-submit">
                {processingAction === sessionToRename?.id ? t('sessionsList.renaming') : t('sessionsList.rename')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    );
  }

  return (
    <div ref={containerRef} className='sessions-list overflow-y-auto py-2 flex-1' data-testid="sidebar-sessions-list">
      {(loading || initialLoad) && displayedSessions.length === 0 ? (
        <div className='flex flex-col items-center justify-center py-2 px-4 text-zinc-500 dark:text-zinc-400'>
          <p className='text-sm'>{t('sessionsList.loadingSessions')}</p>
        </div>
      ) : error ? (
        <div className='flex flex-col items-center justify-center py-6 px-4 text-zinc-500 dark:text-red-300'>
          <p className='text-sm mb-2'>{error}</p>
          <div className='flex flex-col gap-2 w-full'>
            <button
              data-testid="sidebar-sessions-retry-button"
              className='text-sm py-1.5 bg-violet-100 text-violet-700 hover:bg-violet-200 dark:bg-violet-900/30 dark:text-violet-300 dark:hover:bg-violet-900/50 transition-colors'
              onClick={() => loadSessions(1, true)}
            >
              {t('sessionsList.retryLoading')}
            </button>
            <button
              data-testid="sidebar-sessions-login-button"
              className='text-sm py-1.5 bg-transparent border border-zinc-300 text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800/50 transition-colors'
              onClick={() => navigateToLogin()}
            >
              {t('sessionsList.goToLoginPage')}
            </button>
          </div>
        </div>
      ) : displayedSessions.length === 0 ? (
        <div className='flex flex-col items-center justify-center px-4 text-zinc-500 dark:text-zinc-400'>
          <p className='text-sm'>{t('sessionsList.noSessionsFound')}</p>
        </div>
      ) : (
        <>
          {!isSecondaryList && (
            <div className='px-2 pb-1 flex justify-end'>
              <button
                type='button'
                data-testid='sidebar-sessions-sort-marker'
                onClick={toggleSortByMarker}
                title={t('sessionsList.markers.sortByMarker')}
                className={`inline-flex items-center gap-1 px-1.5 py-0.5 text-xs transition-colors ${sortByMarker ? 'text-primary' : 'text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200'}`}
              >
                <ArrowDownUp className='h-3 w-3' />
                <span>{t('sessionsList.markers.sortByMarker')}</span>
              </button>
            </div>
          )}
          <ul className='mb-2' role='list'>
            {visibleSessions.map(session => (
              <li key={session.id}>
                <SessionItem
                  session={session}
                  isSelected={selectedSessionId === session.id}
                  processingAction={processingAction}
                  onSelectSession={onSelectSession}
                  onDeleteSession={handleDeleteSession}
                  onCloneSession={handleCloneSession}
                  onEditSession={handleEditSession}
                  onMoveSession={handleMoveSession}
                  onShareSession={handleShareSession}
                  onSetMarker={handleSetMarker}
                  onTogglePin={handleTogglePin}
                  mobileMenuOpen={mobileMenuOpen}
                  onCloseMobileMenu={onCloseMobileMenu}
                />
              </li>
            ))}
          </ul>
        </>
      )}

      {/* Primary list "Load more" button */}
      {hasMoreToShow && !initialLoad && (
        <button
          data-testid="sidebar-sessions-load-more"
          onClick={handleLoadMore}
          disabled={loadMoreLoading}
          className='w-full py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors flex items-center justify-center gap-1 disabled:opacity-50'
        >
          {loadMoreLoading ? (
            <Loader2 className='h-3 w-3 animate-spin' />
          ) : (
            <ChevronsDown className='h-3 w-3' />
          )}
          {t('sessionsList.loadMore')}
        </button>
      )}

      {deleteConfirmDialog}

      {/* Rename Session Dialog */}
      <Dialog open={renameDialogOpen} onOpenChange={setRenameDialogOpen}>
        <DialogContent dialogOpen={renameDialogOpen} onOpenChange={setRenameDialogOpen} disableFullscreenOnMobile data-testid="sidebar-session-rename-dialog-primary">
          <DialogHeader>
            <div className='flex items-center gap-3'>
              <div className='p-2 bg-primary/10 text-primary'>
                <Edit3 className='h-5 w-5' />
              </div>
              <div>
                <DialogTitle>{t('sessionsList.renameSession')}</DialogTitle>
                <DialogDescription>{t('sessionsList.renameSessionDescription')}</DialogDescription>
              </div>
            </div>
          </DialogHeader>
          <div className='py-4'>
            <Label htmlFor='session-name' className='text-sm font-medium mb-2 block'>
              {t('sessionsList.sessionName')}
            </Label>
            <Input
              id='session-name'
              data-testid="sidebar-session-rename-input-primary"
              value={newSessionName}
              onChange={e => setNewSessionName(e.target.value)}
              placeholder={t('sessionsList.enterSessionName')}
              onKeyDown={e => { if (e.key === 'Enter') void handleRenameSubmit(); }}
            />
          </div>
          <DialogFooter>
            <Button variant='outline' onClick={() => { setRenameDialogOpen(false); setSessionToRename(null); setNewSessionName(''); }} data-testid="sidebar-session-rename-cancel-primary">
              {t('sessionsList.cancel')}
            </Button>
            <Button onClick={handleRenameSubmit} disabled={!newSessionName.trim() || processingAction === sessionToRename?.id} data-testid="sidebar-session-rename-submit-primary">
              {processingAction === sessionToRename?.id ? t('sessionsList.renaming') : t('sessionsList.rename')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Move Session Dialog */}
      <Dialog open={moveDialogOpen} onOpenChange={setMoveDialogOpen}>
        <DialogContent dialogOpen={moveDialogOpen} onOpenChange={setMoveDialogOpen} data-testid="sidebar-session-move-dialog-primary">
          <DialogHeader>
            <div className='flex items-center gap-3'>
              <div className='p-2 bg-primary/10 text-primary'>
                <FolderInput className='h-5 w-5' />
              </div>
              <div>
                <DialogTitle>{t('sessionFolders.moveToFolder')}</DialogTitle>
                <DialogDescription>{t('sessionFolders.moveToFolderDescription')}</DialogDescription>
              </div>
            </div>
          </DialogHeader>
          <div className='py-4'>
            <Label className='text-sm font-medium mb-2 block'>{t('sessionFolders.selectFolder')}</Label>
            <Select value={targetFolderId} onValueChange={setTargetFolderId}>
              <SelectTrigger data-testid="sidebar-session-move-folder-select-primary">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value='__unfiled__'>{t('sessionFolders.unfiled')}</SelectItem>
                {folders.map(f => (
                  <SelectItem key={f.id} value={f.id}>{f.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button variant='outline' onClick={() => setMoveDialogOpen(false)} data-testid="sidebar-session-move-cancel-primary">
              {t('general.cancel')}
            </Button>
            <Button onClick={handleMoveSubmit} data-testid="sidebar-session-move-submit-primary">
              {t('sessionFolders.move')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Share Session Dialog */}
      <Dialog open={shareDialogOpen} onOpenChange={setShareDialogOpen}>
        <DialogContent dialogOpen={shareDialogOpen} onOpenChange={setShareDialogOpen} disableFullscreenOnMobile data-testid="sidebar-session-share-dialog">
          <DialogHeader>
            <div className='flex items-center gap-3'>
              <div className='p-2 border border-border text-primary bg-primary/5 dark:bg-primary/10'>
                <Link2 className='h-5 w-5' />
              </div>
              <div>
                <DialogTitle>{t('share.title')}</DialogTitle>
                <DialogDescription className='text-xs mt-0.5'>{t('share.description')}</DialogDescription>
              </div>
            </div>
          </DialogHeader>
          <div className='py-3'>
            {shareLoading ? (
              <div className='flex items-center justify-center py-6'>
                <Loader2 className='h-5 w-5 animate-spin text-muted-foreground' />
              </div>
            ) : activeShare ? (
              <div className='space-y-3'>
                <div className='flex items-center gap-2'>
                  <Input
                    readOnly
                    value={`${window.location.origin}/shared/${activeShare.share_token}`}
                    className='flex-1 text-sm font-mono'
                    data-testid="share-link-input"
                  />
                  <Button
                    size='sm'
                    variant='outline'
                    onClick={handleCopyShareLink}
                    data-testid="share-copy-button"
                  >
                    {shareCopied ? <Check className='h-4 w-4' /> : <Copy className='h-4 w-4' />}
                  </Button>
                </div>
                <p className='text-xs text-muted-foreground'>
                  {t('share.messageCount', { count: activeShare.message_snapshot_count })}
                </p>
              </div>
            ) : (
              <div className='flex items-start gap-3 p-3 border border-border bg-muted/30 dark:bg-muted/10'>
                <Link2 className='h-4 w-4 mt-0.5 text-muted-foreground shrink-0' />
                <p className='text-sm text-muted-foreground leading-snug'>{t('share.noActiveShare')}</p>
              </div>
            )}
          </div>
          <DialogFooter>
            {activeShare ? (
              <Button
                variant='destructive'
                onClick={handleRevokeShare}
                disabled={shareLoading}
                data-testid="share-revoke-button"
              >
                {t('share.revoke')}
              </Button>
            ) : (
              <Button
                onClick={handleCreateShare}
                disabled={shareLoading}
                data-testid="share-create-button"
              >
                {t('share.create')}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

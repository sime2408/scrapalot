import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import axios from 'axios';
import { DocumentCollection } from '@/types';
import { getCollections, CollectionSortBy, CollectionSortOrder } from '@/lib/api-collections';
import { useWorkspace } from '@/hooks/use-workspace';
import { useAuth } from '@/hooks/use-auth';
import { useLocation } from 'react-router-dom';

interface CollectionsContextType {
  collections: DocumentCollection[];
  loading: boolean;
  error: string | null;
  hasMore: boolean;
  page: number;
  totalCollections: number;
  sortBy: CollectionSortBy;
  sortOrder: CollectionSortOrder;
  refreshCollections: () => Promise<void>;
  loadMoreCollections: () => Promise<void>;
  fetchCollectionsPage: (page: number, append?: boolean) => Promise<void>;
  updateCollectionInState: (collectionId: string, updates: Partial<DocumentCollection>) => void;
  addCollectionToState: (collection: DocumentCollection) => void;
  removeCollectionFromState: (collectionId: string) => void;
  setSortBy: (sortBy: CollectionSortBy) => void;
  setSortOrder: (sortOrder: CollectionSortOrder) => void;
  setSort: (sortBy: CollectionSortBy, sortOrder: CollectionSortOrder) => void;
}

const CollectionsContext = createContext<CollectionsContextType | undefined>(undefined);

export const CollectionsProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [collections, setCollections] = useState<DocumentCollection[]>([]);
  const [loading, setLoading] = useState(false);
  const [_loadingMore, setLoadingMore] = useState(false);
  const loadingMoreRef = React.useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [page, setPage] = useState(1);
  const [totalCollections, setTotalCollections] = useState(0);
  const [sortBy, setSortByState] = useState<CollectionSortBy>('name');
  const [sortOrder, setSortOrderState] = useState<CollectionSortOrder>('asc');
  const { currentWorkspace, isLoading: workspaceLoading } = useWorkspace();
  const { isAuthenticated } = useAuth();
  const location = useLocation();

  // Helper function to check if current route requires collections data
  const isProtectedRoute = useCallback(() => {
    const protectedPaths = ['/dashboard', '/workspaces'];
    return protectedPaths.some(path => location.pathname.startsWith(path));
  }, [location.pathname]);

  const fetchCollectionsPage = useCallback(async (pageNum: number, append: boolean = false) => {
    try {
      // Wait for workspace to load before proceeding
      if (workspaceLoading) {
        return;
      }

      // Check if we have a valid workspace ID
      if (!currentWorkspace?.id) {
        return;
      }

      // Synchronous guard to prevent duplicate concurrent "load more" calls
      if (append) {
        if (loadingMoreRef.current) {
          return;
        }
        loadingMoreRef.current = true;
        setLoadingMore(true);
      } else {
        setLoading(true);
      }

      const workspaceId = currentWorkspace.id;
      const response = await getCollections(workspaceId, pageNum, 500, sortBy, sortOrder);
      if (response && response.collections) {
        const { collections: newCollections, pagination } = response;

        if (append) {
          setCollections(prev => [...prev, ...newCollections]);
        } else {
          setCollections(newCollections);
        }

        setHasMore(pagination?.has_more || false);
        setTotalCollections(pagination?.total || newCollections.length);
        setPage(pageNum);
        setError(null);
      }
    } catch (err) {
      console.error('Error fetching collections:', err);
      // Don't set error state if it's a network error (backend down)
      // This allows public pages to work without backend
      const isNetworkError = axios.isAxiosError(err) && err.code === 'ERR_NETWORK';
      if (!isNetworkError) {
        setError('Failed to load collections');
      }
      // Silently fail for network errors to allow public pages to work
    } finally {
      setLoading(false);
      setLoadingMore(false);
      loadingMoreRef.current = false;
    }
  }, [currentWorkspace?.id, workspaceLoading, sortBy, sortOrder]);

  const refreshCollections = useCallback(async () => {
    await fetchCollectionsPage(1, false);
  }, [fetchCollectionsPage]);

  const loadMoreCollections = useCallback(async () => {
    if (hasMore && !loading && !loadingMoreRef.current) {
      await fetchCollectionsPage(page + 1, true);
    }
  }, [hasMore, loading, page, fetchCollectionsPage]);

  // Optimistically update a collection in local state (for instant UI feedback)
  const updateCollectionInState = useCallback((collectionId: string, updates: Partial<DocumentCollection>) => {
    setCollections(prev =>
      prev.map(col =>
        col.id === collectionId
          ? { ...col, ...updates }
          : col
      )
    );
  }, []);

  // Optimistically add a new collection to local state (for instant UI feedback)
  const addCollectionToState = useCallback((collection: DocumentCollection) => {
    setCollections(prev => {
      // Check if collection already exists to avoid duplicates
      const exists = prev.some(col => col.id === collection.id);
      if (exists) {
        return prev;
      }
      // Add to beginning of array so it appears at the top
      return [collection, ...prev];
    });
    // Increment total count
    setTotalCollections(prev => prev + 1);
  }, []);

  // Optimistically remove a collection and all its descendants from local state
  const removeCollectionFromState = useCallback((collectionId: string) => {
    setCollections(prev => {
      // Collect IDs to remove: the collection + all descendants (CASCADE delete on backend)
      const idsToRemove = new Set<string>([collectionId]);
      let changed = true;
      while (changed) {
        changed = false;
        for (const col of prev) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- API may return snake_case before camelCase normalization
          const parentId = col.parentCollectionId || (col as any).parent_collection_id;
          if (parentId && idsToRemove.has(parentId) && !idsToRemove.has(col.id)) {
            idsToRemove.add(col.id);
            changed = true;
          }
        }
      }
      return prev.filter(col => !idsToRemove.has(col.id));
    });
    setTotalCollections(prev => Math.max(0, prev - 1));
  }, []);

  // Sort setters that trigger re-fetch
  const setSortBy = useCallback((newSortBy: CollectionSortBy) => {
    setSortByState(newSortBy);
  }, []);

  const setSortOrder = useCallback((newSortOrder: CollectionSortOrder) => {
    setSortOrderState(newSortOrder);
  }, []);

  const setSort = useCallback((newSortBy: CollectionSortBy, newSortOrder: CollectionSortOrder) => {
    setSortByState(newSortBy);
    setSortOrderState(newSortOrder);
  }, []);

  // Preload collections when workspace changes or sort changes (only on protected routes)
  useEffect(() => {
    const isProtected = isProtectedRoute();

    console.log('🔄 [CollectionsContext] useEffect triggered', {
      isProtected,
      currentWorkspaceId: currentWorkspace?.id || 'null',
      workspaceLoading,
      sortBy,
      sortOrder,
    });

    // Only fetch collections on protected routes (like /dashboard)
    // Public routes (like /home) should not trigger API calls
    if (!isProtected) {
      console.log('🔄 [CollectionsContext] Public route, skipping fetch');
      setLoading(false);
      return;
    }

    // Wait for authentication before making API calls
    if (!isAuthenticated) {
      console.log('🔄 [CollectionsContext] Not authenticated, skipping fetch');
      return;
    }

    if (currentWorkspace?.id && !workspaceLoading) {
      console.log('🔄 [CollectionsContext] Fetching collections for workspace:', currentWorkspace.id);
      void fetchCollectionsPage(1, false);
    } else {
      console.log('🔄 [CollectionsContext] Waiting for workspace...', {
        hasWorkspaceId: !!currentWorkspace?.id,
        workspaceLoading,
      });
    }
  }, [currentWorkspace?.id, workspaceLoading, fetchCollectionsPage, isProtectedRoute, isAuthenticated, sortBy, sortOrder]);

  // Listen for cache cleared event and refresh collections
  useEffect(() => {
    // Check if window is available (SSR guard)
    if (typeof window === 'undefined') return;

    const handleCacheCleared = () => {
      void refreshCollections();
    };

    window.addEventListener('scrapalot:cache-cleared', handleCacheCleared);
    return () => window.removeEventListener('scrapalot:cache-cleared', handleCacheCleared);
  }, [refreshCollections]);

  const value = {
    collections,
    loading,
    error,
    hasMore,
    page,
    totalCollections,
    sortBy,
    sortOrder,
    refreshCollections,
    loadMoreCollections,
    fetchCollectionsPage,
    updateCollectionInState,
    addCollectionToState,
    removeCollectionFromState,
    setSortBy,
    setSortOrder,
    setSort,
  };

  return (
    <CollectionsContext.Provider value={value}>
      {children}
    </CollectionsContext.Provider>
  );
};

// eslint-disable-next-line react-refresh/only-export-components -- co-located with component for cohesion
export const useCollections = () => {
  const context = useContext(CollectionsContext);
  if (context === undefined) {
    // During HMR (hot module reload), context might be temporarily unavailable
    // Check if we're in development mode and provide a safe fallback
    if (import.meta.env.DEV) {
      console.warn('useCollections: CollectionsContext not available (possibly during HMR). Using fallback values.');
      // Return a safe fallback during HMR to prevent crashes
      return {
        collections: [],
        loading: false,
        error: null,
        hasMore: false,
        page: 1,
        totalCollections: 0,
        sortBy: 'name' as CollectionSortBy,
        sortOrder: 'asc' as CollectionSortOrder,
        refreshCollections: async () => {},
        loadMoreCollections: async () => {},
        fetchCollectionsPage: async () => {},
        updateCollectionInState: () => {},
        addCollectionToState: () => {},
        removeCollectionFromState: () => {},
        setSortBy: () => {},
        setSortOrder: () => {},
        setSort: () => {},
      } as CollectionsContextType;
    }
    throw new Error('useCollections must be used within a CollectionsProvider');
  }
  return context;
};

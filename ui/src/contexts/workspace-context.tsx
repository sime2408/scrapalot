import React, {
  createContext,
  ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import axios from 'axios';
import {
  getDefaultWorkspace,
  setSelectedWorkspace,
  Workspace,
} from '@/lib/api-workspace';
import { useAuth } from '@/hooks/use-auth';
import { uiState } from '@/lib/storage-utils';
import { authState } from '@/lib/api';
import { useLocation } from 'react-router-dom';

// Define the shape of the workspace context
export interface WorkspaceContextType {
  currentWorkspace: Workspace | null;
  isLoading: boolean;
  error: string | null;
  selectWorkspace: (workspaceId: string) => Promise<boolean>;
  refreshWorkspace: () => Promise<void>;
}

// Create the context with a default value
export const WorkspaceContext = createContext<WorkspaceContextType | undefined>(
  undefined
);

// Create provider component
interface WorkspaceProviderProps {
  children: ReactNode;
}

export const WorkspaceProvider: React.FC<WorkspaceProviderProps> = ({
  children,
}) => {
  const [currentWorkspace, setCurrentWorkspace] = useState<Workspace | null>(
    null
  );
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [authReady, setAuthReady] = useState(authState.authReady);

  const { isAuthenticated, isOfflineMode, user } = useAuth();
  const userId = (user as { id?: string } | null)?.id;
  const lastFetchTime = useRef<number>(0);
  const isMounted = useRef(true);
  const workspaceLoadedRef = useRef(false);
  const location = useLocation();

  // Helper function to check if current route requires workspace data
  const isProtectedRoute = useCallback(() => {
    const protectedPaths = ['/dashboard', '/workspaces'];
    return protectedPaths.some(path => location.pathname.startsWith(path));
  }, [location.pathname]);

  // Debounce a mechanism to prevent multiple calls in a short period
  const loadWorkspaceDebounced = useCallback(
    async (forceRefresh = false) => {
      const now = Date.now();
      const minInterval = 5000; // 5 seconds between API calls

      // Skip if we recently fetched and aren't forcing a refresh
      if (!forceRefresh && now - lastFetchTime.current < minInterval) {
        return;
      }

      setIsLoading(true);
      setError(null);

      try {
        // First check consolidated storage — scoped to the current user so a
        // previous user's workspace on a shared device is ignored (the cache
        // miss falls through to the per-user getDefaultWorkspace below).
        const storedWorkspace = uiState.getCurrentWorkspace(userId);
        if (storedWorkspace) {
          if (
            isMounted.current &&
            (!currentWorkspace || currentWorkspace.id !== storedWorkspace.id)
          ) {
            setCurrentWorkspace(storedWorkspace);
          }
        }

        // In offline mode, we rely only on localStorage
        if (isOfflineMode) {
          setIsLoading(false);
          return;
        }

        // Don't make API calls if auth is not ready (prevents 401 errors).
        // Do NOT update lastFetchTime — allow retry once auth becomes ready.
        if (!authState.authReady) {
          if (storedWorkspace) {
            setIsLoading(false);
          }
          return;
        }

        // Auth is ready — mark fetch time only when we actually call the backend
        lastFetchTime.current = now;

        // Auth is ready - validate workspace with backend
        // If workspace is already in storage and validated, and we're not forcing refresh, we can skip
        if (storedWorkspace && !forceRefresh && currentWorkspace?.id === storedWorkspace.id) {
          setIsLoading(false);
          return;
        }

        // Use the cached version if available (the function internally handles caching)
        const workspace = await getDefaultWorkspace(forceRefresh);

        // Only update if the workspace has changed
        if (
          isMounted.current &&
          (!currentWorkspace || currentWorkspace.id !== workspace.id)
        ) {
          setCurrentWorkspace(workspace);
          uiState.setCurrentWorkspace(workspace, userId);
        }
      } catch (err) {
        console.error('Failed to load workspace:', err);

        // Check if it's a 404 error (workspace doesn't exist in backend)
        const is404Error = axios.isAxiosError(err) && err.response?.status === 404;
        if (is404Error) {
          console.warn('⚠️ Workspace not found in backend (404), clearing cached workspace');
          // Clear the invalid workspace from localStorage
          uiState.setCurrentWorkspace(null);
          setCurrentWorkspace(null);

          // Try to fetch a new default workspace (backend will create one)
          try {
            const newWorkspace = await getDefaultWorkspace(true);
            if (isMounted.current) {
              setCurrentWorkspace(newWorkspace);
              uiState.setCurrentWorkspace(newWorkspace, userId);
            }
          } catch (retryErr) {
            console.error('❌ Failed to fetch new workspace:', retryErr);
            if (isMounted.current) {
              setError('Failed to load workspace');
            }
          }
        } else {
          // Don't set error state if it's a network error (backend down)
          // This allows public pages to work without backend
          const isNetworkError = axios.isAxiosError(err) && err.code === 'ERR_NETWORK';
          if (isMounted.current && !isNetworkError) {
            setError('Failed to load workspace');
          }
          // Silently fail for network errors to allow public pages to work
        }
      } finally {
        if (isMounted.current) {
          setIsLoading(false);
        }
      }
    },
    [currentWorkspace, isOfflineMode, userId]
  );

  // Refresh workspace function (used by cache clear event handler)
  const refreshWorkspace = useCallback(async (): Promise<void> => {
    if (isOfflineMode) return;
    await loadWorkspaceDebounced(true); // Force refresh
  }, [isOfflineMode, loadWorkspaceDebounced]);

  // Cleanup effect to prevent memory leaks
  useEffect(() => {
    isMounted.current = true;
    return () => {
      isMounted.current = false;
    };
  }, []);

  // Listen for auth-ready events to ensure we only load workspace when auth is fully ready
  useEffect(() => {
    const handleAuthReady = () => {
      setAuthReady(true);
    };

    const handleWorkspaceLoaded = (event: CustomEvent) => {
      const workspace = event.detail;
      if (workspace) {
        setCurrentWorkspace(workspace);
        setIsLoading(false);
      }
    };

    // Set the initial state
    setAuthReady(authState.authReady);

    // Listen for auth-ready and workspace-loaded events
    window.addEventListener('auth-ready', handleAuthReady);
    window.addEventListener('workspace-loaded', handleWorkspaceLoaded as EventListener);

    return () => {
      window.removeEventListener('auth-ready', handleAuthReady);
      window.removeEventListener('workspace-loaded', handleWorkspaceLoaded as EventListener);
    };
  }, []);

  // Load workspace on mount and when authentication becomes ready
  useEffect(() => {
    const isProtected = isProtectedRoute();
    const storedWorkspace = uiState.getCurrentWorkspace(userId);

    // Load workspace from backend if no cached version and auth is ready
    if (
      !storedWorkspace &&
      authReady &&
      !workspaceLoadedRef.current &&
      !isOfflineMode
    ) {
      workspaceLoadedRef.current = true;
      void loadWorkspaceDebounced();
      return;
    }

    if (isProtected) {
      // Immediately set workspace from localStorage for dependent contexts
      if (
        storedWorkspace &&
        !currentWorkspace &&
        isMounted.current &&
        currentWorkspace?.id !== storedWorkspace.id
      ) {
        setCurrentWorkspace(storedWorkspace);
      }

      // Async load from backend to validate/sync
      if (!workspaceLoadedRef.current || (authReady && !currentWorkspace)) {
        workspaceLoadedRef.current = true;
        void loadWorkspaceDebounced();
      }
    } else {
      if (
        storedWorkspace &&
        isMounted.current &&
        currentWorkspace?.id !== storedWorkspace.id
      ) {
        setCurrentWorkspace(storedWorkspace);
      }
      setIsLoading(false);
    }

  // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are intentionally limited
  }, [authReady, isAuthenticated, userId, location.pathname, isOfflineMode, loadWorkspaceDebounced, isProtectedRoute]);

  // Separate effect to clear workspace on logout
  useEffect(() => {
    if (!isAuthenticated && authReady) {
      // User logged out - clear workspace
      setCurrentWorkspace(null);
      setIsLoading(false);
      workspaceLoadedRef.current = false;
    }
  }, [isAuthenticated, authReady]);

  // Listen for cache cleared event and refresh workspace
  useEffect(() => {
    // Check if window is available (SSR guard)
    if (typeof window === 'undefined') return;

    const handleCacheCleared = () => {
      void refreshWorkspace();
    };

    window.addEventListener('scrapalot:cache-cleared', handleCacheCleared);
    return () => window.removeEventListener('scrapalot:cache-cleared', handleCacheCleared);
  }, [refreshWorkspace]);

  const selectWorkspace = async (workspaceId: string): Promise<boolean> => {
    if (isOfflineMode) {
      setError('Cannot change workspace in offline mode');
      return false;
    }

    // Check if the workspace is already the current workspace
    if (currentWorkspace && currentWorkspace.id === workspaceId) {
      return true; // Return success since the workspace is already selected
    }

    setIsLoading(true);
    setError(null);

    try {
      const success = await setSelectedWorkspace(workspaceId);
      if (success) {
        await loadWorkspaceDebounced(true); // Force refresh on workspace change
        return true;
      }
      return false;
    } catch (err) {
      console.error('Failed to select workspace:', err);
      // Don't set error state if it's a network error (backend down)
      const isNetworkError = axios.isAxiosError(err) && err.code === 'ERR_NETWORK';
      if (!isNetworkError) {
        setError('Failed to select workspace');
      }
      return false;
    } finally {
      setIsLoading(false);
    }
  };

  const value = {
    currentWorkspace,
    isLoading,
    error,
    selectWorkspace,
    refreshWorkspace,
  };

  return (
    <WorkspaceContext.Provider value={value}>
      {children}
    </WorkspaceContext.Provider>
  );
};

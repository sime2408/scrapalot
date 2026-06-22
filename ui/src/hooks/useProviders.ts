import { useCallback, useEffect, useRef, useState, useMemo } from 'react';
import { useAuth } from './use-auth';
import {
  getModelProviders,
  createModelProvider,
  deleteModelProvider,
  updateModelProvider,
} from '@/lib/api-settings';
import { RemoteProvider, ProviderStatus } from '@/types/settings-types';
import { formatProvider, formatProviderForApi } from "@/lib/provider-utils";
import { ModelProviderApiResponse } from "@/types/provider-types";
import { Model } from '@/types';

// Global state to prevent duplicate requests
let globalFetchPromise: Promise<RemoteProvider[]> | null = null;
let globalProviders: RemoteProvider[] = [];
let globalLastFetch = 0;
const CACHE_TTL = 30000; // 30 seconds cache

// Global cache clearing function
export const clearProviderCache = () => {
  globalProviders = [];
  globalLastFetch = 0;
  globalFetchPromise = null;

};

/**
 * Unified hook for managing providers and models
 * Serves both chat interface (flat models) and settings interface (provider objects)
 * Eliminates duplication and race conditions between ModelsContext and useModelProviders
 */
export function useProviders() {
  const { isAuthenticated, isLoading: authLoading } = useAuth();
  // Initialize from global cache to prevent empty state flash when multiple hook instances exist
  const [providers, setProviders] = useState<RemoteProvider[]>(() => globalProviders);
  const [loading, setLoading] = useState(() => globalProviders.length === 0);
  const [error, setError] = useState<string | null>(null);
  const hasFetchedRef = useRef(false);
  const fetchInProgress = false;

  // Derived state for chat interface - flat array of all models (excluding embedding models)
  const models = useMemo<Model[]>(() => {
    const result = providers.flatMap(provider =>
      (provider.models || [])
        .filter(model => model.model_type !== 'EMBEDDING')
        .map(model => ({
          ...model,
          // Use the model's actual ID, not a composite ID
          id: model.id,
          name: model.display_name || model.model_name,
          provider: provider.name,
          provider_id: provider.id,
          provider_type: provider.provider_type
        }))
    );

    if (result.length > 0) {
      // Providers with models found
    }

    return result;
  }, [providers]);

  // Derived state for pagination info
  const providerPagination = useMemo(() => {
    const paginationState: Record<string, { page: number; loading: boolean; hasMore: boolean; totalModels: number; }> = {};
    providers.forEach(provider => {
      if (provider.pagination) {
        paginationState[provider.id] = {
          page: provider.pagination.current_page,
          loading: false,
          hasMore: provider.pagination.has_more,
          totalModels: provider.pagination.total_models
        };
      }
    });
    return paginationState;
  }, [providers]);

  // Fetch all providers with deduplication and caching
  const fetchProviders = useCallback(async (forceRefresh = false) => {
    // Don't fetch if explicitly not authenticated AND no tokens exist
    // Allow fetching in dev mode where tokens exist but isAuthenticated might be stuck at false
    const hasTokens = !!localStorage.getItem('auth_tokens') || !!sessionStorage.getItem('auth_tokens');

    if (isAuthenticated === false && !hasTokens) {
      // console.log('⏭️ useProviders: Skipping fetch - not authenticated and no tokens');
      setLoading(false);
      return;
    }

    // If auth is still loading, don't start fetching yet (unless we have tokens)
    if (authLoading && !hasTokens) {
      // console.log('⏳ useProviders: Waiting for auth to complete');
      return;
    }

    if (hasTokens && isAuthenticated === false) {
      // console.log('🔓 useProviders: Fetching despite isAuthenticated=false because tokens exist (dev mode)');
    }

    // Check cache first (unless force refresh)
    const now = Date.now();
    if (!forceRefresh && globalProviders.length > 0 && (now - globalLastFetch) < CACHE_TTL) {
      setProviders(globalProviders);
      setLoading(false);
      return;
    }

    // If there's already a global fetch in progress, wait for it
    if (globalFetchPromise) {
      setLoading(true);
      try {
        const data = await globalFetchPromise;
        setProviders(data);
      } catch (err) {
        console.error('Error waiting for providers:', err);
        setError('Failed to fetch providers');
      } finally {
        setLoading(false);
      }
      return;
    }

    // Start new fetch
    setLoading(true);
    setError(null);

    // Add timeout to prevent hanging
    globalFetchPromise = Promise.race([
      getModelProviders(1, 50), // Reduced limit to prevent timeout
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('getModelProviders timeout after 15 seconds')), 15000)
      )
    ]);

    try {
      const data = await globalFetchPromise;

      globalProviders = data;
      globalLastFetch = now;
      setProviders(data);


      // console.log('🔍 Unified useProviders: Extracted',
      //   data.flatMap(p => p.models || []).length, 'total models');

      // Check if providers exist but have no models - trigger auto-sync
      const totalModels = data.flatMap(p => p.models || []).length;
      if (totalModels === 0 && data.length > 0) {


        // Auto-attempt to trigger sync for active providers with 0 models
        void Promise.all(
          data
            .filter(provider => provider.status === 'active' && provider.pagination?.total_models === 0)
            .map(async (provider) => {
              try {
                await updateModelProvider(provider.id, {
                  name: provider.name,
                  status: provider.status, // Keep same status to trigger sync
                  provider_type: provider.provider_type,
                });
              } catch (error) {
                console.warn(`❌ Failed to trigger sync for ${provider.name}:`, error);
              }
            })
        );

        // Show user-friendly message
        import('@/lib/toast-compat').then(({ toast }) => {
          toast({
            title: "No Models Available - Sync Required",
            description: "Providers are configured but models need to be synced from APIs. Automatic sync has been triggered.",
            variant: "warning",
            duration: 10000
          });
        }).catch(console.error);
      }

    } catch (err) {
      console.error('Error fetching providers:', err);

      // Handle specific error types
      if (err instanceof Error) {
        // For timeout errors
        if (err.message.includes('timeout')) {
          console.error('⏰ Unified useProviders: API timeout - setting empty providers to prevent stuck loading');
          setProviders([]);
          setError('API timeout - using cached data');

          import('@/lib/toast-compat').then(({ toast }) => {
            toast({
              title: "API Timeout",
              description: "The providers API is taking too long to respond. Using cached data or empty state.",
              variant: "warning"
            });
          }).catch(console.error);
        }
        // For connection errors
        else if (err.name === 'ConnectionError' || err.message.includes('Backend server not responding')) {
          setError('Backend server not responding');
          // Note: Not showing toast to user - backend unavailability is handled by the UI state
        } else {
          setError(err.message || 'Failed to fetch providers');
        }
      } else {
        setError('Failed to fetch providers');
      }
    } finally {
      setLoading(false);
      globalFetchPromise = null; // Clear the promise
    }
  }, [isAuthenticated, authLoading]);

  // Create a new provider
  const addProvider = useCallback(async (provider: Partial<RemoteProvider>) => {
    try {
      setLoading(true);
      setError(null);

      // Format for API and create provider
      const formattedForApi = formatProviderForApi(provider);
      const response = await createModelProvider(formattedForApi);

      // Convert the response back to RemoteProvider format
      const newProvider = formatProvider(response as ModelProviderApiResponse);

      // Update local state and global cache
      const updatedProviders = [...providers, newProvider];
      setProviders(updatedProviders);
      globalProviders = updatedProviders;
      globalLastFetch = Date.now();

      // Trigger ChatModelSelector refresh after provider addition
      const { uiState } = await import('@/lib/storage-utils');
      uiState.requestChatModelSelectorRefresh();

      return newProvider;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to create provider';
      setError(message);
      console.error('Failed to create provider', err);
      throw err;
    } finally {
      setLoading(false);
    }
  }, [providers]);

  // Update an existing provider
  const updateProvider = useCallback(
    async (id: string, provider: Partial<RemoteProvider>) => {
      try {
        setLoading(true);
        setError(null);

        // Format for API and update provider
        const formattedForApi = formatProviderForApi(provider);
        const response = await updateModelProvider(id, formattedForApi);

        // Convert response back to RemoteProvider format
        const formattedProvider = formatProvider(
          response as ModelProviderApiResponse
        );

        // Update local state and global cache
        const updatedProviders = providers.map(p => (p.id === id ? formattedProvider : p));
        setProviders(updatedProviders);
        globalProviders = updatedProviders;
        globalLastFetch = Date.now();

        // Trigger ChatModelSelector refresh after provider update
        const { uiState } = await import('@/lib/storage-utils');
        uiState.requestChatModelSelectorRefresh();

        return formattedProvider;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Failed to update provider';
        setError(message);
        console.error('Failed to update provider', err);
        throw err;
      } finally {
        setLoading(false);
      }
    },
    [providers]
  );

  // Delete a provider
  const deleteProvider = useCallback(async (id: string) => {
    try {
      setLoading(true);
      setError(null);

      // Call the delete API
      await deleteModelProvider(id);

      // Update local state and global cache by removing the provider
      const updatedProviders = providers.filter(p => p.id !== id);
      setProviders(updatedProviders);
      globalProviders = updatedProviders;
      globalLastFetch = Date.now();

      return true;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to delete provider';
      setError(message);
      console.error('Failed to delete provider', err);
      throw err;
    } finally {
      setLoading(false);
    }
  }, [providers]);

  // Toggle provider status (active/disabled)
  const toggleProviderStatus = useCallback(
    async (id: string) => {
      // Find the provider
      const provider = providers.find(p => p.id === id);
      if (!provider) {
        const message = `Provider with id ${id} not found`;
        setError(message);
        console.error('Failed to toggle provider status', message);
        throw new Error(message);
      }

      try {
        // Toggle status
        const newStatus =
          provider.status === ProviderStatus.ACTIVE
            ? ProviderStatus.DISABLED
            : ProviderStatus.ACTIVE;

        // Update with new status
        return await updateProvider(id, { status: newStatus });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Failed to toggle provider status';
        setError(message);
        console.error('Failed to toggle provider status', err);
        throw err;
      }
    },
    [providers, updateProvider]
  );

  // Toggle provider show_models flag
  const toggleProviderShowModels = useCallback(
    async (id: string) => {
      // Find the provider
      const provider = providers.find(p => p.id === id);
      if (!provider) {
        const message = `Provider with id ${id} not found`;
        setError(message);
        console.error('Failed to toggle show models', message);
        throw new Error(message);
      }

      try {
        // Toggle showModels
        return await updateProvider(id, { show_models: !provider.show_models });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Failed to toggle show models';
        setError(message);
        console.error('Failed to toggle show models', err);
        throw err;
      }
    },
    [providers, updateProvider]
  );

  // Get providers by type
  const getProvidersByType = useCallback(
    (type: string) => {
      return providers.filter(p => p.provider_type === type);
    },
    [providers]
  );

  // Get active providers
  const getActiveProviders = useCallback(() => {
    return providers.filter(p => p.status === ProviderStatus.ACTIVE);
  }, [providers]);

  // Refresh models (alias for fetchProviders with force refresh)
  const refreshModels = useCallback(async () => {
    await fetchProviders(true);
  }, [fetchProviders]);

  // Emergency function to force loading state to complete
  const forceCompleteLoading = useCallback(() => {

    setLoading(false);
    setProviders([]);
  }, []);

  // Load providers when authentication is ready
  useEffect(() => {
    // Check for tokens in addition to isAuthenticated to handle dev mode hot reload
    const hasTokens = !!localStorage.getItem('auth_tokens') || !!sessionStorage.getItem('auth_tokens');

    if ((isAuthenticated === true || hasTokens) && !authLoading) {
      // Auth is ready and user is authenticated OR tokens exist (dev mode)

      // First, check if global cache has data we can use immediately
      if (providers.length === 0 && globalProviders.length > 0) {
        console.log('🔄 useProviders: Using global cache (%d providers)', globalProviders.length);
        setProviders(globalProviders);
        setLoading(false);
        hasFetchedRef.current = true;
        return; // Don't need to fetch, cache is fresh
      }

      if (!hasFetchedRef.current || providers.length === 0) {
        void fetchProviders();
        hasFetchedRef.current = true;
      } else {
        // Providers already loaded, ensure loading is false
        setLoading(false);
      }
    } else if (isAuthenticated === false && !authLoading && !hasTokens) {
      // Only reset state when explicitly not authenticated AND no tokens exist
      setProviders([]);
      setLoading(false);
      setError(null);
      hasFetchedRef.current = false; // Reset fetch flag when logged out
    } else if (authLoading) {
      // If auth is loading, set loading to true but don't fetch yet
      setLoading(true);
    }
  }, [isAuthenticated, authLoading, fetchProviders, providers.length]); // fetchProviders included to re-trigger on auth change

  // Retry fallback: if auth is ready but models are still empty after 3 seconds, retry once
  useEffect(() => {
    if (!isAuthenticated || authLoading) return;

    const retryTimer = setTimeout(() => {
      if (globalProviders.length === 0 && !globalFetchPromise) {
        console.warn('useProviders: No models loaded after 3s, retrying fetch');
        hasFetchedRef.current = false;
        void fetchProviders(true);
      }
    }, 3000);

    return () => clearTimeout(retryTimer);
  }, [isAuthenticated, authLoading, fetchProviders]);

  // Make emergency function available globally for debugging
  useEffect(() => {
    (window as unknown as Record<string, unknown>).forceCompleteProvidersLoading = forceCompleteLoading;
    return () => {
      delete (window as unknown as Record<string, unknown>).forceCompleteProvidersLoading;
    };
  }, [forceCompleteLoading]);

  return {
    // Provider data (for settings interface)
    providers,
    loading,
    error,
    fetchInProgress,

    // Model data (for chat interface) - derived from providers
    models,
    modelsLoading: loading, // Alias for chat components
    modelsLoaded: !loading && providers.length >= 0, // Computed state
    providerPagination,

    // Operations
    fetchProviders,
    refreshModels,
    addProvider,
    updateProvider,
    deleteProvider,
    toggleProviderStatus,
    toggleProviderShowModels,
    getProvidersByType,
    getActiveProviders,

    // Emergency functions
    forceCompleteLoading,
  };
}

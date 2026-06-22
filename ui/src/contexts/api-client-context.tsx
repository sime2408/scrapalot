import React, { createContext, useContext, ReactNode, useEffect } from 'react';
import { api, apiClient, authState } from '@/lib/api';
import { useAuth } from '@/hooks/use-auth';

// Create a context for the API client
const ApiClientContext = createContext(apiClient);

interface ApiClientProviderProps {
  children: ReactNode;
}

// Provider component that wraps parts of the app that need access to the API client
export const ApiClientProvider: React.FC<ApiClientProviderProps> = ({
  children,
}) => {
  const { isAuthenticated, tokens, isLoading } = useAuth();

  // Sync auth state with API client - use a debounced approach to prevent multiple rapid updates
  useEffect(() => {
    // Skip if auth is still loading or tokens are undefined
    if (isLoading || tokens === undefined) {
      return;
    }

    // Update auth ready state
    authState.setAuthReady(isAuthenticated);

    // Update API headers when tokens change
    if (tokens?.access_token) {
      apiClient.defaults.headers.common['Authorization'] =
        `Bearer ${tokens.access_token}`;
    } else if (!isAuthenticated) {
      // Clear auth header when not authenticated
      delete apiClient.defaults.headers.common['Authorization'];
    }
  }, [isAuthenticated, tokens, isLoading]);

  return (
    <ApiClientContext.Provider value={apiClient}>
      {children}
    </ApiClientContext.Provider>
  );
};

// Hook to use the API client
export const useApiClient = () => {
  const context = useContext(ApiClientContext);
  if (context === undefined) {
    // During HMR (hot module reload), context might be temporarily unavailable
    // Check if we're in development mode and provide a safe fallback
    if (import.meta.env.DEV) {
      console.warn('useApiClient: ApiClientContext not available (possibly during HMR). Using fallback values.');
      // Return the apiClient directly as fallback during HMR to prevent crashes
      return apiClient;
    }
    throw new Error('useApiClient must be used within an ApiClientProvider');
  }
  return context;
};

// Export the API instance directly for non-component usage
// eslint-disable-next-line react-refresh/only-export-components -- co-located with component for cohesion
export { api, apiClient };

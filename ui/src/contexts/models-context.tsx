import React, { createContext, useContext } from 'react';
import { Model } from '@/types';
import { useProviders } from '@/hooks/useProviders';
import { useAuth } from '@/hooks/use-auth';

// Define pagination info type that supports both snake_case (backend) and camelCase (frontend)
interface PaginationInfo {
  page?: number;
  current_page?: number;
  loading?: boolean;
  hasMore?: boolean;
  has_more?: boolean;
  totalModels?: number;
  total_models?: number;
  models_per_page?: number;
}

// Define the context type - now simplified since it's just a wrapper around useProviders
interface ModelsContextType {
  availableModels: Model[];
  isLoading: boolean;
  error: string | null;
  modelsLoaded: boolean;
  providerPagination: Record<string, PaginationInfo>;
  refreshModels: () => Promise<void>;
}

// Create the context
const ModelsContext = createContext<ModelsContextType | undefined>(undefined);

// Custom hook to use the models context
// eslint-disable-next-line react-refresh/only-export-components -- co-located with component for cohesion
export const useModels = (): ModelsContextType => {
  const context = useContext(ModelsContext);
  if (!context) {
    // During HMR (Hot Module Replacement), context might be temporarily unavailable
    // Return default values instead of throwing to prevent app crashes
    console.warn('useModels: ModelsContext not available (possibly during HMR). Using fallback values.');
    return {
      availableModels: [],
      isLoading: true,
      error: null,
      modelsLoaded: false,
      providerPagination: {},
      refreshModels: async () => {},
    };
  }
  return context;
};

interface ModelsProviderProps {
  children: React.ReactNode;
}

export const ModelsProvider: React.FC<ModelsProviderProps> = ({ children }) => {
  // useAuth() must be called unconditionally (Rules of Hooks).
  // Returns a safe fallback when AuthProvider is not in the tree.
  useAuth();

  // useProviders must always be called (Rules of Hooks).
  const {
    models,
    modelsLoading,
    modelsLoaded,
    error,
    providerPagination,
    refreshModels,
  } = useProviders();

  const value: ModelsContextType = {
    availableModels: models,
    isLoading: modelsLoading,
    error,
    modelsLoaded,
    providerPagination,
    refreshModels,
  };

  return (
    <ModelsContext.Provider value={value}>
      {children}
    </ModelsContext.Provider>
  );
};

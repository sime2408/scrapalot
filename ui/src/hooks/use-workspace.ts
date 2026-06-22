import { useContext } from 'react';
import {
  WorkspaceContext,
  WorkspaceContextType,
} from '@/contexts/workspace-context';

// Export the hook for using the workspace context
export const useWorkspace = (): WorkspaceContextType => {
  const context = useContext(WorkspaceContext);
  if (!context) {
    // During HMR (hot module reload), context might be temporarily unavailable
    // Check if we're in development mode and provide a safe fallback
    if (import.meta.env.DEV) {
      console.warn('useWorkspace: WorkspaceContext not available (possibly during HMR). Using fallback values.');
      // Return a safe fallback during HMR to prevent crashes
      return {
        currentWorkspace: null,
        isLoading: false,
        error: null,
        selectWorkspace: async () => false,
        refreshWorkspace: async () => {},
      } as WorkspaceContextType;
    }
    throw new Error('useWorkspace must be used within a WorkspaceProvider');
  }
  return context;
};

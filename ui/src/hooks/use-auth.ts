import { useContext } from 'react';
import { AuthContext, AuthContextType } from '@/contexts/auth-context';

const AUTH_FALLBACK: AuthContextType = {
  user: null,
  tokens: null,
  isLoading: true,
  error: null,
  authError: null,
  isAuthenticated: false,
  isOfflineMode: false,
  backendUnavailable: false,
  login: async () => false,
  loginWithGoogle: async () => false,
  logout: () => {},
  getAuthHeader: () => ({ Authorization: '' }),
  enableOfflineMode: () => {},
  ensureModelsLoaded: async () => {},
  refreshUser: async () => {},
  authState: {
    isReady: false,
    user: null,
    token: null,
    waitForAuthReady: async () => {},
  },
} as unknown as AuthContextType;

// Export the hook for using the auth context.
// Returns a safe fallback when AuthProvider is not in the tree
// (during route transitions, HMR, or component unmount/remount cycles).
// This avoids throwing exceptions that would break the Rules of Hooks
// when consumers wrap useAuth() in try-catch blocks.
export const useAuth = (): AuthContextType => {
  const context = useContext(AuthContext);
  if (!context) {
    if (import.meta.env.DEV) {
      console.warn('useAuth: AuthContext not available (possibly during HMR). Using fallback values.');
    }
    return AUTH_FALLBACK;
  }
  return context;
};

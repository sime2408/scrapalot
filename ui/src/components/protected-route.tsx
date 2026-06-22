import React, { useEffect, useState } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '@/hooks/use-auth';
import { useTranslation } from 'react-i18next';
import { I18nextProvider } from 'react-i18next';
import i18n from '@/i18n';
import { isDesktopMode, isDesktopAuthInitialized, isDesktopCloudMode, isCloudMode } from '@/lib/desktop-auth';
import { navigateToLogin } from '@/lib/navigation';

// Error boundary component for catching React errors
class ProtectedRouteErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean; error?: Error }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error(
      'ProtectedRoute Error Boundary caught an error:',
      error,
      errorInfo
    );
    // Store error details for debugging
    try {
      localStorage.setItem('last_protected_route_error', JSON.stringify({
        message: error.message,
        stack: error.stack,
        componentStack: errorInfo.componentStack,
        timestamp: Date.now()
      }));
    } catch (e) {
      console.error('Failed to store error details:', e);
    }
  }

  render() {
    if (this.state.hasError) {
      return (
        <I18nextProvider i18n={i18n}>
          <div className='flex flex-col items-center justify-center min-h-screen'>
            <div className='text-red-500 text-center'>
              <h2 className='text-xl font-bold mb-2'>Something went wrong</h2>
              <p className='mb-4'>
                Please refresh the page or try logging in again.
              </p>
              {this.state.error && (
                <details className='mb-4 text-sm'>
                  <summary className='cursor-pointer text-red-600 hover:text-red-800'>Show Error Details</summary>
                  <pre className='mt-2 p-2 bg-red-50 dark:bg-red-900/20 text-left text-xs overflow-auto max-h-32'>
                    {this.state.error.message}
                  </pre>
                </details>
              )}
              <button
                onClick={() => window.location.reload()}
                className='px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600'
              >
                Refresh Page
              </button>
            </div>
          </div>
        </I18nextProvider>
      );
    }

    return this.props.children;
  }
}

interface ProtectedRouteProps {
  children: React.ReactNode;
}

const ProtectedRouteInner: React.FC<ProtectedRouteProps> = ({ children }) => {
  const location = useLocation();
  const { t } = useTranslation();
  const [loadingTooLong, setLoadingTooLong] = useState(false);
  const [authCheckComplete, setAuthCheckComplete] = useState(false);
  const [retryCountdown, setRetryCountdown] = useState<number | null>(null);
  const [redirectAttempts, setRedirectAttempts] = useState(0);
  const [isTransitioning, setIsTransitioning] = useState(false);
  const [contextRetryCount, setContextRetryCount] = useState(0);
  const MAX_REDIRECT_ATTEMPTS = 3;
  const MAX_CONTEXT_RETRIES = 5;

  // useAuth() returns a safe fallback when AuthProvider is not in the tree,
  // so no try-catch needed (avoids Rules of Hooks violations).
  const authContext = useAuth();

  // Extract auth values safely (use defaults when authContext is null)
  const isAuthenticated = authContext?.isAuthenticated ?? false;
  const isLoading = authContext?.isLoading ?? true;
  const user = authContext?.user ?? null;
  const logout = authContext?.logout ?? (() => {});
  const backendUnavailable = authContext?.backendUnavailable ?? false;
  const isOfflineMode = authContext?.isOfflineMode ?? false;

  // Check if we're coming from a successful login
  const justLoggedIn = sessionStorage.getItem('just_logged_in') === 'true';

  // Handle context retry logic
  useEffect(() => {
    if (!authContext && contextRetryCount < MAX_CONTEXT_RETRIES) {
      const retryTimeout = setTimeout(() => {
        setContextRetryCount(prev => prev + 1);
      }, 1000); // Retry every second

      return () => clearTimeout(retryTimeout);
    }
  }, [authContext, contextRetryCount]);

  // Setup auth check with delay to ensure the token is processed
  useEffect(() => {
    if (!authContext) return; // Skip when auth context not ready

    let authCheckTimeout: NodeJS.Timeout | null = null;
    let isMounted = true;

    // If we just logged in, give some time for the auth state to update
    if (justLoggedIn && !authCheckComplete) {
      setIsTransitioning(true);
      authCheckTimeout = setTimeout(() => {
        if (isMounted) {
          setAuthCheckComplete(true);
          setIsTransitioning(false);
        }
      }, 500);
    } else if (!authCheckComplete) {
      // For regular checks, still give a small delay
      authCheckTimeout = setTimeout(() => {
        if (isMounted) {
          setAuthCheckComplete(true);
        }
      }, 100);
    }

    return () => {
      isMounted = false;
      if (authCheckTimeout) clearTimeout(authCheckTimeout);
    };
  }, [authContext, justLoggedIn, authCheckComplete]);

  // Safety timeout to prevent infinite loading
  useEffect(() => {
    if (!authContext) return; // Skip when auth context not ready

    let longWaitTimeout: NodeJS.Timeout | null = null;

    // Reset loading too long state when loading changes
    if (!isLoading) {
      setLoadingTooLong(false);
    }

    // Set a safety timeout to prevent infinite loading
    if (isLoading && !isTransitioning) {
      // Only show warning if we're not in a normal authentication flow
      // Check if we just logged in or if this is a page refresh
      const isNormalAuthFlow =
        justLoggedIn || sessionStorage.getItem('auth_in_progress') === 'true';

      if (!isNormalAuthFlow) {
        // Set flag to track that auth is in progress to prevent repeated warnings
        sessionStorage.setItem('auth_in_progress', 'true');

        // Show a warning after 8 seconds (increased from 3 seconds)
        longWaitTimeout = setTimeout(() => {
          console.warn('Protected Route - Loading taking longer than expected');
          setLoadingTooLong(true);
          // Clear the auth in progress flag
          sessionStorage.removeItem('auth_in_progress');
        }, 8000); // 8 second warning - increased to accommodate normal auth flow
      }
    }

    return () => {
      if (longWaitTimeout) clearTimeout(longWaitTimeout);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are intentionally limited
  }, [authContext, isLoading, isTransitioning]);

  // Countdown timer for retry button when the backend is unavailable
  useEffect(() => {
    if (!backendUnavailable) {
      setRetryCountdown(null);
      return;
    }

    // Check if we're in a cooldown period
    const retryAfter = localStorage.getItem('backend_retry_after');
    if (!retryAfter) return;

    const updateCountdown = () => {
      const now = Date.now();
      const retryTime = parseInt(retryAfter);

      if (retryTime > now) {
        setRetryCountdown(Math.ceil((retryTime - now) / 1000));
      } else {
        setRetryCountdown(null);
        localStorage.removeItem('backend_retry_after');
      }
    };

    // Initial update
    updateCountdown();

    // Update countdown every second
    const countdownInterval = setInterval(updateCountdown, 1000);

    return () => clearInterval(countdownInterval);
  }, [backendUnavailable]);

  // Log authentication status changes
  useEffect(() => {
    if (!authContext) return; // Skip when auth context not ready

    // Clear the login flag only when the auth check is complete and we're authenticated
    if (justLoggedIn && authCheckComplete && isAuthenticated) {
      sessionStorage.removeItem('just_logged_in');
    }

    // If we detect backend unavailability while on the protected route,
    // prevent continuous reloads by stopping further auth checks
    if (backendUnavailable && !isOfflineMode && !isLoginPage()) {
      // Make sure we're not in a loading state that could cause issues
      if (isLoading) {
        // setLocalLoading(false); // No longer needed
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are intentionally limited
  }, [
    authContext,
    isAuthenticated,
    isLoading,
    loadingTooLong,
    authCheckComplete,
    redirectAttempts,
    location.pathname,
    user,
    justLoggedIn,
    backendUnavailable,
    isOfflineMode,
  ]);

  // Track redirect attempts - but only when not transitioning from login
  useEffect(() => {
    if (!authContext) return; // Skip when auth context not ready

    // Only increment redirect attempts when:
    // - Not authenticated
    // - Loading is finished
    // - Auth check is complete
    // - Not coming from a successful login
    // - Not currently in a transition state
    if (
      !isAuthenticated &&
      !isLoading &&
      authCheckComplete &&
      !justLoggedIn &&
      !isTransitioning
    ) {
      setRedirectAttempts(prev => prev + 1);
    }
  }, [
    authContext,
    isAuthenticated,
    isLoading,
    authCheckComplete,
    justLoggedIn,
    isTransitioning,
  ]);

  // Safety check for auth context with retry mechanism
  // IMPORTANT: This check is AFTER all hooks to maintain consistent hook count
  if (!authContext) {
    if (contextRetryCount < MAX_CONTEXT_RETRIES) {
      return (
        <div className='flex flex-col items-center justify-center min-h-screen'>
          <div className='text-center'>
            <div className='animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500 mx-auto mb-4'></div>
            <p className='text-gray-600 dark:text-gray-300'>
              Initializing authentication... ({contextRetryCount + 1}/
              {MAX_CONTEXT_RETRIES})
            </p>
          </div>
        </div>
      );
    }

    return (
      <div className='flex flex-col items-center justify-center min-h-screen'>
        <div className='text-red-500 text-center'>
          <h2 className='text-xl font-bold mb-2'>Authentication Error</h2>
          <p className='mb-4'>
            Please refresh the page or try logging in again.
          </p>
          <button
            onClick={() => window.location.reload()}
            className='px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600 mr-2'
          >
            Refresh Page
          </button>
          <button
            onClick={() => (navigateToLogin())}
            className='px-4 py-2 bg-gray-500 text-white rounded hover:bg-gray-600'
          >
            Go to Login
          </button>
        </div>
      </div>
    );
  }

  // Handle logout
  const handleForceLogout = () => {
    // Clear just_logged_in flag to prevent login loop
    sessionStorage.removeItem('just_logged_in');
    // Clear backend unavailable flag to allow fresh login attempts
    localStorage.removeItem('backend_unavailable');
    localStorage.removeItem('backend_retry_after');
    logout();
    navigateToLogin();
  };

  // Handle retry connection
  const handleRetryConnection = () => {
    // Clear backend unavailable flag
    localStorage.removeItem('backend_unavailable');
    localStorage.removeItem('backend_retry_after');

    // Force a reload to reinitialize everything
    window.location.reload();
  };

  // Check if we're on the login page
  const isLoginPage = () => {
    return location.pathname === '/login';
  };

  // Skip loading state - let the login page handle authentication loading
  // Only show loading if it's taking too long and we need to offer force logout
  if ((isLoading || !authCheckComplete) && loadingTooLong) {
    return (
      <div className='flex flex-col items-center justify-center min-h-screen'>
        <div className='flex flex-col items-center'>
          <p className='text-gray-600 dark:text-gray-300 mt-4 text-center max-w-md'>
            {t('auth.loadingLong')}
          </p>
          <button
            onClick={handleForceLogout}
            className='mt-4 px-4 py-2 bg-red-500 text-white rounded hover:bg-red-600 transition-colors'
          >
            {t('auth.forceLogout')}
          </button>
        </div>
      </div>
    );
  }

  // If the backend is unavailable, show a message and don't redirect
  if (backendUnavailable && !isOfflineMode) {
    return (
      <div className='flex flex-col items-center justify-center min-h-screen p-4'>
        <div className='bg-amber-50 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-700 rounded-lg p-6 max-w-md w-full'>
          <h2 className='text-xl font-semibold text-amber-800 dark:text-amber-300 mb-3'>
            {t('auth.backendUnavailable.title')}
          </h2>
          <p className='text-amber-700 dark:text-amber-400 mb-4'>
            {t('auth.backendUnavailable.description')}
          </p>
          <div className='flex flex-col space-y-3'>
            <button
              onClick={handleRetryConnection}
              disabled={retryCountdown !== null}
              className={`px-4 py-2 ${retryCountdown === null
                ? 'bg-amber-600 hover:bg-amber-700'
                : 'bg-amber-400 cursor-not-allowed'
                } text-white rounded transition-colors`}
            >
              {retryCountdown === null
                ? t('auth.backendUnavailable.retryConnection')
                : t('auth.backendUnavailable.retryIn', {
                  seconds: retryCountdown,
                })}
            </button>
            <button
              onClick={handleForceLogout}
              className='px-4 py-2 bg-gray-500 hover:bg-gray-600 text-white rounded transition-colors'
            >
              {t('auth.backendUnavailable.goToLogin')}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // CRITICAL: Check if we have tokens but isAuthenticated is false
  // This means auth state is still updating (race condition)
  const hasTokens = localStorage.getItem('auth_tokens') || sessionStorage.getItem('auth_tokens');

  // If we just logged in OR have tokens but not authenticated yet, allow access
  if (justLoggedIn || (hasTokens && !isAuthenticated && !isLoading)) {
    return <>{children}</>;
  }

  // If the user is not authenticated after checks, redirect to login
  // Check if authentication check is complete, not loading, and user is not authenticated
  // Also ensure we are not on the login page already and haven't exceeded redirect attempts
  if (!isAuthenticated && !isLoading && authCheckComplete && !isLoginPage()) {
    // In desktop mode with LOCAL backend, wait for desktop auth to initialize
    // In cloud mode, don't wait - redirect to login for user authentication
    if (isDesktopMode() && !isDesktopAuthInitialized() && !isCloudMode() && !isDesktopCloudMode()) {
      console.log('[ProtectedRoute] Desktop LOCAL mode detected, waiting for desktop auth...');
      return (
        <div className='flex flex-col items-center justify-center min-h-screen'>
          <div className='text-center'>
            <div className='animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500 mx-auto mb-4'></div>
            <p className='text-gray-600 dark:text-gray-300'>
              Initializing desktop authentication...
            </p>
          </div>
        </div>
      );
    }

    // Double-check tokens one more time before redirecting
    if (hasTokens) {

      // Show loading instead of redirecting
      return (
        <div className='flex flex-col items-center justify-center min-h-screen'>
          <div className='text-center'>
            <div className='animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500 mx-auto mb-4'></div>
            <p className='text-gray-600 dark:text-gray-300'>
              Completing authentication...
            </p>
          </div>
        </div>
      );
    }

    // Prevent redirect loops
    if (redirectAttempts >= MAX_REDIRECT_ATTEMPTS) {
      console.error(
        'Protected Route - Maximum redirect attempts reached. Preventing further redirects.'
      );
      return (
        <div className='flex flex-col items-center justify-center min-h-screen p-4'>
          <div className='bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-700 rounded-lg p-6 max-w-md w-full'>
            <h2 className='text-xl font-semibold text-red-800 dark:text-red-300 mb-3'>
              {t('auth.authLoopDetected.title')}
            </h2>
            <p className='text-red-700 dark:text-red-400 mb-4'>
              {t('auth.authLoopDetected.description')}
            </p>
            <button
              onClick={handleForceLogout}
              className='mt-4 px-4 py-2 bg-red-500 text-white rounded hover:bg-red-600 transition-colors'
            >
              {t('auth.forceLogout')}
            </button>
          </div>
        </div>
      );
    }

    // Pass the current location to redirect back after login
    return <Navigate to='/login' state={{ from: location }} replace />;
  }

  // If authenticated and checks complete, render the child components
  return <>{children}</>;
};

const ProtectedRoute: React.FC<ProtectedRouteProps> = ({ children }) => {
  return (
    <ProtectedRouteErrorBoundary>
      <ProtectedRouteInner>{children}</ProtectedRouteInner>
    </ProtectedRouteErrorBoundary>
  );
};

export default ProtectedRoute;

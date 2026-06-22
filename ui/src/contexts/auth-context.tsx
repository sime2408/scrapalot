import React, {
  createContext,
  ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import axios from 'axios';
import { AuthTokens, User } from '@/types';
import { api, API_BASE_URL, authState, login as apiLogin, refreshToken, getCurrentUser, showSessionExpiredAndRedirect } from '@/lib/api';
import { getModels } from '@/lib/api-llm-inference';
import { getDefaultWorkspace, Workspace } from '@/lib/api-workspace';
import { getGeneralSettings, getUserSettings } from '@/lib/api-settings';
import { userPrefs, uiState, modelSelections, settings as settingsStore } from '@/lib/storage-utils';
import i18n from '@/i18n';
import { navigateToLogin, isPublicRoute } from '@/lib/navigation';
import { resetJobSyncAuthState } from '@/hooks/use-persistent-job-sync';
import { exitImpersonation, isImpersonating } from '@/lib/impersonation';
import { isNativeApp } from '@/lib/native-app';

/**
 * Apply the user's saved language from `settings_general` to i18n on login.
 *
 * Without this, the app falls back to localStorage (`i18nextLng`) or browser
 * Accept-Language. The UI would render in English on the first login from a
 * new device, because i18next-browser-languagedetector never consults the
 * backend — and the language only switched once Settings was opened (which
 * reads `general.language` on mount). We also write the resolved value to
 * `i18nextLng` so subsequent cold loads pick it up before this runs.
 *
 * Two fields can hold the language because the backend writes them from
 * different paths: `language` from the Settings UI save, `locale` from
 * InvitationController when an admin invites a user. Read both, with
 * `language` taking precedence (UI is the canonical write path).
 */
export async function applyLocaleFromGeneralSettings(settingsResult: unknown): Promise<void> {
  if (!Array.isArray(settingsResult) || settingsResult.length < 2) return;
  const general = settingsResult[1] as Record<string, unknown> | undefined;
  const language = general?.language;
  const locale =
    (typeof language === 'string' && language) ? language :
    (typeof general?.locale === 'string' && general.locale) ? general.locale :
    null;
  if (!locale) return;
  if (i18n.language === locale) {
    // Even if i18n is already in sync, make sure both localStorage keys
    // agree so the next cold load doesn't trip the 8 s English flash.
    try {
      if (localStorage.getItem('i18nextLng') !== locale) {
        localStorage.setItem('i18nextLng', locale);
      }
    } catch {
      // ignore quota / private-mode storage errors
    }
    settingsStore.setI18nLanguage(locale);
    return;
  }
  try {
    await i18n.changeLanguage(locale);
    settingsStore.setI18nLanguage(locale);
  } catch (err) {
    console.warn('Failed to apply user locale from general settings:', err);
  }
}

/**
 * Load the user's settings (locale etc.) in the BACKGROUND and apply them when
 * ready. Non-blocking and non-throwing on purpose: settings are not required
 * to render the dashboard, so they must not gate auth-ready. The previous
 * inline `Promise.race([..., 10s throwing timeout])` both delayed the post-
 * login flow by up to 10s on a slow mobile link AND logged a benign
 * "Settings loading timeout" error to the console. Here a failure is a warning
 * and the locale simply applies a moment later (or stays on the seeded value).
 */
function loadUserSettingsInBackground(): void {
  void Promise.all([getUserSettings(), getGeneralSettings()])
    .then((settingsResult) => applyLocaleFromGeneralSettings(settingsResult))
    .catch((err) =>
      console.warn('User settings not loaded yet (continuing):', err)
    );
}

// Define the shape of the auth context
export interface AuthContextType {
  user: User | null;
  tokens: AuthTokens | null;
  isLoading: boolean;
  error: string | null;
  authError: string | null;
  isAuthenticated: boolean;
  isOfflineMode: boolean;
  backendUnavailable: boolean;
  authState: typeof authState; // Add authState to context
  login: (
    username: string,
    password: string,
    rememberMe?: boolean
  ) => Promise<boolean>;
  loginWithGoogle: (code: string) => Promise<boolean>;
  loginWithNativeGoogle: (
    idToken: string,
    createIfMissing: boolean
  ) => Promise<{ ok: boolean; needsConfirmation?: boolean; email?: string }>;
  logout: () => void;
  getAuthHeader: () => { Authorization: string };
  enableOfflineMode: (enable: boolean) => void;
  ensureModelsLoaded: () => Promise<void>;
  refreshUser: () => Promise<void>;
}

// Export the context so the hook can import it
export const AuthContext = createContext<AuthContextType | undefined>(
  undefined
);

// Create provider component
interface AuthProviderProps {
  children: ReactNode;
}

export const AuthProvider: React.FC<AuthProviderProps> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [tokens, setTokens] = useState<AuthTokens | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [isOfflineMode, setIsOfflineMode] = useState(false);
  const [_connectionErrors, setConnectionErrors] = useState(0);
  const [_lastConnectionAttempt, setLastConnectionAttempt] = useState(0);
  const [rememberSession, setRememberSession] = useState<boolean>(() => {
    try {
      return userPrefs.getRememberSession();
    } catch (e) {
      console.error('Error getting remember session preference:', e);
      return false;
    }
  });
  const [failedAuthAttempts, setFailedAuthAttempts] = useState(0);
  const [consecutiveRefreshFailures, setConsecutiveRefreshFailures] = useState(0);
  const [backendUnavailable, _setBackendUnavailable] = useState<boolean>(() => {
    try {
      return localStorage.getItem('backend_unavailable') === 'true';
    } catch (e) {
      console.error(
        'Error accessing localStorage for backend availability:',
        e
      );
      return false;
    }
  });
  const [modelsPreloaded, setModelsPreloaded] = useState(false);
  const MAX_FAILED_ATTEMPTS = 2;
  const MAX_CONSECUTIVE_REFRESH_FAILURES = 3;

  // Mutex to prevent concurrent token refresh attempts
  const refreshMutexRef = useRef<Promise<boolean> | null>(null);
  const lastActivityRef = useRef<number>(Date.now());

  // Helper function to check if the current page is the login page
  const isLoginPage = (): boolean => {
    return window.location.pathname === '/login';
  };

  // Helper function to check if the current page is a public page.
  // Delegates to the shared allowlist so /invite and /shared/:token are
  // treated as public (see navigation.ts).
  const isPublicPage = (): boolean => isPublicRoute(window.location.pathname);

  // Cache for user data to prevent redundant API calls
  const userCache = {
    data: null as User | null,
    timestamp: 0,
    maxAge: 60000, // 1 minute cache

    isValid() {
      return this.data !== null && Date.now() - this.timestamp < this.maxAge;
    },

    set(userData: User) {
      this.data = userData;
      this.timestamp = Date.now();
    },

    clear() {
      this.data = null;
      this.timestamp = 0;
    },
  };

  // Store token expiry timestamp so auth-service.ts needsRefresh() works.
  // The backend tells us `expires_in` (seconds), but historically lied
  // (returned 14400 / 4 h while the JWT was actually 30 min). Cross-check
  // against the JWT `exp` claim and trust whichever is sooner — this way
  // a backend that under-reports lifetime can never park us past the
  // real expiry, which is what triggers the "kicked to login mid-action"
  // bug class.
  const storeTokenExpiry = useCallback((authTokens: AuthTokens) => {
    let expiryTimestamp: number | null = null;

    if (authTokens.expires_in && authTokens.expires_in > 0) {
      expiryTimestamp = Date.now() + authTokens.expires_in * 1000;
    }

    if (authTokens.access_token) {
      try {
        const payload = JSON.parse(atob(authTokens.access_token.split('.')[1]));
        if (typeof payload.exp === 'number') {
          const jwtExpMs = payload.exp * 1000;
          if (expiryTimestamp === null || jwtExpMs < expiryTimestamp) {
            expiryTimestamp = jwtExpMs;
          }
        }
      } catch {
        /* malformed token — fall through to expires_in only */
      }
    }

    if (expiryTimestamp !== null) {
      localStorage.setItem('token_expiry', String(expiryTimestamp));
    }
  }, []);

  const trySessionCookieAuth = async () => {
    // The HttpOnly refresh cookie belongs to the admin's original login.
    // During impersonation, using it silently restores admin identity on
    // top of the target's tokens — defeating the whole point. Skip.
    if (isImpersonating()) {
      setIsLoading(false);
      setUser(null);
      authState.setAuthReady(false);
      return null;
    }
    try {
      // Try to restore auth using the HttpOnly refresh_token cookie (30-day expiry).
      // We cannot check document.cookie for HttpOnly cookies, so just attempt the
      // refresh call and let the server validate the cookie.
      const refreshResponse = await fetch(`${API_BASE_URL}/users/token/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
      }).catch(() => {
        // Silently handle fetch errors - server unreachable or user not authenticated
        return null;
      });

      if (!refreshResponse || !refreshResponse.ok) {
        // No valid refresh cookie or server rejected it
        setIsLoading(false);
        setUser(null);
        authState.setAuthReady(false);
        return null;
      }

      const data = await refreshResponse.json();
      if (data.access_token) {
        const sessionTokens: AuthTokens = {
          access_token: data.access_token,
          token_type: data.token_type || 'bearer',
          expires_in: data.expires_in,
          refresh_token: data.refresh_token || undefined,
        };
        setTokens(sessionTokens);
        storeTokenExpiry(sessionTokens);

        // Store in localStorage so subsequent refreshes can send refresh_token in body
        localStorage.setItem('auth_tokens', JSON.stringify(sessionTokens));

        api.defaults.headers.common['Authorization'] =
          `Bearer ${data.access_token}`;

        // Get user data
        const currentUser = await getCurrentUser();
        if (currentUser) {
          setUser(currentUser as User);
          uiState.setCachedUser(currentUser);
          authState.setAuthReady(true);

          // Load workspace after successful session auth - MUST complete before auth-ready
          try {
            const workspace = await getDefaultWorkspace(true);
            uiState.setCurrentWorkspace(workspace as unknown as Record<string, unknown>);
            window.dispatchEvent(new CustomEvent('workspace-loaded', {
              detail: workspace
            }));

            await new Promise(resolve => setTimeout(resolve, 50));

            window.dispatchEvent(new CustomEvent('auth-ready'));
            setIsLoading(false);
            return;
          } catch (workspaceError) {
            console.error('Error loading workspace:', workspaceError);
            window.dispatchEvent(new CustomEvent('auth-ready'));
            setIsLoading(false);
            return;
          }
        }
      }
    } catch (error) {
      console.debug('Cookie-based auth restoration not available:', error);
    }

    // If cookie auth fails, set default state
    setIsLoading(false);
    setUser(null);
    authState.setAuthReady(false);
  };

  const checkAuth = async () => {
    if (isLoginPage() || isPublicPage()) {
      setIsLoading(false);
      authState.setAuthReady(false);
      return;
    }

    if (failedAuthAttempts >= MAX_FAILED_ATTEMPTS) {
      setIsLoading(false);
      authState.setAuthReady(false);
      return;
    }

    if (userCache.isValid()) {
      setUser(userCache.data);
      setConnectionErrors(0);
      setFailedAuthAttempts(0);
      setAuthError(null);
      authState.setAuthReady(true);

      // Load workspace from cache - MUST complete before auth-ready
      try {
        const workspace = await getDefaultWorkspace(false); // Use cache
        // CRITICAL: Save to localStorage SYNCHRONOUSLY before auth-ready
        uiState.setCurrentWorkspace(workspace as unknown as Record<string, unknown>);
        // Dispatch workspace-loaded event
        window.dispatchEvent(new CustomEvent('workspace-loaded', {
          detail: workspace
        }));

        // Short delay to ensure localStorage is flushed
        await new Promise(resolve => setTimeout(resolve, 50));

        setIsLoading(false);
        window.dispatchEvent(new CustomEvent('auth-ready'));
        return;
      } catch (workspaceError) {
        console.error('❌ Error loading workspace from cache:', workspaceError);
        // Continue even if workspace fails - auth is still valid
        setIsLoading(false);
        window.dispatchEvent(new CustomEvent('auth-ready'));
        return;
      }
    }

    setIsLoading(true);
    setLastConnectionAttempt(Date.now());

    let storedTokens: AuthTokens | null = null;

    const sessionTokens = sessionStorage.getItem('auth_tokens');
    if (sessionTokens) {
      try {
        storedTokens = JSON.parse(sessionTokens);
      } catch (e) {
        console.error('Failed to parse session tokens', e);
        sessionStorage.removeItem('auth_tokens');
      }
    }

    if (!storedTokens) {
      const localTokens = localStorage.getItem('auth_tokens');
      if (localTokens) {
        try {
          storedTokens = JSON.parse(localTokens);
        } catch (e) {
          console.error('Failed to parse local tokens', e);
          localStorage.removeItem('auth_tokens');
        }
      }
    }

    if (storedTokens && storedTokens.access_token) {
      setTokens(storedTokens);
      api.defaults.headers.common['Authorization'] =
        `Bearer ${storedTokens.access_token}`;

      // Use setTimeout to avoid promise hang issue
      setTimeout(async () => {
        try {
          const result = await getCurrentUser();
          if (result) {
            setUser(result as User);
            userCache.set(result as User);
            setConnectionErrors(0);
            setFailedAuthAttempts(0);
            setAuthError(null);
            authState.setAuthReady(true);
            window.dispatchEvent(new CustomEvent('auth-ready'));
          } else {
            await handleRefreshToken();
          }
        } catch (error) {
          console.error('Error fetching user:', error);
          setFailedAuthAttempts(prev => prev + 1);
          setAuthError('Authentication failed. Please log in.');
          authState.setAuthReady(false);
        } finally {
          // Set loading to false after user is loaded (or failed)
          setIsLoading(false);
        }
      }, 0);

      // Keep isLoading = true until user loads
      return;
    }

    setIsLoading(false);
  };

  const handleRefreshToken = async (): Promise<boolean> => {
    // If refresh already in progress, wait for it to complete
    if (refreshMutexRef.current) {
      return await refreshMutexRef.current;
    }

    if (isLoginPage()) {
      authState.setAuthReady(false);
      setIsLoading(false);
      return false;
    }

    if (isOfflineMode) {
      authState.setAuthReady(true);
      setIsLoading(false);
      return true;
    }

    // Create refresh promise and set mutex
    const executeRefresh = async (): Promise<boolean> => {
      setIsLoading(true);
      // Track whether failures are due to server unavailability (502/503/network)
      // vs actual auth errors (401). Only auth errors should count toward logout.
      let lastFailureIsServerDown = false;

      try {
        const newTokens = await refreshToken();
        if (newTokens && newTokens.access_token) {
          setTokens(newTokens);
          storeTokenExpiry(newTokens);
          setFailedAuthAttempts(0);
          setConsecutiveRefreshFailures(0); // Reset on success
          localStorage.setItem('auth_tokens', JSON.stringify(newTokens));
          api.defaults.headers.common['Authorization'] =
            `Bearer ${newTokens.access_token}`;
          localStorage.removeItem('token_refresh_needed');

          const currentUser = await getCurrentUser();
          if (currentUser) {
            setUser(currentUser as User);
            uiState.setCachedUser(currentUser);
            authState.setAuthReady(true);
            window.dispatchEvent(new CustomEvent('auth-ready'));
            setIsLoading(false);
            return true;
          } else {
            console.warn('⚠️ Token refresh succeeded but getCurrentUser failed');
            // Don't logout immediately - increment failure counter
            setConsecutiveRefreshFailures(prev => prev + 1);

            if (consecutiveRefreshFailures >= MAX_CONSECUTIVE_REFRESH_FAILURES) {
              console.error('❌ Multiple consecutive refresh failures, logging out');
              logout();
              // Only redirect to login if not on a public page
              if (!isPublicPage() && window.location.pathname !== '/login') {
                await showSessionExpiredAndRedirect();
              }
            }
            authState.setAuthReady(false);
            setIsLoading(false);
            return false;
          }
        }

        console.warn(
          '⚠️ Token refresh API call failed or returned invalid tokens.'
        );
        localStorage.setItem('token_refresh_needed', 'true');

        try {
          // Build request body with refresh_token from storage (same as primary refresh)
          const stored =
            localStorage.getItem('auth_tokens') ||
            sessionStorage.getItem('auth_tokens');
          const storedTokens = stored ? JSON.parse(stored) : {};
          const fallbackBody: Record<string, string> = {};
          if (storedTokens?.refresh_token) {
            fallbackBody.refresh_token = storedTokens.refresh_token;
          }

          // Do NOT send expired access token — refresh endpoint is public
          const response = await fetch(`${API_BASE_URL}/users/token/refresh`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: Object.keys(fallbackBody).length > 0 ? JSON.stringify(fallbackBody) : undefined,
          });

          if (response.ok) {
            const data = await response.json();
            if (data.access_token) {
              const directTokens = {
                access_token: data.access_token,
                token_type: data.token_type || 'bearer',
                expires_in: data.expires_in,
                // Preserve refresh_token: use new one from response, or keep existing
                refresh_token: data.refresh_token || storedTokens?.refresh_token,
              };
              setTokens(directTokens);
              storeTokenExpiry(directTokens);
              setConsecutiveRefreshFailures(0); // Reset on success
              localStorage.setItem('auth_tokens', JSON.stringify(directTokens));
              api.defaults.headers.common['Authorization'] =
                `Bearer ${data.access_token}`;
              localStorage.removeItem('token_refresh_needed');
              window.dispatchEvent(new CustomEvent('auth-ready'));
              authState.setAuthReady(true);
              setIsLoading(false);
              return true;
            }
          } else if (response.status === 502 || response.status === 503 || response.status === 504) {
            // Server is down — not an auth failure
            lastFailureIsServerDown = true;
            console.warn('⚠️ Token refresh got server error:', response.status);
          }
        } catch (directError) {
          // Network error (connection refused, etc.) — server is down
          lastFailureIsServerDown = true;
          console.warn('⚠️ Direct token refresh failed (server likely down):', directError);
        }

        // Try cookie-only refresh fallback (HttpOnly refresh_token cookie, 30-day expiry).
        // Skipped during impersonation: the cookie still belongs to the admin's
        // original login, so falling back here silently restores admin identity
        // and contaminates the impersonated session with admin's chat history,
        // workspace, and settings. If the target's refresh token is dead, end
        // the impersonation cleanly so the admin lands back in their own
        // session instead of a half-mixed one.
        if (isImpersonating()) {
          console.warn('Impersonation refresh failed — exiting impersonation, returning to admin');
          exitImpersonation();
          window.location.href = '/dashboard';
          return false;
        }
        try {
          const cookieRefreshResponse = await fetch(`${API_BASE_URL}/users/token/refresh`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
          });

          if (cookieRefreshResponse.ok) {
            const cookieData = await cookieRefreshResponse.json();
            if (cookieData.access_token) {
              const existingStored =
                localStorage.getItem('auth_tokens') ||
                sessionStorage.getItem('auth_tokens');
              const existingTokens = existingStored ? JSON.parse(existingStored) : {};

              const cookieTokens = {
                access_token: cookieData.access_token,
                token_type: cookieData.token_type || 'bearer',
                expires_in: cookieData.expires_in,
                refresh_token: cookieData.refresh_token || existingTokens?.refresh_token,
              };
              setTokens(cookieTokens);
              storeTokenExpiry(cookieTokens);
              setConsecutiveRefreshFailures(0);

              // Always store in localStorage so refresh_token persists across browser restarts
              localStorage.setItem('auth_tokens', JSON.stringify(cookieTokens));

              api.defaults.headers.common['Authorization'] =
                `Bearer ${cookieData.access_token}`;
              localStorage.removeItem('token_refresh_needed');
              window.dispatchEvent(new CustomEvent('auth-ready'));
              authState.setAuthReady(true);
              setIsLoading(false);
              return true;
            }
          } else if (cookieRefreshResponse.status === 502 || cookieRefreshResponse.status === 503 || cookieRefreshResponse.status === 504) {
            lastFailureIsServerDown = true;
          }
        } catch (cookieRefreshError) {
          lastFailureIsServerDown = true;
          console.warn('Cookie-based refresh failed (server likely down):', cookieRefreshError);
        }

        // All refresh attempts failed
        console.warn('⚠️ All token refresh attempts failed, serverDown:', lastFailureIsServerDown);

        // Only count toward logout threshold if server is reachable (auth error, not server down)
        if (lastFailureIsServerDown) {
          console.warn('⚠️ Server appears down — preserving tokens, not counting toward logout');
          setAuthError('Server temporarily unavailable. Your session is preserved.');
        } else {
          setConsecutiveRefreshFailures(prev => prev + 1);
          setAuthError('Session refresh failed. Please save your work.');
        }

        // Only logout after multiple consecutive auth failures (not server-down failures)
        if (!lastFailureIsServerDown && consecutiveRefreshFailures >= MAX_CONSECUTIVE_REFRESH_FAILURES) {
          console.error(`❌ ${MAX_CONSECUTIVE_REFRESH_FAILURES} consecutive refresh failures, logging out`);
          logout();
          // Only redirect to login if not on a public page
          if (!isPublicPage() && window.location.pathname !== '/login') {
            await showSessionExpiredAndRedirect();
          }
        }

        authState.setAuthReady(false);
        setIsLoading(false);
        return false;
      } catch (err) {
        console.error('❌ Error during handleRefreshToken:', err);
        localStorage.setItem('token_refresh_needed', 'true');

        // Check if the error is a server unavailability issue (502/503/network)
        const isServerDown = (
          (err instanceof TypeError && err.message === 'Failed to fetch') ||
          (err && typeof err === 'object' && 'response' in err &&
            ((err as { response?: { status?: number } }).response?.status === 502 ||
             (err as { response?: { status?: number } }).response?.status === 503 ||
             (err as { response?: { status?: number } }).response?.status === 504))
        );

        if (isServerDown) {
          console.warn('⚠️ Server appears down during refresh — preserving tokens');
          setAuthError('Server temporarily unavailable. Your session is preserved.');
        } else {
          // Only count genuine auth errors toward logout threshold
          setConsecutiveRefreshFailures(prev => prev + 1);
          setAuthError('Session refresh failed. Please save your work.');

          if (consecutiveRefreshFailures >= MAX_CONSECUTIVE_REFRESH_FAILURES) {
            console.error(`❌ ${MAX_CONSECUTIVE_REFRESH_FAILURES} consecutive refresh failures, logging out`);
            logout();
            if (!isPublicPage() && window.location.pathname !== '/login') {
              await showSessionExpiredAndRedirect();
            }
          }
        }

        authState.setAuthReady(false);
        setIsLoading(false);
        return false;
      }
    };
    const refreshPromise = executeRefresh();

    // Set mutex
    refreshMutexRef.current = refreshPromise;

    try {
      return await refreshPromise;
    } finally {
      // Release mutex
      refreshMutexRef.current = null;
    }
  };

  const login = async (
    username: string,
    password: string,
    rememberMe: boolean = false
  ): Promise<boolean> => {
    if (isOfflineMode) {
      setError('Cannot login while in offline mode');
      authState.setAuthReady(false);
      return false;
    }

    setIsLoading(true);
    setError(null);
    setAuthError(null);
    setRememberSession(rememberMe);
    userPrefs.setRememberSession(rememberMe);

    try {
      const authTokens = await apiLogin(username, password);

      if (authTokens?.access_token) {
        setTokens(authTokens);
        storeTokenExpiry(authTokens);

        // Set Authorization header immediately after getting tokens
        api.defaults.headers.common['Authorization'] =
          `Bearer ${authTokens.access_token}`;

        // The native app always persists the session (mobile-app UX: log in
        // once, land on the dashboard on every launch) — sessionStorage dies
        // with the app process, which forced a re-login on every app start.
        if (rememberMe || isNativeApp()) {
          localStorage.setItem('auth_tokens', JSON.stringify(authTokens));
          sessionStorage.removeItem('auth_tokens');
        } else {
          sessionStorage.setItem('auth_tokens', JSON.stringify(authTokens));
        }

        const success = true;
        if (success) {
          sessionStorage.setItem('just_logged_in', 'true');
          sessionStorage.removeItem('just_logged_out'); // Clear logout flag
          resetJobSyncAuthState(); // Reset job sync state after successful login

          // Save or clear username/email based on remember me preference
          if (rememberMe) {
            userPrefs.setSavedUsername(username);
          } else {
            userPrefs.setSavedUsername('');
          }
        }

        authState.setAuthReady(true);
        // Dispatch auth-ready event immediately so waitForAuthReady() can resolve
        window.dispatchEvent(new CustomEvent('auth-ready'));

        setUser({
          id: 'pending',
          username: username,
          email: '',
          is_active: true,
          role: 'USER',
          created_at: new Date(),
        } as unknown as User);

        try {
          const userData = await getCurrentUser();
          if (userData) {
            setUser(userData as User);
            uiState.setCachedUser(userData);
          }

          // Settings (locale) load in the background — never block login.
          loadUserSettingsInBackground();

          // Sync anonymous accent color to logged-in user preferences
          try {
            const anonymousAccentColor = userPrefs.getAccentColor();
            if (anonymousAccentColor && anonymousAccentColor !== 'blue') {
              // Update the user's accent color preference
              await userPrefs.setCurrentAccentColor(anonymousAccentColor);

              // Preserve the anonymous accent color for future logout sessions
              // Don't reset to violet - keep the user's choice for when they logout again

              // Dispatch event for immediate UI updates
              window.dispatchEvent(
                new CustomEvent('accentColorChange', {
                  detail: anonymousAccentColor,
                })
              );
            }
          } catch (accentColorError) {
            console.warn(
              '⚠️ Failed to sync anonymous accent color:',
              accentColorError
            );
            // Don't fail login if accent color sync fails
          }

          // Load workspace after login - wait up to 10s, then continue anyway
          try {
            const defaultWorkspace = await Promise.race([
              getDefaultWorkspace(true),
              new Promise<Workspace>((_, reject) =>
                setTimeout(
                  () => reject(new Error('Workspace loading timeout')),
                  10000
                )
              ),
            ]);
            uiState.setCurrentWorkspace(defaultWorkspace as unknown as Record<string, unknown>);
            window.dispatchEvent(
              new CustomEvent('workspace-loaded', {
                detail: defaultWorkspace,
              })
            );
            await new Promise((resolve) => setTimeout(resolve, 50));
          } catch (e) {
            console.warn(
              'Workspace loading failed post-login, WorkspaceContext will retry:',
              e
            );
          }

          setFailedAuthAttempts(0);
          return true;
        } finally {
          setIsLoading(false);
        }
      } else {
        console.error('Login failed: No access token in response');
        setAuthError('Login failed. Please try again.');
        setIsLoading(false);
        return false;
      }
    } catch (loginErr: unknown) {
      console.error('Login error:', loginErr);

      const errMessage = loginErr instanceof Error ? loginErr.message : undefined;
      const errName = loginErr instanceof Error ? loginErr.name : undefined;
      const errCode = axios.isAxiosError(loginErr) ? loginErr.code : undefined;

      console.error('Login error details:', {
        name: errName,
        message: errMessage,
        code: errCode,
        hasResponse: axios.isAxiosError(loginErr) && !!loginErr.response,
        hasRequest: axios.isAxiosError(loginErr) && !!loginErr.request,
      });
      authState.setAuthReady(false);

      // Check for network/connection errors first (TypeError: Failed to fetch)
      const isNetworkError =
        errMessage?.includes('Failed to fetch') ||
        errMessage?.includes('fetch') ||
        errCode === 'ERR_CONNECTION_REFUSED' ||
        errName === 'NetworkError' ||
        errMessage?.includes('ERR_CONNECTION_REFUSED') ||
        errMessage?.includes('ECONNREFUSED') ||
        errMessage?.includes('Network Error') ||
        errMessage?.includes('Unable to connect to server') ||
        (errName === 'TypeError' && errMessage?.includes('fetch')) ||
        // Also check for Error instances with NetworkError name
        (loginErr instanceof Error && loginErr.name === 'NetworkError');

      if (isNetworkError) {
        setAuthError('Unable to connect to server. Please check your internet connection and try again.');
      } else if (axios.isAxiosError(loginErr) && loginErr.response) {
        // Handle HTTP response errors (axios-style errors)
        const responseData = loginErr.response.data as Record<string, unknown> | undefined;
        switch (loginErr.response.status) {
          case 401:
            setAuthError('Invalid username or password');
            break;
          case 403:
            setAuthError('Account is locked or disabled');
            break;
          case 429:
            setAuthError('Too many login attempts. Please try again later.');
            break;
          default:
            setAuthError(
              `Login failed: ${(responseData?.detail as string) || 'Unknown error'}`
            );
        }
      } else if (axios.isAxiosError(loginErr) && loginErr.request) {
        // Request was made but no response received
        setAuthError(
          'Unable to reach server. Please check your internet connection.'
        );
      } else if (errMessage) {
        // Check if the error message itself indicates a specific problem
        if (errMessage.includes('Login failed:')) {
          setAuthError(errMessage);
        } else if (errMessage.includes('Invalid response format')) {
          setAuthError('Unable to connect to server. Please check your internet connection and try again.');
        } else {
          // Log the unhandled error case for debugging
          console.warn('Unhandled login error case:', errMessage);
          setAuthError('An unexpected error occurred. Please try again.');
        }
      } else {
        // Other errors - generic message
        console.warn('Login error with no message property:', loginErr);
        setAuthError('An unexpected error occurred. Please try again.');
      }

      setIsLoading(false);
      return false;
    }
  };

  // Shared post-auth sequence for both Google flows (web code exchange and
  // native id_token exchange): persist tokens, hydrate user, settings,
  // workspace. `persist` is sessionStorage for the web (don't remember by
  // default) but localStorage for the native app, which should stay signed in.
  const completeGoogleSession = async (
    authTokens: AuthTokens,
    emailHint: string | undefined,
    persist: 'session' | 'local'
  ): Promise<boolean> => {
    setTokens(authTokens);
    storeTokenExpiry(authTokens);

    if (persist === 'local') {
      localStorage.setItem('auth_tokens', JSON.stringify(authTokens));
      sessionStorage.removeItem('auth_tokens');
    } else {
      sessionStorage.setItem('auth_tokens', JSON.stringify(authTokens));
    }

    sessionStorage.setItem('just_logged_in', 'true');
    sessionStorage.removeItem('just_logged_out'); // Clear logout flag
    resetJobSyncAuthState(); // Reset job sync state after successful Google login

    localStorage.removeItem('token_refresh_needed');
    api.defaults.headers.common['Authorization'] =
      `Bearer ${authTokens.access_token}`;
    authState.setAuthReady(true);

    // Set temporary user data
    setUser({
      id: 'pending',
      username: emailHint || 'google_user',
      email: emailHint || '',
      is_active: true,
      role: 'USER',
      created_at: new Date(),
    } as unknown as User);

    try {
      const userData = await getCurrentUser();
      if (userData) {
        setUser(userData as User);
        uiState.setCachedUser(userData);
      }

      // Settings (locale) load in the background — never block Google login.
      loadUserSettingsInBackground();

      // Load default workspace
      try {
        const workspacePromise = getDefaultWorkspace(true);
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error('Workspace loading timeout')),
            2000
          )
        );
        const defaultWorkspace = await Promise.race([
          workspacePromise,
          timeoutPromise,
        ]);
        uiState.setCurrentWorkspace(defaultWorkspace as unknown as Record<string, unknown>);
      } catch (e) {
        console.error(
          'Error fetching default workspace post-Google login:',
          e
        );
      }

      setFailedAuthAttempts(0);
      window.dispatchEvent(new CustomEvent('auth-ready'));
      return true;
    } finally {
      setIsLoading(false);
    }
  };

  const loginWithGoogle = async (code: string): Promise<boolean> => {
    setIsLoading(true);
    setError(null);
    setAuthError(null);

    try {
      const response = await fetch(`${API_BASE_URL}/auth/google/callback`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'include',
        body: JSON.stringify({ code }),
      });

      if (!response.ok) {
        console.error('Google OAuth callback failed:', response.statusText);
        setAuthError('Google login failed. Please try again.');
        setIsLoading(false);
        return false;
      }

      const data = await response.json();

      if (data?.access_token) {
        const authTokens: AuthTokens = {
          access_token: data.access_token,
          token_type: data.token_type || 'bearer',
          expires_in: data.expires_in,
        };
        return await completeGoogleSession(authTokens, data.email, 'session');
      } else {
        console.error('Google login failed: No access token in response');
        setAuthError('Google login failed. Please try again.');
        setIsLoading(false);
        return false;
      }
    } catch (googleErr) {
      console.error('Google login error:', googleErr);
      authState.setAuthReady(false);
      setAuthError('Google login failed. Please try again.');
      setIsLoading(false);
      return false;
    }
  };

  /**
   * Native (Capacitor) Google Sign-In: exchange the on-device Google ID token
   * at POST /auth/google/mobile. When the account doesn't exist yet and
   * createIfMissing=false, resolves with needsConfirmation so the login page
   * can ask the user before creating an account (it then retries with true).
   */
  const loginWithNativeGoogle = async (
    idToken: string,
    createIfMissing: boolean
  ): Promise<{ ok: boolean; needsConfirmation?: boolean; email?: string }> => {
    setIsLoading(true);
    setError(null);
    setAuthError(null);

    try {
      const response = await fetch(`${API_BASE_URL}/auth/google/mobile`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          id_token: idToken,
          create_if_missing: createIfMissing,
        }),
      });

      if (!response.ok) {
        console.error('Google mobile login failed:', response.statusText);
        setAuthError('Google login failed. Please try again.');
        setIsLoading(false);
        return { ok: false };
      }

      const data = await response.json();

      if (data?.account_exists === false) {
        setIsLoading(false);
        return { ok: false, needsConfirmation: true, email: data.email };
      }

      const tokenData = data?.tokens;
      if (tokenData?.access_token) {
        const authTokens: AuthTokens = {
          access_token: tokenData.access_token,
          token_type: tokenData.token_type || 'bearer',
          expires_in: tokenData.expires_in,
          refresh_token: tokenData.refresh_token || undefined,
        };
        const ok = await completeGoogleSession(
          authTokens,
          data?.user?.email,
          'local'
        );
        return { ok };
      }

      console.error('Google mobile login failed: no tokens in response');
      setAuthError('Google login failed. Please try again.');
      setIsLoading(false);
      return { ok: false };
    } catch (nativeErr) {
      console.error('Native Google login error:', nativeErr);
      authState.setAuthReady(false);
      setAuthError('Google login failed. Please try again.');
      setIsLoading(false);
      return { ok: false };
    }
  };

  const logout = () => {
    // Preserve the authenticated user's accent color for anonymous use
    // Read directly from storage before clearing tokens to avoid authentication check issues
    const prefs = userPrefs.get();


    const currentAccentColor = prefs.accentColor;


    if (
      currentAccentColor &&
      ['gray', 'blue', 'green', 'red', 'violet', 'orange'].includes(
        currentAccentColor
      )
    ) {
      // Only set the flag if we're actually changing the anonymous color
      const currentAnonymousColor = prefs.accentColor;
      if (currentAccentColor !== currentAnonymousColor) {

        userPrefs.set({
          accentColor: currentAccentColor,
        });
      }
    }

    setUser(null);
    setTokens(null);
    userCache.clear();
    localStorage.removeItem('auth_tokens');
    localStorage.removeItem('token_expiry');
    sessionStorage.removeItem('auth_tokens');
    userPrefs.setRememberSession(false);
    userPrefs.setSavedUsername('');
    sessionStorage.removeItem('just_logged_in');
    sessionStorage.removeItem('models_preloaded');
    sessionStorage.removeItem('anonymous_migration_completed');

    // Clear model selection to prevent leaking previous user's provider choice
    modelSelections.clear();

    // Set flag to prevent auto-login after explicit logout
    sessionStorage.setItem('just_logged_out', 'true');

    // Log final localStorage state before redirect
    delete api.defaults.headers.common['Authorization'];
    authState.setAuthReady(false);


    window.location.href = '/';
  };

  const getAuthHeader = () => {
    if (tokens?.access_token) {
      return { Authorization: `Bearer ${tokens.access_token}` };
    }
    return { Authorization: '' };
  };

  const enableOfflineMode = (enable: boolean) => {
    setIsOfflineMode(enable);
    localStorage.setItem('offline_mode', enable ? 'true' : 'false');

    if (enable) {
      const cachedUser = uiState.getCachedUser();
      if (cachedUser) {
        try {
          setUser(cachedUser as unknown as User);
        } catch (e) {
          console.error('Failed to parse cached user for offline mode', e);
        }
      }
    } else {
      checkAuth().catch(console.error);
    }
  };

  const ensureModelsLoaded = useCallback(async () => {
    if (!modelsPreloaded && (user || isOfflineMode) && !isLoading) {
      try {
        // Use refresh=false for faster cached loading during auth
        await getModels(false, undefined, false);
        setModelsPreloaded(true);
        sessionStorage.setItem('models_preloaded', 'true');
      } catch (error) {
        console.error('Error loading models:', error);
      }
    }
  }, [modelsPreloaded, user, isOfflineMode, isLoading]);

  // Load tokens from localStorage on mount
  useEffect(() => {
    const authInitKey = 'auth_init_in_progress';
    const isDevelopment = import.meta.env.DEV;

    try {
      // Check for Google OAuth tokens in URL parameters (from backend redirect)
      const urlParams = new URLSearchParams(window.location.search);
      const accessTokenFromUrl = urlParams.get('access_token');
      const tokenTypeFromUrl = urlParams.get('token_type');

      if (accessTokenFromUrl) {
        // Create tokens object from URL parameters
        const oauthTokens: AuthTokens = {
          access_token: accessTokenFromUrl,
          token_type: tokenTypeFromUrl || 'bearer',
        };

        // Store tokens in sessionStorage (Google OAuth doesn't use rememberMe by default)
        sessionStorage.setItem('auth_tokens', JSON.stringify(oauthTokens));
        sessionStorage.setItem('just_logged_in', 'true');
        sessionStorage.removeItem('just_logged_out'); // Clear logout flag

        // Set tokens in state
        setTokens(oauthTokens);
        storeTokenExpiry(oauthTokens);

        // Set authorization header
        api.defaults.headers.common['Authorization'] = `Bearer ${accessTokenFromUrl}`;

        // Clean URL by removing token parameters
        const cleanUrl = window.location.pathname;
        window.history.replaceState({}, document.title, cleanUrl);

        // CRITICAL: Keep loading state and auth NOT ready until everything is loaded
        setIsLoading(true);
        authState.setAuthReady(false);

        // Load user data and workspace BEFORE marking auth as ready
        getCurrentUser()
          .then(async (userData) => {
            if (userData) {
              // CRITICAL: Set user first and wait for state to update
              setUser(userData as User);
              uiState.setCachedUser(userData);

              // Wait for React to flush the state update
              await new Promise(resolve => setTimeout(resolve, 50));

              // Load workspace after user data
              try {
                const workspace = await getDefaultWorkspace(true);
                // Save to localStorage
                uiState.setCurrentWorkspace(workspace as unknown as Record<string, unknown>);
                // Dispatch workspace-loaded event
                window.dispatchEvent(new CustomEvent('workspace-loaded', {
                  detail: workspace
                }));

                // Short delay to ensure everything is persisted
                await new Promise(resolve => setTimeout(resolve, 50));
              } catch (workspaceError) {
                console.error('❌ Error loading workspace after Google OAuth:', workspaceError);
                // Continue even if workspace fails
              }

              // NOW mark auth as ready - user state is committed, everything is loaded
              authState.setAuthReady(true);
              window.dispatchEvent(new CustomEvent('auth-ready'));

              // Final delay to ensure authReady propagates
              await new Promise(resolve => setTimeout(resolve, 50));
            } else {
              console.error('❌ Failed to load user data after Google OAuth');
              // Clear tokens and redirect to login
              sessionStorage.removeItem('auth_tokens');
              sessionStorage.removeItem('just_logged_in');
              navigateToLogin();
            }
            setIsLoading(false);
          })
          .catch(error => {
            console.error('❌ Error loading user after Google OAuth:', error);
            // Clear tokens and redirect to login
            sessionStorage.removeItem('auth_tokens');
            sessionStorage.removeItem('just_logged_in');
            setIsLoading(false);
            navigateToLogin();
          });

        return;
      }

      // In development, if we already have valid tokens AND user, skip full re-initialization
      if (isDevelopment && user && (tokens?.access_token || localStorage.getItem('auth_tokens') || sessionStorage.getItem('auth_tokens'))) {
        setIsLoading(false);
        return;
      }

      // In development, check if auth init is already in progress
      if (isDevelopment && window[authInitKey]) {
        return;
      }

      window[authInitKey] = true;
      authState.setAuthReady(false);
      setIsLoading(true);

      if (isLoginPage()) {
        setIsLoading(false);
        window[authInitKey] = false;
        return;
      }

      const justLoggedIn = sessionStorage.getItem('just_logged_in') === 'true';
      if (justLoggedIn) {
        // If user is already loaded (from Google OAuth flow), we're done
        if (user) {
          setIsLoading(false);
          authState.setAuthReady(true);
          window.dispatchEvent(new CustomEvent('auth-ready'));

          // Clear the just_logged_in flag after a delay
          setTimeout(() => {
            sessionStorage.removeItem('just_logged_in');
          }, 5000);
          window[authInitKey] = false;
          return;
        }

        // User not loaded yet - need to load it
        // Don't return - continue to load user via checkAuth
      }

      let foundTokens = false;
      const storedTokens = localStorage.getItem('auth_tokens');
      if (storedTokens) {
        try {
          const parsedTokens = JSON.parse(storedTokens);
          setTokens(parsedTokens);
          foundTokens = true;
          if (parsedTokens.access_token) {
            api.defaults.headers.common['Authorization'] =
              `Bearer ${parsedTokens.access_token}`;
          }
        } catch (e) {
          console.error('Failed to parse stored tokens', e);
          localStorage.removeItem('auth_tokens');
        }
      }

      if (!foundTokens) {
        const sessionTokens = sessionStorage.getItem('auth_tokens');
        if (sessionTokens) {
          try {
            const parsedTokens = JSON.parse(sessionTokens);
            setTokens(parsedTokens);
            foundTokens = true;
            if (parsedTokens.access_token) {
              api.defaults.headers.common['Authorization'] =
                `Bearer ${parsedTokens.access_token}`;
            }
          } catch (e) {
            console.error('Failed to parse session tokens', e);
            sessionStorage.removeItem('auth_tokens');
          }
        }
      }

      const offline = localStorage.getItem('offline_mode') === 'true';
      if (offline) {
        setIsOfflineMode(true);
        setIsLoading(false);

        const cachedUser = uiState.getCachedUser();
        if (cachedUser) {
          try {
            setUser(cachedUser as unknown as User);
          } catch (e) {
            console.error('Failed to parse cached user', e);
          }
        }

        authState.setAuthReady(true);
        window[authInitKey] = false;
        return;
      }

      if (foundTokens) {
        // Don't set a pending user - wait for actual authentication
        checkAuth().finally(() => {
          window[authInitKey] = false;
        });
      } else {
        // Try session cookie fallback when no stored tokens found
        trySessionCookieAuth().finally(() => {
          window[authInitKey] = false;
        });
      }

      const safetyTimeout = setTimeout(() => {
        if (isLoading) {
          setIsLoading(false);
          window[authInitKey] = false;
        }
      }, 5000);

      return () => {
        clearTimeout(safetyTimeout);
        window[authInitKey] = false;
      };
    } catch (error) {
      console.error('Error during auth initialization:', error);
      setIsLoading(false);
      setAuthError('Authentication initialization failed');
      window[authInitKey] = false;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are intentionally limited
  }, []);

  // Track user activity for smart token refresh
  useEffect(() => {
    const updateActivity = () => {
      lastActivityRef.current = Date.now();
    };

    const events = ['mousedown', 'keydown', 'scroll', 'touchstart'];
    events.forEach(event => {
      window.addEventListener(event, updateActivity, { passive: true });
    });

    return () => {
      events.forEach(event => {
        window.removeEventListener(event, updateActivity);
      });
    };
  }, []);

  // Apply the user's saved language whenever they become authenticated,
  // not just on explicit login. Session-resume (a refresh while a valid
  // token sits in localStorage) and cached-user fast path both skip the
  // login handler, so without this effect the UI stays on whatever
  // i18next's LanguageDetector resolved at cold init (typically 'en' from
  // navigator) until the user opens Settings — which mounts SettingsTab
  // and pulls settings_general for its own reasons. We refresh both
  // language and accent so the whole UI catches up the moment the auth
  // restore finishes.
  useEffect(() => {
    if (!user?.id) return;
    let cancelled = false;
    (async () => {
      // Retry a few times: on a freshly cleared cache the user lands here via
      // session-cookie restore while the gateway/backend may still be cold
      // (or its shared circuit breaker is briefly open). A single silent
      // failure here is exactly what leaves the UI stuck on the browser's
      // English instead of the user's saved Croatian, so we give the backend
      // a couple of chances before giving up.
      for (let attempt = 0; attempt < 3 && !cancelled; attempt++) {
        try {
          const settingsResult = await Promise.all([
            getUserSettings(),
            getGeneralSettings(),
          ]);
          if (cancelled) return;
          await applyLocaleFromGeneralSettings(settingsResult);
          return;
        } catch (err) {
          // Settings may legitimately fail on offline mode / cold backend —
          // a console hint is enough, the UI keeps its current language.
          console.warn(
            `Failed to apply locale on auth restore (attempt ${attempt + 1}/3):`,
            err
          );
          await new Promise((resolve) => setTimeout(resolve, 1500));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user?.id]);

  // Set up token refresh interval with activity awareness
  useEffect(() => {
    if (isLoginPage()) {
      return;
    }

    if (!tokens?.access_token || isOfflineMode) return;

    const validateInitialToken = async () => {
      if (isLoading || !tokens?.access_token) return;

      try {
        setIsLoading(true);
        const currentUser = await getCurrentUser();

        if (currentUser) {
          setUser(currentUser as User);
          authState.setAuthReady(true);
        } else {
          await handleRefreshToken();
        }
      } catch (error) {
        console.error('Error during initial token validation:', error);
        await handleRefreshToken();
      } finally {
        setIsLoading(false);
      }
    };

    // Only validate initial token for remember-me users (others already validated on mount)
    if (rememberSession) {
      validateInitialToken().catch(console.error);
    }

    // Proactive token refresh: check every 60 seconds if token needs refresh.
    // Token lasts 30 min, refresh threshold is 5 min before expiry.
    // Reduced from 5-min to 1-min interval because Chrome throttles background
    // tab timers, and a 5-min gap can miss the refresh window entirely.
    const checkAndRefresh = () => {
      const tokenExpiry = localStorage.getItem('token_expiry');
      if (tokenExpiry) {
        const timeUntilExpiry = parseInt(tokenExpiry) - Date.now();
        // Refresh if less than 5 minutes remain or already expired
        if (timeUntilExpiry <= 5 * 60 * 1000) {
          handleRefreshToken().catch(console.error);
        }
      }
    };

    const refreshInterval = setInterval(checkAndRefresh, 60 * 1000);

    // Also refresh immediately when tab becomes visible again (user returns
    // after background — browser may have throttled the interval timer)
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        checkAndRefresh();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      clearInterval(refreshInterval);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are intentionally limited
  }, [tokens, isOfflineMode]);

  // Function to refresh user data
  const refreshUser = async () => {
    try {
      const currentUser = await getCurrentUser();
      if (currentUser) {
        setUser(currentUser as User);
        uiState.setCachedUser(currentUser);
      }
    } catch (error) {
      console.error('Error refreshing user data:', error);
    }
  };

  const contextValue: AuthContextType = {
    user,
    tokens,
    isLoading,
    error,
    authError,
    isAuthenticated: (!!user && authState.authReady) || isOfflineMode,
    isOfflineMode,
    backendUnavailable,
    authState, // Add authState to context value
    login,
    loginWithGoogle,
    loginWithNativeGoogle,
    logout,
    getAuthHeader,
    enableOfflineMode,
    ensureModelsLoaded,
    refreshUser,
  };

  return (
    <AuthContext.Provider value={contextValue}>{children}</AuthContext.Provider>
  );
};

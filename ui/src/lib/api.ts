import { AuthTokens, ChatRequest, ChatStreamResponse, } from '@/types';
import axios, { AxiosRequestConfig, AxiosRequestHeaders, AxiosResponse, InternalAxiosRequestConfig, } from 'axios';
import { navigateToLogin, isPublicRoute } from '@/lib/navigation';
import { loadingService } from '@/lib/loading-service';
import { LoadingErrorHandler } from '@/lib/loading-error-handler';
import { performanceMonitor } from '@/lib/performance-monitor';
// Dynamic import to break circular dependency (connection-lost-dialog imports API_BASE_URL from this file)
let _connectionLostDialog: typeof import('@/components/ui/connection-lost-dialog').connectionLostDialog | null = null;
async function getConnectionLostDialog() {
  if (!_connectionLostDialog) {
    const mod = await import('@/components/ui/connection-lost-dialog');
    _connectionLostDialog = mod.connectionLostDialog;
  }
  return _connectionLostDialog;
}

// Dynamic API base URL based on hostname and environment
function getApiBaseUrl(): string {
  // Check if we're in a browser environment
  if (typeof window !== 'undefined') {
    const hostname = window.location.hostname;
    const protocol = window.location.protocol;

    // Electron desktop mode with file:// protocol - use cloud API
    // In file:// mode, hostname is empty or undefined
    if (protocol === 'file:' || (!hostname && 'electronAPI' in window)) {
      console.log('[API] Electron file:// mode detected, using cloud API');
      return 'https://api.scrapalot.app/api/v1';
    }

    // Production domains - use backend API subdomain with /api/v1 prefix
    if (hostname === 'scrapalot.app' || hostname === 'www.scrapalot.app') {
      return 'https://api.scrapalot.app/api/v1';
    }

    // For other production domains, construct URL dynamically
    if (
      hostname !== 'localhost' &&
      hostname !== '127.0.0.1' &&
      !hostname.includes('192.168')
    ) {
      return `${protocol}//${hostname}/api/v1`;
    }

    // Local development / E2E testing - use gateway
    return 'http://localhost:8080/api/v1';
  }

  // Development fallback or environment variable
  const envApiUrl = import.meta.env.VITE_API_BASE_URL;
  return envApiUrl || 'http://localhost:8080/api/v1';
}

export const API_BASE_URL = getApiBaseUrl();

// Production static-file host (profile pictures, uploads). Single source of
// truth for the remote origin used as a local-dev fallback when a file is not
// present on the locally-configured static host. Matches the host
// getApiBaseUrl() returns in production. In production this equals
// getStaticBaseUrl(), so the fallback is a no-op there.
export const PROD_STATIC_BASE_URL = 'https://api.scrapalot.app';

// Returns the base URL for static file serving (e.g. profile pictures).
// In local dev the gateway (8080) doesn't proxy /upload/* — use VITE_STATIC_BASE_URL if set.
//
// Production guard: Vite loads `.env` in EVERY mode (prod included) and
// the dev `.env` ships VITE_STATIC_BASE_URL=http://localhost:8090. If
// `.env.production` doesn't override it, the prod bundle bakes a
// localhost URL into every <img src=…profile_pictures/…> and the prod
// site silently 404s. So when we're running under https:// (any prod-
// like origin) and the env value points at a loopback host, drop it
// and fall back to API_BASE_URL — which IS guaranteed correct in prod
// because that's the variable users actually maintain.
export const getStaticBaseUrl = () => {
  const envVal = import.meta.env.VITE_STATIC_BASE_URL || '';
  const isLoopback = /(^https?:\/\/)?(localhost|127\.0\.0\.1)(:\d+)?/.test(envVal);
  const onHttpsOrigin = typeof window !== 'undefined' && window.location.protocol === 'https:';
  if (envVal && !(onHttpsOrigin && isLoopback)) return envVal;
  return API_BASE_URL.replace('/api/v1', '');
};

// Authentication status tracking
export const authState = {
  authReady: false,
  authReadyPromise: null as Promise<void> | null,
  authReadyResolve: null as ((value?: unknown) => void) | null,

  setAuthReady(ready: boolean) {
    this.authReady = ready;

    // When auth becomes ready, resolve any pending promise
    if (ready && this.authReadyResolve) {
      this.authReadyResolve();
      this.authReadyPromise = null;
      this.authReadyResolve = null;
    }

    // If auth is not ready, create a new promise for future waiters
    if (!ready && !this.authReadyPromise) {
      this.authReadyPromise = new Promise<void>(resolve => {
        this.authReadyResolve = resolve;
      });
    }
  },

  // Add a method to wait for auth to be ready with timeout
  async waitForAuthReady(timeoutMs = 2000): Promise<boolean> {
    // If already ready, return immediately
    if (this.authReady) return true;

    // If no promise exists, create one
    if (!this.authReadyPromise) {
      this.authReadyPromise = new Promise<void>(resolve => {
        this.authReadyResolve = resolve;
      });
    }

    try {
      // Wait for auth ready or timeout
      const timeoutPromise = new Promise<void>((_, reject) => {
        setTimeout(() => reject(new Error('Auth wait timeout')), timeoutMs);
      });

      await Promise.race([this.authReadyPromise, timeoutPromise]);
      return true;
    } catch (e) {
      return false;
    }
  },
};

// Endpoint-specific timeout configuration (in milliseconds)
const ENDPOINT_TIMEOUTS = {
  // Document processing endpoints - very long timeout
  '/documents/upload': 300000,        // 5 minutes
  '/documents/upload_async': 300000,  // 5 minutes
  '/documents/process': 300000,       // 5 minutes

  // Job status polling - long timeout (shouldn't fail during processing)
  '/jobs/': 180000,                   // 3 minutes
  '/jobs/my-active': 180000,          // 3 minutes

  // Chat/streaming endpoints - moderate timeout
  '/chat/': 120000,                   // 2 minutes
  '/llm-inference/': 120000,          // 2 minutes

  // Paper generation - long timeout (sequential LLM section generation)
  '/papers/generate': 180000,         // 3 minutes

  // Edge-TTS synthesis (request interceptor stomps per-call timeout otherwise)
  '/tts/': 180000,                    // 3 minutes

  // Voice mode — multipart WAV upload over slow client networks easily
  // exceeds the 60 s default before the server even sees the bytes.
  '/voice/': 180000,                  // 3 minutes

  // Settings and management - moderate timeout
  '/settings/': 90000,                // 1.5 minutes
  '/model-providers/': 90000,         // 1.5 minutes

  // Admin Data Inspector endpoints — Neo4j graph aggregates over the whole
  // corpus are slow. Knowledge-gaps runs five heavy queries back-to-back;
  // housekeeping health-check walks the entire hierarchy. Give them enough
  // headroom that a cold query on a multi-hundred-book graph doesn't trip
  // the default 1-minute timeout.
  '/graph/knowledge-gaps': 300000,    // 5 minutes
  '/graph/housekeeping/': 300000,     // 5 minutes
  '/graph/health': 180000,            // 3 minutes
  '/admin/inspector/': 180000,        // 3 minutes

  // Default for all other endpoints
  'default': 60000                    // 1 minute
};

/**
 * Get timeout for a specific endpoint
 */
function getEndpointTimeout(url?: string): number {
  if (!url) return ENDPOINT_TIMEOUTS.default;

  // Check for specific endpoint matches
  for (const [endpoint, timeout] of Object.entries(ENDPOINT_TIMEOUTS)) {
    if (endpoint !== 'default' && url.includes(endpoint)) {
      return timeout;
    }
  }

  return ENDPOINT_TIMEOUTS.default;
}

// Create a shared axios instance with auth
const api = axios.create({
  baseURL: API_BASE_URL,
  withCredentials: true,
  timeout: 60000, // Default 60-second timeout (will be overridden per-request)
});

// Note: Document uploads use fetch() with custom timeout handling in the upload component

// Export the api instance so it can be used by other modules
export { api };
// Also export as apiClient for compatibility
export const apiClient = api;

// Request deduplication system
interface PendingRequest {
  timestamp: number;
  promise: Promise<unknown>;
}

const pendingRequests: Record<string, PendingRequest> = {};
// Increase the deduplication window to reduce redundant calls
const DEDUPE_WINDOW = 5000; // 5-second window to deduplicate identical GET requests

// Simple response cache
interface CachedResponse {
  data: unknown;
  timestamp: number;
}

const responseCache: Record<string, CachedResponse> = {};
const CACHE_TTL = 60000; // 1-minute cache TTL for GET requests

// Track if connection lost dialog is currently showing to prevent multiple dialogs
let isConnectionDialogShowing = false;
let isSilentRetrying = false;

/**
 * Show a "session expired" toast and redirect to login after a visible delay.
 * Exported so auth-context.tsx can reuse the same UX instead of silent redirects.
 */
export const showSessionExpiredAndRedirect = async (): Promise<void> => {
  try {
    const [{ toast }, i18nModule] = await Promise.all([
      import('@/lib/toast-compat'),
      import('@/i18n')
    ]);
    const i18n = i18nModule.default;
    toast({
      title: i18n.t('general.errors.sessionExpired'),
      description: i18n.t('general.errors.pleaseLoginAgain'),
      variant: 'destructive',
      duration: 5000,
    });
  } catch {
    console.error('Session expired, redirecting to login');
  }

  localStorage.removeItem('auth_tokens');
  sessionStorage.removeItem('auth_tokens');

  // Clear the HTTP-only refresh cookie SERVER-SIDE. JS can't touch it, and a
  // stale cookie (e.g. left over from a different/deleted account on the same
  // device — the cookie-refresh fallback then keeps hitting "User not found")
  // would survive a client-only logout and silently log the user out again.
  // Fire-and-forget; never block the redirect on it.
  try {
    void fetch(`${API_BASE_URL}/users/token/logout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
    }).catch(() => { /* best effort */ });
  } catch {
    /* ignore */
  }

  // Disconnect STOMP to prevent reconnection loop with expired token
  try {
    const { default: stompService } = await import('@/lib/stomp-service');
    stompService.disconnect();
  } catch {
    // stomp-service may not be loaded yet
  }

  // Redirect to login from any authenticated page
  if (typeof window !== 'undefined') {
    if (!isPublicRoute(window.location.pathname)) {
      // Stash the current location so the login page can resume the
      // user's work after re-auth instead of dropping them on /dashboard.
      try {
        const target = window.location.pathname + window.location.search + window.location.hash;
        sessionStorage.setItem('post_login_redirect', target);
      } catch {
        /* private mode / quota exceeded — non-critical */
      }
      // 3s delay so the toast is clearly visible before full page navigation
      setTimeout(() => navigateToLogin(), 3000);
    }
  }
};

// Helper function to delay execution
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Silent health check - pings the backend without showing UI
const silentHealthCheck = async (): Promise<boolean> => {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    const response = await fetch(`${API_BASE_URL}/`, {
      method: 'GET',
      signal: controller.signal,
      headers: { 'Accept': 'application/json' },
    });
    clearTimeout(timeoutId);
    return !!response;
  } catch {
    return false;
  }
};

// Silent retry config: 3 attempts, 3s apart (~10s total before showing dialog)
const SILENT_RETRY_ATTEMPTS = 3;
const SILENT_RETRY_DELAY_MS = 3000;

// Helper function to handle connection errors with retry logic
const handleConnectionErrorWithRetry = async (
  error: unknown,
  _originalConfig: InternalAxiosRequestConfig
): Promise<unknown> => {
  // Prevent multiple dialogs or silent retries
  if (isConnectionDialogShowing || isSilentRetrying) {
    return Promise.reject(error);
  }

  // If on a public page (anything except /dashboard), just reject the error
  if (typeof window !== 'undefined' && window.location.pathname !== '/dashboard') {
    return Promise.reject(error);
  }

  isSilentRetrying = true;
  window.dispatchEvent(new CustomEvent('serviceUpdating'));

  // Defer silent retry + dialog to next event loop tick to prevent blocking UI
  setTimeout(async () => {
    try {
      // Silent retry: check backend health a few times before showing the dialog
      for (let i = 0; i < SILENT_RETRY_ATTEMPTS; i++) {
        await delay(SILENT_RETRY_DELAY_MS);
        const isHealthy = await silentHealthCheck();
        if (isHealthy) {
          console.log(`[ConnectionRetry] Backend recovered after silent retry ${i + 1}/${SILENT_RETRY_ATTEMPTS}`);
          isSilentRetrying = false;
          window.dispatchEvent(new CustomEvent('serviceUpdateDone'));
          // Dispatch connectionRestored so components can reload data
          window.dispatchEvent(new CustomEvent('connectionRestored'));
          return;
        }
        console.log(`[ConnectionRetry] Silent retry ${i + 1}/${SILENT_RETRY_ATTEMPTS} failed, backend still down`);
      }

      // Backend still down after silent retries - show the dialog
      isSilentRetrying = false;
      window.dispatchEvent(new CustomEvent('serviceUpdateDone'));
      isConnectionDialogShowing = true;

      const dialog = await getConnectionLostDialog();
      const userChoice = await dialog.show();

      if (userChoice === 'logout') {
        // Clear auth tokens and redirect to login
        sessionStorage.removeItem('auth_tokens');
        localStorage.removeItem('auth_tokens');
        navigateToLogin();
      }
      // User chose to stay (X close) - just close the dialog, don't reload

      // Hide dialog and reset flag
      dialog.hide();
      isConnectionDialogShowing = false;
    } catch (dialogError) {
      // If dialog itself fails, fall back to simple reject
      console.error('Error showing connection dialog:', dialogError);
      isSilentRetrying = false;
      window.dispatchEvent(new CustomEvent('serviceUpdateDone'));
      isConnectionDialogShowing = false;
    }
  }, 0);

  // Immediately reject the error to prevent blocking the UI
  return Promise.reject(error);
};

// Check if a response is cached and still valid
const getCachedResponse = (key: string): unknown | null => {
  const cached = responseCache[key];
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.data;
  }
  return null;
};

// Cache a response
const cacheResponse = (key: string, data: unknown): void => {
  // Don't cache error responses or empty data
  if (!data) return;

  // Don't cache certain endpoints
  if (
    key.includes('/users/token') ||
    key.includes('/login') ||
    key.includes('/service-logs')
  )
    return;

  responseCache[key] = {
    data,
    timestamp: Date.now(),
  };
};

// Clear cache for specific endpoints or all caches
export const clearCache = (urlPattern?: string): void => {
  if (!urlPattern) {
    // Clear all caches
    Object.keys(responseCache).forEach(key => delete responseCache[key]);
    return;
  }

  // Clear cache for matching URLs
  Object.keys(responseCache).forEach(key => {
    if (key.includes(urlPattern)) {
      delete responseCache[key];
    }
  });

  // Special case: if upload-related endpoints are called, clear document collection caches
  if (
    urlPattern.includes('/documents/upload') ||
    urlPattern.includes('/upload_stream')
  ) {
    Object.keys(responseCache).forEach(key => {
      if (
        key.includes('/documents/collection/') ||
        key.includes('/collections/')
      ) {
        delete responseCache[key];
      }
    });
  }
};

// Function to create a request key
const createRequestKey = (config: AxiosRequestConfig): string => {
  const { method, url, params } = config;
  // Only deduplicate GET requests
  if (method?.toLowerCase() !== 'get') return '';

  // Create a key based on the URL and params
  return `${method}:${url}:${JSON.stringify(params || {})}`;
};

// Define a type for promise callbacks
interface PromiseCallbacks {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
}

// Extend InternalAxiosRequestConfig instead of AxiosRequestConfig to make it compatible with interceptors
interface ExtendedAxiosRequestConfig extends InternalAxiosRequestConfig {
  __promiseCallbacks?: PromiseCallbacks;
  __loadingId?: string;
  __performanceId?: string;
}

// Add a request interceptor to include auth token and handle special request types
api.interceptors.request.use(
  async (config: ExtendedAxiosRequestConfig) => {
    try {
      // Apply endpoint-specific timeout
      const endpointTimeout = getEndpointTimeout(config.url);
      if (endpointTimeout !== config.timeout) {
        config.timeout = endpointTimeout;
      }

      // Desktop mode: Inject desktop API key
      if (typeof window !== 'undefined' && 'electronAPI' in window) {
        try {
          const { getDesktopApiKey } = await import('@/lib/electron-api');
          const apiKey = await getDesktopApiKey();
          if (apiKey) {
            config.headers['X-Desktop-Api-Key'] = apiKey;
          }
        } catch (error) {
          console.error('Failed to inject desktop API key:', error);
        }
      }

      // Check for cache control headers
      const skipCache = config.headers?.['x-skip-cache'] === 'true';

      // Determine if this is an auth-related api_base
      // that doesn't need existing authentication
      const isAuthEndpoint =
        config.url?.includes('/users/token') ||
        config.url?.includes('/login') ||
        config.url?.includes('/auth/') ||
        config.url?.includes('/desktop/'); // Desktop endpoints don't need JWT auth

      // For non-auth endpoints, check if auth is ready
      if (!isAuthEndpoint && !authState.authReady) {
        // Quick check: if we have tokens in storage, don't wait for auth
        const hasTokens =
          sessionStorage.getItem('auth_tokens') ||
          localStorage.getItem('auth_tokens');

        // Only wait for auth if we don't have tokens AND auth is initializing
        if (!hasTokens) {
          // Reduced timeout (2s instead of 5s) to prevent long UI blocks
          try {
            const authWaitPromise = authState.waitForAuthReady();
            const timeoutPromise = new Promise((_, reject) => {
              setTimeout(() => reject(new Error('Auth wait timeout')), 2000);
            });

            await Promise.race([authWaitPromise, timeoutPromise]);
          } catch (waitError) {
            console.warn(
              `Auth wait timed out for ${config.url}, checking token directly`
            );
            // Fall through to the direct token check below
          }
        }
      }

      // Get an access token from storage
      let accessToken: string | null = null;

      // Check session storage first (current session)
      const sessionTokensJson = sessionStorage.getItem('auth_tokens');
      if (sessionTokensJson) {
        try {
          const tokens = JSON.parse(sessionTokensJson);
          if (tokens && typeof tokens.access_token === 'string') {
            accessToken = tokens.access_token;
          }
        } catch (parseError) {
          console.error('Failed to parse session tokens:', parseError);
          sessionStorage.removeItem('auth_tokens');
        }
      }

      // If not in session storage, check local storage (for remembered logins)
      if (!accessToken) {
        const localTokensJson = localStorage.getItem('auth_tokens');
        if (localTokensJson) {
          try {
            const tokens = JSON.parse(localTokensJson);
            if (tokens && typeof tokens.access_token === 'string') {
              accessToken = tokens.access_token;
            }
          } catch (parseError) {
            console.error('Failed to parse local tokens:', parseError);
            localStorage.removeItem('auth_tokens');
          }
        }
      }

      // Add an auth header if we have a token
      if (accessToken) {
        config.headers = config.headers || ({} as AxiosRequestHeaders);
        config.headers.Authorization = `Bearer ${accessToken}`;
      }

      // Start loading tracking for HTTP requests (except auth endpoints)
      if (!isAuthEndpoint && !skipCache) {
        (config as ExtendedAxiosRequestConfig).__loadingId = loadingService.startHttpRequest(config.url || 'unknown');

        // Start performance tracking
        (config as ExtendedAxiosRequestConfig).__performanceId = performanceMonitor.startMetric(
          'api_request',
          `${config.method?.toUpperCase() || 'REQUEST'} ${config.url || 'unknown'}`,
          {
            method: config.method,
            url: config.url,
            hasAuth: !!config.headers?.Authorization
          },
          ['api', 'http']
        );
      }

      // Handle request deduplication for GET requests
      if (config.method?.toLowerCase() === 'get' && !skipCache) {
        const requestKey = createRequestKey(config);
        if (requestKey) {
          // First check cache
          const cachedResponse = getCachedResponse(requestKey);
          if (cachedResponse) {
            // Stop loading for cached responses
            if ((config as ExtendedAxiosRequestConfig).__loadingId) {
              loadingService.stopHttpRequest((config as ExtendedAxiosRequestConfig).__loadingId!);
            }
            
            // Complete performance tracking for cached responses
            if ((config as ExtendedAxiosRequestConfig).__performanceId) {
              performanceMonitor.completeMetric(
                (config as ExtendedAxiosRequestConfig).__performanceId!,
                'completed',
                { cached: true }
              );
            }
            return Promise.reject({
              __CACHED_RESPONSE__: true,
              data: cachedResponse,
            });
          }

          const now = Date.now();
          const existingRequest = pendingRequests[requestKey];

          // If there's already a pending request for this exact URL+params
          if (
            existingRequest &&
            now - existingRequest.timestamp < DEDUPE_WINDOW
          ) {
            // Stop loading for duplicate requests
            if ((config as ExtendedAxiosRequestConfig).__loadingId) {
              loadingService.stopHttpRequest((config as ExtendedAxiosRequestConfig).__loadingId!);
            }
            
            // Complete performance tracking for duplicate requests
            if ((config as ExtendedAxiosRequestConfig).__performanceId) {
              performanceMonitor.completeMetric(
                (config as ExtendedAxiosRequestConfig).__performanceId!,
                'completed',
                { deduplicated: true }
              );
            }
            // Return the existing promise to avoid duplicate requests
            return Promise.reject({
              __DUPLICATE_REQUEST__: true,
              promise: existingRequest.promise,
            });
          }

          // Store this request in the pending requests
          const requestPromise = new Promise((resolve, reject) => {
            // Store the resolve/reject functions to be called later
            (config as ExtendedAxiosRequestConfig).__promiseCallbacks = {
              resolve,
              reject,
            };
          });

          pendingRequests[requestKey] = {
            timestamp: now,
            promise: requestPromise,
          };

          // Clean up old pending requests
          Object.keys(pendingRequests).forEach(key => {
            if (now - pendingRequests[key].timestamp > DEDUPE_WINDOW * 2) {
              delete pendingRequests[key];
            }
          });
        }
      }

      return config;
    } catch (error) {
      console.error('Error in request interceptor:', error);
      return config;
    }
  },
  error => Promise.reject(error)
);

// Define interfaces for error rejection types with more specific typing
interface DuplicateRequestRejection {
  __DUPLICATE_REQUEST__: boolean;
  promise: Promise<unknown>;
}

interface CachedResponseRejection {
  __CACHED_RESPONSE__: boolean;
  data: unknown;
}

// Type guard functions
function isDuplicateRequestRejection(
  error: unknown
): error is DuplicateRequestRejection {
  return !!(
    error &&
    typeof error === 'object' &&
    '__DUPLICATE_REQUEST__' in error
  );
}

function isCachedResponseRejection(
  error: unknown
): error is CachedResponseRejection {
  return !!(
    error &&
    typeof error === 'object' &&
    '__CACHED_RESPONSE__' in error
  );
}

// Add a response interceptor to handle 401 errors and token refresh and handle deduplicated requests
api.interceptors.response.use(
  (response: AxiosResponse) => {
    // Stop loading for successful responses
    const config = response.config as ExtendedAxiosRequestConfig;
    if (config.__loadingId) {
      loadingService.stopHttpRequest(config.__loadingId);
    }

    // Complete performance tracking for successful responses
    if (config.__performanceId) {
      // Calculate response size safely - don't JSON.stringify binary data
      let responseSize: number;
      if (response.data instanceof ArrayBuffer) {
        responseSize = response.data.byteLength;
      } else if (response.data instanceof Blob) {
        responseSize = response.data.size;
      } else {
        try {
          responseSize = JSON.stringify(response.data).length;
        } catch {
          responseSize = 0;
        }
      }

      performanceMonitor.completeMetric(
        config.__performanceId,
        'completed',
        {
          status: response.status,
          statusText: response.statusText,
          responseSize,
          cached: false
        }
      );
    }

    // Cache successful GET responses (skip binary data)
    if (response.config.method?.toLowerCase() === 'get') {
      const requestKey = createRequestKey(response.config);
      // Don't cache binary data (ArrayBuffer, Blob)
      const isBinaryData = response.data instanceof ArrayBuffer || response.data instanceof Blob;
      if (requestKey && !isBinaryData) {
        cacheResponse(requestKey, response.data);

        // Resolve any pending requests for this same URL
        const pendingRequest = pendingRequests[requestKey];
        if (
          pendingRequest &&
          (response.config as ExtendedAxiosRequestConfig).__promiseCallbacks
        ) {
          // This is the original request, not a duplicate
          delete pendingRequests[requestKey];
        }
      }
    }

    return response;
  },
  async error => {
    // Stop loading for failed requests
    const config = error.config as ExtendedAxiosRequestConfig;
    if (config?.__loadingId) {
      loadingService.stopHttpRequest(config.__loadingId);
    }

    // Complete performance tracking for failed requests
    if (config?.__performanceId) {
      performanceMonitor.completeMetric(
        config.__performanceId,
        'failed',
        {
          error: error.message,
          status: error.response?.status,
          statusText: error.response?.statusText
        }
      );
    }

    // Handle any cached or duplicate response from the interceptor
    if (isDuplicateRequestRejection(error)) {
      try {
        const result = await error.promise;
        return { data: result, status: 200, statusText: 'OK (Deduplicated)' };
      } catch (e) {
        return Promise.reject(e);
      }
    }
    if (isCachedResponseRejection(error)) {
      return { data: error.data, status: 200, statusText: 'OK (Cached)' };
    }

    // Caller-canceled requests (AbortController.abort, React StrictMode double-mount,
    // navigation away while a fetch was in flight) are NOT a backend failure —
    // surface them silently. Without this guard the cancellation falls into the
    // network-error branch below and triggers the "service is updating" banner
    // for ~10s even though the backend is healthy.
    if (axios.isCancel(error) || error.code === 'ERR_CANCELED' || error.name === 'CanceledError') {
      return Promise.reject(error);
    }

    if (!error.config) {
      return Promise.reject(error);
    }

    // Enhanced error analysis and handling
    try {
      const operation = `${error.config.method?.toUpperCase() || 'REQUEST'} ${error.config.url || 'unknown'}`;
      const analysisResult = await LoadingErrorHandler.handle(error, operation);
      
      // Log structured error information for debugging
      if (process.env.NODE_ENV === 'development') {
        console.group(`[API Error] ${analysisResult.type.toUpperCase()}`);
        console.log('Operation:', operation);
        console.log('Error Type:', analysisResult.type);
        console.log('Recoverable:', analysisResult.recoverable);
        console.log('Retryable:', analysisResult.retryable);
        console.log('Timestamp:', new Date(analysisResult.timestamp).toISOString());
        if (analysisResult.originalError) {
          console.log('Original Error:', analysisResult.originalError);
        }
        console.groupEnd();
      }

      // Store error information on the error object for component-level handling
      error.__errorAnalysis = analysisResult;
    } catch (analysisError) {
      console.error('Error during error analysis:', analysisError);
    }

    // Handle connection errors with retry logic and dialog
    if (!error.response) {
      // Network errors (connection refused, timeout, etc.)
      const errorMessage = error.message || 'Network error';

      // Check for specific connection errors (connection refused, network error)
      if (
        errorMessage.includes('ERR_CONNECTION_REFUSED') ||
        errorMessage.includes('Network Error') ||
        errorMessage.includes('ECONNREFUSED')
      ) {
        // Backend is down - use retry logic with dialog
        const fullUrl = `${error.config?.baseURL || ''}${error.config?.url || ''}`;
        console.error('❌ HTTP Request Failed (Connection Refused)', {
          url: fullUrl,
          method: error.config?.method?.toUpperCase(),
          error: errorMessage,
          code: error.code,
          params: error.config?.params,
          headers: error.config?.headers ? {
            ...error.config.headers,
            Authorization: error.config.headers.Authorization ? '[REDACTED]' : undefined
          } : undefined,
        });

        // Skip retry if this is already a retry request to prevent infinite loops
        if (error.config?.__isRetryRequest) {
          return Promise.reject(error);
        }

        // Use the retry handler with dialog
        return handleConnectionErrorWithRetry(error, error.config);
      } else if (errorMessage.includes('timeout')) {
        // Timeout errors - show toast but don't retry automatically
        Promise.all([
          import('@/lib/toast-compat'),
          import('@/i18n')
        ])
          .then(([{ toast }, i18nModule]) => {
            const i18n = i18nModule.default;
            toast({
              title: i18n.t('general.errors.requestTimeoutTitle'),
              description: i18n.t('general.errors.requestTimeoutDescription'),
              variant: 'destructive',
            });
          })
          .catch(() => {
            console.error('Request timeout:', errorMessage);
          });
      } else {
        // Generic network error - use retry logic with dialog
        const fullUrl = `${error.config?.baseURL || ''}${error.config?.url || ''}`;
        console.error('❌ HTTP Request Failed (Network Error)', {
          url: fullUrl,
          method: error.config?.method?.toUpperCase(),
          error: errorMessage,
          code: error.code,
          params: error.config?.params,
        });

        // Skip retry if this is already a retry request to prevent infinite loops
        if (error.config?.__isRetryRequest) {
          return Promise.reject(error);
        }

        // Use the retry handler with dialog for generic network errors too
        return handleConnectionErrorWithRetry(error, error.config);
      }
    }

    // Handle "service is temporary unavailable" errors - show retry dialog, preserve tokens
    // 503 means "server is temporarily down", NOT "your session is invalid"
    if (error.response && (
      error.response.status === 502 ||
      error.response.status === 503 ||
      (error.response.data &&
       (String(error.response.data).toLowerCase().includes('service is temporary unavailable') ||
        String(error.response.data).toLowerCase().includes('service temporarily unavailable') ||
        String(error.response.data.detail || '').toLowerCase().includes('service is temporary unavailable') ||
        String(error.response.data.detail || '').toLowerCase().includes('service temporarily unavailable')))
    )) {
      console.warn('⚠️ Service temporarily unavailable:', error.response.status, error.response.data);

      // On any non-dashboard route the connection-lost dialog wasn't the
      // right UX (it forces a global retry banner), so we used to silently
      // reject. That left callers like the "Save to server" dialog with
      // *no* visible feedback when the gateway circuit breaker tripped to
      // 503 — the spinner stopped and the user saw nothing happen.
      // Surface a non-blocking toast instead so each call site's existing
      // catch path still sees the rejection and can clear its loading
      // state, while the user gets an actual reason.
      if (typeof window !== 'undefined' && window.location.pathname !== '/dashboard') {
        Promise.all([
          import('@/lib/toast-compat'),
          import('@/i18n'),
        ])
          .then(([{ toast }, i18nModule]) => {
            const i18n = i18nModule.default;
            toast({
              title: i18n.t('general.errors.serviceUnavailableTitle', 'Service temporarily unavailable'),
              description: i18n.t('general.errors.serviceUnavailableDescription', 'Please try again in a few seconds.'),
              variant: 'destructive',
            });
          })
          .catch(() => {
            console.error('Service unavailable:', error.response?.status);
          });
        return Promise.reject(error);
      }

      // Skip retry if this is already a retry request to prevent infinite loops
      if (error.config?.__isRetryRequest) {
        return Promise.reject(error);
      }

      // Show connection lost dialog with retry instead of clearing tokens
      return handleConnectionErrorWithRetry(error, error.config);
    }

    // Handle token refresh for 401 errors
    if (
      error.response &&
      error.response.status === 401 &&
      !error.config.__isRetryRequest &&
      error.config.url !== '/users/token' &&
      error.config.url !== '/auth/login'
    ) {
      // Skip refresh on public pages where auth is not needed
      if (isPublicRoute(window.location.pathname)) {
        return Promise.reject(error);
      }

      // Check if we're on dashboard with Google OAuth tokens in URL (don't redirect during OAuth flow)
      const urlParams = new URLSearchParams(window.location.search);
      if (window.location.pathname === '/dashboard' && urlParams.has('access_token')) {
        return Promise.reject(error);
      }

      // Check if we just logged in (Google OAuth initialization in progress)
      const justLoggedIn = sessionStorage.getItem('just_logged_in');
      if (justLoggedIn === 'true') {
        return Promise.reject(error);
      }

      // Check if we have tokens stored but not yet in headers (race condition)
      const hasStoredTokens = sessionStorage.getItem('auth_tokens') || localStorage.getItem('auth_tokens');
      if (hasStoredTokens && !error.config.headers.Authorization) {
        try {
          const tokens = JSON.parse(hasStoredTokens);
          if (tokens.access_token) {
            error.config.headers.Authorization = `Bearer ${tokens.access_token}`;
            error.config.__isRetryRequest = true;
            return api(error.config);
          }
        } catch (e) {
          console.error('Failed to parse stored tokens:', e);
        }
      }

      // Mark that we're retrying this request
      error.config.__isRetryRequest = true;

      try {
        const newTokens = await refreshToken();

        if (newTokens && newTokens.access_token) {
          // Update the auth header with the new token
          error.config.headers.Authorization = `Bearer ${newTokens.access_token}`;

          // Clear cache for this api_base
          if (error.config.url) {
            clearCache(error.config.url);
          }

          // Retry the original request with the new token
          return api(error.config);
        } else {
          // Token refresh failed. If the failure was transient (offline / 5xx),
          // keep the session and let the caller retry once the network is back —
          // do NOT log out, otherwise a flaky mobile connection drops a valid
          // login. Only a definitive auth rejection clears the session.
          if (wasLastRefreshTransient()) {
            return Promise.reject(error);
          }
          await showSessionExpiredAndRedirect();
          return Promise.reject(error);
        }
      } catch (refreshError) {
        console.error('Error refreshing token:', refreshError);
        if (wasLastRefreshTransient()) {
          return Promise.reject(error);
        }
        await showSessionExpiredAndRedirect();
        return Promise.reject(error);
      }
    }

    // Account no longer valid: a 403/404 on the IDENTITY endpoint (/users/me)
    // means the account behind this (still cryptographically valid) token was
    // deleted or disabled by an admin — there is no user to be. Unlike a
    // feature-403, the right move is to drop the session and send them to login
    // rather than leave them stranded on a dashboard that can't load their data.
    if (
      error.response &&
      (error.response.status === 403 || error.response.status === 404) &&
      typeof error.config?.url === 'string' &&
      error.config.url.includes('/users/me')
    ) {
      await showSessionExpiredAndRedirect();
      return Promise.reject(error);
    }

    // Handle 403 Forbidden - user doesn't have permission for THIS action.
    // 403 ≠ session expired. NEVER clear tokens or redirect to login.
    // The user is authenticated but lacks permission for the specific resource.
    //
    // `error.config._silent403` lets call sites opt out of the global
    // toast. Plan-gated endpoints (e.g. `/messages/conversations`,
    // which 403s for accounts below Pro) call us on every dashboard
    // load even when the feature is disabled, and surfacing a generic
    // "Access denied" banner for that legitimate gate scared users
    // mid-impersonation. Such endpoints set the flag and handle the
    // empty/unavailable case themselves.
    if (error.response && error.response.status === 403) {
      const silent = (error.config as { _silent403?: boolean } | undefined)?._silent403;
      if (!silent) {
        try {
          const [{ toast }, i18nModule] = await Promise.all([
            import('@/lib/toast-compat'),
            import('@/i18n')
          ]);
          const i18n = i18nModule.default;
          toast({
            title: i18n.t('general.errors.accessDenied', 'Access denied'),
            description: i18n.t('general.errors.insufficientPermissions', 'You don\'t have permission for this action.'),
            variant: 'destructive',
          });
        } catch {
          console.error('Access denied (403)');
        }
      }

      return Promise.reject(error);
    }

    // Log all HTTP errors with full details before rejecting — EXCEPT
    // statuses a call site explicitly declared as expected via
    // `_silentStatuses`. Some GETs treat a status as a normal "not set"
    // signal (e.g. /settings/user/notes_editor_preferences 404s when the
    // user never customised the notes editor); without this opt-out the
    // global logger spams a scary "❌ HTTP Request Failed" for every such
    // benign miss even though the caller handles it.
    if (error.response) {
      const silentStatuses = (error.config as { _silentStatuses?: number[] } | undefined)?._silentStatuses;
      if (!silentStatuses?.includes(error.response.status)) {
        const fullUrl = `${error.config?.baseURL || ''}${error.config?.url || ''}`;
        console.error('❌ HTTP Request Failed', {
          url: fullUrl,
          method: error.config?.method?.toUpperCase(),
          status: error.response.status,
          statusText: error.response.statusText,
          responseData: error.response.data,
          requestParams: error.config?.params,
          requestData: error.config?.data,
        });
      }
    }

    return Promise.reject(error);
  }
);

// All requests now use the same api instance with consistent auth handling
// Document uploads can override timeout using createDocumentUploadRequest helper

// Function to get auth headers from local storage
export function getAuthHeaders(): HeadersInit {
  try {
    // Check for tokens in session storage first (current session)
    let tokensStr = sessionStorage.getItem('auth_tokens');

    // If not in session storage, check local storage (remembered login)
    if (!tokensStr) {
      tokensStr = localStorage.getItem('auth_tokens');
    }

    if (!tokensStr) {
      console.warn('No auth tokens found when creating auth headers');
      return {};
    }

    // Parse the tokens
    const tokens = JSON.parse(tokensStr);
    if (!tokens || !tokens.access_token) {
      console.warn('Auth tokens found but missing access_token');
      return {};
    }

    return {
      Authorization: `Bearer ${tokens.access_token}`,
    };
  } catch (error) {
    console.error('Error creating auth headers:', error);

    // Clean up invalid tokens
    try {
      localStorage.removeItem('auth_tokens');
      sessionStorage.removeItem('auth_tokens');
    } catch (cleanupError) {
      console.error('Error cleaning up invalid tokens:', cleanupError);
    }

    return {};
  }
}

// ---------------------------------------------------------------------------
// OpenAI-compatible adapter helpers
// ---------------------------------------------------------------------------

/**
 * Translate the legacy ChatRequest into the OpenAI envelope
 * (POST /v1/chat/completions). Anything that does not fit the OpenAI shape
 * is relocated under `scrapalot`; backend's
 * OpenAICompatibleService.buildChatRequest reverses the mapping.
 *
 * The `model` field is intentionally a placeholder — we route by
 * `scrapalot.workspace_id` + `scrapalot.collection_ids`, which the backend
 * prefers over the slug-resolved workspace.
 */
function toOpenAiCompatBody(request: ChatRequest): Record<string, unknown> {
  const mode = request.deep_research_enabled
    ? 'deep_research'
    : request.agentic_rag_enabled
      ? 'agentic'
      : (request as unknown as { tutor_mode?: boolean }).tutor_mode
        ? 'tutor'
        : (request as unknown as { thought_partner_mode?: boolean }).thought_partner_mode
          ? 'thought_partner'
          : request.web_search_enabled
            ? 'web_search'
            : undefined; // null / "rag" → backend default
  const r = request as unknown as Record<string, unknown>;

  // Rebuild scrapalot block — only include fields the user actually set
  // so we don't fight backend defaults.
  const extras: Record<string, unknown> = {};
  if (mode) extras.mode = mode;
  if (request.session_id) extras.session_id = request.session_id;
  if (request.workspace_id) extras.workspace_id = request.workspace_id;
  if (request.collection_ids?.length) extras.collection_ids = request.collection_ids;
  if (request.document_ids?.length) extras.document_ids = request.document_ids;
  if (r.saved_search_ids) extras.saved_search_ids = r.saved_search_ids;
  if (request.user_message_id) extras.user_message_id = request.user_message_id;
  if (request.research_breadth != null) extras.research_breadth = request.research_breadth;
  if (request.research_depth != null) extras.research_depth = request.research_depth;
  if (request.attachments?.length) extras.attachments = request.attachments;
  if (request.annotation_color_filter?.length) extras.annotation_color_filter = request.annotation_color_filter;
  for (const k of [
    'similarity_threshold', 'top_k',
    'source_preferences', 'min_confidence_threshold', 'max_sources',
    'language',
    'mentions', 'prompt_template_name',
    'clarification_answers', 'clarification_request_id',
    'approved_plan_id', 'template_type', 'council_enabled', 'council_members', 'research_mode',
    'continue_research_plan_id', 'continuation_context',
    // "AI thinking" toggle → backend appends the model's own-knowledge
    // reflection ("osvrt modela" / model-insight block) after the answer.
    // Applies to manual RAG and agentic RAG alike; without it the toggle was
    // silently dropped here and never reached the backend.
    'deep_synthesis_enabled',
  ] as const) {
    const v = r[k];
    if (v != null && (Array.isArray(v) ? v.length > 0 : true)) extras[k] = v;
  }

  return {
    model: 'scrapalot:default',
    messages: [{ role: 'user', content: request.prompt }],
    stream: true,
    scrapalot: extras,
  };
}

/**
 * Unwrap one OpenAI `chat.completion.chunk` event into the legacy
 * `{ind, obj}` shape that handleChunk consumes (it already does
 * `chunk.obj?.X || chunk.X` on every accessor, see use-conversations.tsx).
 *
 * Mapping:
 *   - delta.scrapalot       → obj   (full native packet, verbatim)
 *   - delta.content         → obj.message_delta
 *   - finish_reason='stop'  → obj.stream_end
 *   - delta.role only       → null  (synthetic role chunk; no UI payload)
 */
function unwrapOpenAiChunk(
  chunk: { choices?: { delta?: { role?: string; content?: string; scrapalot?: Record<string, unknown> }; finish_reason?: string }[] },
  index: number,
): { ind: number; obj: Record<string, unknown> } | null {
  const choice = chunk.choices?.[0];
  if (!choice) return null;
  const delta = choice.delta || {};

  if (delta.scrapalot && typeof delta.scrapalot === 'object') {
    return { ind: index, obj: delta.scrapalot };
  }
  if (typeof delta.content === 'string' && delta.content.length > 0) {
    return { ind: index, obj: { type: 'message_delta', content: delta.content } };
  }
  if (choice.finish_reason === 'stop') {
    return { ind: index, obj: { type: 'stream_end', content: 'completed' } };
  }
  return null;
}

// Function to handle streaming chat responses
export async function streamChat(
  request: ChatRequest,
  onChunk: (data: ChatStreamResponse) => void,
  onError: (error: Error) => void,
  onEnd: () => void,
  timeout = 1800000, // 30-minute timeout for chat requests (deep research with iterations can take 15+ min)
  signal?: AbortSignal // AbortSignal for cancellation
): Promise<{
  reader: ReadableStreamDefaultReader<Uint8Array>;
  cancel: () => void;
}> {
  try {
    // Ensure session_id is set
    if (!request.session_id) {
      request.session_id = 'default-session';
    }

    // Create AbortController if one wasn't provided
    const controller = signal ? undefined : new AbortController();
    const abortSignal = signal || controller?.signal;

    // Set up timeout if provided
    let timeoutId: NodeJS.Timeout | undefined;
    if (timeout && timeout > 0 && controller) {
      timeoutId = setTimeout(() => {
        controller.abort('Request timeout');
        onError(
          new Error('Request timed out. The server took too long to respond.')
        );
      }, timeout);
    }

    // Get auth headers and verify token is included
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    // Try to get auth token from both sessionStorage (priority) and localStorage
    let authToken = null;

    // First check sessionStorage (current session tokens)
    const sessionTokensJson = sessionStorage.getItem('auth_tokens');
    if (sessionTokensJson) {
      try {
        const tokens = JSON.parse(sessionTokensJson);
        if (tokens && tokens.access_token) {
          authToken = tokens.access_token;
        }
      } catch (e) {
        console.error('Error parsing session auth tokens:', e);
      }
    }

    // If not found in sessionStorage, check localStorage (remembered login)
    if (!authToken) {
      const localTokensJson = localStorage.getItem('auth_tokens');
      if (localTokensJson) {
        try {
          const tokens = JSON.parse(localTokensJson);
          if (tokens && tokens.access_token) {
            authToken = tokens.access_token;
          }
        } catch (e) {
          console.error('Error parsing local auth tokens:', e);
        }
      }
    }

    // Set the Authorization header if we found a token
    if (authToken) {
      headers['Authorization'] = `Bearer ${authToken}`;
    } else {
      console.warn('No auth token found in storage for chat request!');
    }

    // Single-chat-surface adapter. Translate the legacy ChatRequest
    // (snake_case, flat) into the OpenAI envelope with everything that does
    // not fit the OpenAI shape relocated under `scrapalot`. Backend reverses
    // this in OpenAICompatibleService.buildChatRequest. The model field is a
    // placeholder ("scrapalot:default" → user's default workspace), since
    // workspace_id and collection_ids in extras override the slug-resolved
    // workspace anyway.
    const openAiBody = toOpenAiCompatBody(request);
    headers['Accept'] = 'text/event-stream';

    let response = await fetch(`${API_BASE_URL}/chat/completions`, {
      // KEEP AS FETCH
      method: 'POST',
      headers: headers,
      body: JSON.stringify(openAiBody),
      credentials: 'include', // Important for cookies/auth
      signal: abortSignal,
    });

    // Clear timeout as soon as we get a response
    if (timeoutId) {
      clearTimeout(timeoutId);
    }

    // Handle 401 by refreshing token and retrying once
    if (response.status === 401) {
      try {
        const newTokens = await refreshToken();
        if (newTokens?.access_token) {
          headers['Authorization'] = `Bearer ${newTokens.access_token}`;
          response = await fetch(`${API_BASE_URL}/chat/completions`, {
            method: 'POST',
            headers: headers,
            body: JSON.stringify(openAiBody),
            credentials: 'include',
            signal: abortSignal,
          });
        }
      } catch (refreshError) {
        console.error('Token refresh failed during stream:', refreshError);
      }
    }

    if (!response.ok) {
      const statusText = response.statusText || `HTTP ${response.status}`;
      throw new Error(
        response.status === 401
          ? 'Authentication error. Your session may have expired. Please try refreshing the page or logging out and back in.'
          : `Stream request failed: ${statusText}`
      );
    }

    if (!response.body) {
      onError(new Error('No response body'));
      const dummyReader = new ReadableStream<Uint8Array>().getReader();
      const dummyCancel = async () => { try { await dummyReader.cancel('No response body'); } catch { /* ignore */ } };
      return { reader: dummyReader, cancel: dummyCancel };
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    // Create a cancellation function
    const cancel = async () => {
      try {
        // Create a flag to track if this operation was completed
        let abortCompleted = false;

        // Use a timeout to ensure this function doesn't the app freeze indefinitely
        const timeoutId = setTimeout(() => {
          if (!abortCompleted) {
            console.warn('Cancel operation timed out after 2 seconds');
            // Force completion by manually calling callbacks
            try {
              onChunk({
                type: 'status',
                content: 'Request cancellation timed out',
              });
              onChunk({ type: 'stream_end', content: 'Cancelled' });
              // Defer onEnd to avoid race conditions
              setTimeout(() => {
                try {
                  onEnd();
                } catch (e) {
                  console.error('Error calling onEnd from timeout:', e);
                }
              }, 0);
            } catch (e) {
              console.error('Error during forced cancellation cleanup:', e);
            }
          }
        }, 2000);

        // Abort the controller if it exists and hasn't been aborted yet
        if (controller && !controller.signal.aborted) {
          controller.abort('User cancelled');
        }

        // The browser will automatically close the connection when the AbortController is called
        // This will be detected on the server side as a client disconnect

        // Close the reader - wrap in try/catch as it might already be closing
        try {
          await reader.cancel('User cancelled request').catch(e => {
            console.warn('Error cancelling reader:', e);
          });
        } catch (e) {
          console.warn('Error during reader.cancel():', e);
        }

        // Notify UI that the stream was canceled
        try {
          onChunk({ type: 'status', content: 'Request cancelled by user' });
          onChunk({ type: 'stream_end', content: 'Cancelled' });
          // Use setTimeout to avoid race conditions with callbacks
          setTimeout(() => {
            try {
              onEnd();
            } catch (e) {
              console.error('Error calling onEnd from cancel:', e);
            }
          }, 0);
        } catch (e) {
          console.error('Error during cancel notification:', e);
        }

        // Mark as completed and clear timeout
        abortCompleted = true;
        clearTimeout(timeoutId);
      } catch (err) {
        console.error('Error during cancellation:', err);
        // Attempt to call onEnd even if there was an error
        try {
          setTimeout(() => onEnd(), 0);
        } catch (e) {
          console.error('Error calling onEnd after cancel error:', e);
        }
      }
    };

    // Process the stream
    const processStream = async () => {
      try {
        let buffer = '';
        let chunkCounter = 0;
        let bytesReceived = 0;

        while (true) {
          // Check if the stream has been aborted
          if (abortSignal?.aborted) {

            break;
          }

          let readResult: ReadableStreamReadResult<Uint8Array>;
          try {
            readResult = await reader.read();
          } catch (readError) {
            // Handle read errors specifically
            if (
              readError.name === 'AbortError' ||
              String(readError).includes('aborted')
            ) {

              break;
            }

            // For network errors like "The user aborted a request"
            if (
              String(readError).includes('user aborted') ||
              String(readError).includes('network')
            ) {

              break;
            }

            // Server disconnect (e.g., container restart during deep research)
            console.error('Stream read error (likely server restart):', readError);
            // Emit an error packet so the UI shows a user-facing message
            try {
              onChunk({ type: 'error', content: 'stream_disconnected' });
              onChunk({ type: 'stream_end', content: 'Disconnected' });
            } catch (chunkError) {
              console.error('Error emitting disconnect packets:', chunkError);
            }
            try {
              onError(readError instanceof Error ? readError : new Error(String(readError)));
            } catch (callbackError) {
              console.error('Error in onError callback:', callbackError);
            }
            // Always call onEnd so streaming state resets (spinner stops, buttons re-enable)
            try {
              setTimeout(() => onEnd(), 0);
            } catch (endError) {
              console.error('Error calling onEnd after stream disconnect:', endError);
            }
            break;
          }

          const { done, value } = readResult;

          if (done) {
            // SSE trailing event: try to parse one final `data: ...` block.
            const trailing = buffer.trim();
            if (trailing.startsWith('data:')) {
              const payload = trailing.slice(5).trim();
              if (payload && payload !== '[DONE]') {
                try {
                  const sseChunk = JSON.parse(payload);
                  const unwrapped = unwrapOpenAiChunk(sseChunk, chunkCounter);
                  if (unwrapped) onChunk(unwrapped as unknown as ChatStreamResponse);
                } catch (e) {
                  console.error('Error parsing final SSE buffer:', e);
                  console.error('Raw final buffer:', trailing);
                }
              }
            }

            onEnd();
            break;
          }

          chunkCounter++;
          bytesReceived += value.length;
          const chunk = decoder.decode(value);
          buffer += chunk;
          // SSE event boundary is a blank line (\n\n). Split on it; the last
          // element is the in-flight buffer carry-over.
          const events = buffer.split('\n\n');
          buffer = events.pop() || '';

          for (const evt of events) {
            const lines = evt.split('\n');
            const dataLines: string[] = [];
            for (const ln of lines) {
              if (ln.startsWith('data:')) dataLines.push(ln.slice(5).trim());
            }
            if (dataLines.length === 0) continue;
            const payload = dataLines.join('\n');
            if (payload === '[DONE]') {
              setTimeout(() => onEnd(), 0);
              continue;
            }
            try {
              const sseChunk = JSON.parse(payload);
              const unwrapped = unwrapOpenAiChunk(sseChunk, chunkCounter);
              if (!unwrapped) continue;
              const objType = unwrapped.obj?.type;
              onChunk(unwrapped as unknown as ChatStreamResponse);
              if (objType === 'stream_end') setTimeout(() => onEnd(), 0);
              if (objType === 'error') {
                console.error('Stream error:', unwrapped.obj?.content);
              }
            } catch (parseError) {
              console.error('Error parsing SSE JSON:', parseError);
              console.error('Problematic payload:', payload);
            }
          }
        }
      } catch (streamError) {
        // Handle both abort errors and network errors gracefully
        if (streamError instanceof Error) {
          const errorMessage = streamError.message || String(streamError);
          if (
            streamError.name === 'AbortError' ||
            errorMessage.includes('aborted') ||
            errorMessage.includes('user aborted') ||
            errorMessage.includes('network')
          ) {
            // Expected abort/network error during stream cancellation; intentionally ignored
          } else {
            console.error('Stream error:', streamError);
            // Safely call onError with a try/catch to prevent uncaught exceptions
            try {
              onError(streamError);
            } catch (callbackError) {
              console.error('Error in onError callback:', callbackError);
            }
          }
        } else {
          console.error('Unknown stream error:', streamError);
          // Safely call onError with a try/catch
          try {
            onError(new Error(String(streamError)));
          } catch (callbackError) {
            console.error('Error in onError callback:', callbackError);
          }
        }
      } finally {
        // Always attempt to notify the end of the stream, but do it safely
        try {
          // Use setTimeout to ensure we don't block and handle any potential race conditions
          setTimeout(() => {
            onEnd();
          }, 0);
        } catch (finalError) {
          console.error('Error in final onEnd callback:', finalError);
        }
      }
    };

    // Run the stream consumer in the background so the caller receives
    // { reader, cancel } immediately after the response arrives. Awaiting here
    // would defer registering the cancel handler until generation completes,
    // turning the Stop button into a no-op for the duration of the stream.
    processStream().catch(err => {
      console.error('Unexpected error in processStream:', err);
    });

    return { reader, cancel };
  } catch (error) {
    // Clear timeout as soon as we catch an error
    if (timeout) {
      clearTimeout(timeout);
    }

    // Create a fake reader and cancel a function for a consistent return type
    const dummyReader = new ReadableStream().getReader();
    const dummyCancel = async () => {

      try {
        await dummyReader.cancel('Stream already failed');
      } catch (e) {
        console.warn('Error cancelling dummy reader:', e);
      }
    };

    // For abort errors, channel failures, or network errors, handle gracefully
    const errorMessage = error instanceof Error ? error.message : String(error);
    const isAbortOrNetworkError =
      (error instanceof Error && error.name === 'AbortError') ||
      errorMessage.includes('aborted') ||
      errorMessage.includes('user aborted') ||
      errorMessage.includes('channel closed') ||
      errorMessage.includes('network') ||
      errorMessage.includes('failed to fetch');

    if (isAbortOrNetworkError) {

      // Send a special message for aborted requests
      try {
        onChunk({
          type: 'status',
          content: 'Request cancelled or network error',
        });
        onChunk({ type: 'stream_end', content: 'Cancelled' });
        // Defer the onEnd call to avoid race conditions
        setTimeout(() => {
          try {
            onEnd();
          } catch (e) {
            console.error('Error calling onEnd after abort:', e);
          }
        }, 0);
      } catch (callbackError) {
        console.error('Error calling onChunk after abort:', callbackError);
      }
      return { reader: dummyReader, cancel: dummyCancel };
    } else {
      console.error('Error in streamChat:', error);
      // Safely call error callback
      try {
        onError(error instanceof Error ? error : new Error(String(error)));
      } catch (callbackError) {
        console.error('Error in onError callback:', callbackError);
      }
      // Still try to notify the end to prevent freezing UI
      try {
        setTimeout(() => {
          try {
            onEnd();
          } catch (e) {
            console.error('Error calling onEnd after stream error:', e);
          }
        }, 0);
      } catch (e) {
        console.error('Error setting timeout for onEnd:', e);
      }
    }

    return { reader: dummyReader, cancel: dummyCancel };
  }
}

// Login function - This one *must* use fetch because it needs to manually handle
// the response to store the token *before* the interceptors can use it.
// Keep this as fetch.
export async function login(
  username: string,
  password: string
): Promise<AuthTokens> {

  let response: Response;
  try {
    // Use JSON body instead of form-urlencoded for /auth/login endpoint
    response = await fetch(`${API_BASE_URL}/auth/login`, {
      // KEEP AS FETCH
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        username_or_email: username,
        password: password,
      }),
      credentials: 'include', // Needed if backend sets HttpOnly refresh cookie
    });
  } catch (error) {
    console.error('Login error details:', error);
    console.error('Login URL attempted:', `${API_BASE_URL}/auth/login`);
    console.error('API_BASE_URL value:', API_BASE_URL);

    // Check for connection-refused errors from fetch
    if (error instanceof TypeError && error.message.includes('fetch')) {
      // This is likely a network error (connection refused, etc.)
      throw Object.assign(
        new Error(`ERR_CONNECTION_REFUSED: Unable to connect to ${API_BASE_URL}/auth/login - ${error.message}`),
        {
          name: 'NetworkError',
          code: 'ERR_CONNECTION_REFUSED',
          url: `${API_BASE_URL}/auth/login`
        }
      );
    }

    // Re-throw the specific error message
    throw error instanceof Error ? error : new Error('Login failed');
  }

  if (!response.ok) {
    console.error('Login failed with status:', response.status);
    // Try parsing error details if available
    let errorMessage = `Login failed: ${response.statusText}`;
    try {
      const errorData = await response.json();
      if (errorData.detail) {
        errorMessage = errorData.detail;
      }
    } catch {
      // JSON parsing failed; fall back to statusText message
    }
    throw new Error(errorMessage);
  }

  const data = await response.json() as Record<string, unknown>;

  const processedData: AuthTokens = {
    access_token: (data.access_token as string) || '',
    token_type: (data.token_type as string) || 'bearer',
    refresh_token: (data.refresh_token as string) || undefined,
    // expires_in is useful for client-side expiry checks if needed
    expires_in:
      typeof data.expires_in === 'number' ? data.expires_in : undefined,
  };

  if (!processedData.access_token) {
    console.error('Login response missing access_token:', data);
    throw new Error('Invalid response format: missing access token');
  }

  return processedData;
}

// Get current user - Use Axios 'api'
export async function getCurrentUser() {
  // Axios interceptor will add the token from localStorage if available
  // No need to check localStorage here explicitly
  try {
    const response = await api.get('/users/me'); // Use Axios 'api'
    return response.data; // Axios parses data
  } catch (error) {
    // Interceptor handles refresh 401. Log other errors.
    if (error.response?.status !== 401) {
      console.error('Error fetching current user:', error);
    } else {
      // 401 errors are handled by the interceptor for token refresh
    }
    // Return null or let the error propagate depending on how AuthContext handles it
    return null; // Returning null indicates not authenticated or error
  }
}

// Global async mutex: ensures only one token refresh is in-flight at a time.
// Any concurrent callers (401 interceptor, proactive interval, 2-min monitor)
// wait for the same promise rather than sending multiple requests with the
// same (old) cookie, which would cause a hash mismatch in Redis and revoke
// the token family, logging the user out.
let _refreshPromise: Promise<{
  access_token: string;
  refresh_token?: string;
  token_type: string;
  expires_in?: number;
} | null> | null = null;

// Set by _doRefreshToken when its last failure was TRANSIENT (no HTTP response —
// offline/timeout — or a 5xx server error) rather than a definitive auth
// rejection (401/403/invalid refresh token). The 401 interceptor reads this to
// decide whether a failed refresh should log the user out: a transient failure
// must NOT, so a flaky mobile connection never drops a valid session.
let _lastRefreshTransient = false;

/** True when a failed token refresh should be treated as transient (keep the
 *  session) rather than a real auth failure (log out). */
export const wasLastRefreshTransient = (): boolean =>
  _lastRefreshTransient || (typeof navigator !== 'undefined' && navigator.onLine === false);

export const refreshToken = async (): Promise<{
  access_token: string;
  refresh_token?: string;
  token_type: string;
  expires_in?: number;
} | null> => {
  // If a refresh is already in-flight, reuse that promise.
  if (_refreshPromise) {
    return _refreshPromise;
  }

  _refreshPromise = _doRefreshToken().finally(() => {
    _refreshPromise = null;
  });

  return _refreshPromise;
};

const _doRefreshToken = async (): Promise<{
  access_token: string;
  refresh_token?: string;
  token_type: string;
  expires_in?: number;
} | null> => {
  // Fresh attempt: assume any failure is a real auth failure unless the catch
  // block below proves it was transient (network / 5xx).
  _lastRefreshTransient = false;

  // Rate-limit: don't hit the backend more than once every 5 seconds.
  const now = Date.now();
  const lastRefresh = parseInt(
    localStorage.getItem('last_token_refresh') || '0'
  );

  if (now - lastRefresh < 5000) {
    // 5-second cooldown - return stored tokens only if they're not expired
    try {
      const stored =
        localStorage.getItem('auth_tokens') ||
        sessionStorage.getItem('auth_tokens');
      if (stored) {
        const tokens = JSON.parse(stored);
        if (tokens?.access_token) {
          // Verify the cached token is actually valid (not expired)
          try {
            const payload = JSON.parse(atob(tokens.access_token.split('.')[1]));
            if (payload.exp && Date.now() >= payload.exp * 1000) {
              console.warn('Token refresh cooldown: cached token is expired, returning null');
              return null;
            }
          } catch {
            // Can't decode token, return it anyway
          }
          console.log('Token refresh skipped (cooldown) - using stored tokens');
          return tokens;
        }
      }
    } catch (e) {
      console.error('Error parsing stored tokens during cooldown:', e);
    }

    console.warn('Token refresh skipped (cooldown) but no valid stored tokens found');
    return null;
  }

  // After a refresh is completed, store the timestamp
  const markRefreshComplete = () => {
    localStorage.setItem('last_token_refresh', now.toString());
    localStorage.removeItem('token_refresh_needed');
  };

  try {
    // Attempt to get refresh token from storage
    const stored =
      localStorage.getItem('auth_tokens') ||
      sessionStorage.getItem('auth_tokens');
    if (!stored) {
      console.warn('Token refresh failed: No auth tokens found in storage');
      return null;
    }

    const tokens = JSON.parse(stored);

    // Build refresh request - send refresh_token in body if available,
    // always include credentials for cookie-based fallback
    const requestBody: Record<string, string> = {};
    if (tokens?.refresh_token) {
      requestBody.refresh_token = tokens.refresh_token;
    }

    if (!tokens?.refresh_token && !tokens?.access_token) {
      console.warn('Token refresh unavailable: No refresh_token or access_token');
      return null;
    }

    // Make the refresh request with body (if refresh_token available) + cookies
    // Do NOT send expired access token in Authorization header — the refresh endpoint
    // is public and sending an expired JWT can cause the Gateway to reject the request.
    //
    // During impersonation we MUST NOT attach cookies. The HTTP-only refresh
    // cookie still belongs to the admin's original login; sending it lets the
    // backend swap the target's tokens for admin's. Omitting cookies also
    // prevents the backend's refresh response from overwriting admin's cookie
    // with a target-scoped one, which would corrupt the admin's session
    // after exitImpersonation. Dynamic import keeps `api.ts` free of a
    // hard dependency on the impersonation module.
    const { isImpersonating } = await import('@/lib/impersonation');
    const sendCookies = !isImpersonating();
    const response = await axios.post(
      `${API_BASE_URL}/users/token/refresh`,
      Object.keys(requestBody).length > 0 ? requestBody : undefined,
      {
        headers: {
          'Content-Type': 'application/json',
        },
        withCredentials: sendCookies,
      }
    );

    if (response.status === 200 && response.data) {
      // Backend may send refresh_token as HTTP-only cookie instead of JSON
      // Use existing refresh_token if not provided in response.
      // Always preserve expires_in so storeTokenExpiry() keeps token_expiry up-to-date.
      const newTokens = {
        access_token: response.data.access_token,
        refresh_token: response.data.refresh_token || tokens.refresh_token,
        token_type: 'Bearer',
        expires_in: response.data.expires_in ?? tokens.expires_in,
      };

      // Update tokens in storage
      const storeTokens = JSON.stringify(newTokens);
      if (localStorage.getItem('auth_tokens')) {
        localStorage.setItem('auth_tokens', storeTokens);
      } else {
        sessionStorage.setItem('auth_tokens', storeTokens);
      }

      // Update the axios default headers
      setAuthorizationHeader(newTokens.access_token);

      // Mark refresh as complete
      markRefreshComplete();

      return newTokens;
    } else {
      console.error('Token refresh failed: Unexpected response status', response.status);
      return null;
    }
  } catch (error: unknown) {
    if (axios.isAxiosError(error)) {
      if (error.response) {
        // Got an HTTP response. A 5xx is a transient server hiccup (keep the
        // session); a 4xx (401/403/invalid refresh token) is a real auth
        // rejection (drop the session).
        _lastRefreshTransient = error.response.status >= 500;
        console.error('Token refresh failed: HTTP', error.response.status, error.response.data);
      } else if (error.request) {
        // No response at all — offline / DNS / timeout. Transient: never log
        // the user out for a flaky connection.
        _lastRefreshTransient = true;
        console.error('Token refresh failed: No response from server', error.message);
      } else {
        _lastRefreshTransient = true;
        console.error('Token refresh failed:', error.message);
      }
    } else {
      // Unknown non-axios error — be conservative and treat as transient so a
      // bug here can't strand a logged-in user.
      _lastRefreshTransient = true;
      console.error('Token refresh failed:', error instanceof Error ? error.message : String(error));
    }
    return null;
  }
};

// ----------------------------------------------------------------------------
// Document Processing Utilities
// ----------------------------------------------------------------------------

// API URLs - keeping only the ones actually used
export const apiUrls = {
  // Auth endpoints
  login: 'auth/login',
  currentUser: '/users/me',
  refreshToken: 'auth/refresh',

  // Workspace endpoints
  getWorkspaces: '/workspaces',
  getWorkspace: '/workspaces/:id',
  createWorkspace: '/workspaces',
  updateWorkspace: '/workspaces/:id',
  deleteWorkspace: '/workspaces/:id',
  shareWorkspace: '/workspaces/:workspaceId/share',
  removeWorkspaceAccess: '/workspaces/:workspaceId/users/:userId',
  updateWorkspaceUserRole: '/workspaces/:workspaceId/share/:userId',
  defaultWorkspace: '/workspaces/default',
  selectWorkspace: '/settings/user/workspace/selected',

  // Collection endpoints
  getCollections: '/collections',
  getCollection: '/collections/:id',
  createCollection: '/collections',
  updateCollection: '/collections/:id',
  deleteCollection: '/collections/:id',
  getWorkspaceCollections: '/collections/workspace/:workspaceId',

  // Chat endpoints
  chat: '/chat',

  // Model endpoints
  models: '/models',
  modelProviders: '/settings/providers',
  providerModels: '/models/provider-models',

  // Documents
  documents: '/documents',
  documentSources: '/documents/sources',

  // Settings
  settings: '/settings',

  // Local AI
  llmInference: '/llm-inference',

  // User endpoints
  registerUser: '/users/register',
  searchUsers: '/users/search',
  getUserByEmail: '/users/by-email',
  userPlan: '/users/plan',
  updateUserProfile: '/users/me',
  changePassword: '/users/me/password',
  updateTourCompleted: '/users/me/tour-completed',
  // Admin user management endpoints
  adminUpdateUser: '/users/edit/:userId',
  adminDeleteUser: '/users/:userId',
  adminResetPassword: '/users/edit/:userId/reset-password',

  // Storage endpoints
  storageQuota: '/storage/quota',
  workspaceStorage: '/storage/workspace/:workspaceId',
  checkStorageQuota: '/storage/check',
};

// Define the missing setAuthorizationHeader function
/**
 * Set the Authorization header for axios requests
 * @param token The access token to use
 */
const setAuthorizationHeader = (token: string) => {
  if (token) {
    // Update the axios default headers
    api.defaults.headers.common['Authorization'] = `Bearer ${token}`;

  } else {
    // Remove the header if no token
    delete api.defaults.headers.common['Authorization'];

  }
};

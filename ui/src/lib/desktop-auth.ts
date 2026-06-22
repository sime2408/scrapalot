/**
 * Desktop Authentication Helper
 *
 * Handles auto-login flow for Electron desktop mode.
 * Supports two modes:
 * - Local mode: Uses local Python backend with desktop-specific auth endpoint
 * - Cloud mode: Uses api.scrapalot.app, marks desktop as initialized to allow normal auth flow
 */

import axios from 'axios';
import { api, API_BASE_URL } from '@/lib/api';
import { isDesktopMode, getDesktopApiKey, getMachineId, getMachineName } from '@/lib/electron-api';

// Re-export for convenience
export { isDesktopMode } from '@/lib/electron-api';

// Track if desktop auth has been attempted (to prevent infinite loops)
let desktopAuthAttempted = false;

export interface DesktopAuthResponse {
  user: {
    id: string;
    email: string;
    username: string;
    role: string;
  };
  access_token: string;
  refresh_token: string;
  token_type: string;
}

/**
 * Check if we're in cloud mode (using api.scrapalot.app instead of local backend)
 */
export function isCloudMode(): boolean {
  // Check if the API base URL points to the cloud backend
  return API_BASE_URL.includes('api.scrapalot.app') ||
         API_BASE_URL.includes('scrapalot.app') ||
         !API_BASE_URL.includes('localhost');
}

/**
 * Persist auth tokens from a desktop auth response into localStorage.
 * Sets the base token keys plus the combined auth_tokens JSON blob.
 * When cloudMode is true, also sets the desktop_cloud_mode flag.
 */
function storeDesktopAuthTokens(data: DesktopAuthResponse, cloudMode: boolean): void {
  localStorage.setItem('access_token', data.access_token);
  localStorage.setItem('refresh_token', data.refresh_token);
  localStorage.setItem('token_type', data.token_type);
  localStorage.setItem('user', JSON.stringify(data.user));
  localStorage.setItem('desktop_auth_initialized', 'true');
  if (cloudMode) {
    localStorage.setItem('desktop_cloud_mode', 'true');
  }
  const authTokens = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    token_type: data.token_type,
  };
  localStorage.setItem('auth_tokens', JSON.stringify(authTokens));
}

/**
 * Initialize desktop authentication.
 * Called on app startup in desktop mode to create/verify the desktop user.
 *
 * In cloud mode: Uses the cloud-compatible desktop auth endpoint for auto-login
 * In local mode: Calls the local backend's desktop auth endpoint
 */
export async function initializeDesktopAuth(): Promise<DesktopAuthResponse | null> {
  if (!isDesktopMode()) {
    return null;
  }

  // Prevent re-initialization attempts
  if (desktopAuthAttempted) {
    console.log('[Desktop Auth] Already attempted, skipping re-initialization');
    return null;
  }
  desktopAuthAttempted = true;

  try {
    console.log('[Desktop Auth] Initializing desktop authentication...');
    console.log('[Desktop Auth] API Base URL:', API_BASE_URL);
    console.log('[Desktop Auth] Cloud mode:', isCloudMode());

    // Get desktop API key from Electron
    const apiKey = await getDesktopApiKey();
    if (!apiKey) {
      console.error('[Desktop Auth] Failed to get desktop API key from Electron');
      console.error('[Desktop Auth] Troubleshooting:');
      console.error('[Desktop Auth]   1. Ensure you are running in Electron (not browser)');
      console.error('[Desktop Auth]   2. Check electron-store for corrupted API key');
      console.error('[Desktop Auth]   3. Try restarting the application');
      return null;
    }

    // In cloud mode, use the cloud-compatible endpoint for auto-login
    if (isCloudMode()) {
      console.log('[Desktop Auth] Cloud mode detected - using cloud desktop auth endpoint');

      // Get machine ID and name for cloud auth
      const machineId = await getMachineId();
      const machineName = await getMachineName();

      if (!machineId) {
        console.error('[Desktop Auth] Failed to get machine ID');
        localStorage.setItem('desktop_auth_initialized', 'true');
        localStorage.setItem('desktop_cloud_mode', 'true');
        return null;
      }

      console.log('[Desktop Auth] Machine ID:', machineId.substring(0, 8) + '...');
      console.log('[Desktop Auth] Machine Name:', machineName);

      try {
        // Call cloud-compatible desktop auth endpoint
        const response = await api.post<DesktopAuthResponse>('/desktop/auth/cloud-initialize', {
          api_key: apiKey,
          machine_id: machineId,
          machine_name: machineName,
        });

        if (response.data) {
          console.log('[Desktop Auth] Cloud desktop authentication successful!');
          console.log(`[Desktop Auth] Logged in as: ${response.data.user.email}`);

          storeDesktopAuthTokens(response.data, true);

          return response.data;
        }
      } catch (cloudError: unknown) {
        console.error('[Desktop Auth] Cloud desktop auth failed:', cloudError);

        // If cloud endpoint not available, mark as initialized for manual login
        if (axios.isAxiosError(cloudError) && cloudError.response?.status === 404) {
          console.log('[Desktop Auth] Cloud desktop endpoint not available, falling back to manual login');
        }

        localStorage.setItem('desktop_auth_initialized', 'true');
        localStorage.setItem('desktop_cloud_mode', 'true');
        return null;
      }
    }

    // Local mode: Call local backend to initialize desktop mode
    const response = await api.post<DesktopAuthResponse>('/desktop/auth/initialize', {
      api_key: apiKey,
    });

    if (response.data) {
      console.log('[Desktop Auth] Desktop authentication initialized successfully');
      console.log(`[Desktop Auth] Logged in as: ${response.data.user.email}`);

      storeDesktopAuthTokens(response.data, false);

      return response.data;
    }

    return null;
  } catch (error: unknown) {
    console.error('[Desktop Auth] Failed to initialize desktop authentication');
    console.error('[Desktop Auth] Error details:', error);

    // Provide specific error guidance
    const status = axios.isAxiosError(error) ? error.response?.status : undefined;
    const errMsg = error instanceof Error ? error.message : '';
    const errCode = axios.isAxiosError(error) ? error.code : undefined;
    if (status === 403) {
      console.error('[Desktop Auth] Desktop mode is not enabled on the backend');
      console.error('[Desktop Auth] Ensure SCRAPALOT_DESKTOP_MODE=true environment variable is set');
    } else if (status === 401) {
      console.error('[Desktop Auth] Desktop API key validation failed');
      console.error('[Desktop Auth] The API key may have changed - try restarting the application');
    } else if (errCode === 'ECONNREFUSED' || errMsg.includes('Network Error')) {
      console.error('[Desktop Auth] Cannot connect to backend server');
      console.error('[Desktop Auth] Ensure Python backend is running on http://localhost:8090');
    } else if (status === 500) {
      console.error('[Desktop Auth] Backend server error');
      console.error('[Desktop Auth] Check backend logs in ~/.scrapalot/logs/');
    } else if (status === 404) {
      // Endpoint not found - likely in cloud mode or old backend
      console.log('[Desktop Auth] Desktop auth endpoint not available, marking as initialized');
      localStorage.setItem('desktop_auth_initialized', 'true');
      localStorage.setItem('desktop_cloud_mode', 'true');
    }

    return null;
  }
}

/**
 * Check if desktop authentication is already initialized.
 * In cloud mode, we check for the desktop_auth_initialized flag.
 * In local mode, we check for actual auth tokens.
 */
export function isDesktopAuthInitialized(): boolean {
  if (!isDesktopMode()) {
    return false;
  }

  // Check if desktop auth has been marked as initialized (cloud mode)
  const desktopAuthInitialized = localStorage.getItem('desktop_auth_initialized') === 'true';
  if (desktopAuthInitialized) {
    return true;
  }

  // Check for actual auth tokens (local mode)
  const accessToken = localStorage.getItem('access_token');
  const user = localStorage.getItem('user');

  return !!accessToken && !!user;
}

/**
 * Check if desktop is in cloud mode.
 */
export function isDesktopCloudMode(): boolean {
  return isDesktopMode() && localStorage.getItem('desktop_cloud_mode') === 'true';
}


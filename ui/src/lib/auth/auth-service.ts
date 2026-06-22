/**
 * Authentication Service
 * 
 * Centralized service for all authentication-related API operations.
 * This consolidates logic from auth.ts, auth-manager.ts, and parts of auth-context.tsx.
 */

import { api, API_BASE_URL } from '@/lib/api';
import { AuthTokens, User } from '@/types';
import { hasValidAuthTokens } from './auth-utils';

/**
 * Configuration for authentication manager
 */
interface AuthServiceConfig {
  refreshThresholdMinutes: number;
  maxRetries: number;
  retryDelayMs: number;
}

/**
 * Authentication Service Class
 * Handles all auth operations with built-in retry logic and token management
 */
class AuthService {
  private config: AuthServiceConfig = {
    refreshThresholdMinutes: 5,
    maxRetries: 3,
    retryDelayMs: 1000,
  };

  private refreshPromise: Promise<AuthTokens | null> | null = null;
  private lastRefreshTime = 0;
  private isRefreshing = false;

  /**
   * Login with username/email and password
   */
  async login(
    username: string,
    password: string
  ): Promise<AuthTokens | null> {
    const formData = new URLSearchParams();
    formData.append('username', username);
    formData.append('password', password);

    let response: Response;
    try {
      response = await fetch(`${API_BASE_URL}/users/token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: formData,
        credentials: 'include',
      });
    } catch (error) {
      console.error('Login error:', error);
      // Check if it's a network error (connection refused, offline, etc.)
      if (error instanceof TypeError && error.message === 'Failed to fetch') {
        throw Object.assign(
          new Error('ERR_CONNECTION_REFUSED: Unable to connect to server'),
          {
            name: 'NetworkError',
            code: 'ERR_CONNECTION_REFUSED'
          }
        );
      }
      throw error;
    }

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({})) as Record<string, string>;
      throw new Error(errorData.detail || 'Login failed');
    }

    return await response.json() as AuthTokens;
  }

  /**
   * Login with Google OAuth
   */
  async loginWithGoogle(code: string): Promise<AuthTokens | null> {
    let response: Response;
    try {
      response = await fetch(`${API_BASE_URL}/auth/google/callback`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ code }),
        credentials: 'include',
      });
    } catch (error) {
      console.error('Google login error:', error);
      throw error;
    }

    if (!response.ok) {
      throw new Error('Google login failed');
    }

    return await response.json() as AuthTokens;
  }

  /**
   * Refresh authentication token
   * Uses mutex to prevent concurrent refresh attempts
   */
  async refreshToken(): Promise<AuthTokens | null> {
    // If already refreshing, wait for that operation
    if (this.refreshPromise) {
      return await this.refreshPromise;
    }

    // Create new refresh promise
    this.refreshPromise = this.performTokenRefresh();

    try {
      const result = await this.refreshPromise;
      if (result) {
        this.lastRefreshTime = Date.now();
      }
      return result;
    } finally {
      this.refreshPromise = null;
    }
  }

  /**
   * Perform the actual token refresh with retry logic
   */
  private async performTokenRefresh(): Promise<AuthTokens | null> {
    this.isRefreshing = true;

    try {
      // Get current tokens from storage
      const stored =
        localStorage.getItem('auth_tokens') ||
        sessionStorage.getItem('auth_tokens');

      if (!stored) {
        console.warn('No tokens found in storage for refresh');
        return null;
      }

      const currentTokens = JSON.parse(stored);

      // Build request body with refresh_token if available
      // AuthController.login() does not set cookies, so we must send refresh_token in body
      const requestBody: Record<string, string> = {};
      if (currentTokens.refresh_token) {
        requestBody.refresh_token = currentTokens.refresh_token;
      }

      for (let attempt = 1; attempt <= this.config.maxRetries; attempt++) {
        try {
          // Do NOT send expired access token — refresh endpoint is public
          // and sending an expired JWT can cause the Gateway to reject the request
          const response = await fetch(`${API_BASE_URL}/users/token/refresh`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            credentials: 'include',
            body: Object.keys(requestBody).length > 0 ? JSON.stringify(requestBody) : undefined,
          });

          if (response.ok) {
            const newTokens: AuthTokens = await response.json();
            // Preserve refresh_token from previous tokens if not returned by backend
            if (!newTokens.refresh_token && currentTokens.refresh_token) {
              newTokens.refresh_token = currentTokens.refresh_token;
            }
            return newTokens;
          }

          if (response.status === 401) {
            console.warn('Token refresh returned 401, token invalid');
            return null;
          }

          console.warn(`Token refresh attempt ${attempt} failed with status ${response.status}`);
        } catch (error) {
          console.error(`Token refresh attempt ${attempt} failed:`, error);

          if (attempt < this.config.maxRetries) {
            const delay = this.config.retryDelayMs * attempt;
            await new Promise(resolve => setTimeout(resolve, delay));
          }
        }
      }

      return null;
    } finally {
      this.isRefreshing = false;
    }
  }

  /**
   * Get current user information
   */
  async getCurrentUser(): Promise<User | null> {
    try {
      const response = await api.get('/users/me');
      return response.data;
    } catch (error) {
      console.error('Error fetching current user:', error);
      return null;
    }
  }

  /**
   * Logout user: revoke refresh token on server, then clear all auth data
   */
  logout(): void {
    // Best-effort server-side revocation (don't block on failure)
    this.revokeRefreshTokenOnServer().catch(() => {
      // Silent failure — local cleanup still happens
    });

    // Clear all auth-related storage
    localStorage.removeItem('auth_tokens');
    localStorage.removeItem('auth_token'); // Legacy
    localStorage.removeItem('token_expiry'); // Legacy
    localStorage.removeItem('token_refresh_needed');
    sessionStorage.removeItem('auth_tokens');
    sessionStorage.removeItem('just_logged_in');

    // Clear API authorization header
    delete api.defaults.headers.common['Authorization'];
  }

  /**
   * Revoke the current refresh token family on the server.
   * Called during logout to invalidate the session server-side.
   */
  private async revokeRefreshTokenOnServer(): Promise<void> {
    const stored =
      localStorage.getItem('auth_tokens') ||
      sessionStorage.getItem('auth_tokens');

    if (!stored) return;

    const tokens = JSON.parse(stored);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (tokens.access_token) {
      headers['Authorization'] = `Bearer ${tokens.access_token}`;
    }

    const body = tokens.refresh_token
      ? JSON.stringify({ refresh_token: tokens.refresh_token })
      : undefined;

    await fetch(`${API_BASE_URL}/users/token/logout`, {
      method: 'POST',
      headers,
      credentials: 'include',
      body,
    });
  }

  /**
   * Check if token needs refresh based on expiry time
   */
  needsRefresh(): boolean {
    const tokenExpiry = localStorage.getItem('token_expiry');
    if (!tokenExpiry) return false;

    const expiryTime = parseInt(tokenExpiry);
    const currentTime = Date.now();
    const thresholdTime = this.config.refreshThresholdMinutes * 60 * 1000;

    return expiryTime - currentTime <= thresholdTime;
  }

  /**
   * Get time remaining until token expiry in minutes
   */
  getTimeUntilExpiry(): number {
    const tokenExpiry = localStorage.getItem('token_expiry');
    if (!tokenExpiry) return 0;

    const expiryTime = parseInt(tokenExpiry);
    const currentTime = Date.now();
    return Math.max(0, Math.floor((expiryTime - currentTime) / (60 * 1000)));
  }

  /**
   * Ensure authentication is valid, refresh if needed
   * Useful for long-running operations
   */
  async ensureValidAuthentication(): Promise<boolean> {
    try {
      // Check if we have valid tokens
      if (!hasValidAuthTokens()) {
        console.warn('No valid auth tokens found');
        return false;
      }

      // Check if refresh is needed
      if (!this.needsRefresh()) {
        return true;
      }

      const tokens = await this.refreshToken();

      if (tokens) {
        // Update storage
        const storage = localStorage.getItem('remember_session') === 'true'
          ? localStorage
          : sessionStorage;
        storage.setItem('auth_tokens', JSON.stringify(tokens));

        // Update token expiry so needsRefresh() stays accurate
        if (tokens.expires_in) {
          const expiryTimestamp = Date.now() + tokens.expires_in * 1000;
          localStorage.setItem('token_expiry', String(expiryTimestamp));
        }

        // Update API header
        api.defaults.headers.common['Authorization'] = `Bearer ${tokens.access_token}`;

        return true;
      }

      return false;
    } catch (error) {
      console.error('Error ensuring valid authentication:', error);
      return false;
    }
  }

  /**
   * Start monitoring authentication for long-running operations
   * Returns a cleanup function
   */
  startAuthenticationMonitoring(intervalMinutes: number = 2): () => void {
    const intervalId = setInterval(
      async () => {
        if (this.needsRefresh()) {
          await this.ensureValidAuthentication();
        }
      },
      intervalMinutes * 60 * 1000
    );

    return () => clearInterval(intervalId);
  }

  /**
   * Prepare authentication for bulk processing
   * Ensures token is fresh and starts monitoring
   */
  async prepareForBulkProcessing(
    _documentCount: number
  ): Promise<{ success: boolean; cleanup: () => void }> {
    const authValid = await this.ensureValidAuthentication();
    if (!authValid) {
      return {
        success: false,
        cleanup: () => { },
      };
    }

    // Start monitoring with frequent checks for bulk operations
    const cleanup = this.startAuthenticationMonitoring(1);

    return {
      success: true,
      cleanup,
    };
  }

  /**
   * Get authentication status information
   */
  getAuthStatus(): {
    timeUntilExpiry: number;
    needsRefresh: boolean;
    isRefreshing: boolean;
    lastRefreshTime: number;
    hasValidTokens: boolean;
  } {
    return {
      timeUntilExpiry: this.getTimeUntilExpiry(),
      needsRefresh: this.needsRefresh(),
      isRefreshing: this.isRefreshing,
      lastRefreshTime: this.lastRefreshTime,
      hasValidTokens: hasValidAuthTokens(),
    };
  }

  /**
   * Refresh session using session cookie (fallback)
   */
  async refreshFromSessionCookie(): Promise<AuthTokens | null> {
    try {
      const response = await fetch(`${API_BASE_URL}/users/token/session`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'include',
      });

      if (response.ok) {
        return await response.json() as AuthTokens;
      }

      return null;
    } catch (error) {
      console.error('Session cookie authentication failed:', error);
      return null;
    }
  }
}

// Export singleton instance
export const authService = new AuthService();

// Export convenience functions for backward compatibility
export const login = (username: string, password: string) =>
  authService.login(username, password);

export const refreshToken = () =>
  authService.refreshToken();

export const getCurrentUser = () =>
  authService.getCurrentUser();

export const logout = () =>
  authService.logout();

export const prepareForBulkProcessing = (count: number) =>
  authService.prepareForBulkProcessing(count);

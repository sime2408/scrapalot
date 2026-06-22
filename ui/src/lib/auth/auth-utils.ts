/**
 * Authentication Utilities
 * 
 * Utility functions for JWT token validation and management.
 */

import { AuthTokens } from '@/types';

/**
 * Decode JWT payload without verification
 * @param token - JWT token string
 * @returns Decoded payload object or null if invalid
 */
export function decodeJWTPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) {
      console.error('Invalid JWT format - expected 3 parts, got:', parts.length);
      return null;
    }

    const payload = parts[1];

    // Handle base64url encoding
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');

    // Add padding if needed
    const paddedBase64 = base64.padEnd(
      base64.length + ((4 - (base64.length % 4)) % 4),
      '='
    );

    const jsonPayload = atob(paddedBase64);
    return JSON.parse(jsonPayload);
  } catch (error) {
    console.error('Error decoding JWT payload:', error);
    return null;
  }
}

/**
 * Check if a JWT token is expired
 * @param token - JWT token string
 * @param bufferSeconds - Extra buffer time in seconds (default: 60)
 * @returns true if expired, false if still valid
 */
export function isTokenExpired(token: string, bufferSeconds: number = 60): boolean {
  try {
    const payload = decodeJWTPayload(token);
    if (!payload || !payload.exp) {
      console.warn('Token has no expiration claim');
      return true;
    }

    const currentTime = Math.floor(Date.now() / 1000);
    const expirationTime = payload.exp;
    return currentTime >= expirationTime - bufferSeconds;
  } catch (error) {
    console.error('Error checking token expiration:', error);
    return true;
  }
}

/**
 * Check if we have valid authentication tokens in storage
 * Checks both localStorage and sessionStorage
 * @returns true if valid tokens exist, false otherwise
 */
export function hasValidAuthTokens(): boolean {
  try {
    // Check localStorage first
    const localTokensStr = localStorage.getItem('auth_tokens');
    if (localTokensStr) {
      const tokens: AuthTokens = JSON.parse(localTokensStr);
      if (tokens.access_token && !isTokenExpired(tokens.access_token)) {
        return true;
      } else if (tokens.access_token && isTokenExpired(tokens.access_token)) {
        // Clean up expired tokens
        try {
          localStorage.removeItem('auth_tokens');
        } catch (cleanupError) {
          console.error('Error cleaning up expired tokens:', cleanupError);
        }
      }
    }

    // Check sessionStorage as fallback
    const sessionTokensStr = sessionStorage.getItem('auth_tokens');
    if (sessionTokensStr) {
      const tokens: AuthTokens = JSON.parse(sessionTokensStr);
      if (tokens.access_token && !isTokenExpired(tokens.access_token)) {
        return true;
      } else if (tokens.access_token && isTokenExpired(tokens.access_token)) {
        // Clean up expired tokens
        try {
          sessionStorage.removeItem('auth_tokens');
        } catch (cleanupError) {
          console.error('Error cleaning up expired tokens:', cleanupError);
        }
      }
    }

    return false;
  } catch (error) {
    console.error('Error checking for valid auth tokens:', error);
    return false;
  }
}


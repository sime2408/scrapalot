/**
 * Extract a structured error from an error object.
 *
 * Returns both a human-readable message and an optional error_code
 * that maps to frontend i18n keys (general.errors.{error_code}).
 */
export interface ExtractedError {
  message: string;
  errorCode?: string;
}

/**
 * Extract the root cause error message and optional i18n error_code from an error object.
 */
export function extractError(error: unknown): ExtractedError {
  // Handle axios errors (have response property)
  if (error && typeof error === 'object' && 'response' in error) {
    const axiosError = error as { response?: { status?: number; data?: Record<string, unknown> }; code?: string; message?: string };
    const data = axiosError.response?.data;

    if (data) {
      const errorCode = data.error_code as string | undefined;
      const detail = data.detail as string | undefined;
      const message = data.message as string | undefined;

      if (detail || message) {
        return { message: detail || message, errorCode };
      }
    }

    // Status-based fallbacks
    const status = axiosError.response?.status;
    if (status === 401) return { message: 'Authentication required', errorCode: 'authenticationRequired' };
    if (status === 403) return { message: 'Access denied', errorCode: 'permissionDenied' };
    if (status === 404) return { message: 'Resource not found', errorCode: 'resourceNotFound' };
    if (status === 429) return { message: 'Too many requests', errorCode: 'requestTimeout' };
    if (status === 500) return { message: 'Server error', errorCode: 'failed' };
    if (status === 503) return { message: 'Service unavailable', errorCode: 'serviceUnavailable' };

    // Network errors
    if (axiosError.code === 'ECONNREFUSED' || axiosError.message?.includes('ECONNREFUSED')) {
      return { message: 'Connection refused', errorCode: 'connectionError' };
    }
    if (axiosError.code === 'ETIMEDOUT' || axiosError.message?.includes('timeout')) {
      return { message: 'Request timed out', errorCode: 'requestTimeout' };
    }
    if (axiosError.code === 'ERR_NETWORK' || axiosError.message?.includes('Network Error')) {
      return { message: 'Network error', errorCode: 'networkError' };
    }
  }

  // Handle standard Error objects
  if (error instanceof Error) {
    if (error.name === 'AbortError') {
      return { message: 'Request cancelled' };
    }
    if (error.message) {
      return { message: error.message };
    }
  }

  // Handle string errors
  if (typeof error === 'string') {
    return { message: error };
  }

  return { message: 'Unknown error occurred' };
}


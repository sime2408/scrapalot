/**
 * Enhanced error handling for loading service integration
 * Provides better error classification and recovery strategies
 */

/** Error categories for loading operations */
export type LoadingErrorType = 
  | 'network'
  | 'timeout' 
  | 'auth'
  | 'server'
  | 'client'
  | 'unknown';

/** Enhanced error information */
export interface LoadingError {
  readonly type: LoadingErrorType;
  readonly message: string;
  readonly operation?: string;
  readonly recoverable: boolean;
  readonly retryable: boolean;
  readonly timestamp: number;
  readonly originalError?: unknown;
}

/**
 * Classifies errors and provides context for better handling
 */
export class LoadingErrorHandler {
  /**
   * Analyze an error and categorize it
   * 
   * @param error The error to analyze
   * @param operation Optional description of the operation that failed
   * @returns Classified error information
   */
  static analyze(error: unknown, operation?: string): LoadingError {
    const timestamp = Date.now();
    
    // Network errors
    if (this.isNetworkError(error)) {
      return {
        type: 'network',
        message: 'Network connection failed. Please check your internet connection.',
        operation,
        recoverable: true,
        retryable: true,
        timestamp,
        originalError: error
      };
    }
    
    // Timeout errors
    if (this.isTimeoutError(error)) {
      return {
        type: 'timeout',
        message: 'Request timed out. The server is taking too long to respond.',
        operation,
        recoverable: true,
        retryable: true,
        timestamp,
        originalError: error
      };
    }
    
    // Authentication errors
    if (this.isAuthError(error)) {
      return {
        type: 'auth',
        message: 'Authentication required. Please log in again.',
        operation,
        recoverable: true,
        retryable: false,
        timestamp,
        originalError: error
      };
    }
    
    // Server errors (5xx)
    if (this.isServerError(error)) {
      return {
        type: 'server',
        message: 'Server error occurred. Please try again later.',
        operation,
        recoverable: true,
        retryable: true,
        timestamp,
        originalError: error
      };
    }
    
    // Client errors (4xx, excluding auth)
    if (this.isClientError(error)) {
      return {
        type: 'client',
        message: 'Request failed due to invalid data or permissions.',
        operation,
        recoverable: false,
        retryable: false,
        timestamp,
        originalError: error
      };
    }
    
    // Unknown errors
    return {
      type: 'unknown',
      message: error instanceof Error ? error.message : 'An unexpected error occurred.',
      operation,
      recoverable: false,
      retryable: false,
      timestamp,
      originalError: error
    };
  }
  
  /**
   * Handle an error with appropriate recovery strategy
   * 
   * @param error The error to handle
   * @param operation Optional operation description
   * @returns Promise that resolves with recovery action
   */
  static async handle(error: unknown, operation?: string): Promise<LoadingError> {
    const analysisResult = this.analyze(error, operation);

    // Sanitize error for logging (remove sensitive data like auth tokens)
    const sanitizedError = this.sanitizeError(analysisResult.originalError);

    // Log error based on severity
    if (analysisResult.type === 'unknown' || analysisResult.type === 'server') {
      console.error(`[LoadingError:${analysisResult.type}]`, {
        message: analysisResult.message,
        operation: analysisResult.operation,
        error: sanitizedError
      });
    } else if (process.env.NODE_ENV === 'development') {
      console.warn(`[LoadingError:${analysisResult.type}]`, {
        message: analysisResult.message,
        operation: analysisResult.operation
      });
    }

    return analysisResult;
  }

  /**
   * Sanitize error object by removing sensitive data like auth tokens, headers, and axios config
   * Only keep essential error information for debugging
   */
  private static sanitizeError(error: unknown): Record<string, unknown> | null {
    if (!error) return null;

    // Handle axios errors
    if (typeof error === 'object' && 'isAxiosError' in error) {
      const axiosError = error as { message?: string; name?: string; code?: string; response?: { status?: number; statusText?: string; data?: unknown } };
      return {
        message: axiosError.message,
        name: axiosError.name,
        code: axiosError.code,
        status: axiosError.response?.status,
        statusText: axiosError.response?.statusText,
        // Only include safe response data (no tokens or sensitive info)
        responseData: axiosError.response?.data
      };
    }

    // Handle standard Error objects
    if (error instanceof Error) {
      return {
        message: error.message,
        name: error.name
      };
    }

    // For unknown errors, return basic info
    return {
      type: typeof error,
      value: String(error)
    };
  }

  private static isNetworkError(error: unknown): boolean {
    if (error instanceof Error) {
      const message = error.message.toLowerCase();
      return (
        message.includes('network error') ||
        message.includes('connection refused') ||
        message.includes('failed to fetch') ||
        message.includes('err_internet_disconnected') ||
        message.includes('err_network_changed')
      );
    }
    return false;
  }
  
  private static isTimeoutError(error: unknown): boolean {
    if (error instanceof Error) {
      const message = error.message.toLowerCase();
      return message.includes('timeout') || message.includes('aborted');
    }
    return false;
  }
  
  private static isAuthError(error: unknown): boolean {
    return this.hasStatus(error, [401, 403]);
  }
  
  private static isServerError(error: unknown): boolean {
    return this.hasStatus(error, [500, 501, 502, 503, 504, 505]);
  }
  
  private static isClientError(error: unknown): boolean {
    return this.hasStatus(error, [400, 404, 405, 406, 409, 422, 429]);
  }
  
  private static hasStatus(error: unknown, statuses: number[]): boolean {
    // Check for axios error response
    if (
      error && 
      typeof error === 'object' && 
      'response' in error &&
      error.response &&
      typeof error.response === 'object' &&
      'status' in error.response
    ) {
      return statuses.includes(error.response.status as number);
    }
    
    // Check for fetch Response object
    if (error instanceof Response) {
      return statuses.includes(error.status);
    }
    
    return false;
  }
}
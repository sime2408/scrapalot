import { useMemo } from 'react';
import { LoadingErrorHandler, LoadingError } from '@/lib/loading-error-handler';

/**
 * Classifies an error into a structured LoadingError.
 * Returns null when error is null/undefined.
 *
 * Usage:
 *   const errorInfo = useLoadingError(error, 'fetchDocuments');
 *   if (errorInfo?.retryable) showRetryButton();
 */
export function useLoadingError(
  error: unknown,
  operation?: string
): LoadingError | null {
  return useMemo(() => {
    if (!error) return null;
    return LoadingErrorHandler.analyze(error, operation);
  }, [error, operation]);
}

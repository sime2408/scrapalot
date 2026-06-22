import { useCallback, useEffect, useRef, useState } from 'react';

export interface AsyncDataOptions<T> {
  /** Re-run fetcher when these values change. Pass [] to run once. */
  deps?: unknown[];
  /** Skip the fetch (e.g. while required params are not yet ready). */
  skip?: boolean;
  /** Initial data before first fetch completes. */
  initialData?: T;
}

export interface AsyncDataResult<T> {
  data: T | undefined;
  loading: boolean;
  error: string | null;
  /** Manually trigger a re-fetch without changing deps. */
  refetch: () => void;
}

/**
 * Is this an "aborted request" error? We silence it in state updates so an
 * unmounted tab does not flash a spurious "Request canceled" banner.
 *
 * Matches both axios's CanceledError (code 'ERR_CANCELED') and the native
 * DOMException that AbortController produces for fetch.
 */
function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const asObj = err as { name?: string; code?: string; message?: string };
  return (
    asObj.name === 'AbortError' ||
    asObj.name === 'CanceledError' ||
    asObj.code === 'ERR_CANCELED' ||
    asObj.message === 'canceled'
  );
}

/**
 * Fetches async data with loading/error state management.
 *
 * The fetcher now receives an `AbortSignal`. Pass it to axios / fetch so
 * the network request is genuinely cancelled when the component unmounts
 * or its deps change. Without this, tab-flipping the admin dashboard
 * leaves 6+ slow inspector requests in flight against the Python
 * backend — they eventually trip the gateway circuit breaker.
 *
 * Backward compat: fetchers that ignore the signal still work. Migrate
 * them opportunistically; never-aborted requests are not a regression.
 *
 * Usage:
 *   const { data, loading, error, refetch } = useAsyncData(
 *     (signal) => fetchDocuments(collectionId, signal),
 *     { deps: [collectionId] }
 *   );
 */
export function useAsyncData<T>(
  fetcher: (signal: AbortSignal) => Promise<T>,
  options: AsyncDataOptions<T> = {}
): AsyncDataResult<T> {
  const { deps = [], skip = false, initialData } = options;

  const [data, setData] = useState<T | undefined>(initialData);
  const [loading, setLoading] = useState(!skip);
  const [error, setError] = useState<string | null>(null);
  const [refetchTick, setRefetchTick] = useState(0);

  const fetcherRef = useRef(fetcher);
  useEffect(() => { fetcherRef.current = fetcher; });

  useEffect(() => {
    if (skip) {
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    let cancelled = false;
    setLoading(true);
    setError(null);

    fetcherRef.current(controller.signal)
      .then((result) => { if (!cancelled) { setData(result); setLoading(false); } })
      .catch((err: unknown) => {
        if (cancelled || isAbortError(err)) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });

    return () => {
      cancelled = true;
      // Cancel the in-flight HTTP request — not just the state update.
      // Admin tabs that kick off 3+ calls on mount stop flooding the
      // backend the moment the user switches away.
      controller.abort();
    };
  // `deps` is spread so ESLint cannot statically verify it — intentional dynamic dep array.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skip, refetchTick, ...deps]);

  const refetch = useCallback(() => setRefetchTick((n) => n + 1), []);

  return { data, loading, error, refetch };
}

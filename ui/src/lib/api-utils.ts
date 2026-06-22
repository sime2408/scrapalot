import { api } from './api';
import { cacheData } from './storage-utils';

/**
 * Shared API utilities for consistent caching, request handling, and error management
 * Used across all API service files to eliminate code duplication
 */

// Shared cache and mutex storage
const memoryCache: Record<string, { data: unknown; expiry: number }> = {};
const apiCallMutex: Record<string, Promise<unknown> | null> = {};

// Default configuration
export const API_CONFIG = {
  DEFAULT_TIMEOUT: 60000, // 60 seconds (increased for heavy operations)
  CACHE_TTL: 300000, // 5 minutes
  FRESH_CACHE_THRESHOLD: 30000, // 30 seconds
  SHORT_CACHE_TTL: 60000, // 1 minute
} as const;

/**
 * Generate consistent cache keys
 */
export function generateCacheKey(
  prefix: string,
  params?: Record<string, unknown>,
  suffix?: string
): string {
  const paramKey = params ? Object.entries(params)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}:${Array.isArray(v) ? v.join(',') : v}`)
    .join('_') : 'default';
  const suffixKey = suffix ? `_${suffix}` : '';
  return `${prefix}_${paramKey}${suffixKey}`;
}

/**
 * Check if cached data is valid
 */
export function checkCacheValidity<T>(
  cacheKey: string,
  bypassCache: boolean = false,
  refresh: boolean = false,
  ttl: number = API_CONFIG.CACHE_TTL
): T | null {
  if (bypassCache) return null;

  // Check memory cache first
  const memoryEntry = memoryCache[cacheKey];
  if (memoryEntry && memoryEntry.expiry > Date.now()) {
    // If refresh requested but cache is fresh, still use it
    const cacheAge = Date.now() - (memoryEntry.expiry - ttl);
    if (!refresh || cacheAge < API_CONFIG.FRESH_CACHE_THRESHOLD) {
      return memoryEntry.data as T;
    }
  }

  // Check persistent cache
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- cacheKey is dynamic, not keyof CacheData
  const persistentData = cacheData.getItem<T>(cacheKey as any);
  if (persistentData && !refresh) {
    // Update memory cache
    memoryCache[cacheKey] = {
      data: persistentData,
      expiry: Date.now() + ttl
    };
    return persistentData;
  }

  return null;
}

/**
 * Set data in both memory and persistent cache
 */
export function setCacheData<T>(
  cacheKey: string,
  data: T,
  ttl: number = API_CONFIG.CACHE_TTL
): void {
  // Update memory cache
  memoryCache[cacheKey] = {
    data,
    expiry: Date.now() + ttl
  };

  // Update persistent cache
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- cacheKey is dynamic, not keyof CacheData
  cacheData.setItem(cacheKey as any, data, ttl);
}

/**
 * Invalidate cache entries by pattern
 */
export function invalidateCache(pattern: string | RegExp): void {
  const isRegex = pattern instanceof RegExp;

  // Clear memory cache
  Object.keys(memoryCache).forEach(key => {
    if (isRegex ? pattern.test(key) : key.includes(pattern as string)) {
      delete memoryCache[key];
    }
  });

  // Clear persistent cache (simplified approach)
  if (typeof pattern === 'string') {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- pattern is dynamic, not keyof CacheData
    cacheData.removeItem(pattern as any);
  }
}

/**
 * Make API request with timeout, error handling, and optional mutex
 */
export async function makeApiRequest<T>(
  url: string,
  options: {
    params?: Record<string, unknown>;
    timeout?: number;
    method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
    data?: unknown;
    useMutex?: boolean;
    mutexKey?: string;
  } = {}
): Promise<T> {
  const {
    params,
    timeout = API_CONFIG.DEFAULT_TIMEOUT,
    method = 'GET',
    data,
    useMutex = false,
    mutexKey = `${method}_${url}_${JSON.stringify(params || {})}`
  } = options;

  // Handle mutex for request deduplication
  if (useMutex) {
    if (apiCallMutex[mutexKey]) {
      try {
        return await apiCallMutex[mutexKey] as T;
      } catch (error) {
        // If the existing promise fails, clear it and continue
        apiCallMutex[mutexKey] = null;
      }
    }
  }

  // Create API call promise
  const apiCall = async (): Promise<T> => {
    // Use Axios's built-in timeout instead of Promise.race to avoid double timeout issues
    // Only enforce 60s minimum for very short timeouts (< 30s) to allow reasonable custom timeouts
    const axiosConfig = { 
      params, 
      timeout: timeout < 30000 ? Math.max(timeout, 60000) : timeout
    };
    
    const response = method === 'GET'
      ? await api.get(url, axiosConfig)
      : method === 'POST'
        ? await api.post(url, data, axiosConfig)
        : method === 'PUT'
          ? await api.put(url, data, axiosConfig)
          : await api.delete(url, axiosConfig);
          
    return response.data;
  };

  // Store in mutex if requested
  if (useMutex) {
    apiCallMutex[mutexKey] = apiCall();
    try {
      const result = await apiCallMutex[mutexKey];
      return result as T;
    } finally {
      apiCallMutex[mutexKey] = null;
    }
  }

  return await apiCall();
}

/**
 * Cached API request - combines caching with API request
 */
export async function cachedApiRequest<T>(
  cacheKey: string,
  url: string,
  options: {
    params?: Record<string, unknown>;
    bypassCache?: boolean;
    refresh?: boolean;
    ttl?: number;
    timeout?: number;
    method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
    data?: unknown;
    useMutex?: boolean;
  } = {}
): Promise<T> {
  const {
    bypassCache = false,
    refresh = false,
    ttl = API_CONFIG.CACHE_TTL,
    ...apiOptions
  } = options;

  // Check cache first
  const cachedData = checkCacheValidity<T>(cacheKey, bypassCache, refresh, ttl);
  if (cachedData !== null) {
    return cachedData;
  }

  // Make API request
  const data = await makeApiRequest<T>(url, {
    ...apiOptions,
    useMutex: true, // Always use mutex for cached requests
    mutexKey: cacheKey
  });

  // Cache the result
  setCacheData(cacheKey, data, ttl);

  return data;
}

/**
 * Error handling wrapper for API functions
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- generic rest args require any[]
export function withErrorHandling<T extends any[], R>(
  fn: (...args: T) => Promise<R>,
  defaultValue?: R,
  errorMessage?: string
) {
  return async (...args: T): Promise<R> => {
    try {
      return await fn(...args);
    } catch (error) {
      // Enhanced error logging to help debug issues
      console.error(errorMessage || `API call failed:`, {
        function: fn.name,
        error,
        message: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined,
        args: args,
        timestamp: new Date().toISOString()
      });
      if (defaultValue !== undefined) {
        return defaultValue;
      }
      throw error;
    }
  };
}

/**
 * Utility functions for API calls and error handling
 */

// Request deduplication cache to prevent multiple identical API calls
const requestCache = new Map<string, Promise<unknown>>();

/**
 * Deduplicates API requests by caching promises based on a key
 */
export function deduplicateRequest<T>(
  key: string,
  requestFn: () => Promise<T>,
  ttlMs: number = 5000
): Promise<T> {
  // Check if request is already in progress
  if (requestCache.has(key)) {

    return requestCache.get(key)!;
  }

  // Create new request

  const promise = requestFn().finally(() => {
    // Remove from cache after TTL
    setTimeout(() => {
      requestCache.delete(key);
    }, ttlMs);
  });

  requestCache.set(key, promise);
  return promise;
}

/**
 * Map over items running at most `concurrency` async tasks at a time, preserving
 * input order in the result. Use instead of `Promise.all(items.map(fn))` whenever
 * the mapper hits the backend once per item — an unbounded fan-out (e.g. one
 * `/documents/collection/{id}` request per collection) is a thundering herd that
 * contends on the gRPC/DB connection pool and turns sub-100ms queries into
 * multi-second requests under the per-container CPU cap.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const limit = Math.max(1, Math.min(concurrency, items.length || 1));

  async function worker(): Promise<void> {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: limit }, () => worker()));
  return results;
}

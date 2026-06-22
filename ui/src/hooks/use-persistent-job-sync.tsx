/**
 * Persistent Job Synchronization Hook
 *
 * This hook manages WebSocket job tracking that persists across component
 * mount/unmount cycles. It keeps trackers alive globally and synchronizes
 * UI state when components reconnect.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { DocumentProcessingTracker } from '@/lib/api-documents';
import { API_BASE_URL, authState, showSessionExpiredAndRedirect } from '@/lib/api';
import { authService } from '@/lib/auth';
import stompService from '@/lib/stomp-service';

interface OngoingJob {
  jobId: string;
  documentId: string;
  filename: string;
  progress?: number;
  status?: string;
}

interface JobProgress {
  jobId: string;
  documentId?: string;
  progress: number;
  status: string;
  message?: string;
}

// Global registry to persist trackers across component lifecycles
const globalTrackerRegistry = new Map<string, DocumentProcessingTracker>();
const globalJobCallbacks = new Map<string, Set<(progress: JobProgress) => void>>();

// Global state to prevent concurrent fetches and implement backoff
let globalIsFetching = false;
let globalLastFetchTime = 0;
let globalFailureCount = 0;
const MIN_FETCH_INTERVAL = 300000; // Minimum 5 minutes between fetches (WebSocket notifications handle real-time updates)
const MAX_BACKOFF = 120000; // Max 2 minutes backoff on failures

// Global flag to prevent duplicate STOMP subscriptions
let globalStompSubscribed = false;
let globalStompUnsubscribe: (() => void) | null = null;

// Global flag to stop polling after 401 redirect (prevents repeated error logs)
let globalAuthFailed = false;

/**
 * Reset auth failed flag - call this after successful login
 * This allows job sync to resume after the user logs in again
 */
export function resetJobSyncAuthState(): void {
  globalAuthFailed = false;
  globalFailureCount = 0;
  globalLastFetchTime = 0;
  console.log('🔄 Job sync auth state reset');
}

/**
 * Get access token from storage
 */
function getAccessToken(): string | null {
  try {
    const storageKeys = ['auth_tokens', 'accessToken', 'access_token'];
    const storageLocations = [localStorage, sessionStorage];

    for (const storage of storageLocations) {
      for (const key of storageKeys) {
        try {
          const tokenData = storage.getItem(key);
          if (!tokenData) continue;

          if (key === 'auth_tokens') {
            const authTokens = JSON.parse(tokenData);
            const token = authTokens?.access_token;
            if (token && typeof token === 'string' && token.length > 10) {
              return token;
            }
          } else if (typeof tokenData === 'string' && tokenData.length > 10) {
            return tokenData;
          }
        } catch (parseError) {
          // Ignore parse errors and continue to the next key
        }
      }
    }
    return null;
  } catch (error) {
    console.error('Error accessing token storage:', error);
    return null;
  }
}

/**
 * Fetch active jobs from backend with concurrency control and backoff
 *
 * @param force - If true, bypasses the backoff interval check (for dialog open/manual refresh)
 * @returns Array of active jobs on success, null on error (network/auth failure)
 */
async function fetchActiveJobs(force: boolean = false): Promise<OngoingJob[] | null> {
  const now = Date.now();
  console.log(`🔄 fetchActiveJobs called (force=${force})`);

  // Skip if auth has already failed (prevents repeated 401 errors after logout)
  if (globalAuthFailed) {
    console.log('⏭️ fetchActiveJobs: Auth failed previously, skipping to prevent repeated errors');
    return null;
  }

  // Skip if already fetching (prevents concurrent requests)
  if (globalIsFetching) {
    console.log('⏭️ fetchActiveJobs: Already fetching, skipping');
    return null;
  }

  // Calculate backoff interval based on failure count
  const backoffInterval = Math.min(
    MIN_FETCH_INTERVAL * Math.pow(2, globalFailureCount),
    MAX_BACKOFF
  );

  // Skip if we fetched too recently (respects backoff) - unless force is true
  if (!force && now - globalLastFetchTime < backoffInterval) {
    console.log(`⏭️ fetchActiveJobs: Backoff active (${Math.round((backoffInterval - (now - globalLastFetchTime)) / 1000)}s remaining)`);
    return null;
  }

  const accessToken = getAccessToken();
  if (!accessToken) {
    console.log('⚠️ fetchActiveJobs: No access token');
    return null;
  }

  globalIsFetching = true;
  globalLastFetchTime = now;

  try {
    const response = await fetch(`${API_BASE_URL}/jobs/active?include_details=true`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(15000), // Increased to 15 seconds
    });

    if (!response.ok) {
      console.log(`❌ fetchActiveJobs: Response not OK (${response.status})`);

      // Handle 401 Unauthorized — try ONE refresh-and-retry before
      // surrendering the session. The previous behaviour kicked the
      // user back to /login the moment any background poll caught a
      // stale-token window, even when the worker was actively pushing
      // STOMP updates. With the refresh-token still valid (7-day TTL),
      // the access token can be rotated without bothering the user.
      if (response.status === 401) {
        console.log('🔒 fetchActiveJobs: 401 — attempting silent refresh + retry');
        try {
          const { refreshToken } = await import('@/lib/auth');
          const fresh = await refreshToken();
          if (fresh?.access_token) {
            const retry = await fetch(`${API_BASE_URL}/jobs/active?include_details=true`, {
              headers: {
                Authorization: `Bearer ${fresh.access_token}`,
                'Content-Type': 'application/json',
              },
              signal: AbortSignal.timeout(15000),
            });
            if (retry.ok) {
              const data = await retry.json();
              if (data.active_jobs) {
                globalFailureCount = 0;
                return Object.entries(data.active_jobs)
                  .filter(([, v]) => v && typeof v === 'object')
                  .map(([jobId, jobData]) => {
                    const j = jobData as Record<string, unknown>;
                    return {
                      jobId,
                      documentId: (j.document_id as string) || '',
                      filename: (j.filename as string) || (j.title as string) || '',
                      progress: typeof j.progress === 'number' ? j.progress : 0,
                      status: (j.status as string) || 'processing',
                    } as OngoingJob;
                  })
                  .filter(j => j.status === 'processing' || j.status === 'pending');
              }
            }
          }
        } catch (refreshErr) {
          console.warn('fetchActiveJobs: silent refresh failed', refreshErr);
        }
        // Refresh failed → genuine session loss
        globalAuthFailed = true;
        if (globalStompUnsubscribe) {
          globalStompUnsubscribe();
          globalStompUnsubscribe = null;
          globalStompSubscribed = false;
        }
        void showSessionExpiredAndRedirect();
        return null;
      }

      globalFailureCount = Math.min(globalFailureCount + 1, 5);
      return null;  // Error - return null to preserve existing state
    }

    // Success - reset failure count
    globalFailureCount = 0;

    const data = await response.json();
    if (!data.active_jobs) {
      return [];  // Success with no jobs - return empty array
    }

    const activeJobs = Object.values(data.active_jobs)
      .filter((job) => {
        const j = job as Record<string, unknown>;
        return j.status !== 'cancelled' &&
          j.status !== 'failed' &&
          j.status !== 'completed';
      })
      .map((job) => {
        const j = job as Record<string, unknown>;
        return {
          jobId: j.job_id as string,
          documentId: j.document_id as string,
          filename: (j.filename as string) || 'Unknown Document',
          progress: j.progress as number,
          status: j.status as string,
        };
      });
    console.log(`📡 fetchActiveJobs: Backend returned ${Object.keys(data.active_jobs).length} jobs, ${activeJobs.length} after filtering:`, JSON.stringify(activeJobs));
    return activeJobs;
  } catch (error) {
    console.log(`❌ fetchActiveJobs: Error - ${error}`);
    globalFailureCount = Math.min(globalFailureCount + 1, 5);
    return null;  // Error - return null to preserve existing state
  } finally {
    globalIsFetching = false;
  }
}

/**
 * Create or get existing tracker for a job
 */
function getOrCreateTracker(
  jobId: string,
  documentId: string,
  onComplete?: () => void
): DocumentProcessingTracker {
  // Check if tracker already exists
  let tracker = globalTrackerRegistry.get(jobId);

  if (!tracker) {
    // Create new tracker
    tracker = new DocumentProcessingTracker({
      jobId,
      documentId,
      onProgress: (progressData) => {
        // Notify all registered callbacks
        const callbacks = globalJobCallbacks.get(jobId);
        if (callbacks) {
          callbacks.forEach(callback => {
            callback({
              jobId,
              documentId,  // Include documentId in the callback
              progress: progressData.progress || 0,
              status: progressData.status || 'processing',
              message: progressData.message,
            });
          });
        }
      },
      onComplete: () => {
        // Clean up tracker
        globalTrackerRegistry.delete(jobId);
        globalJobCallbacks.delete(jobId);

        // Notify completion callback
        if (onComplete) {
          onComplete();
        }
      },
      onError: (error) => {
        console.error(`Job ${jobId} error:`, error);
        // Clean up on error
        globalTrackerRegistry.delete(jobId);
        globalJobCallbacks.delete(jobId);
      },
    });

    globalTrackerRegistry.set(jobId, tracker);
  }

  return tracker;
}

/**
 * Document added event data from WebSocket
 */
interface DocumentAddedData {
  document_id: string;
  collection_id: string;
  title: string;
  filename?: string;
  status: string;
  source?: string;
}

/**
 * WebSocket job notification message format
 */
interface JobNotificationMessage {
  type?: string;
  content?: {
    progress?: number;
    message?: string;
    status?: string;
  };
  event_type?: string;
  job?: {
    id?: string;
    job_id?: string;
    document_id?: string;
    collection_id?: string;
    progress?: number;
    status?: string;
    message?: string;
    title?: string;
    filename?: string;
    source?: string;
  };
  // Direct notification format
  job_id?: string;
  document_id?: string;
  collection_id?: string;
  progress?: number;
  status?: string;
  message?: string;
  title?: string;
  filename?: string;
  source?: string;
  id?: string;
}

/**
 * Hook for persistent job synchronization
 */
export function usePersistentJobSync(options?: {
  onJobComplete?: () => void;
  onJobProgress?: (jobId: string, progress: JobProgress) => void;
  onDocumentAdded?: (data: DocumentAddedData) => void;
}) {
  const [ongoingJobs, setOngoingJobs] = useState<OngoingJob[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const { onJobComplete, onJobProgress, onDocumentAdded } = options || {};

  // Store callbacks in refs to avoid re-creating dependencies
  const onJobCompleteRef = useRef(onJobComplete);
  const onJobProgressRef = useRef(onJobProgress);
  const onDocumentAddedRef = useRef(onDocumentAdded);

  // Update refs when callbacks change
  useEffect(() => {
    onJobCompleteRef.current = onJobComplete;
    onJobProgressRef.current = onJobProgress;
    onDocumentAddedRef.current = onDocumentAdded;
  }, [onJobComplete, onJobProgress, onDocumentAdded]);

  /**
   * Register callback for job progress
   */
  const registerCallback = useCallback((jobId: string) => {
    const callback = (progress: JobProgress) => {
      // Update local state
      setOngoingJobs(prev =>
        prev.map(job =>
          job.jobId === jobId
            ? { ...job, progress: progress.progress, status: progress.status }
            : job
        )
      );

      // Notify external callback (use ref to avoid dependency)
      if (onJobProgressRef.current) {
        onJobProgressRef.current(jobId, progress);
      }
    };

    let callbacks = globalJobCallbacks.get(jobId);
    if (!callbacks) {
      callbacks = new Set();
      globalJobCallbacks.set(jobId, callbacks);
    }
    callbacks.add(callback);

    return () => {
      callbacks?.delete(callback);
      if (callbacks?.size === 0) {
        globalJobCallbacks.delete(jobId);
      }
    };
  }, []); // No dependencies - uses refs

  /**
   * Synchronize with backend and WebSocket trackers
   * @param force - If true, bypasses the backoff interval check (for dialog open/manual refresh)
   */
  const syncJobs = useCallback(async (force: boolean = false) => {
    setIsLoading(true);
    try {
      // 1. Fetch active jobs from backend
      const backendJobs = await fetchActiveJobs(force);

      // If fetch failed (null), skip sync to preserve existing state
      if (backendJobs === null) {
        console.log('⚠️ syncJobs: fetchActiveJobs returned null, preserving existing state');
        return [];
      }

      // 2. Merge backend + STOMP-known jobs. The backend "active jobs"
      // endpoint reads from JobService.processing_status (in-memory dict
      // populated only by the legacy streaming-upload path) and so
      // returns 0 jobs even when Celery workers are busy on the jobs
      // table. Treating it as the sole source of truth caused
      // setOngoingJobs([]) on every poll, which wiped any progress
      // entries that arrived via STOMP and froze the progress ring at
      // its first captured value. Use the functional setter so we
      // observe the latest STOMP-added entries (closure on `ongoingJobs`
      // would be stale because syncJobs has empty useCallback deps).
      const backendJobIds = new Set(backendJobs.map(j => j.jobId));
      let mergedJobs: OngoingJob[] = backendJobs;
      setOngoingJobs(prev => {
        const jobMap = new Map<string, OngoingJob>();
        prev.forEach(p => {
          if (p.status === 'processing') jobMap.set(p.jobId, p);
        });
        backendJobs.forEach(job => jobMap.set(job.jobId, job));
        mergedJobs = Array.from(jobMap.values());
        return mergedJobs;
      });

      // 3. Clean up tracker registry — only remove trackers for jobs
      // that are gone from BOTH backend AND the merged set (so STOMP-
      // only entries keep their tracker).
      const mergedJobIds = new Set(mergedJobs.map(j => j.jobId));
      for (const [jobId, tracker] of globalTrackerRegistry.entries()) {
        if (!backendJobIds.has(jobId) && !mergedJobIds.has(jobId)) {
          tracker.cleanup?.();
          globalTrackerRegistry.delete(jobId);
          globalJobCallbacks.delete(jobId);
        }
      }

      // 4. Create trackers for jobs that don't have them
      mergedJobs.forEach(job => {
        // Use ref to avoid dependency on onJobComplete
        getOrCreateTracker(job.jobId, job.documentId, onJobCompleteRef.current);
        registerCallback(job.jobId);
      });

      // 5. (state already updated above via the functional setter)
      console.log(`📥 usePersistentJobSync: ongoingJobs synced to ${mergedJobs.length} jobs`);

      return mergedJobs;
    } catch (error) {
      console.error('Failed to sync jobs:', error);
      return [];
    } finally {
      setIsLoading(false);
    }
  }, [registerCallback]); // Only depends on registerCallback (which is now stable)

  /**
   * Initial sync on mount and WebSocket subscription
   */
  useEffect(() => {
    // REMOVED: isSubscribedRef guard - it causes hot-reload issues
    // The guard could fail to reset during hot-reload, blocking syncJobs() from running
    // globalStompSubscribed already prevents duplicate STOMP subscriptions

    // Force sync on mount to always get latest jobs (fixes hot-reload showing empty list)
    const initialTimeout = setTimeout(() => syncJobs(true), 1000);

    // Sync every 5 minutes as fallback (WebSocket handles real-time updates)
    const interval = setInterval(syncJobs, 300000);

    // Subscribe to user-level job notifications via WebSocket
    let unsubscribe: (() => void) | null = null;

    const setupWebSocket = async () => {
      try {
        // Wait for auth to be ready before accessing tokens
        await authState.waitForAuthReady();

        // Get user_id from token storage
        const authTokensStr = localStorage.getItem('auth_tokens') || sessionStorage.getItem('auth_tokens');
        if (!authTokensStr) {
          console.warn('No auth tokens found, cannot subscribe to job notifications');
          return;
        }

        const authTokens = JSON.parse(authTokensStr);
        const token = authTokens?.access_token;
        if (!token) {
          console.warn('No access token found, cannot subscribe to job notifications');
          return;
        }

        // Decode JWT to get user_id (basic decode, not verification)
        const payload = JSON.parse(atob(token.split('.')[1]));
        const userId = payload?.sub;
        if (!userId) {
          console.warn('No user ID in token, cannot subscribe to job notifications');
          return;
        }

        // Check if already subscribed globally to prevent duplicates
        if (globalStompSubscribed) {
          console.log('⏭️ STOMP subscription already active, skipping duplicate');
          return;
        }

        // Mark as subscribed BEFORE async call to prevent race conditions
        globalStompSubscribed = true;

        // Subscribe to user job notifications
        unsubscribe = await stompService.subscribeToUserJobs(userId, (rawMessage: unknown) => {
          try {
            const message = rawMessage as JobNotificationMessage;
            console.log('🔍 RAW WebSocket message received:', JSON.stringify(message, null, 2));

            // Handle status update format: {"type": "status", "content": {progress, message, status}}
            if (message.type === 'status' && message.content) {
              console.log(`📊 Status update: ${message.content.progress}% - ${message.content.message}`);
              // Note: This format doesn't include job_id/document_id, so we can't update specific documents
              // This is likely from job-specific subscriptions, not user-wide subscriptions
              // We'll need to handle this differently - possibly by subscribing to individual jobs
              return;
            }

            // Handle both old format (event_type + job) and new format (direct notification)
            const eventType = message.event_type;
            const jobData = message.job || message; // Fallback to message itself if no .job field

            // Normalise: backend's send_user_job_notification wraps the payload
            // as {type:"job_notification", event_type, job:{job_id, ...}}, so
            // job_id et al live one level deeper. Promote them to message-level
            // so the existing direct-notification branch below catches them
            // without an extra code path.
            if (!message.job_id && message.job && typeof message.job === 'object') {
              const j = message.job as Record<string, unknown>;
              message.job_id = j.job_id as string | undefined;
              message.document_id = j.document_id as string | undefined;
              message.progress = j.progress as number | undefined;
              message.status = j.status as string | undefined;
              message.filename = (j.filename as string | undefined) ?? message.filename;
              message.title = (j.title as string | undefined) ?? message.title;
              message.message = (j.message as string | undefined) ?? message.message;
            }

            // Check if this is a direct document notification (new format)
            if (message.job_id && message.document_id && typeof message.progress === 'number') {
              console.log(`📊 Document processing progress: ${message.progress}% (Job: ${message.job_id})`);

              // Update ongoingJobs state so UI reflects live progress
              setOngoingJobs(prev => {
                const exists = prev.some(j => j.jobId === message.job_id);
                if (exists) {
                  return prev.map(j =>
                    j.jobId === message.job_id
                      ? { ...j, progress: message.progress, status: message.status || j.status }
                      : j
                  );
                }
                // New job not in list yet — add it
                return [...prev, {
                  jobId: message.job_id!,
                  documentId: message.document_id!,
                  filename: message.filename || message.title || 'Processing...',
                  progress: message.progress,
                  status: message.status || 'processing',
                }];
              });

              // Handle completion/failure — remove from ongoing and notify
              if (message.status === 'completed' || message.status === 'failed' || message.status === 'cancelled') {
                setOngoingJobs(prev => prev.filter(j => j.jobId !== message.job_id));
                if (onJobCompleteRef.current) {
                  onJobCompleteRef.current();
                }
              }

              if (onJobProgressRef.current) {
                onJobProgressRef.current(message.job_id, {
                  jobId: message.job_id,
                  progress: message.progress,
                  status: message.status || 'processing',
                  documentId: message.document_id,
                  message: message.message,
                });
              }
              return; // Early return after handling
            }

            console.log(`📩 Received job notification: ${eventType}`, jobData);

            if (eventType === 'job_started') {
              // New job started - force fetch updated job list (bypass backoff)
              console.log('🚀 Job started event received, forcing sync');
              syncJobs(true);
            } else if (eventType === 'job_progress') {
              // Job progress update - update local state and notify callback
              const jobId = jobData?.id || jobData?.job_id;
              console.log(`📊 Job ${jobId} progress: ${jobData?.progress}%`, jobData);

              // Update ongoingJobs state with new progress
              if (jobId) {
                setOngoingJobs(prev => {
                  const exists = prev.some(j => j.jobId === jobId);
                  if (exists) {
                    return prev.map(j =>
                      j.jobId === jobId
                        ? { ...j, progress: jobData?.progress ?? j.progress, status: jobData?.status ?? j.status }
                        : j
                    );
                  }
                  // New job not in list yet — add it and force a full sync
                  syncJobs(true);
                  return prev;
                });
              }

              if (onJobProgressRef.current && jobData && jobId) {
                onJobProgressRef.current(jobId, {
                  jobId,
                  progress: jobData.progress || 0,
                  status: jobData.status || 'processing',
                  documentId: jobData.document_id,
                  message: jobData.message,
                });
              }
            } else if (eventType === 'job_completed' || eventType === 'job_failed' || eventType === 'job_cancelled') {
              // Job finished - remove from ongoing jobs immediately and notify
              const finishedJobId = jobData?.id || jobData?.job_id;
              if (finishedJobId) {
                setOngoingJobs(prev => prev.filter(j => j.jobId !== finishedJobId));
              }
              // Notify completion callback
              if (onJobCompleteRef.current) {
                onJobCompleteRef.current();
              }
              // Sync with backend to ensure consistency
              syncJobs(true);
            } else if (eventType === 'document_added') {
              // New document added (e.g., external book downloaded) - notify callback
              console.log(`📚 Document added: ${jobData?.title || 'Unknown'}`, jobData);
              if (onDocumentAddedRef.current && jobData) {
                onDocumentAddedRef.current({
                  document_id: jobData.document_id || '',
                  collection_id: jobData.collection_id || '',
                  title: jobData.title || '',
                  filename: jobData.filename,
                  status: jobData.status || '',
                  source: jobData.source,
                });
              }
            }
          } catch (error) {
            console.error('Error processing job notification:', error);
          }
        });

        // Store unsubscribe function globally
        globalStompUnsubscribe = unsubscribe;

        console.log('Subscribed to user job notifications for user:', userId);
      } catch (error) {
        console.error('Failed to subscribe to user job notifications:', error);
        // Reset flag on error so retry is possible
        globalStompSubscribed = false;
        globalStompUnsubscribe = null;
      }
    };

    void setupWebSocket();

    return () => {
      clearTimeout(initialTimeout);
      clearInterval(interval);
      // Intentionally do NOT call unsubscribe() here. The previous code
      // tore down the STOMP callback on unmount but kept
      // globalStompSubscribed=true, so the next mount skipped re-subscribing
      // and incoming STOMP frames had no listener — the progress ring sat
      // frozen because setOngoingJobs was never called even though the
      // backend was emitting per-batch updates. Leaving the global
      // subscription alive across mount/unmount cycles keeps live progress
      // working when the user closes and re-opens the Knowledge Stacks
      // dialog. The subscription is global by design (one per user
      // session); the cleanup function still cancels the per-mount poller.
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are intentionally limited
  }, []); // Empty dependencies - runs once per mount, syncJobs(true) forces fresh data

  /**
   * Keep the access token alive while the user has any active processing.
   * Without this the JWT would expire after its TTL (~30 min default), the
   * next API call returned 401, and the app bounced the user back to /login
   * mid-upload — even though processing was still running on the worker.
   * The auth-service monitor refreshes every minute when needsRefresh()
   * trips, using the longer-lived refresh token. We start it whenever
   * there is at least one active job and stop when the queue drains.
   */
  useEffect(() => {
    if (ongoingJobs.length === 0) return;
    const cleanup = authService.startAuthenticationMonitoring(1);
    return () => cleanup();
  }, [ongoingJobs.length]);

  /**
   * Check if there are active jobs
   */
  const hasActiveJobs = ongoingJobs.length > 0;

  /**
   * Force sync jobs immediately (bypasses the 5-minute backoff interval)
   * Use this when the dialog opens or user manually refreshes
   */
  const forceSync = useCallback(() => {
    return syncJobs(true);
  }, [syncJobs]);

  return {
    ongoingJobs,
    isLoading,
    hasActiveJobs,
    syncJobs,
    forceSync,
  };
}

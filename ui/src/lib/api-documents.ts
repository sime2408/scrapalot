import axios from 'axios';
import { io, Socket } from 'socket.io-client';
import { api, API_BASE_URL, getAuthHeaders, clearCache } from './api';
import { Client } from '@stomp/stompjs';

// Shared WebSocket connection for document processing
let sharedSocketConnection: Socket | null = null;

/**
 * Get a shared WebSocket connection for document processing.
 * This ensures we only have a single connection across the app.
 */
export function getSharedWebSocketConnection(): Socket {
  if (!sharedSocketConnection) {
    // Helper function to get correct base URL for Socket.IO (handles api.scrapalot.app routing)
    const getSocketIOBaseUrl = (): string => {
      const hostname = window.location.hostname;

      // Production domains - use backend API subdomain
      if (hostname === 'scrapalot.app' || hostname === 'www.scrapalot.app') {
        return 'https://api.scrapalot.app';
      }

      // For other production domains or localhost, use current origin
      return window.location.origin;
    };

    const baseUrl = getSocketIOBaseUrl();

    // Tokens live in localStorage with "Remember me", sessionStorage
    // otherwise (see api.ts:1741-1744). Reading only one storage skips
    // session-storage users entirely.
    let accessToken: string | null = null;
    try {
      const storedTokensJson =
        localStorage.getItem('auth_tokens') ||
        sessionStorage.getItem('auth_tokens');
      if (storedTokensJson) {
        const tokens = JSON.parse(storedTokensJson);
        if (tokens && typeof tokens.access_token === 'string') {
          accessToken = tokens.access_token;
        }
      }
    } catch (e) {
      console.error('Failed to parse auth tokens for WebSocket connection:', e);
    }

    // Create a new socket connection
    sharedSocketConnection = io(baseUrl, {
      path: '/ws/socket.io/',  // Socket.IO endpoint (backend mounts at /ws with socketio_path="socket.io")
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: 3, // Reduced from 5 to minimize noise
      reconnectionDelay: 5000, // Increased delay
      reconnectionDelayMax: 15000, // Increased max delay
      timeout: 20000,
      autoConnect: false, // Don't connect automatically - connect when needed
      // Use the same auth approach as REST API
      auth: accessToken ? { token: accessToken } : undefined,
      extraHeaders: accessToken
        ? {
          Authorization: `Bearer ${accessToken}`,
        }
        : {},
    });

    sharedSocketConnection.on('connect', () => {
      console.log('Socket.IO connected for document processing');
    });

    sharedSocketConnection.on('connect_error', error => {
      // Suppress protocol version errors - they're expected if backend is using different version
      const errorMessage = error?.message || String(error);
      if (errorMessage.includes('unsupported version') || errorMessage.includes('protocol')) {
        console.warn('⚠️ Socket.IO version mismatch - real-time document updates unavailable');
      } else {
        console.warn('⚠️ Socket.IO connection error:', errorMessage);
      }
    });

    sharedSocketConnection.on('disconnect', reason => {
      console.warn('⚠️ WebSocket disconnected:', reason);
    });

    sharedSocketConnection.io.on('reconnect_attempt', _attempt => {
      // Update auth token on reconnected attempts in case it changed
      try {
        const storedTokensJson =
          localStorage.getItem('auth_tokens') ||
          sessionStorage.getItem('auth_tokens');
        let newAccessToken: string | null = null;

        if (storedTokensJson) {
          const tokens = JSON.parse(storedTokensJson);
          if (tokens && typeof tokens.access_token === 'string') {
            newAccessToken = tokens.access_token;
          }
        }

        if (newAccessToken && sharedSocketConnection) {
          sharedSocketConnection.auth = { token: newAccessToken };
          // Also update extraHeaders if possible
          if (sharedSocketConnection.io?.opts?.extraHeaders) {
            sharedSocketConnection.io.opts.extraHeaders['Authorization'] =
              `Bearer ${newAccessToken}`;
          }
        }
      } catch (e) {
        console.error('Failed to update auth token during reconnection:', e);
      }
    });

    sharedSocketConnection.io.on('reconnect_failed', () => {
      console.error('WebSocket reconnection failed after maximum attempts');
      sharedSocketConnection = null; // Clear the reference so the next call creates a new connection
    });
  }

  return sharedSocketConnection;
}

// Define a logger utility
const logger = {
  debug: (message: string) => console.debug(message),
  info: (message: string) => console.info(message),
  warn: (message: string) => console.warn(message),
  error: (message: string) => console.error(message),
};

// Define job status types
type JobStatus =
  | 'pending'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'info'
  | 'warning'
  | 'unknown';

// Define interface for job processing status
interface ProcessingJobStatus {
  job_id: string;
  document_id?: string;
  collection_id?: string;
  status: JobStatus;
  progress: number;
  message: string;
  timestamp?: number;
  last_update_time?: number;
  warnings?: string[];
  errors?: string;
  [key: string]: unknown;
}

// Interface for job update events
interface JobUpdateEvent {
  job_id?: string;
  jobId?: string;
  document_id?: string;
  documentId?: string;
  progress?: number | string;
  message?: string;
  status?: string;
  [key: string]: unknown;
}

// Define types that aren't in the imported types
interface Document {
  id: string;
  name: string;
  size?: number;
  content_type?: string;
  collection_id?: string;
  [key: string]: unknown;
}

interface Collection {
  id: string;
  name: string;
  documents?: Document[];
  workspace_id?: string;
  [key: string]: unknown;
}
// Use types imported from @/types
// No need to redefine Document, Collection, Workspace


// Delete a collection
export const deleteCollection = async (id: string): Promise<boolean> => {
  try {
    await api.delete(`/collections/${id}`);
    return true;
  } catch (error) {
    console.error('Error deleting collection:', error);
    throw error;
  }
};

/**
 * Fetch a single document by its ID.
 * Returns the full document details including file_stored, file_size, thumbnail info.
 */
export async function getDocumentById(documentId: string): Promise<Record<string, unknown>> {
  const response = await api.get(`/documents/${documentId}`);
  return response.data;
}

/**
 * Delete a document by its ID.
 * Note: The backend route only requires the document ID.
 */
export async function updateDocumentPriority(documentId: string, priority: number): Promise<{ success: boolean; priority: number }> {
  const response = await api.patch(`/documents/${documentId}/priority`, { priority });
  return response.data;
}

export async function deleteDocument(documentId: string): Promise<void> {
  let response;
  try {
    // Construct the URL according to the backend route: /documents/{document_id}
    response = await api.delete(`/documents/${documentId}`);
  } catch (error) {
    console.error('Error deleting document:', error);
    throw error; // Re-throw the error to be handled by the caller
  }

  if (response.status !== 200 && response.status !== 204) {
    throw new Error(`Failed to delete document: ${response.statusText}`);
  }

  // Clear cached responses for document-related endpoints to ensure fresh data
  clearCache('/documents/collection/');
  clearCache('/collections/');
  // The "Recent" sidebar reads from /document-views/recent — deletion
  // must invalidate that cache AND ping any mounted strip to refetch,
  // otherwise the deleted book lingers for up to 60 s.
  clearCache('/document-views/recent');
  window.dispatchEvent(new CustomEvent('scrapalot:recent-documents-changed'));
}

/**
 * Partially delete a document — remove only embeddings, graph, or file.
 * @param documentId - The document UUID
 * @param scope - "embeddings" | "graph" | "file"
 */
export async function partialDeleteDocument(
  documentId: string,
  scope: 'embeddings' | 'graph' | 'file'
): Promise<{ success: boolean; message: string }> {
  const response = await api.delete(`/documents/${documentId}/partial?scope=${scope}`);
  clearCache('/documents/collection/');
  return response.data;
}

/**
 * Move documents to a different collection.
 */
export async function moveDocuments(documentIds: string[], targetCollectionId: string): Promise<{ success: boolean; moved_count: number; failed_count: number; message: string }> {
  const response = await api.post('/documents/move', {
    document_ids: documentIds,
    target_collection_id: targetCollectionId,
  });
  clearCache('/documents/collection/');
  clearCache('/collections/');
  return response.data;
}

/**
 * Batch delete multiple documents at once.
 */
export async function batchDeleteDocuments(documentIds: string[]): Promise<{ success: boolean; deleted_count: number; failed_count: number }> {
  const response = await api.post('/documents/batch-delete', {
    document_ids: documentIds,
  });
  clearCache('/documents/collection/');
  clearCache('/collections/');
  return response.data;
}

/**
 * Reprocess a failed document by cleaning up orphan data and restarting processing.
 * This function:
 * 1. Cleans up orphan embeddings and Neo4j data
 * 2. Resets document status to 'pending'
 * 3. Starts background processing
 * @param documentId - The document UUID to reprocess
 * @returns Promise with job information for tracking progress
 */
/**
 * Image / table / equation extracted from a document during ingest.
 * The list endpoint feeds the "Visual entities" tab next to text chunks.
 */
export interface MultimodalElement {
  id: string;
  element_type: 'image' | 'table' | 'equation' | string;
  entity_subtype: string | null;
  page_idx: number;
  entity_name: string | null;
  caption: string | null;
  description: string | null;
  content_text: string | null;
  storage_path: string | null;
  bbox_json: string | null;
  symbol_map_json: string | null;
  structured_data_json: string | null;
  derived_stats_json: string | null;
  processing_status: string;
  described_at: string | null;
}

export async function listDocumentMultimodalElements(
  documentId: string,
): Promise<{ elements: MultimodalElement[]; total_count: number }> {
  const response = await api.get(`/documents/${documentId}/multimodal-elements`);
  return response.data;
}

export async function reprocessDocument(documentId: string): Promise<{
  message: string;
  document_id: string;
  job_id: string;
  status: string;
}> {
  let response;
  try {
    response = await api.post(`/documents/reprocess/${documentId}`);
  } catch (error: unknown) {
    console.error('Error reprocessing document:', error);

    // Extract error message from response if available
    const errorMessage = axios.isAxiosError(error)
      ? (error.response?.data as Record<string, unknown>)?.detail as string || error.message
      : error instanceof Error ? error.message : 'Failed to reprocess document';
    throw new Error(errorMessage);
  }

  if (response.status !== 200) {
    throw new Error(`Failed to reprocess document: ${response.statusText}`);
  }

  return response.data;
}

// Process a single pending document
export async function processDocument(documentId: string): Promise<{
  message: string;
  document_id: string;
  job_id: string;
  status: string;
}> {
  let response;
  try {
    response = await api.post(`/documents/process/${documentId}`);
  } catch (error: unknown) {
    console.error('Error processing document:', error);

    // Extract error message from response if available
    const errorMessage = axios.isAxiosError(error)
      ? (error.response?.data as Record<string, unknown>)?.detail as string || error.message
      : error instanceof Error ? error.message : 'Failed to process document';
    throw new Error(errorMessage);
  }

  if (response.status !== 200) {
    throw new Error(`Failed to process document: ${response.statusText}`);
  }

  return response.data;
}

// Get documents for a collection
export async function getDocumentsByCollection(
  collectionId: string,
  page = 1,
  pageSize = 20,
  workspaceId?: string,
  searchQuery?: string
) {
  // Add retry mechanism
  const maxRetries = 3;
  let retryCount = 0;
  let lastError = null;

  while (retryCount < maxRetries) {
    try {
      const params: Record<string, string | number> = {
        page,
        page_size: pageSize,
      };

      if (workspaceId) {
        params.workspace_id = workspaceId;
      }

      if (searchQuery && searchQuery.trim()) {
        params.search = searchQuery.trim();
      }

      const response = await api.get(`/documents/collection/${collectionId}`, {
        params,
      });

      // Normalize the response to always return a documents' array, hasMore boolean, and total count
      const result = {
        documents: [],
        hasMore: false,
        total: 0,
      };

      if (response.data) {
        // Case 1: API returns {documents: [...], hasMore: boolean, total: number}
        if (response.data.documents && Array.isArray(response.data.documents)) {
          result.documents = response.data.documents;
          result.hasMore = !!response.data.hasMore;
          result.total = response.data.total || 0;
        }
        // Case 2: API returns {data: [...], hasMore: boolean, total: number}
        else if (response.data.data && Array.isArray(response.data.data)) {
          result.documents = response.data.data;
          result.hasMore = !!response.data.hasMore;
          result.total = response.data.total || 0;
        }
        // Case 3: API returns [] (direct array)
        else if (Array.isArray(response.data)) {
          result.documents = response.data;
          // If API returns direct array, we can't know if there are more
          result.hasMore = false;
          result.total = response.data.length;
        }
      }

      return result;
    } catch (error) {
      lastError = error;
      retryCount++;
      console.warn(
        `Error fetching documents by collection (attempt ${retryCount}/${maxRetries}):`,
        error
      );

      if (retryCount < maxRetries) {
        // Exponential backoff: 500ms, 1000ms, 2000ms, etc.
        const backoffMs = Math.min(500 * Math.pow(2, retryCount - 1), 5000);
        await new Promise(resolve => setTimeout(resolve, backoffMs));
      }
    }
  }

  console.error(
    'All retries failed when fetching documents by collection:',
    lastError
  );
  throw lastError;
}

/**
 * Tracker for document processing and upload progress
 */
export class DocumentProcessingTracker {
  private readonly jobId: string;
  private readonly documentId: string | null = null;
  private active: boolean = true;
  private socket: Socket | null = null;
  private stompClient: Client | null = null;
  private isPolling: boolean = false;
  private intervalId: NodeJS.Timeout | null = null;
  private progressHandlers: ((
    progress: number,
    message: string,
    status: string
  ) => void)[] = [];
  private objectProgressHandlers: ((data: {
    progress: number;
    message: string;
    status: string;
  }) => void)[] = [];
  private completeHandlers: (() => void)[] = [];
  private errorHandlers: ((error: Error) => void)[] = [];
  private jobStatus: string = 'pending';

  // Cache last known progress for restoration after hot-reload
  private lastProgress: { progress: number; message: string; status: string } | null = null;

  private static activeTrackers = new Map<string, DocumentProcessingTracker>();

  /**
   * Create a new DocumentProcessingTracker
   */
  constructor(options: {
    jobId: string;
    documentId?: string;
    onProgress?:
    | ((progress: number, message: string, status: string) => void)
    | ((data: { progress: number; message: string; status: string }) => void);
    onComplete?: () => void;
    onError?: (error: Error) => void;
  }) {
    this.jobId = options.jobId;
    this.documentId = options.documentId || null;

    if (options.onProgress) {
      // Check if the handler expects 3 arguments or 1 object argument
      if (options.onProgress.length === 3) {
        this.progressHandlers.push(
          options.onProgress as (
            progress: number,
            message: string,
            status: string
          ) => void
        );
      } else {
        this.objectProgressHandlers.push(
          options.onProgress as (data: {
            progress: number;
            message: string;
            status: string;
          }) => void
        );
      }
    }

    if (options.onComplete) {
      this.completeHandlers.push(options.onComplete);
    }

    if (options.onError) {
      this.errorHandlers.push(options.onError);
    }

    // Store the tracker in the active trackers map
    DocumentProcessingTracker.activeTrackers.set(this.jobId, this);

    // Set up tracking if we have a job ID
    if (this.jobId) {
      this.setupTracking();
    }
  }

  private setupTracking(): void {
    // Attempt to use Socket.IO first
    try {
      this.socket = getSharedWebSocketConnection();

      // Ensure socket is connected before subscribing
      if (!this.socket.connected) {
        this.socket.connect();
      }

      // Set up Socket.IO event handling
      // Filter to only process events for THIS job (shared socket receives all events)
      this.socket.on('job_update', (data: JobUpdateEvent) => {
        const eventJobId = data.job_id || data.jobId;
        if (eventJobId === this.jobId) {
          console.log(`📡 Socket.IO job_update received for job ${this.jobId}: progress=${data.progress}`);
          this.processProgressEvent(data);
        }
      });

      // Set a timeout for subscription - if no response within 5 seconds, fall back to polling
      let subscriptionTimeout: ReturnType<typeof setTimeout> | null = setTimeout(() => {
        logger.warn(`Socket.IO subscription timeout for job ${this.jobId}, falling back to polling`);
        subscriptionTimeout = null;
        this.startPollingFallback();
      }, 5000);

      // Subscribe to job updates
      // NOTE: Backend expects 'subscribe' event, not 'subscribe_to_job'
      this.socket.emit(
        'subscribe',
        { job_id: this.jobId },
        (response: Record<string, unknown>) => {
          // Clear timeout on any response
          if (subscriptionTimeout) {
            clearTimeout(subscriptionTimeout);
            subscriptionTimeout = null;
          }
          if (response && response.success) {
            logger.info(
              `Successfully subscribed to job ${this.jobId} via Socket.IO`
            );
          } else {
            logger.warn(
              `Failed to subscribe to job ${this.jobId} via Socket.IO, falling back to polling`
            );
            this.startPollingFallback();
          }
        }
      );
    } catch (error) {
      logger.error(`Error setting up Socket.IO tracking: ${error}`);

      // Try to set up STOMP tracking
      this.setupStompTracking();
    }
  }

  private setupStompTracking(): void {
    try {
      // Get auth token for STOMP connection. Read both storages because
      // sessionStorage is the home for sessions without "Remember me".
      let accessToken: string | null = null;
      try {
        const storedTokensJson =
          localStorage.getItem('auth_tokens') ||
          sessionStorage.getItem('auth_tokens');
        if (storedTokensJson) {
          const tokens = JSON.parse(storedTokensJson);
          if (tokens && typeof tokens.access_token === 'string') {
            accessToken = tokens.access_token;
          }
        }
      } catch (e) {
        logger.error(`Failed to parse auth tokens for STOMP connection: ${e}`);
      }

      // Create STOMP client using native WebSocket (backend doesn't support SockJS)
      // Helper function to get correct WebSocket URL (handles api.scrapalot.app routing)
      const getWebSocketUrl = (): string => {
        const hostname = window.location.hostname;
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';

        // Production domains - use backend API subdomain
        if (hostname === 'scrapalot.app' || hostname === 'www.scrapalot.app') {
          return `${protocol}//api.scrapalot.app/stomp/ws`;
        }

        // For other production domains or localhost, use current host
        return `${protocol}//${hostname}/stomp/ws`;
      };

      const wsUrl = getWebSocketUrl();
      const wsUrlWithToken = accessToken
        ? `${wsUrl}?token=${encodeURIComponent(accessToken)}`
        : wsUrl;

      this.stompClient = new Client({
        brokerURL: wsUrlWithToken,
        connectHeaders: accessToken
          ? {
            Authorization: `Bearer ${accessToken}`,
          }
          : {},
        debug: msg => {
          logger.debug(`STOMP: ${msg}`);
        },
        reconnectDelay: 5000,
        heartbeatIncoming: 4000,
        heartbeatOutgoing: 4000,
      });

      // Set up connection event handlers
      this.stompClient.onConnect = frame => {
        logger.info(
          `Connected to STOMP server: ${frame.headers['session-id']}`
        );

        // Subscribe to job updates
        this.stompClient?.subscribe(`/topic/job.${this.jobId}`, message => {
          try {
            const data = JSON.parse(message.body);
            this.processProgressEvent(data);
          } catch (error) {
            logger.error(`Error processing STOMP message: ${error}`);
          }
        });

        // Also emit a subscription event for compatibility
        this.stompClient?.publish({
          destination: '/app/subscribe',
          body: JSON.stringify({ job_id: this.jobId }),
        });
      };

      this.stompClient.onStompError = frame => {
        logger.error(`STOMP error: ${frame.headers['message']}`);
        this.startPollingFallback();
      };

      // Activate the client
      this.stompClient.activate();
    } catch (error) {
      logger.error(`Error setting up STOMP tracking: ${error}`);
      this.startPollingFallback();
    }
  }

  private startPollingFallback(): void {
    if (this.isPolling) return;

    this.isPolling = true;
    logger.info(`Starting polling fallback for job ${this.jobId}`);

    let pollCount = 0;
    let consecutiveErrors = 0;
    const maxConsecutiveErrors = 5; // Stop polling after 5 consecutive non-404 errors
    const maxFastPolls = 15; // Fast poll for first 15 polls (30 seconds)

    const pollFunction = async () => {
      try {
        const response = await fetch(
          `${API_BASE_URL}/documents/processing_status/${this.jobId}`,
          {
            method: 'GET',
            headers: {
              'Content-Type': 'application/json',
              ...getAuthHeaders(),
            },
          }
        );

        if (response.ok) {
          const data: ProcessingJobStatus = await response.json();
          this.handleProgressUpdate(data);

          pollCount++;
          consecutiveErrors = 0; // Reset on success

          // Adjust polling frequency based on progress and poll counts
          if (this.intervalId) {
            clearInterval(this.intervalId);
          }

          let nextInterval;
          if (pollCount < maxFastPolls && data.progress < 30) {
            // Fast polling during upload phase (every 500ms for first 30 seconds or until 30% progress)
            nextInterval = 500;
          } else if (data.progress < 50) {
            // Medium polling during early processing (every 1 second)
            nextInterval = 1000;
          } else {
            // Standard polling for later stages (every 2 seconds)
            nextInterval = 2000;
          }

          this.intervalId = setTimeout(pollFunction, nextInterval);
        } else if (response.status === 404) {
          // Job not found, clean up
          this.cleanup();
        } else if (response.status === 401) {
          // Unauthorized - token expired or invalid, stop polling and notify error
          logger.error(`Authentication failed for job polling: ${this.jobId}`);
          for (const handler of this.errorHandlers) {
            handler(new Error('Authentication failed - please log in again'));
          }
          this.cleanup();
        } else if (response.status === 403) {
          // Forbidden - user doesn't have access to this job, stop polling
          logger.error(`Access denied to job ${this.jobId}`);
          for (const handler of this.errorHandlers) {
            handler(new Error('Access denied to this job'));
          }
          this.cleanup();
        } else {
          consecutiveErrors++;
          logger.error(`Error polling job status: ${response.statusText} (${consecutiveErrors}/${maxConsecutiveErrors})`);
          if (consecutiveErrors >= maxConsecutiveErrors) {
            logger.error(`Too many consecutive errors for job ${this.jobId}, stopping poll`);
            this.cleanup();
          } else {
            this.intervalId = setTimeout(pollFunction, 3000);
          }
        }
      } catch (error) {
        consecutiveErrors++;
        logger.error(`Error in polling: ${error} (${consecutiveErrors}/${maxConsecutiveErrors})`);
        if (consecutiveErrors >= maxConsecutiveErrors) {
          logger.error(`Too many consecutive errors for job ${this.jobId}, stopping poll`);
          this.cleanup();
        } else {
          this.intervalId = setTimeout(pollFunction, 3000);
        }
      }
    };

    // Start with fast polling (500ms)
    this.intervalId = setTimeout(pollFunction, 500);
  }

  private handleProgressUpdate(data: Record<string, unknown>) {
    // Normalize data format from different sources
    const normalizedData = this.normalizeProgressData(data);

    // Cache the last known progress for restoration after hot-reload
    this.lastProgress = {
      progress: normalizedData.progress,
      message: normalizedData.message,
      status: normalizedData.status,
    };

    // Debug logging - this is where progress should flow to handlers
    console.log(`📊 DocumentProcessingTracker.handleProgressUpdate: job=${this.jobId}, progress=${normalizedData.progress}%, status=${normalizedData.status}, handlers=${this.objectProgressHandlers.length + this.progressHandlers.length}`);

    // Call the object-based handlers
    for (const handler of this.objectProgressHandlers) {
      try {
        handler(normalizedData);
      } catch (error) {
        logger.error(`Error in object progress handler: ${error}`);
      }
    }

    // Call the individual parameter handlers
    for (const handler of this.progressHandlers) {
      try {
        handler(
          normalizedData.progress,
          normalizedData.message,
          normalizedData.status
        );
      } catch (error) {
        logger.error(`Error in progress handler: ${error}`);
      }
    }

    // Update internal job status
    if (normalizedData.status) {
      this.jobStatus = normalizedData.status;
    }

    // Check for completion or failure with more robust status checking
    // IMPORTANT: Only check status, NOT progress. The backend sends progress updates
    // during embeddings storage (85-95%) and Neo4j graph creation (93-95%).
    // We must wait for the explicit 'completed' status, not just progress >= 100.
    const isCompleted =
      normalizedData.status === 'completed' ||
      normalizedData.status === 'COMPLETED';

    const isFailed =
      normalizedData.status === 'failed' ||
      normalizedData.status === 'FAILED' ||
      normalizedData.status === 'cancelled' ||
      normalizedData.status === 'CANCELLED';

    if (isCompleted) {
      // Ensure final progress is 100% for completed jobs
      const completedData = {
        ...normalizedData,
        progress: 100,
        status: 'completed',
      };

      // Send final update to handlers with 100% progress
      for (const handler of this.objectProgressHandlers) {
        try {
          handler(completedData);
        } catch (error) {
          logger.error(
            `Error in object progress handler (completion): ${error}`
          );
        }
      }

      for (const handler of this.progressHandlers) {
        try {
          handler(100, completedData.message, 'completed');
        } catch (error) {
          logger.error(`Error in progress handler (completion): ${error}`);
        }
      }

      this.completeHandlers.forEach(handler => {
        try {
          handler();
        } catch (error) {
          logger.error(`Error in complete handler: ${error}`);
        }
      });
      this.cleanup();
    } else if (isFailed) {
      const errorMsg = `Document processing ${normalizedData.status}: ${normalizedData.message}`;
      this.errorHandlers.forEach(handler => {
        try {
          handler(new Error(errorMsg));
        } catch (error) {
          logger.error(`Error in error handler: ${error}`);
        }
      });
      this.cleanup();
    }
  }

  // Use function overloads for different handler types
  onProgress(
    handler: (progress: number, message: string, status: string) => void
  ): this;
  onProgress(
    handler: (data: {
      progress: number;
      message: string;
      status: string;
    }) => void
  ): this;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- implementation signature for overloaded method
  onProgress(handler: any) {
    // Use type checking based on function length
    if (handler.length === 3) {
      // It's the handler with individual parameters (3 args)
      this.progressHandlers.push(handler);
    } else {
      // It's the handler with object parameter (1 arg)
      this.objectProgressHandlers.push(handler);
    }
    return this;
  }

  onComplete(handler: () => void): this {
    if (handler) {
      this.completeHandlers.push(handler);
    }
    return this;
  }

  onError(handler: (error: Error) => void): this {
    if (handler) {
      this.errorHandlers.push(handler);
    }
    return this;
  }

  /**
   * Clear all handlers (progress, complete, error). Used when reconnecting
   * to an existing tracker from a new component instance.
   */
  clearAllHandlers(): void {
    this.progressHandlers = [];
    this.objectProgressHandlers = [];
    this.completeHandlers = [];
    this.errorHandlers = [];
  }

  /**
   * Get the last known progress data. Used to restore state after hot-reload.
   */
  getLastProgress(): { progress: number; message: string; status: string } | null {
    return this.lastProgress;
  }

  /**
   * Get the job ID for this tracker.
   * Use this instead of relying on ref keys which may be filenames.
   */
  getJobId(): string {
    return this.jobId;
  }

  static getActiveJobs(): Map<string, DocumentProcessingTracker> {
    return this.activeTrackers;
  }

  static removeJob(jobId: string): void {
    // Remove from active trackers
    if (this.activeTrackers.has(jobId)) {
      const tracker = this.activeTrackers.get(jobId);
      tracker?.cleanup();
      this.activeTrackers.delete(jobId);
    }
  }

  /**
   * Fetch current status from backend immediately.
   * Used to get initial progress after page reload when cached progress is lost.
   */
  async fetchCurrentStatus(): Promise<{ progress: number; message: string; status: string } | null> {
    try {
      const response = await fetch(
        `${API_BASE_URL}/documents/processing_status/${this.jobId}`,
        {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
            ...getAuthHeaders(),
          },
        }
      );

      if (response.ok) {
        const data: ProcessingJobStatus = await response.json();
        const result = {
          progress: data.progress ?? 0,
          message: data.message ?? 'Processing...',
          status: data.status ?? 'processing',
        };

        // Cache the fetched progress
        this.lastProgress = result;

        console.log(`📡 Fetched current status for job ${this.jobId}: ${result.progress}% (${result.status})`);
        return result;
      }
    } catch (error) {
      logger.error(`Error fetching current status: ${error}`);
    }

    return null;
  }

  cleanup(): void {
    // Only clean up once
    if (!this.active) return;

    this.active = false;

    // Check if there are any active jobs before disconnecting everything
    const hasActiveJobs = Array.from(
      DocumentProcessingTracker.getActiveJobs().values()
    ).some(tracker => tracker !== this && tracker.active);

    // Clean up Socket.IO subscription if no other active jobs
    if (this.socket && !hasActiveJobs) {
      try {
        // No need to unsubscribe explicitly, the server handles this
        logger.debug(`Socket.IO connection maintained for other active jobs`);
      } catch (error) {
        logger.error(`Error cleaning up Socket.IO: ${error}`);
      }
    }

    // Clean up STOMP subscription
    if (this.stompClient) {
      try {
        // Only disconnect if no other active jobs
        if (!hasActiveJobs) {
          void this.stompClient.deactivate();
          logger.debug(`STOMP connection maintained for other active jobs`);
        }
      } catch (error) {
        logger.error(`Error cleaning up STOMP: ${error}`);
      }
      this.stompClient = null;
    }

    // Clean up a polling interval/timeout
    if (this.intervalId) {
      clearTimeout(this.intervalId); // Changed from clearInterval to clearTimeout
      this.intervalId = null;
      this.isPolling = false;
    }

    // Remove from active trackers
    DocumentProcessingTracker.activeTrackers.delete(this.jobId);
  }

  async abort(): Promise<void> {
    if (!this.active || !this.jobId) return;

    try {
      const success = await this.cancelProcessing();
      if (success) {
        logger.info(`Successfully aborted job ${this.jobId}`);
      } else {
        logger.error(`Failed to abort job ${this.jobId}`);
      }
    } catch (error) {
      logger.error(`Error aborting job: ${error}`);
    } finally {
      this.cleanup();
    }
  }

  processProgressEvent(data: JobUpdateEvent): void {
    this.handleProgressUpdate(data);
  }

  // Add a new method for the object style handler with clear naming
  onProgressObject(
    handler: (data: {
      progress: number;
      message: string;
      status: string;
    }) => void
  ) {
    this.objectProgressHandlers.push(handler);
    return this;
  }

  static async getMyActiveJobs(
    includeDetails = false
  ): Promise<Record<string, unknown>> {
    try {
      const response = await api.get<{
        count: number;
        jobs: Record<string, unknown>;
      }>(`/jobs/active`, {
        params: { include_details: includeDetails },
        headers: { 'x-skip-cache': 'true' },  // liveness poll — never cache
      });
      return response.data.jobs || {};
    } catch (error) {
      logger.error(`Error fetching active jobs: ${error}`);

      // Check if it's a server error vs network error
      if (error.response?.status >= 500) {
        // Server error - log and return empty to prevent UI crashes
        logger.warn('Server error fetching jobs, returning empty state');
        return {};
      } else if (error.response?.status === 401) {
        // Authentication error - should be handled by auth interceptor
        throw error;
      } else {
        // Other errors - log but return empty to maintain UI stability
        logger.warn(
          'Network or client error fetching jobs, returning empty state'
        );
        return {};
      }
    }
  }

  // Add the normalizeProgressData method
  private normalizeProgressData(data: Record<string, unknown>): {
    progress: number;
    message: string;
    status: string;
  } {
    return {
      progress: typeof data.progress === 'number' ? data.progress : 0,
      message: typeof data.message === 'string' ? data.message : '',
      status: typeof data.status === 'string' ? data.status : 'processing',
    };
  }

  async cancelProcessing(): Promise<boolean> {
    try {
      const response = await fetch(
        `${API_BASE_URL}/documents/cancel_processing/${this.jobId}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...getAuthHeaders(),
          },
        }
      );

      return response.ok;
    } catch (error) {
      logger.error(`Error cancelling processing: ${error}`);
      return false;
    }
  }
}

export async function cancelDocumentProcessing(
  jobId: string
): Promise<boolean> {
  try {
    const response = await fetch(
      `${API_BASE_URL}/documents/cancel_processing/${jobId}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...getAuthHeaders(),
        },
      }
    );

    return response.ok;
  } catch (error) {
    logger.error(`Error cancelling document processing: ${error}`);
    return false;
  }
}

export async function getMyActiveJobs(includeDetails = false) {
  try {
    // Liveness poll — never serve a stale cached snapshot. The 60s response
    // cache otherwise pinned the first (empty) result, so a background research
    // job that started after mount stayed invisible in the header indicator for
    // up to a minute.
    const response = await api.get(`/jobs/active`, {
      params: { include_details: includeDetails },
      headers: { 'x-skip-cache': 'true' },
    });

    // Backend already returns the correct format: { active_jobs: {}, active_jobs_count: 0 }
    const data = response.data || { active_jobs: {}, active_jobs_count: 0 };
    return {
      active_jobs_count: data.active_jobs_count || 0,
      active_jobs: data.active_jobs || {},
      timeout: data.timeout || false,
      message: data.message || null,
    };
  } catch (error) {
    console.error(`Error fetching active jobs:`, error);
    return { active_jobs: {}, active_jobs_count: 0 };
  }
}

// =============================================================================
// THUMBNAIL API FUNCTIONS
// =============================================================================

/**
 * Upload a custom thumbnail for a document.
 * @param documentId - The document UUID
 * @param file - The image file to upload (PNG, JPEG, or WebP)
 * @returns Promise with upload result
 */
export async function uploadCustomThumbnail(
  documentId: string,
  file: File
): Promise<{ success: boolean; message?: string; thumbnail?: Record<string, unknown> }> {
  try {
    const formData = new FormData();
    formData.append('file', file);

    const response = await api.post(
      `/documents/${documentId}/thumbnail`,
      formData,
      {
        headers: {
          'Content-Type': 'multipart/form-data',
        },
      }
    );

    return response.data;
  } catch (error: unknown) {
    console.error('Error uploading custom thumbnail:', error);
    throw new Error(
      axios.isAxiosError(error)
        ? (error.response?.data as Record<string, unknown>)?.detail as string || 'Failed to upload custom thumbnail'
        : error instanceof Error ? error.message : 'Failed to upload custom thumbnail'
    );
  }
}

/**
 * Delete a custom thumbnail for a document.
 * @param documentId - The document UUID
 * @returns Promise with deletion result
 */
export async function deleteCustomThumbnail(
  documentId: string
): Promise<{ success: boolean; deleted: boolean; regenerated: boolean }> {
  try {
    const response = await api.delete(`/documents/${documentId}/thumbnail`);
    return response.data;
  } catch (error: unknown) {
    console.error('Error deleting custom thumbnail:', error);
    throw new Error(
      axios.isAxiosError(error) && error.response?.data?.detail
        ? error.response.data.detail
        : 'Failed to delete custom thumbnail'
    );
  }
}

/**
 * Download book cover from the internet using ISBN from document metadata.
 * @param documentId - The document UUID
 * @returns Promise with download result
 */
export async function downloadBookCover(
  documentId: string
): Promise<{ success: boolean; message: string; isbn: string; source: string }> {
  const response = await api.post(`/documents/${documentId}/cover/download`);
  return response.data;
}

/**
 * Download a document file to the user's computer (browser download).
 * Uses the /documents/{id}/file endpoint which serves the actual file content.
 */
export async function downloadDocumentToComputer(
  documentId: string,
  filename: string
): Promise<void> {
  const response = await api.get(`/documents/${documentId}/file?download=true`, {
    responseType: 'blob',
  });
  const url = window.URL.createObjectURL(new Blob([response.data]));
  const link = document.createElement('a');
  link.href = url;
  link.setAttribute('download', filename);
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.URL.revokeObjectURL(url);
}

// =============================================================================
// READING POSITION API
// =============================================================================

export interface ReadingPosition {
  id: string;
  document_id: string;
  page_number: number;
  scroll_position?: number;
  epub_cfi?: string;
  last_tts_char_index?: number;
  total_pages?: number;
  updated_at?: string;
}

/**
 * Get the user's reading position for a document.
 * @param documentId - The document UUID
 * @returns Promise with reading position data or null
 */
export async function getReadingPosition(
  documentId: string
): Promise<ReadingPosition | null> {
  try {
    const response = await api.get(`/documents/${documentId}/reading-position`);
    const data = response.data?.data || response.data;
    if (!data) return null;
    // Backend returns {document_id, page, position} — map to ReadingPosition
    return {
      ...data,
      page_number: data.page_number ?? data.page ?? data.pageNumber ?? 1,
    };
  } catch (error: unknown) {
    // 404 or no data is not an error, just means no saved position
    if (axios.isAxiosError(error) && error.response?.status === 404) {
      return null;
    }
    console.error('Error fetching reading position:', error);
    return null;
  }
}

/**
 * Save or update the user's reading position for a document.
 * @param documentId - The document UUID
 * @param position - Reading position data
 * @returns Promise with updated reading position
 */
export async function saveReadingPosition(
  documentId: string,
  position: {
    page_number: number;
    scroll_position?: number;
    epub_cfi?: string;
    last_tts_char_index?: number;
    total_pages?: number;
  }
): Promise<ReadingPosition | null> {
  try {
    // Backend expects JSON body with "page" (int) and optional "position" (JSON string)
    const positionJson: Record<string, string | number | undefined> = {};
    if (position.scroll_position !== undefined) positionJson.scroll_position = position.scroll_position;
    if (position.epub_cfi !== undefined) positionJson.epub_cfi = position.epub_cfi;
    if (position.last_tts_char_index !== undefined) positionJson.last_tts_char_index = position.last_tts_char_index;
    if (position.total_pages !== undefined) positionJson.total_pages = position.total_pages;

    const body = {
      page: position.page_number,
      pageNumber: position.page_number,
      position: Object.keys(positionJson).length > 0 ? JSON.stringify(positionJson) : '',
    };

    const response = await api.put(
      `/documents/${documentId}/reading-position`,
      body
    );
    return response.data?.data || null;
  } catch (error: unknown) {
    console.error('Error saving reading position:', error);
    return null;
  }
}

/**
 * Fetch the book-level summary for a document.
 * Returns { found, summary_text } or { found: false } on error.
 */
export async function getBookSummary(
  documentId: string
): Promise<{ found: boolean; summary_text: string | null }> {
  try {
    const response = await api.get(`/documents/${documentId}/summary`);
    return response.data;
  } catch {
    return { found: false, summary_text: null };
  }
}

/**
 * Stream a translated book summary via NDJSON.
 * Returns cached translation instantly or streams LLM translation.
 */
export async function translateBookSummary(
  documentId: string,
  targetLanguage: string,
  onDelta: (fullText: string) => void,
  onComplete: (fullText: string) => void,
  onError: (error: string) => void,
  signal?: AbortSignal
): Promise<void> {
  const headers = getAuthHeaders();
  const url = `${API_BASE_URL}/documents/${documentId}/summary/translate?lang=${encodeURIComponent(targetLanguage)}`;

  const response = await fetch(url, { headers, signal });
  if (!response.ok) {
    onError(`HTTP ${response.status}`);
    return;
  }

  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let fullText = '';
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const packet = JSON.parse(line);
        if (packet.type === 'delta') {
          fullText += packet.content;
          onDelta(fullText);
        } else if (packet.type === 'cached') {
          fullText = packet.content;
          onComplete(fullText);
          return;
        } else if (packet.type === 'complete') {
          onComplete(fullText);
          return;
        } else if (packet.type === 'error') {
          onError(packet.content);
          return;
        }
      } catch {
        // skip malformed lines
      }
    }
  }

  if (fullText) {
    onComplete(fullText);
  }
}

/**
 * Generate book summary (chapter-by-chapter then full book).
 * Streams progress via NDJSON.
 */
export async function generateBookSummary(
  documentId: string,
  onProgress: (message: string, progress: number) => void,
  onComplete: (summaryText: string) => void,
  onError: (error: string) => void,
  signal?: AbortSignal
): Promise<void> {
  const headers = getAuthHeaders();
  const url = `${API_BASE_URL}/documents/${documentId}/summary/generate`;

  const response = await fetch(url, { method: 'POST', headers, signal });
  if (!response.ok) {
    onError(`HTTP ${response.status}`);
    return;
  }

  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const packet = JSON.parse(line);
        if (packet.type === 'progress' || packet.type === 'chapter_done') {
          onProgress(packet.message, packet.progress);
        } else if (packet.type === 'complete') {
          onComplete(packet.summary_text);
          return;
        } else if (packet.type === 'error') {
          onError(packet.message);
          return;
        }
      } catch {
        // skip malformed lines
      }
    }
  }
}

/**
 * Fetch collection statistics (documents, embeddings, graph, summaries).
 */
export interface CollectionStats {
  total_documents: number;
  docs_stored_on_disk: number;
  docs_memory_only: number;
  docs_with_embeddings: number;
  total_embedding_chunks: number;
  graph_completed: number;
  graph_entity_running: number;
  graph_hierarchy_done: number;
  graph_failed: number;
  graph_pending: number;
  docs_with_summaries: number;
  total_summary_records: number;
  docs_with_thumbnails: number;
}

export async function getCollectionStats(collectionId: string): Promise<CollectionStats | null> {
  try {
    const response = await api.get(`/documents/collection/${collectionId}/stats`);
    return response.data;
  } catch (err) {
    console.error('Failed to fetch collection stats:', err);
    return null;
  }
}

export async function buildDocumentGraph(documentId: string, collectionId: string): Promise<boolean> {
  try {
    const response = await api.post(`/documents/${documentId}/build-graph`, null, {
      params: { collection_id: collectionId },
    });
    return response.data?.success ?? false;
  } catch (err) {
    console.error('Failed to build document graph:', err);
    return false;
  }
}

export async function rebuildDocumentEmbeddings(documentId: string, collectionId: string): Promise<boolean> {
  try {
    const response = await api.post(`/documents/${documentId}/rebuild-embeddings`, null, {
      params: { collection_id: collectionId },
    });
    return response.data?.success ?? false;
  } catch (err) {
    console.error('Failed to rebuild document embeddings:', err);
    return false;
  }
}

/** Add a document to an additional collection (no duplication). */
export async function addDocumentToCollection(documentId: string, collectionId: string): Promise<boolean> {
  try {
    await api.post(`/documents/${documentId}/collections`, { collection_id: collectionId });
    return true;
  } catch (err) {
    console.error('Failed to add document to collection:', err);
    return false;
  }
}

/** Find open-access PDF via Unpaywall */
export async function findOpenAccessPdf(documentId: string): Promise<{
  success: boolean;
  is_oa: boolean;
  pdf_url: string;
  oa_status: string;
  message: string;
}> {
  const { data } = await api.post(`/documents/${documentId}/find-pdf`);
  return data;
}

/** Extract annotations from uploaded PDF */
export async function extractPdfAnnotations(documentId: string): Promise<{
  success: boolean;
  annotations: Array<{
    page_index: number;
    annotation_type: number;
    selected_text: string;
    comment: string;
    color_index: number;
    position_json: string;
  }>;
  page_count: number;
  message: string;
}> {
  const { data } = await api.post(`/documents/${documentId}/extract-annotations`);
  return data;
}

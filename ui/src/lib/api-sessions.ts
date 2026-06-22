import { apiClient, authState, clearCache } from './api';
import { v4 as uuidv4 } from 'uuid';
import type { Message } from '@/types';
import {
  generateCacheKey,
  checkCacheValidity,
  setCacheData,
  invalidateCache,
  API_CONFIG
} from './api-utils';

/**
 * Session type as returned by the backend API and used in the UI
 * We're standardizing on using Session throughout the application
 */
export interface Session {
  id: string;
  user_id: string;
  collection_id?: string | null;
  session_folder_id?: string | null;
  conversation_name?: string | null;
  marker_icon?: string | null;
  marker_color?: string | null;
  is_pinned?: boolean;
  created_at: string;
  updated_at: string;
  model_name?: string | null; // Maps to last_model_used in backend
  title?: string;
  messages?: Message[];
  createdAt?: Date;
  updatedAt?: Date;
  modelId?: string;
  lastMessageFetchTime?: number;
}

/**
 * Paginated sessions response with metadata
 */
export interface PaginatedSessionsResponse {
  sessions: Session[];
  total: number;
  totalPages: number;
}

/**
 * Metadata for a document kept attached to a chat session. Server-backed and
 * sticky across messages — the chip bar renders these (no `content`, which can
 * be hundreds of KB and lives only server-side).
 */
export interface SessionAttachmentMeta {
  id: string;
  type: 'document' | 'image' | 'youtube';
  filename: string;
  mime_type?: string | null;
  char_count?: number | null;
  created_at: string;
}

/**
 * List all sessions for the current user
 * @param page - Page number (1-based)
 * @param pageSize - Number of sessions per page
 * @param forceRefresh - Whether to force refresh from server
 * @param folderId - Optional folder ID to filter sessions by folder
 * @returns Paginated response with sessions and metadata
 */
export const listSessions = async (
  page = 1,
  pageSize = 20,
  forceRefresh = false,
  folderId?: string | null
): Promise<PaginatedSessionsResponse> => {
  const cacheKey = generateCacheKey('sessions', { page, pageSize, folderId: folderId || '' });

  // Check cache first unless force refresh is requested
  if (!forceRefresh) {
    const cachedData = checkCacheValidity<PaginatedSessionsResponse>(cacheKey, false, false, API_CONFIG.CACHE_TTL);
    if (cachedData) {
      return cachedData;
    }
  }

  try {
    // Wait for auth to be ready to prevent unauthorized/hanging requests
    if (!authState.authReady) {
      await authState.waitForAuthReady(5000); // Wait up to 5 seconds
    }

    // Backend uses 0-based pagination (Spring PageRequest), frontend uses 1-based
    const backendPage = Math.max(0, page - 1);

    const params: Record<string, string | number> = { page: backendPage, page_size: pageSize };
    if (folderId) params.folderId = folderId;

    const response = await apiClient.get('/sessions', {
      params,
      headers: forceRefresh ? { 'x-skip-cache': 'true' } : {},
    });

    // Backend returns {sessions: [], total, page, page_size, total_pages}
    const result: PaginatedSessionsResponse = {
      sessions: response.data.sessions || [],
      total: response.data.total || 0,
      totalPages: response.data.total_pages || 1,
    };

    // Cache the result using shared utilities
    setCacheData(cacheKey, result, API_CONFIG.CACHE_TTL);

    return result;
  } catch (error) {
    console.error('Error listing sessions:', error);
    throw error;
  }
};

/**
 * Gets a session by ID
 * @param sessionId Session ID to retrieve
 * @returns The session data or an error
 */
export const getSession = async (sessionId: string): Promise<Session> => {
  try {
    // Wait for auth to be ready to prevent unauthorized requests
    if (!authState.authReady) {
      await authState.waitForAuthReady(5000); // Wait up to 5 seconds
    }

    if (!isValidUUID(sessionId)) {
      sessionId = stringToUUID(sessionId);
    }

    // Ensure we have auth headers
    const headers = {};
    const stored =
      localStorage.getItem('auth_tokens') ||
      sessionStorage.getItem('auth_tokens');
    if (stored) {
      try {
        const tokens = JSON.parse(stored);
        if (tokens?.access_token) {
          headers['Authorization'] = `Bearer ${tokens.access_token}`;
        }
      } catch (e) {
        console.error('Error parsing stored tokens:', e);
      }
    }

    const response = await apiClient.get(`/sessions/${sessionId}`, { headers });
    return response.data;
  } catch (error) {
    console.error(`Error getting session ${sessionId}:`, error);
    throw error;
  }
};

/**
 * Renames a session by updating its conversation_name
 * @param sessionId ID of the session to rename
 * @param newName New name for the session
 * @returns The updated session
 */
export const renameSession = async (
  sessionId: string,
  newName: string
): Promise<Session> => {
  try {
    // Convert the session ID to a valid UUID if it's not already one
    const validSessionId = isValidUUID(sessionId)
      ? sessionId
      : stringToUUID(sessionId);
    const response = await apiClient.put(`/sessions/${validSessionId}`, {
      conversation_name: newName,
    });

    // Invalidate cache when a session is updated
    invalidateCache(/^sessions_/);
    return response.data;
  } catch (error) {
    console.error(`Error renaming session ${sessionId}:`, error);
    throw error;
  }
};

/**
 * Set or clear a session's marker (priority icon + color). Pass nulls to clear.
 * Dedicated endpoint so it never collides with rename.
 */
export const setSessionMarker = async (
  sessionId: string,
  markerIcon: string | null,
  markerColor: string | null
): Promise<Session> => {
  try {
    const validSessionId = isValidUUID(sessionId) ? sessionId : stringToUUID(sessionId);
    const response = await apiClient.put(`/sessions/${validSessionId}/marker`, {
      marker_icon: markerIcon,
      marker_color: markerColor,
    });
    invalidateCache(/^sessions_/);
    return response.data;
  } catch (error) {
    console.error(`Error setting marker for session ${sessionId}:`, error);
    throw error;
  }
};

/**
 * Pin or unpin a session. Pinned sessions float to the top of their sidebar
 * group (folder or unfiled). Dedicated endpoint so it never collides with
 * rename or marker.
 */
export const setSessionPin = async (
  sessionId: string,
  isPinned: boolean
): Promise<Session> => {
  try {
    const validSessionId = isValidUUID(sessionId) ? sessionId : stringToUUID(sessionId);
    const response = await apiClient.put(`/sessions/${validSessionId}/pin`, {
      is_pinned: isPinned,
    });
    invalidateCache(/^sessions_/);
    return response.data;
  } catch (error) {
    console.error(`Error setting pin for session ${sessionId}:`, error);
    throw error;
  }
};

/**
 * Curated priority markers — fixed set with a natural sort rank (lower = higher
 * priority) so the list can be sorted by importance. The user picks one icon and
 * optionally a palette color (see ColorPalette). rank 99 sorts unmarked last.
 */
export interface SessionMarkerOption {
  icon: string;
  labelKey: string;
  rank: number;
}

export const SESSION_MARKERS: SessionMarkerOption[] = [
  { icon: '❗', labelKey: 'sessionsList.markers.urgent', rank: 1 },
  { icon: '⭐', labelKey: 'sessionsList.markers.important', rank: 2 },
  { icon: '📌', labelKey: 'sessionsList.markers.pinned', rank: 3 },
  { icon: '🔴', labelKey: 'sessionsList.markers.priorityHigh', rank: 4 },
  { icon: '🟡', labelKey: 'sessionsList.markers.priorityMedium', rank: 5 },
  { icon: '🟢', labelKey: 'sessionsList.markers.priorityLow', rank: 6 },
  { icon: '🚩', labelKey: 'sessionsList.markers.flagged', rank: 7 },
  { icon: '✅', labelKey: 'sessionsList.markers.done', rank: 8 },
];

/** Sort rank for a session by its marker icon (unmarked sorts last). */
export const sessionMarkerRank = (icon?: string | null): number =>
  SESSION_MARKERS.find(m => m.icon === icon)?.rank ?? 99;

/**
 * Deletes a session by ID
 * @param sessionId ID of the session to delete
 * @returns Success message
 */
export const deleteSession = async (
  sessionId: string
): Promise<{ message: string }> => {
  try {
    // Convert the session ID to a valid UUID if it's not already one
    const validSessionId = isValidUUID(sessionId)
      ? sessionId
      : stringToUUID(sessionId);
    const response = await apiClient.delete(`/sessions/${validSessionId}`);
    // Invalidate cache when a session is deleted
    invalidateCache(/^sessions_/);
    return response.data;
  } catch (error) {
    console.error(`Error deleting session ${sessionId}:`, error);
    throw error;
  }
};

/**
 * List the documents kept attached to a chat session (metadata only).
 * Returns [] for an empty/new session so callers can render unconditionally.
 */
export const getSessionAttachments = async (
  sessionId: string
): Promise<SessionAttachmentMeta[]> => {
  if (!sessionId) return [];
  try {
    if (!authState.authReady) {
      await authState.waitForAuthReady(5000);
    }
    const validSessionId = isValidUUID(sessionId)
      ? sessionId
      : stringToUUID(sessionId);
    const response = await apiClient.get(`/sessions/${validSessionId}/attachments`);
    return Array.isArray(response.data) ? response.data : [];
  } catch (error) {
    console.error(`Error fetching attachments for session ${sessionId}:`, error);
    return [];
  }
};

/**
 * Detach a document from a chat session.
 */
export const deleteSessionAttachment = async (
  sessionId: string,
  attachmentId: string
): Promise<void> => {
  const validSessionId = isValidUUID(sessionId)
    ? sessionId
    : stringToUUID(sessionId);
  await apiClient.delete(`/sessions/${validSessionId}/attachments/${attachmentId}`);
};

/**
 * Checks if a string is a valid UUID
 * @param str String to check
 * @returns True if the string is a valid UUID
 */
export const isValidUUID = (str: string): boolean => {
  // UUID regex pattern
  const uuidPattern =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidPattern.test(str);
};

/**
 * Converts a string to a deterministic UUID
 * This ensures that the same input always produces the same UUID
 * @param str Input string to convert
 * @returns A valid UUID derived from the input string
 */
export const stringToUUID = (str: string): string => {
  // If it's already a valid UUID, return it as is
  if (isValidUUID(str)) {
    return str;
  }

  // For non-UUID strings, create a deterministic UUID based on the string
  // This ensures the same string always maps to the same UUID

  // Simple implementation to derive a UUID from a string
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0; // Convert to 32bit integer
  }

  // Use the hash to modify parts of a new UUID
  const uuid = uuidv4().split('-');
  uuid[0] = (parseInt(uuid[0], 16) ^ hash).toString(16).padStart(8, '0');

  return uuid.join('-');
};

/**
 * Clears the sessions cache - useful when you want to force a fresh load.
 * Clears both the api-utils memory cache and the axios interceptor response cache.
 */
export const clearSessionsCache = () => {
  invalidateCache(/^sessions_/);
  clearCache('/sessions');
};


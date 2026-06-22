import { apiClient } from './api';
import { isValidUUID, stringToUUID } from './api-sessions';

/**
 * Message interface for API responses
 */
export interface Message {
  id: string;
  session_id: string;
  role: string;
  content: string;
  created_at: string;
  updated_at: string;
  message_metadata?: Record<string, unknown>;
  feedback?: number | null;
}

/**
 * Token metrics interface
 */
export interface TokenMetrics {
  total_tokens?: number;
  prompt_tokens?: number;
  completion_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
  tokens_per_second?: number;
  cost_usd?: number;
  model?: string;
  provider?: string;
  latency_ms?: number;
}

/**
 * Gets all messages for a specific session/conversation
 * @param sessionId Session/conversation ID to retrieve messages for
 * @param page Optional page number for pagination (defaults to 1)
 * @param pageSize Optional page size (defaults to 20)
 * @returns Array of messages for the session
 */
export const getSessionMessages = async (
  sessionId: string,
  page = 1,
  pageSize = 20
) => {
  try {
    // Convert the session ID to a valid UUID if it's not already one
    let validSessionId = sessionId;

    // Check if it's a valid UUID
    if (!isValidUUID(sessionId)) {
      // Convert to a deterministic UUID
      validSessionId = stringToUUID(sessionId);
    }

    // Backend uses 0-based pagination (Spring PageRequest), frontend uses 1-based
    const backendPage = Math.max(0, page - 1);

    // Make the API request with the valid UUID as query parameter
    const response = await apiClient.get(
      `/messages?sessionId=${validSessionId}&page=${backendPage}&pageSize=${pageSize}`
    );

    if (response.status === 200) {
      // Handle the new pagination format
      if (response.data && response.data.items) {
        return response.data.items;
      } else if (
        response.data &&
        response.data.messages &&
        Array.isArray(response.data.messages)
      ) {
        // Handle new API format with messages array
        return response.data.messages;
      } else if (Array.isArray(response.data)) {
        // Handle backward compatibility with old API format
        return response.data;
      } else {
        console.error('Unexpected response format:', response.data);
        return [];
      }
    } else {
      console.error(
        `Error getting messages for session ${sessionId}: ${response.statusText}`
      );
      return [];
    }
  } catch (error) {
    console.error(`Error getting messages for session ${sessionId}:`, error);

    // Add detailed error logging
    if (error.response) {
      console.error('Error status:', error.response.status);
      console.error('Error data:', error.response.data);
      console.error('Error headers:', error.response.headers);

      // If it's a validation error for UUID, return empty array instead of throwing
      if (error.response.status === 422) {
        console.warn(
          `Invalid UUID format for session ${sessionId}, returning empty array`
        );
        return [];
      }

      // If it's a 500 error, log more details but return empty array to avoid UI disruption
      if (error.response.status === 500) {
        console.error(
          'Server error details:',
          error.response.data?.detail || 'Unknown server error'
        );
        console.warn(
          `Server error for session ${sessionId}, returning empty array to avoid UI disruption`
        );
        return [];
      }
    }

    // For network errors or other issues, return empty array instead of throwing
    // This prevents the UI from breaking when the backend has issues
    console.warn(
      `Handling error gracefully for session ${sessionId}, returning empty array`
    );
    return [];
  }
};

/**
 * A single page of session messages, including the metadata the chat UI needs
 * to drive infinite-scroll history (total pages → is there older history).
 */
export interface SessionMessagesPage {
  messages: Message[];
  total: number;
  totalPages: number;
  page: number; // 1-based (as passed in)
}

/**
 * Gets one page of messages for a session WITH pagination metadata.
 *
 * Unlike `getSessionMessages` (which returns only the array and is kept for
 * existing callers), this preserves `total` / `total_pages` so the caller can
 * tell whether older history remains. Pass `order='desc'` (the chat default) so
 * page 1 is the NEWEST window and higher pages reach further back; the backend
 * reverses each window back to chronological order, so the returned `messages`
 * are always oldest-first within the page and can be prepended as-is.
 */
export const getSessionMessagesPage = async (
  sessionId: string,
  page = 1,
  pageSize = 50,
  order: 'asc' | 'desc' = 'desc'
): Promise<SessionMessagesPage> => {
  let validSessionId = sessionId;
  if (!isValidUUID(sessionId)) {
    validSessionId = stringToUUID(sessionId);
  }

  // Backend uses 0-based pagination (Spring PageRequest), frontend uses 1-based
  const backendPage = Math.max(0, page - 1);

  try {
    const response = await apiClient.get(
      `/messages?sessionId=${validSessionId}&page=${backendPage}&pageSize=${pageSize}&order=${order}`
    );

    const data = response.data ?? {};
    const messages: Message[] = Array.isArray(data)
      ? data
      : data.items || data.messages || [];
    const total: number = typeof data.total === 'number' ? data.total : messages.length;
    const totalPages: number =
      typeof data.total_pages === 'number'
        ? data.total_pages
        : typeof data.totalPages === 'number'
          ? data.totalPages
          : 1;

    return { messages, total, totalPages, page };
  } catch (error) {
    console.error(`Error getting message page for session ${sessionId}:`, error);
    // Mirror getSessionMessages' graceful degradation: an empty page with no
    // further history rather than a thrown error that breaks the chat view.
    return { messages: [], total: 0, totalPages: 1, page };
  }
};

/**
 * Deletes a message by ID
 * @param messageId ID of the message to delete
 * @returns Success message
 */
export const deleteMessage = async (
  messageId: string
): Promise<{ message: string }> => {
  try {
    // Convert the message ID to a valid UUID if it's not already one
    const validMessageId = isValidUUID(messageId)
      ? messageId
      : stringToUUID(messageId);
    const response = await apiClient.delete(`/messages/${validMessageId}`);
    return response.data;
  } catch (error) {
    console.error(`Error deleting message ${messageId}:`, error);
    throw error;
  }
};

/**
 * Updates feedback on a message (1=positive, -1=negative, null=remove)
 * @param messageId Message ID to update feedback for
 * @param feedback Feedback value: 1, -1, or null
 */
export const updateMessageFeedback = async (
  messageId: string,
  feedback: number | null
): Promise<void> => {
  const validMessageId = isValidUUID(messageId) ? messageId : stringToUUID(messageId);
  await apiClient.put(`/messages/${validMessageId}/feedback`, { feedback });
};

/**
 * Gets token metrics for a specific message
 * @param messageId Message ID to retrieve metrics for
 * @returns Token metrics for the message
 */
export const getMessageMetrics = async (
  messageId: string
): Promise<TokenMetrics | null> => {
  try {
    // Convert the message ID to a valid UUID if it's not already one
    const validMessageId = isValidUUID(messageId)
      ? messageId
      : stringToUUID(messageId);



    const response = await apiClient.get(`/messages/${validMessageId}/metrics`);
    return response.data;
  } catch (error) {
    console.error(`Error getting metrics for message ${messageId}:`, error);

    // Return null instead of throwing to avoid UI disruption
    if (error.response?.status === 404) {
      console.warn(`No metrics found for message ${messageId}`);
      return null;
    }

    throw error;
  }
};

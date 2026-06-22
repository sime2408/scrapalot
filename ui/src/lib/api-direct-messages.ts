import { api } from './api';

export interface DirectMessageResponse {
  id: string;
  conversation_id: string;
  sender_id: string;
  sender_username: string | null;
  sender_first_name: string | null;
  sender_last_name: string | null;
  sender_profile_picture: string | null;
  content: string;
  read_at: string | null;
  created_at: string;
}

export interface DirectConversationResponse {
  id: string;
  workspace_id: string;
  other_user_id: string;
  other_username: string | null;
  other_first_name: string | null;
  other_last_name: string | null;
  other_profile_picture: string | null;
  last_message: string | null;
  last_message_at: string | null;
  unread_count: number;
  created_at: string;
}

// Direct messages are gated on Pro / Enterprise subscriptions; the
// backend returns 403 for any account below Pro. Setting `_silent403`
// tells the global axios 403 handler to skip the "Access denied"
// toast — the call site treats the 403 as "feature unavailable" and
// shows nothing rather than scaring the user with a generic
// permission banner on every dashboard load.
const DM_REQUEST_CONFIG = { _silent403: true } as const;

export async function getConversations(workspaceId?: string): Promise<DirectConversationResponse[]> {
  const params = workspaceId ? `?workspaceId=${workspaceId}` : '';
  try {
    const response = await api.get(`/messages/conversations${params}`, DM_REQUEST_CONFIG);
    return response.data;
  } catch (err) {
    const status = (err as { response?: { status?: number } })?.response?.status;
    if (status === 403) return [];
    throw err;
  }
}

export async function getMessages(conversationId: string): Promise<DirectMessageResponse[]> {
  try {
    const response = await api.get(`/messages/conversations/${conversationId}`, DM_REQUEST_CONFIG);
    return response.data;
  } catch (err) {
    const status = (err as { response?: { status?: number } })?.response?.status;
    if (status === 403) return [];
    throw err;
  }
}

export async function markConversationRead(conversationId: string): Promise<void> {
  try {
    await api.post(`/messages/conversations/${conversationId}/read`, undefined, DM_REQUEST_CONFIG);
  } catch (err) {
    const status = (err as { response?: { status?: number } })?.response?.status;
    if (status === 403) return;
    throw err;
  }
}


import { api } from './api';
import type { DirectMessageResponse } from './api-direct-messages';

export type { DirectMessageResponse } from './api-direct-messages';

/** A conversation thread surfaced in the notification bell (admin_dm | admin_broadcast). */
export interface AdminThread {
  id: string;
  workspace_id: string | null;
  other_user_id: string;
  other_username: string | null;
  other_first_name: string | null;
  other_last_name: string | null;
  other_profile_picture: string | null;
  last_message: string | null;
  last_message_at: string | null;
  unread_count: number;
  created_at: string;
  kind: 'peer' | 'admin_dm' | 'admin_broadcast';
}

// ---- Admin (sender) side ----

/** Admin → specific user: send a replyable direct message. */
export async function sendAdminMessage(userId: string, content: string): Promise<DirectMessageResponse> {
  const response = await api.post(`/admin/users/${userId}/messages`, { content });
  return response.data;
}

/** Admin → all active users: broadcast an announcement. Returns delivered count. */
export async function broadcastAdminMessage(content: string): Promise<{ delivered: number }> {
  const response = await api.post('/admin/messages/broadcast', { content });
  return response.data;
}

// ---- Recipient (user) side — NOT subscription-gated ----

export async function getAdminThreads(): Promise<AdminThread[]> {
  const response = await api.get('/messages/admin');
  return response.data;
}

export async function getAdminMessages(conversationId: string): Promise<DirectMessageResponse[]> {
  const response = await api.get(`/messages/admin/${conversationId}`);
  return response.data;
}

export async function replyToAdminMessage(conversationId: string, content: string): Promise<DirectMessageResponse> {
  const response = await api.post(`/messages/admin/${conversationId}/reply`, { content });
  return response.data;
}

/** Mark a thread read (clears the unread badge) without removing it from the bell. */
export async function markAdminMessageRead(conversationId: string): Promise<void> {
  await api.post(`/messages/admin/${conversationId}/read`);
}

/** Dismiss a thread — clears it from the bell entirely (persisted per-participant). */
export async function dismissAdminMessage(conversationId: string): Promise<void> {
  await api.post(`/messages/admin/${conversationId}/dismiss`);
}

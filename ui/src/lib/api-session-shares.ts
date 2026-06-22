import axios from 'axios';
import { apiClient, authState } from './api';

export interface SessionShareDTO {
  id: string;
  session_id: string;
  share_token: string;
  message_snapshot_count: number;
  created_at: string;
  expires_at: string | null;
  share_url: string;
}

export interface SharedConversationDTO {
  conversation_name: string | null;
  shared_at: string;
  messages: SharedMessageDTO[];
}

export interface SharedMessageDTO {
  role: string;
  content: string;
  created_at: string;
}

export interface CreateSessionShareRequest {
  expiresAt?: string | null;
}

export async function createSessionShare(
  sessionId: string,
  request?: CreateSessionShareRequest
): Promise<SessionShareDTO> {
  await authState.waitForAuthReady();
  const response = await apiClient.post<SessionShareDTO>(
    `/sessions/${sessionId}/share`,
    request ?? {}
  );
  return response.data;
}

export async function revokeSessionShare(sessionId: string): Promise<void> {
  await authState.waitForAuthReady();
  await apiClient.delete(`/sessions/${sessionId}/share`);
}

export async function getSessionShare(
  sessionId: string
): Promise<SessionShareDTO | null> {
  await authState.waitForAuthReady();
  const response = await apiClient.get<SessionShareDTO | null>(
    `/sessions/${sessionId}/share`
  );
  return response.data;
}

const API_BASE = import.meta.env.VITE_API_BASE_URL?.replace(/\/api\/v1\/?$/, '') || '';

export async function getSharedConversation(
  shareToken: string
): Promise<SharedConversationDTO> {
  const response = await axios.get<SharedConversationDTO>(
    `${API_BASE}/api/v1/shared/${shareToken}`
  );
  return response.data;
}

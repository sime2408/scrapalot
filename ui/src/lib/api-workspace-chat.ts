import { api, authState } from './api';

export interface WorkspaceChatMessage {
  id: string;
  workspace_id: string;
  sender_id: string;
  sender_username: string | null;
  sender_first_name: string | null;
  sender_last_name: string | null;
  sender_profile_picture: string | null;
  content: string;
  created_at: string;
}

export interface WorkspaceChatPresence {
  user_id: string;
  username: string | null;
  first_name: string | null;
  last_name: string | null;
  profile_picture: string | null;
  is_online: boolean;
  last_seen_at: string;
}

export interface WorkspaceChatAccess {
  hasFeature: boolean;
  isMember: boolean;
  canChat: boolean;
  canModerate: boolean;
}

export async function getChatMessages(workspaceId: string, limit = 50): Promise<WorkspaceChatMessage[]> {
  await authState.waitForAuthReady();
  const response = await api.get(`/workspaces/${workspaceId}/chat/messages`, {
    params: { limit }
  });
  return response.data;
}

export async function getChatMembers(workspaceId: string): Promise<WorkspaceChatPresence[]> {
  await authState.waitForAuthReady();
  const response = await api.get(`/workspaces/${workspaceId}/chat/members`);
  return response.data;
}

export async function checkChatAccess(workspaceId: string): Promise<WorkspaceChatAccess> {
  await authState.waitForAuthReady();
  const response = await api.get(`/workspaces/${workspaceId}/chat/access`);
  return response.data;
}

export async function deleteChatMessage(workspaceId: string, messageId: string): Promise<{ deleted_ids: string[] }> {
  await authState.waitForAuthReady();
  const response = await api.delete(`/workspaces/${workspaceId}/chat/messages/${messageId}`);
  return response.data;
}

export async function rollbackChatMessages(workspaceId: string, fromMessageId: string): Promise<{ deleted_ids: string[] }> {
  await authState.waitForAuthReady();
  const response = await api.post(`/workspaces/${workspaceId}/chat/messages/${fromMessageId}/rollback`);
  return response.data;
}

export async function clearChatMessages(workspaceId: string): Promise<{ cleared: boolean }> {
  await authState.waitForAuthReady();
  const response = await api.delete(`/workspaces/${workspaceId}/chat/messages`);
  return response.data;
}

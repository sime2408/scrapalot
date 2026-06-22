import { apiClient, authState } from './api';
import { invalidateCache } from './api-utils';

export interface SessionFolder {
  id: string;
  user_id: string;
  name: string;
  position: number;
  session_count: number;
  created_at: string;
  updated_at: string;
}

export const listSessionFolders = async (): Promise<SessionFolder[]> => {
  try {
    if (!authState.authReady) {
      await authState.waitForAuthReady(5000);
    }
    const response = await apiClient.get('/session-folders');
    return response.data || [];
  } catch (error) {
    console.error('Error listing session folders:', error);
    throw error;
  }
};

export const createSessionFolder = async (name: string): Promise<SessionFolder> => {
  try {
    if (!authState.authReady) {
      await authState.waitForAuthReady(5000);
    }
    const response = await apiClient.post('/session-folders', { name });
    invalidateCache(/^sessions_/);
    return response.data;
  } catch (error) {
    console.error('Error creating session folder:', error);
    throw error;
  }
};

export const updateSessionFolder = async (
  folderId: string,
  data: { name?: string; position?: number }
): Promise<SessionFolder> => {
  try {
    if (!authState.authReady) {
      await authState.waitForAuthReady(5000);
    }
    const response = await apiClient.put(`/session-folders/${folderId}`, data);
    return response.data;
  } catch (error) {
    console.error('Error updating session folder:', error);
    throw error;
  }
};

export const deleteSessionFolder = async (folderId: string): Promise<void> => {
  try {
    if (!authState.authReady) {
      await authState.waitForAuthReady(5000);
    }
    await apiClient.delete(`/session-folders/${folderId}`);
    invalidateCache(/^sessions_/);
  } catch (error) {
    console.error('Error deleting session folder:', error);
    throw error;
  }
};

export const moveSessionToFolder = async (
  sessionId: string,
  sessionFolderId: string | null
): Promise<void> => {
  try {
    if (!authState.authReady) {
      await authState.waitForAuthReady(5000);
    }
    await apiClient.post(`/session-folders/move-session/${sessionId}`, {
      session_folder_id: sessionFolderId,
    });
    invalidateCache(/^sessions_/);
  } catch (error) {
    console.error('Error moving session to folder:', error);
    throw error;
  }
};

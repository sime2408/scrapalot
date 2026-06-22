/**
 * Storage quota and usage API endpoints.
 */

import { api, apiUrls } from './api';

export interface StorageBreakdown {
  disk_bytes: number;
  db_content_bytes: number;
  thumbnail_bytes: number;
}

export interface StorageQuota {
  current_usage_bytes: number;
  current_usage_gb: number;
  limit_bytes: number | null;
  limit_gb: number | null;
  tier: string;
  percentage_used: number | null;
  unlimited: boolean;
  breakdown?: StorageBreakdown;
}

export interface WorkspaceStorage {
  workspace_id: string;
  storage_bytes: number;
  storage_gb: number;
  document_count_monthly: number;
  document_count_total: number;
  owner_id: string;
  your_role: string;
}

export interface QuotaCheckRequest {
  file_size_bytes: number;
  collection_id: string;
}

export interface QuotaCheckResponse {
  allowed: boolean;
  message: string;
  usage: number;
  limit: number | null;
  tier: string;
  workspace_owner_id: string;
  workspace_id: string;
}


/**
 * Get current user's storage quota and usage information.
 */
export async function getMyStorageQuota(): Promise<StorageQuota> {
  const response = await api.get(apiUrls.storageQuota);
  return response.data;
}


/**
 * Get storage usage for a specific workspace.
 * 
 * @param workspaceId - UUID of the workspace
 */
export async function getWorkspaceStorageUsage(workspaceId: string): Promise<WorkspaceStorage> {
  const response = await api.get(
    apiUrls.workspaceStorage.replace(':workspaceId', workspaceId)
  );
  return response.data;
}


/**
 * Check if uploading a file would exceed storage quota.
 * Useful for frontend validation before attempting upload.
 * 
 * @param fileSizeBytes - Size of the file to upload in bytes
 * @param collectionId - Target collection UUID
 */
export async function checkStorageQuota(
  fileSizeBytes: number,
  collectionId: string
): Promise<QuotaCheckResponse> {
  const response = await api.post(apiUrls.checkStorageQuota, {
    file_size_bytes: fileSizeBytes,
    collection_id: collectionId,
  });
  return response.data;
}


/**
 * Format bytes to human-readable size.
 */
export function formatBytes(bytes: number, decimals: number = 2): string {
  if (bytes === 0) return '0 Bytes';

  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];

  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}


/**
 * Get storage color based on usage percentage.
 */
export function getStorageColor(percentage: number | null): string {
  if (percentage === null) return 'bg-zinc-500'; // Unlimited
  if (percentage >= 90) return 'bg-red-500';
  if (percentage >= 70) return 'bg-orange-500';
  return 'bg-green-500';
}

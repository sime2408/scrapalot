import { api, apiUrls, clearCache } from './api';
import { toast } from '@/lib/toast-compat';

// Types for workspaces
export interface Workspace {
  id: string;
  name: string;
  user_id?: string;  // Owner's user ID
  is_shared?: boolean;  // True if workspace is shared with current user (not owned)
  role?: string;  // Current user's role: owner, editor, viewer
  created_at: string;
  updated_at: string | null;
  storage_bytes?: number;  // Total storage used in bytes
  storage_gb?: number;  // Total storage used in GB
  document_count?: number;  // Number of documents in workspace
}

// Mirrors the backend WorkspaceUserResponse (snake_case over the wire).
// The members list comes from GET /workspaces/:id/users — it carries a
// `permission` (read|write|admin), NOT a `role`, and has no surrogate `id`.
export interface WorkspaceUser {
  workspace_id: string;
  user_id: string;
  username?: string;
  email?: string;
  profile_picture?: string;
  permission: string;
  added_at: string;
}

export interface PaginatedWorkspaces {
  workspaces: Workspace[];
  pagination: {
    page: number;
    page_size: number;
    total: number;
    pages: number;
  };
}

// Cache for workspace data
interface WorkspaceCache {
  data: PaginatedWorkspaces;
  timestamp: number;
  key: string;
}

// Cache for the default workspace
interface DefaultWorkspaceCache {
  data: Workspace | null;
  timestamp: number;
}

// Type for API errors
interface ApiError extends Error {
  response?: {
    data?: {
      detail?: string;
    };
  };
}

// In-memory cache objects
const workspaceCache: Record<string, WorkspaceCache> = {};
const defaultWorkspaceCache: DefaultWorkspaceCache = {
  data: null,
  timestamp: 0,
};

// Cache expiration time (15 seconds)
const CACHE_EXPIRATION = 15000;

// Get all workspaces with pagination and caching
export const getWorkspaces = async (
  page = 1,
  pageSize = 10,
  bypassCache = false
): Promise<PaginatedWorkspaces> => {
  // Create a cache key based on pagination values
  const cacheKey = `${page}-${pageSize}`;
  const now = Date.now();

  // Check if we have valid cached data
  if (
    !bypassCache &&
    workspaceCache[cacheKey] &&
    now - workspaceCache[cacheKey].timestamp < CACHE_EXPIRATION
  ) {
    // Return cached data if still valid
    return workspaceCache[cacheKey].data;
  }

  try {
    const response = await api.get(
      `${apiUrls.getWorkspaces}?page=${page}&page_size=${pageSize}`
    );

    // Store the response in a cache
    workspaceCache[cacheKey] = {
      data: response.data,
      timestamp: now,
      key: cacheKey,
    };

    return response.data;
  } catch (error: unknown) {
    console.error('Error fetching workspaces:', error);
    toast({
      title: 'Error',
      description: 'Failed to fetch workspaces',
      variant: 'destructive',
    });

    // If we have any cached data for this query, return it even if expired
    if (workspaceCache[cacheKey]) {
      return workspaceCache[cacheKey].data;
    }

    return {
      workspaces: [],
      pagination: {
        page: 1,
        page_size: pageSize,
        total: 0,
        pages: 0,
      },
    };
  }
};

// Invalidate workspace cache (call after mutations)
export const invalidateWorkspacesCache = (): void => {
  Object.keys(workspaceCache).forEach(key => {
    delete workspaceCache[key];
  });
};

// Get workspace users/members list
export const getWorkspaceUsers = async (
  workspaceId: string
): Promise<WorkspaceUser[]> => {
  try {
    const response = await api.get(`/workspaces/${workspaceId}/users`);
    return response.data;
  } catch {
    return [];
  }
};

// Create a new workspace
export const createWorkspace = async (
  name: string
): Promise<{ workspace_id: string } | null> => {
  try {
    const response = await api.post(apiUrls.createWorkspace, { name });
    toast({
      title: 'Success',
      description: 'Workspace created successfully',
    });

    // Invalidate caches after mutation
    invalidateWorkspacesCache();
    defaultWorkspaceCache.timestamp = 0;

    return response.data;
  } catch (error: unknown) {
    console.error('Error creating workspace:', error);
    toast({
      title: 'Error',
      description: 'Failed to create workspace',
      variant: 'destructive',
    });
    return null;
  }
};

// Update a workspace
export const updateWorkspace = async (
  workspaceId: string,
  name: string
): Promise<Workspace | null> => {
  try {
    const response = await api.put(
      `${apiUrls.updateWorkspace.replace(':id', workspaceId)}`,
      { name }
    );
    toast({
      title: 'Success',
      description: 'Workspace updated successfully',
    });

    // Invalidate caches after mutation
    invalidateWorkspacesCache();
    defaultWorkspaceCache.timestamp = 0;

    return response.data;
  } catch (error: unknown) {
    console.error('Error updating workspace:', error);
    toast({
      title: 'Error',
      description: 'Failed to update workspace',
      variant: 'destructive',
    });
    return null;
  }
};

// Delete a workspace
export const deleteWorkspace = async (
  workspaceId: string
): Promise<boolean> => {
  try {
    await api.delete(`${apiUrls.deleteWorkspace.replace(':id', workspaceId)}`);
    toast({
      title: 'Success',
      description: 'Workspace deleted successfully',
    });

    // Invalidate caches after mutation
    invalidateWorkspacesCache();
    defaultWorkspaceCache.timestamp = 0;

    return true;
  } catch (error: unknown) {
    console.error('Error deleting workspace:', error);
    toast({
      title: 'Error',
      description: 'Failed to delete workspace',
      variant: 'destructive',
    });
    return false;
  }
};

// Map frontend role names to backend permission names
const roleToPermission = (role: string): string => {
  switch (role) {
    case 'viewer': return 'read';
    case 'editor': return 'write';
    case 'owner': return 'admin';
    default: return 'read';
  }
};

// Inverse of roleToPermission — maps the backend permission (read|write|admin)
// back to the UI role vocabulary (viewer|editor|owner) used by the member list.
export const permissionToRole = (permission: string): string => {
  switch (permission) {
    case 'read': return 'viewer';
    case 'write': return 'editor';
    case 'admin': return 'owner';
    default: return 'viewer';
  }
};

// Share a workspace with another user
export const shareWorkspace = async (
  workspaceId: string,
  targetUserId: string,
  role: string = 'viewer'
): Promise<boolean> => {
  try {
    await api.post(`/workspaces/${workspaceId}/share`, {
      user_id: targetUserId,
      permission: roleToPermission(role),
    });
    toast({
      title: 'Success',
      description: 'Workspace shared successfully',
    });

    // Only invalidate this specific workspace's data
    invalidateWorkspacesCache();

    return true;
  } catch (error: unknown) {
    console.error('Error sharing workspace:', error);

    // Extract detailed error message if available
    let errorMessage = 'Failed to share workspace';
    if (error instanceof Error && 'response' in error) {
      const apiError = error as ApiError;
      if (apiError.response?.data?.detail) {
        errorMessage = apiError.response.data.detail;
      }
    }

    toast({
      title: 'Error',
      description: errorMessage,
      variant: 'destructive',
    });

    return false;
  }
};

// Remove user access from a workspace
export const removeWorkspaceAccess = async (
  workspaceId: string,
  userId: string
): Promise<boolean> => {
  try {
    await api.delete(
      apiUrls.removeWorkspaceAccess
        .replace(':workspaceId', workspaceId)
        .replace(':userId', userId)
    );
    toast({
      title: 'Success',
      description: 'User access removed successfully',
    });

    // Invalidate caches
    invalidateWorkspacesCache();

    return true;
  } catch (error: unknown) {
    console.error('Error removing user access:', error);

    // Extract detailed error message if available
    let errorMessage = 'Failed to remove user access';
    if (error instanceof Error && 'response' in error) {
      const apiError = error as ApiError;
      if (apiError.response?.data?.detail) {
        errorMessage = apiError.response.data.detail;
      }
    }

    toast({
      title: 'Error',
      description: errorMessage,
      variant: 'destructive',
    });

    return false;
  }
};

// Get the default/selected workspace with caching
export const getDefaultWorkspace = async (
  bypassCache = false
): Promise<Workspace> => {
  const now = Date.now();

  // Check for valid cached data
  if (
    !bypassCache &&
    defaultWorkspaceCache.data &&
    now - defaultWorkspaceCache.timestamp < CACHE_EXPIRATION
  ) {
    return defaultWorkspaceCache.data;
  }

  let response;
  try {
    // Fetch the default workspace; the backend will create one if none exists
    response = await api.get(apiUrls.defaultWorkspace, bypassCache ? {
      headers: { 'x-skip-cache': 'true' },
    } : undefined);
  } catch (error: unknown) {
    console.error('❌ Error fetching default workspace:', error);

    // Clear the cache on error
    defaultWorkspaceCache.data = null;
    defaultWorkspaceCache.timestamp = 0;

    toast({
      title: 'Error',
      description: 'Failed to load workspace. Please check your connection.',
      variant: 'destructive',
    });
    throw error;
  }

  if (!response.data || !response.data.id) {
    defaultWorkspaceCache.data = null;
    defaultWorkspaceCache.timestamp = 0;
    toast({
      title: 'Error',
      description: 'Failed to load workspace. Please check your connection.',
      variant: 'destructive',
    });
    throw new Error('Invalid workspace response from server');
  }

  // Cache the response
  defaultWorkspaceCache.data = response.data;
  defaultWorkspaceCache.timestamp = now;

  return response.data;
};

// Set the selected workspace
export const setSelectedWorkspace = async (
  workspaceId: string
): Promise<boolean> => {
  try {
    await api.put(apiUrls.selectWorkspace, { workspaceId });
    toast({
      title: 'Success',
      description: 'Selected workspace updated',
    });

    // Reset the default workspace cache (both JS-level and axios response cache)
    defaultWorkspaceCache.timestamp = 0;
    clearCache('/workspaces/default');
    clearCache('/settings/user/workspace/selected');

    return true;
  } catch (error: unknown) {
    console.error('Error setting selected workspace:', error);
    toast({
      title: 'Error',
      description: 'Failed to update selected workspace',
      variant: 'destructive',
    });
    return false;
  }
};

// Update a user's role in a workspace
export const updateWorkspaceUserRole = async (
  workspaceId: string,
  userId: string,
  role: string
): Promise<boolean> => {
  try {
    await api.put(
      apiUrls.updateWorkspaceUserRole
        .replace(':workspaceId', workspaceId)
        .replace(':userId', userId),
      { permission: roleToPermission(role) }
    );
    toast({
      title: 'Success',
      description: `User role updated to ${role}`,
    });
    return true;
  } catch (error: unknown) {
    console.error('Error updating user role:', error);

    // Extract detailed error message if available
    let errorMessage = 'Failed to update user role';
    if (error instanceof Error && 'response' in error) {
      const apiError = error as ApiError;
      if (apiError.response?.data?.detail) {
        errorMessage = apiError.response.data.detail;
      }
    }

    toast({
      title: 'Error',
      description: errorMessage,
      variant: 'destructive',
    });

    return false;
  }
};

/**
 * Get the current user's role in a workspace
 */
export async function getMyWorkspaceRole(workspaceId: string): Promise<{
  workspace_id: string;
  role: string;
  is_owner: boolean;
  permissions: {
    can_read: boolean;
    can_edit: boolean;
    can_delete: boolean;
    can_share: boolean;
  };
} | null> {
  try {
    const response = await api.get(`${apiUrls.getWorkspaces}/${workspaceId}/my-role`);
    return response.data;
  } catch (error) {
    console.error('Error fetching workspace role:', error);
    return null;
  }
}

/**
 * Get storage usage for a workspace
 * Now uses the dedicated storage API endpoint
 */
export async function getWorkspaceStorage(workspaceId: string): Promise<{
  workspace_id: string;
  storage_used_bytes: number;
  storage_used_gb: number;
  documents_count: number;
} | null> {
  try {
    const response = await api.get(
      apiUrls.workspaceStorage.replace(':workspaceId', workspaceId)
    );
    const data = response.data;

    // Map new API response to expected format
    return {
      workspace_id: data.workspace_id,
      storage_used_bytes: data.storage_bytes,
      storage_used_gb: data.storage_gb,
      documents_count: data.document_count,
    };
  } catch (error) {
    console.error('Error fetching workspace storage:', error);
    return null;
  }
}

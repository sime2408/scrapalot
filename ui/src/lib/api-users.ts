import axios from 'axios';
import { api, apiUrls, clearCache } from './api';
import { toast } from '@/lib/toast-compat';

/** Extract detail message from an axios error response */
function getAxiosErrorDetail(error: unknown, fallback: string): string {
  if (axios.isAxiosError(error)) {
    return (error.response?.data as Record<string, unknown>)?.detail as string || fallback;
  }
  return error instanceof Error ? error.message : fallback;
}

// User interface
export interface User {
  id: string;
  username: string;
  email: string;
  first_name?: string;
  last_name?: string;
  profile_picture?: string;
  is_active: boolean;
  role: string;
  is_superadmin?: boolean;  // Only this account may impersonate admin-role users
  created_at: string;
  updated_at: string | null;
  has_password?: boolean;  // Indicates if user has a password (false for OAuth users)
  license_agreement_consent?: boolean;  // Whether user has accepted license agreement
  content_sharing_consent?: boolean;  // Whether user has consented to content sharing
  tour_completed?: boolean;  // Whether user has completed onboarding tour
  billing_exempt?: boolean;  // Whether user is exempt from Stripe billing
  subscription_plan_name?: string;  // Current subscription plan name
}

// User registration interface
export interface UserRegistration {
  username: string;
  email: string;
  password: string;
  first_name?: string;
  last_name?: string;
  license_agreement_consent: boolean;
  content_sharing_consent: boolean;
}

// User profile update interface
export interface UserProfileUpdate {
  first_name?: string;
  last_name?: string;
  email?: string;
}

// Password change interface
export interface PasswordChange {
  current_password?: string;  // Optional for OAuth users setting password for the first time
  new_password: string;
}

// Search users response
export interface SearchUsersResponse {
  users: User[];
  total: number;
}

/**
 * Search users by email or username
 * If query is empty or not provided, returns all users with pagination
 */
export const searchUsers = async (
  query: string = '',
  page = 1,
  pageSize = 10,
  includeInactive = false
): Promise<SearchUsersResponse> => {
  try {
    // Build query params - only include query if it's not empty
    const params = new URLSearchParams();
    if (query && query.trim()) {
      params.append('query', query);
    }
    params.append('page', page.toString());
    params.append('page_size', pageSize.toString());
    // Admin user management opts in so deactivated users stay visible and can be
    // reactivated; share/invite searches leave this off (active users only).
    if (includeInactive) {
      params.append('include_inactive', 'true');
    }

    const response = await api.get(
      `${apiUrls.searchUsers}?${params.toString()}`
    );
    return response.data;
  } catch (error: unknown) {
    console.error('Error searching users:', error);
    toast({
      title: 'Error',
      description: 'Failed to load users',
      variant: 'destructive',
    });
    return { users: [], total: 0 };
  }
};

/**
 * Get current user info
 */
export const getCurrentUser = async (): Promise<User | null> => {
  try {
    const response = await api.get(apiUrls.currentUser);
    return response.data;
  } catch (error: unknown) {
    console.error('Error getting current user:', error);
    return null;
  }
};

/**
 * Register a new user account
 */
export const registerUser = async (userData: UserRegistration): Promise<User | null> => {
  try {
    const response = await api.post(apiUrls.registerUser, userData);
    return response.data;
  } catch (error: unknown) {
    console.error('Error registering user:', error);

    // Extract error message from response
    const errorMessage = getAxiosErrorDetail(error, 'Failed to register user');
    
    toast({
      title: 'Registration Failed',
      description: errorMessage,
      variant: 'destructive',
    });
    
    throw new Error(errorMessage);
  }
};

/**
 * Update user profile information
 */
export const updateUserProfile = async (profileData: UserProfileUpdate): Promise<User | null> => {
  try {
    const response = await api.put(apiUrls.updateUserProfile, profileData);
    toast({
      title: 'Success',
      description: 'Profile updated successfully',
      variant: 'default',
    });
    return response.data;
  } catch (error: unknown) {
    console.error('Error updating user profile:', error);

    // Extract error message from response
    const errorMessage = getAxiosErrorDetail(error, 'Failed to update profile');
    
    toast({
      title: 'Update Failed',
      description: errorMessage,
      variant: 'destructive',
    });
    
    throw new Error(errorMessage);
  }
};

/**
 * Change user password
 */
export const changePassword = async (passwordData: PasswordChange): Promise<void> => {
  try {
    await api.put(apiUrls.changePassword, passwordData);
    toast({
      title: 'Success',
      description: 'Password changed successfully',
      variant: 'default',
    });
  } catch (error: unknown) {
    console.error('Error changing password:', error);

    // Extract error message from response
    const errorMessage = getAxiosErrorDetail(error, 'Failed to change password');
    
    toast({
      title: 'Password Change Failed',
      description: errorMessage,
      variant: 'destructive',
    });
    
    throw new Error(errorMessage);
  }
};

/**
 * Upload user profile picture
 */
export const uploadProfilePicture = async (file: File): Promise<User | null> => {
  try {
    const formData = new FormData();
    formData.append('file', file);

    const response = await api.post(`${apiUrls.currentUser}/profile-picture`, formData, {
      headers: {
        'Content-Type': 'multipart/form-data',
      },
    });

    toast({
      title: 'Success',
      description: 'Profile picture updated successfully',
      variant: 'default',
    });

    return response.data;
  } catch (error: unknown) {
    console.error('Error uploading profile picture:', error);

    const errorMessage = getAxiosErrorDetail(error, 'Failed to upload profile picture');

    toast({
      title: 'Upload Failed',
      description: errorMessage,
      variant: 'destructive',
    });

    throw new Error(errorMessage);
  }
};

/**
 * Delete user profile picture
 */
export const deleteProfilePicture = async (): Promise<User | null> => {
  try {
    const response = await api.delete(`${apiUrls.currentUser}/profile-picture`);

    toast({
      title: 'Success',
      description: 'Profile picture removed successfully',
      variant: 'default',
    });

    return response.data;
  } catch (error: unknown) {
    console.error('Error deleting profile picture:', error);

    const errorMessage = getAxiosErrorDetail(error, 'Failed to delete profile picture');

    toast({
      title: 'Delete Failed',
      description: errorMessage,
      variant: 'destructive',
    });

    throw new Error(errorMessage);
  }
};


/**
 * Accept license agreement and content sharing consent
 */
export const acceptLicenseAgreement = async (contentSharingConsent: boolean = true): Promise<void> => {
  try {
    await api.post(`${apiUrls.currentUser}/accept-license`, null, {
      params: { content_sharing_consent: contentSharingConsent }
    });
  } catch (error: unknown) {
    console.error('Error accepting license agreement:', error);
    throw error;
  }
};

/**
 * Update onboarding tour completion status
 */
export const updateTourCompleted = async (tourCompleted: boolean): Promise<void> => {
  try {
    await api.put(apiUrls.updateTourCompleted, { tour_completed: tourCompleted });
  } catch (error: unknown) {
    console.error('Error updating tour completion status:', error);
    // Silently fail - localStorage is used as backup
  }
};

// ============================================
// ADMIN USER MANAGEMENT FUNCTIONS
// ============================================

/**
 * Admin: Update any user's details
 */
export const adminUpdateUser = async (
  userId: string,
  userData: Partial<User>
): Promise<User | null> => {
  try {
    const url = apiUrls.adminUpdateUser.replace(':userId', userId);
    const response = await api.put(url, userData);
    // Bust the cached user list so the edited row reflects immediately.
    clearCache('/users/search');
    toast({
      title: 'Success',
      description: 'User updated successfully',
      variant: 'default',
    });
    return response.data;
  } catch (error: unknown) {
    console.error('Error updating user:', error);
    const errorMessage = getAxiosErrorDetail(error, 'Failed to update user');
    toast({
      title: 'Update Failed',
      description: errorMessage,
      variant: 'destructive',
    });
    throw new Error(errorMessage);
  }
};

/**
 * Admin: Delete a user
 */
export const adminDeleteUser = async (userId: string): Promise<void> => {
  try {
    const url = apiUrls.adminDeleteUser.replace(':userId', userId);
    await api.delete(url);
    // The user list (GET /users/search) is cached for 60s by the api.ts
    // response interceptor. Without busting it, the post-delete refetch
    // returns the stale list with the deleted user still present — it
    // only disappeared after a full page reload (which resets the
    // in-memory cache). Invalidate every cached page of the list here.
    clearCache('/users/search');
    toast({
      title: 'Success',
      description: 'User deleted successfully',
      variant: 'default',
    });
  } catch (error: unknown) {
    console.error('Error deleting user:', error);
    const errorMessage = getAxiosErrorDetail(error, 'Failed to delete user');
    toast({
      title: 'Delete Failed',
      description: errorMessage,
      variant: 'destructive',
    });
    throw new Error(errorMessage);
  }
};

/**
 * Admin: Toggle user active status
 */
export const adminToggleUserStatus = async (
  userId: string,
  isActive: boolean
): Promise<User | null> => {
  try {
    const url = apiUrls.adminUpdateUser.replace(':userId', userId);
    const response = await api.put(url, { is_active: isActive });
    // Bust the cached user list so the status toggle reflects immediately.
    clearCache('/users/search');
    toast({
      title: 'Success',
      description: `User ${isActive ? 'activated' : 'deactivated'} successfully`,
      variant: 'default',
    });
    return response.data;
  } catch (error: unknown) {
    console.error('Error toggling user status:', error);
    const errorMessage = getAxiosErrorDetail(error, 'Failed to update user status');
    toast({
      title: 'Update Failed',
      description: errorMessage,
      variant: 'destructive',
    });
    throw new Error(errorMessage);
  }
};

/**
 * Admin: Issue impersonation tokens for the target user. Returns the
 * raw axios response data (not unwrapped) so the caller can store the
 * exact JSON shape back into localStorage for the auth bootstrap to
 * read.
 */
export interface ImpersonationTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
}

export const adminImpersonateUser = async (
  userId: string
): Promise<ImpersonationTokenResponse> => {
  try {
    const response = await api.post(`/admin/users/${userId}/impersonate`);
    return response.data;
  } catch (error: unknown) {
    console.error('Error issuing impersonation token:', error);
    const errorMessage = getAxiosErrorDetail(error, 'Failed to start impersonation');
    toast({
      title: 'Impersonation Failed',
      description: errorMessage,
      variant: 'destructive',
    });
    throw new Error(errorMessage);
  }
};

export interface AdminUserWorkspace {
  id: string;
  name: string;
  is_owner: boolean;
}

/**
 * Admin: list a specific user's accessible workspaces (owned + shared).
 * The user-details edit screen uses this instead of the generic "my
 * workspaces" call, which returned the admin's own workspaces (hence the
 * "0 workspaces" the edited user appeared to have).
 */
export const adminGetUserWorkspaces = async (
  userId: string
): Promise<AdminUserWorkspace[]> => {
  try {
    const response = await api.get(`/admin/users/${userId}/workspaces`);
    return Array.isArray(response.data) ? response.data : [];
  } catch (error: unknown) {
    console.error('Error loading user workspaces:', error);
    return [];
  }
};

/**
 * Admin: Reset a user's password
 */
export const adminResetPassword = async (
  userId: string,
  newPassword: string
): Promise<void> => {
  try {
    const url = apiUrls.adminResetPassword.replace(':userId', userId);
    await api.post(url, { new_password: newPassword });
    toast({
      title: 'Success',
      description: 'Password reset successfully',
      variant: 'default',
    });
  } catch (error: unknown) {
    console.error('Error resetting password:', error);
    const errorMessage = getAxiosErrorDetail(error, 'Failed to reset password');
    toast({
      title: 'Reset Failed',
      description: errorMessage,
      variant: 'destructive',
    });
    throw new Error(errorMessage);
  }
};

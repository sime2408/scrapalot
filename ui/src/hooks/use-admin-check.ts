import { useAuth } from './use-auth';
import { useMemo } from 'react';

/**
 * Custom hook to check if the current user has admin permissions
 * Handles various formats of the admin role that might be returned from the JWT token
 * @returns boolean indicating if the user is an admin, or null if still loading
 */
export const useAdminCheck = (): boolean | null => {
  const { user, isLoading } = useAuth();

  // Use useMemo to cache the admin status and only recalculate when dependencies change
  return useMemo(() => {
    // Return null while loading to prevent premature hiding of admin tabs
    if (isLoading) {
      return null;
    }

    if (!user) {
      return false;
    }

    // Cast to Record to handle different potential formats
    const userAny = user as Record<string, unknown>;

    // Check all possible formats of the admin role
    const role = userAny.role;
    const roles = userAny.roles;
    const roleObj = typeof role === 'object' && role !== null ? role as Record<string, unknown> : null;

    return (
      // Standard string format check - case insensitive
      (typeof role === 'string' &&
        role.toUpperCase() === 'ADMIN') ||
      // Check in an array of roles if present
      (Array.isArray(roles) &&
        roles.some((r) => typeof r === 'string' && r.toUpperCase() === 'ADMIN')) ||
      // Check object format with name or value property
      (roleObj !== null &&
        ((typeof roleObj.name === 'string' && roleObj.name.toUpperCase() === 'ADMIN') ||
          (typeof roleObj.value === 'string' &&
            roleObj.value.toUpperCase() === 'ADMIN') ||
          (typeof roleObj.role === 'string' &&
            roleObj.role.toUpperCase() === 'ADMIN'))) ||
      // Handle enum string representation (may come as "UserRole.ADMIN")
      (typeof role === 'string' && role.includes('ADMIN'))
    );
  }, [user, isLoading]); // Recalculate when user or isLoading changes
};

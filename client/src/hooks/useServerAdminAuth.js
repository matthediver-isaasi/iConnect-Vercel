import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { createPageUrl } from '@/utils';

/**
 * Hook for verifying server-validated permissions.
 * 
 * Permissions available:
 * - 'canEditMembers': Can edit other members' details (admin_can_edit_members feature)
 * - 'canManageCommunications': Can manage communications (admin_can_manage_communications feature)
 * - 'isAdmin': Legacy admin check (role.is_admin flag)
 * 
 * Permissions are controlled via Role Management - if a feature is NOT in the 
 * role's excluded_features array, the role has that permission.
 * Roles with is_admin=true automatically have all permissions.
 */
export function useServerAdminAuth(options = {}) {
  const { 
    redirectOnDeny = true, 
    redirectPath = 'Events',
    requiredPermission = 'canEditMembers' // Which permission to check for access
  } = options;
  const [redirectTriggered, setRedirectTriggered] = useState(false);

  const { data: authData, isLoading, isError, error } = useQuery({
    queryKey: ['authMe'],
    queryFn: async () => {
      const response = await fetch('/api/auth/me', { credentials: 'include' });
      if (!response.ok) {
        throw new Error('Failed to verify authentication');
      }
      const data = await response.json();
      return data;
    },
    staleTime: 30000, 
    refetchOnWindowFocus: false,
  });

  const isAuthenticated = !!authData && !!authData.id;
  const isAdmin = authData?.isAdmin === true;
  const canEditMembers = authData?.canEditMembers === true;
  const canManageCommunications = authData?.canManageCommunications === true;
  const isReady = !isLoading;
  const memberId = authData?.id || null;

  // Determine if user has the required permission
  const hasRequiredPermission = (() => {
    switch (requiredPermission) {
      case 'canEditMembers':
        return canEditMembers;
      case 'canManageCommunications':
        return canManageCommunications;
      case 'isAdmin':
        return isAdmin;
      default:
        return false;
    }
  })();

  useEffect(() => {
    if (isReady && redirectOnDeny && !hasRequiredPermission && !redirectTriggered) {
      setRedirectTriggered(true);
      console.log('[useServerAdminAuth] Access denied - missing permission:', requiredPermission, 'redirecting to:', redirectPath);
      window.location.href = createPageUrl(redirectPath);
    }
  }, [isReady, hasRequiredPermission, redirectOnDeny, redirectPath, redirectTriggered, requiredPermission]);

  return {
    isAuthenticated,
    isAdmin,
    canEditMembers,
    canManageCommunications,
    hasRequiredPermission,
    isReady,
    isLoading,
    isError,
    error,
    authData,
    memberId,
  };
}

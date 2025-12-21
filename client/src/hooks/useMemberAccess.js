import { useState, useCallback, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { base44 } from '../api/base44Client';
import { isResourceExcluded } from '../lib/roleVisibility';

export function useMemberAccess() {
  const queryClient = useQueryClient();
  
  const [memberInfo, setMemberInfo] = useState(() => {
    const stored = localStorage.getItem('agcas_member');
    return stored ? JSON.parse(stored) : null;
  });

  const [organizationInfo, setOrganizationInfo] = useState(() => {
    const stored = localStorage.getItem('agcas_organization');
    return stored ? JSON.parse(stored) : null;
  });

  useEffect(() => {
    const handleStorageChange = (e) => {
      // Only respond to our specific keys
      if (e.key === 'agcas_member' || e.key === 'agcas_organization' || e.key === null) {
        const storedMember = localStorage.getItem('agcas_member');
        const storedOrg = localStorage.getItem('agcas_organization');
        setMemberInfo(storedMember ? JSON.parse(storedMember) : null);
        setOrganizationInfo(storedOrg ? JSON.parse(storedOrg) : null);
      }
    };

    window.addEventListener('storage', handleStorageChange);
    return () => window.removeEventListener('storage', handleStorageChange);
  }, []);

  // Load member's role when logged in
  const { data: memberRole, isLoading: isRoleLoading } = useQuery({
    queryKey: ['memberRole', memberInfo?.role_id],
    enabled: !!(memberInfo && memberInfo.role_id),
    queryFn: async () => {
      if (!memberInfo || !memberInfo.role_id) return null;
      try {
        const data = await base44.entities.Role.get(memberInfo.role_id);
        return data || null;
      } catch (error) {
        console.error('Error loading memberRole:', error);
        return null;
      }
    },
  });

  // Load "Public" role exclusions for non-logged-in users via public API endpoint
  // This allows controlling what public visitors can see via RoleAccessConfigManagement
  const { data: publicRoleData, isLoading: isPublicRoleLoading } = useQuery({
    queryKey: ['publicRoleExclusions'],
    enabled: memberInfo === null, // Only load when not logged in
    staleTime: 0, // Always fetch fresh data - Public role exclusions are critical for access control
    refetchOnMount: true,
    refetchOnWindowFocus: true,
    queryFn: async () => {
      try {
        const response = await fetch('/api/public/role-exclusions', {
          cache: 'no-store', // Bypass browser cache
          headers: { 'Cache-Control': 'no-cache' }
        });
        if (!response.ok) {
          console.error('Failed to load Public role exclusions:', response.status);
          return { excluded_features: [] };
        }
        const data = await response.json();
        console.log('[useMemberAccess] Public role exclusions loaded:', data.excluded_features?.length || 0, 'features excluded');
        return data;
      } catch (error) {
        console.error('Error loading Public role exclusions:', error);
        return { excluded_features: [] };
      }
    },
  });
  
  // Create a publicRole-like object for backward compatibility
  const publicRole = publicRoleData ? { 
    id: publicRoleData.role_id,
    name: 'Public',
    excluded_features: publicRoleData.excluded_features || []
  } : null;

  // Determine the effective role - member's role when logged in, Public role when not
  const effectiveRole = memberInfo ? memberRole : publicRole;

  // Derive admin status from whether admin features are accessible (not excluded)
  // This replaces the deprecated is_admin flag - now all access is controlled via Role Management exclusions
  const isAdmin = memberRole ? !isResourceExcluded(memberRole.excluded_features, 'admin.role-management') : false;

  const isFeatureExcluded = useCallback((featureId) => {
    if (!featureId) return false;
    
    // For non-logged-in users, use Public role exclusions
    if (!memberInfo) {
      const publicExclusions = publicRole?.excluded_features || [];
      return isResourceExcluded(publicExclusions, featureId);
    }
    
    // For logged-in users, combine role and member-specific exclusions
    const roleExclusions = memberRole?.excluded_features || [];
    const memberExclusions = memberInfo.member_excluded_features || [];
    const allExclusions = [...roleExclusions, ...memberExclusions];
    return isResourceExcluded(allExclusions, featureId);
  }, [memberInfo, memberRole, publicRole]);

  const reloadMemberInfo = useCallback(async () => {
    if (!memberInfo?.id) return;
    try {
      const updatedMember = await base44.entities.Member.get(memberInfo.id);
      if (updatedMember) {
        localStorage.setItem('agcas_member', JSON.stringify(updatedMember));
        setMemberInfo(updatedMember);
        if (updatedMember.role_id !== memberInfo.role_id) {
          queryClient.invalidateQueries({ queryKey: ['memberRole'] });
        }
      }
    } catch (error) {
      console.error('Error reloading member info:', error);
    }
  }, [memberInfo?.id, memberInfo?.role_id, queryClient]);

  const refreshOrganizationInfo = useCallback(async () => {
    if (!organizationInfo?.id) return;
    try {
      const updatedOrg = await base44.entities.Organization.get(organizationInfo.id);
      if (updatedOrg) {
        localStorage.setItem('agcas_organization', JSON.stringify(updatedOrg));
        setOrganizationInfo(updatedOrg);
      }
    } catch (error) {
      console.error('Error refreshing organization info:', error);
    }
  }, [organizationInfo?.id]);

  // Access is ready when:
  // - For logged-in users: member info loaded and role loaded (if they have one)
  // - For non-logged-in users: public role query has completed (even if null)
  const isAccessReady = memberInfo !== null 
    ? (!memberInfo.role_id || memberRole !== undefined)
    : !isPublicRoleLoading;

  return {
    memberInfo,
    organizationInfo,
    memberRole,
    publicRole,
    effectiveRole, // The role being used for access control (memberRole or publicRole)
    isAdmin,
    isFeatureExcluded,
    isRoleLoading: isRoleLoading || isPublicRoleLoading,
    isAccessReady,
    reloadMemberInfo,
    refreshOrganizationInfo,
  };
}

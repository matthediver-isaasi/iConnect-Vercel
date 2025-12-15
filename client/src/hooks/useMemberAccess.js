import { useState, useCallback, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { base44 } from '../api/base44Client';
import { isResourceExcluded } from '../lib/roleVisibility';

export function useMemberAccess() {
  const queryClient = useQueryClient();
  
  const [memberInfo, setMemberInfo] = useState(() => {
    const stored = sessionStorage.getItem('agcas_member');
    return stored ? JSON.parse(stored) : null;
  });

  const [organizationInfo, setOrganizationInfo] = useState(() => {
    const stored = sessionStorage.getItem('agcas_organization');
    return stored ? JSON.parse(stored) : null;
  });

  useEffect(() => {
    const handleStorageChange = () => {
      const storedMember = sessionStorage.getItem('agcas_member');
      const storedOrg = sessionStorage.getItem('agcas_organization');
      setMemberInfo(storedMember ? JSON.parse(storedMember) : null);
      setOrganizationInfo(storedOrg ? JSON.parse(storedOrg) : null);
    };

    window.addEventListener('storage', handleStorageChange);
    return () => window.removeEventListener('storage', handleStorageChange);
  }, []);

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

  const isAdmin = memberRole?.is_admin === true;

  const isFeatureExcluded = useCallback((featureId) => {
    if (!memberInfo || !featureId) return false;
    const roleExclusions = memberRole?.excluded_features || [];
    const memberExclusions = memberInfo.member_excluded_features || [];
    const allExclusions = [...roleExclusions, ...memberExclusions];
    return isResourceExcluded(allExclusions, featureId);
  }, [memberInfo, memberRole]);

  const reloadMemberInfo = useCallback(async () => {
    if (!memberInfo?.id) return;
    try {
      const updatedMember = await base44.entities.Member.get(memberInfo.id);
      if (updatedMember) {
        sessionStorage.setItem('agcas_member', JSON.stringify(updatedMember));
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
        sessionStorage.setItem('agcas_organization', JSON.stringify(updatedOrg));
        setOrganizationInfo(updatedOrg);
      }
    } catch (error) {
      console.error('Error refreshing organization info:', error);
    }
  }, [organizationInfo?.id]);

  const isAccessReady = memberInfo !== null && (!memberInfo.role_id || memberRole !== undefined);

  return {
    memberInfo,
    organizationInfo,
    memberRole,
    isAdmin,
    isFeatureExcluded,
    isRoleLoading,
    isAccessReady,
    reloadMemberInfo,
    refreshOrganizationInfo,
  };
}

import { useCallback, useContext } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { base44 } from '../api/base44Client';
import { isResourceExcluded } from '../lib/roleVisibility';
import LayoutContext from '../contexts/LayoutContext';

export function useMemberAccess() {
  const queryClient = useQueryClient();
  
  // SECURITY: Use memberInfo from LayoutContext instead of localStorage
  // This ensures memberInfo is always in sync with the session validation state
  // When Layout.jsx clears localStorage on 401, it also clears the context memberInfo
  const { 
    sessionValidated,
    authResolved,
    memberInfo, 
    organizationInfo,
    setMemberInfo,
    setOrganizationInfo 
  } = useContext(LayoutContext);

  // SECURITY: Only fetch role when auth is resolved and session is validated by server
  // This prevents 401 errors when localStorage has stale member data
  const { data: memberRole, isLoading: isRoleLoading } = useQuery({
    queryKey: ['memberRole', memberInfo?.role_id],
    enabled: authResolved && sessionValidated && !!(memberInfo && memberInfo.role_id),
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

  // Derive admin status from whether admin features are accessible (not excluded)
  // This replaces the deprecated is_admin flag - now all access is controlled via Role Management exclusions
  const isAdmin = memberRole ? !isResourceExcluded(memberRole.excluded_features, 'admin.role-management') : false;

  const isFeatureExcluded = useCallback((featureId) => {
    if (!memberInfo || !featureId) return false;
    const roleExclusions = memberRole?.excluded_features || [];
    const memberExclusions = memberInfo.member_excluded_features || [];
    const allExclusions = [...roleExclusions, ...memberExclusions];
    return isResourceExcluded(allExclusions, featureId);
  }, [memberInfo, memberRole]);

  const reloadMemberInfo = useCallback(async () => {
    // Only reload if session is validated and memberInfo exists
    if (!sessionValidated || !memberInfo?.id) return;
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
  }, [sessionValidated, memberInfo?.id, memberInfo?.role_id, queryClient, setMemberInfo]);

  const refreshOrganizationInfo = useCallback(async () => {
    // Only refresh if session is validated and organizationInfo exists
    if (!sessionValidated || !organizationInfo?.id) return;
    try {
      const updatedOrg = await base44.entities.Organization.get(organizationInfo.id);
      if (updatedOrg) {
        localStorage.setItem('agcas_organization', JSON.stringify(updatedOrg));
        setOrganizationInfo(updatedOrg);
      }
    } catch (error) {
      console.error('Error refreshing organization info:', error);
    }
  }, [sessionValidated, organizationInfo?.id, setOrganizationInfo]);

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

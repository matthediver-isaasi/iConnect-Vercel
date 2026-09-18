import { useCallback, useContext } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { base44 } from '../api/base44Client';
import { isResourceExcluded } from '../lib/roleVisibility';
import LayoutContext from '../contexts/LayoutContext';
import { useSessionMemberRole } from './useSessionMemberRole';
import { stripTrustedMemberProjections } from '../lib/memberSessionRole';

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
    setOrganizationInfo,
    retrySessionRole,
  } = useContext(LayoutContext);
  const { memberRole, roleStatus, roleError, retryRole } = useSessionMemberRole();

  // SECURITY: Only fetch role when auth is resolved and session is validated by server
  // This prevents 401 errors when localStorage has stale member data
  // Derive admin status from whether admin features are accessible (not excluded)
  // This replaces the deprecated is_admin flag - now all access is controlled via Role Management exclusions
  const isAdmin = memberRole ? !isResourceExcluded(memberRole.excluded_features, 'admin.role-management') : false;

  const isFeatureExcluded = useCallback((featureId) => {
    // Confirmed guests retain public-page behaviour. A member whose role has
    // not resolved, however, must never receive optimistic protected access.
    if (!memberInfo || !featureId) return false;
    if (roleStatus !== 'ready') return true;
    const roleExclusions = memberRole?.excluded_features || [];
    const memberExclusions = memberInfo.member_excluded_features || [];
    const allExclusions = [...roleExclusions, ...memberExclusions];
    return isResourceExcluded(allExclusions, featureId);
  }, [memberInfo, memberRole, roleStatus]);

  const reloadMemberInfo = useCallback(async () => {
    // Only reload if session is validated and memberInfo exists
    if (!sessionValidated || !memberInfo?.id) return;
    try {
      const updatedMember = await base44.entities.Member.get(memberInfo.id);
      if (updatedMember) {
        const persistableMember = stripTrustedMemberProjections(updatedMember);
        localStorage.setItem('agcas_member', JSON.stringify(persistableMember));
        setMemberInfo(persistableMember);
        const identityChanged = updatedMember.role_id !== memberInfo.role_id
          || updatedMember.tenant_id !== memberInfo.tenant_id
          || updatedMember.id !== memberInfo.id;
        if (identityChanged) {
          queryClient.invalidateQueries({ queryKey: ['memberRole'] });
          retrySessionRole();
        }
      }
    } catch (error) {
      console.error('Error reloading member info:', error);
    }
  }, [
    sessionValidated,
    memberInfo?.id,
    memberInfo?.tenant_id,
    memberInfo?.role_id,
    queryClient,
    setMemberInfo,
    retrySessionRole,
  ]);

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

  // "Ready" means the access decision is terminal, not necessarily allowed.
  // This lets consumers leave their loading UI on missing/error while
  // isFeatureExcluded continues to fail closed.
  const isAccessReady = authResolved
    && (!memberInfo || !sessionValidated || roleStatus !== 'loading');

  return {
    memberInfo,
    organizationInfo,
    memberRole,
    authResolved,
    sessionValidated,
    isAdmin,
    isFeatureExcluded,
    isRoleLoading: roleStatus === 'loading',
    roleStatus,
    roleError,
    retryRole,
    isAccessReady,
    reloadMemberInfo,
    refreshOrganizationInfo,
  };
}

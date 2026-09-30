export const TEAM_ROLE_ASSIGNMENT_FEATURE = 'element_TeamLoginAccessToggle';

export function canShowTeamRoleControl(isFeatureExcluded) {
  return typeof isFeatureExcluded === 'function'
    && !isFeatureExcluded(TEAM_ROLE_ASSIGNMENT_FEATURE);
}

export function getAssignableTeamRoles(roles, memberRole, currentRoleId) {
  const allowed = new Set(
    Array.isArray(memberRole?.assignable_role_ids) ? memberRole.assignable_role_ids : [],
  );
  return (roles || []).filter((role) => (
    role?.id
    && role.is_tenant_admin !== true
    && (allowed.has(role.id) || role.id === currentRoleId)
  ));
}

export function canClearTeamRole(isAdmin) {
  return isAdmin === true;
}
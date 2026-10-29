export function useMemberAccess() {
  const restricted = new URLSearchParams(location.search).has('restricted');
  return {
    memberInfo: { id: 'viewer', organization_id: 'org', email: 'viewer@example.invalid' },
    organizationInfo: { id: 'org', name: 'Fixture organisation' },
    memberRole: { id: 'role-a', assignable_role_ids: ['role-a', 'role-b'] },
    isAdmin: !restricted,
    isFeatureExcluded: feature => restricted || feature === 'element_TeamInviteMember',
  };
}

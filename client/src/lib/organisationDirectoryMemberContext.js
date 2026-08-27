export function buildOrganisationDirectoryMembersUrl(organizationId, directorySlug) {
  const encodedOrg = encodeURIComponent(organizationId || '');
  if (directorySlug) {
    return `/directory/${encodeURIComponent(directorySlug)}/members/${encodedOrg}`;
  }
  return `/OrganisationDirectory/members/${encodedOrg}`;
}

export function memberMatchesDirectoryScope(member, { organizationId, roleIds }) {
  if (organizationId && member.organization_id !== organizationId) return false;
  if (Array.isArray(roleIds) && roleIds.length > 0 && !roleIds.includes(member.role_id)) return false;
  return true;
}
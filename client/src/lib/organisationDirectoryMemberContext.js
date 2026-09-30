// Match the server's nonblank-string role parsing; contacts are a separate policy.
export function parseOrganisationViewMembersRoleIds(value) {
  let parsed = value;
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed); } catch { return []; }
  }
  return Array.isArray(parsed)
    ? parsed.filter(id => typeof id === 'string' && id.trim())
    : [];
}

export function hasOrganisationViewMembersRoles(settings) {
  return Array.isArray(settings?.viewMembersRoleIds)
    && parseOrganisationViewMembersRoleIds(settings.viewMembersRoleIds).length > 0;
}

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
export const ORGANISATION_DIRECTORY_ORIGIN = 'organisation-directory';

export function buildOrganisationDirectoryMembersUrl(organizationId) {
  const params = new URLSearchParams({
    org: organizationId || '',
    origin: ORGANISATION_DIRECTORY_ORIGIN,
  });
  return `/memberdirectory?${params.toString()}`;
}

export function hasOrganisationDirectoryOrigin(search) {
  const params = search instanceof URLSearchParams
    ? search
    : new URLSearchParams(search || '');
  return params.get('origin') === ORGANISATION_DIRECTORY_ORIGIN;
}

export function resolveDirectoryRoleIds({
  hasOrganisationOrigin,
  organisationRoleIds,
  memberDirectoryRoleIds,
  availableRoleIds,
}) {
  const fallback = Array.isArray(memberDirectoryRoleIds) ? memberDirectoryRoleIds : [];
  if (!hasOrganisationOrigin || !Array.isArray(organisationRoleIds) || organisationRoleIds.length === 0) {
    return fallback;
  }

  const available = new Set(Array.isArray(availableRoleIds) ? availableRoleIds : []);
  const validOrganisationRoles = organisationRoleIds.filter((id) => available.has(id));
  return validOrganisationRoles.length > 0 ? validOrganisationRoles : fallback;
}

export function memberMatchesDirectoryScope(member, { organizationId, roleIds }) {
  if (organizationId && member.organization_id !== organizationId) return false;
  if (Array.isArray(roleIds) && roleIds.length > 0 && !roleIds.includes(member.role_id)) return false;
  return true;
}
import { fetchOrgDisplaySettings } from './directoryConfig.js';
import { resolveOrganisationCorePublication } from '../../shared/organisationDirectoryCore.js';

// Preserve the legacy full-directory public access rule (unrestricted role
// lists permit guests). Carousel has a separate, authenticated-only contract.
export function canReadOrganisationDirectory(directory, context, tenantId) {
  if (context?.tenantMismatch || (context?.tenantId && context.tenantId !== tenantId)) return false;
  let roles = directory?.allowed_role_ids;
  if (typeof roles === 'string') {
    try { roles = JSON.parse(roles); } catch { return false; }
  }
  if (roles == null) roles = [];
  if (!Array.isArray(roles) || roles.some(role => typeof role !== 'string' || !role.trim())) return false;
  if (context?.tenantUserId && context.tenantId === tenantId) return true;
  return roles.length === 0 || (context?.isAuthenticated === true && roles.includes(context.roleId));
}

export function organisationPublicationAuthority(directory, settings) {
  return JSON.stringify({
    active: directory.is_active,
    roles: directory.allowed_role_ids,
    filter: [directory.filter_field_id, directory.filter_value],
    publication: resolveOrganisationCorePublication(settings.corePublication, directory.core_field_visibility),
  });
}

export async function revalidateOrganisationPublication({ db, tenantId, directory, settings, context }) {
  const { data, error } = await db.from('dynamic_directory').select('*')
    .eq('tenant_id', tenantId).eq('id', directory.id).eq('is_active', true).limit(1);
  if (error) throw new Error('Unable to revalidate directory publication');
  const current = data?.[0];
  const freshSettings = await fetchOrgDisplaySettings(db, tenantId);
  return current && canReadOrganisationDirectory(current, context, tenantId)
    && organisationPublicationAuthority(current, freshSettings) === organisationPublicationAuthority(directory, settings);
}

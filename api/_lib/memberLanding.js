import { normalizeMemberLanding } from '../../shared/memberLanding.js';

export async function resolveMemberLanding(db, member, tenantId = member.tenant_id) {
  if (!member.role_id) return normalizeMemberLanding(null);
  const { data: role, error } = await db.from('role')
    .select('id, tenant_id, default_landing_page')
    .eq('id', member.role_id).eq('tenant_id', tenantId).maybeSingle();
  // An assigned role that cannot be read is not an unconfigured landing page.
  if (error || !role || role.id !== member.role_id || role.tenant_id !== tenantId) {
    throw new Error('Unable to resolve member landing page. Please try again.');
  }
  return normalizeMemberLanding(role.default_landing_page);
}

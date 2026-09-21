import { isResourceExcluded } from './roleVisibility.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function copyRoleSettings({ db, context, sourceRoleId, targetRoleId }) {
  if (!context?.isAuthenticated || context.tenantMismatch) {
    return { status: 401, body: { error: 'Authentication required' } };
  }
  if (!context.tenantId) return { status: 400, body: { error: 'Tenant context required' } };
  if (typeof sourceRoleId !== 'string' || typeof targetRoleId !== 'string'
    || !UUID.test(sourceRoleId) || !UUID.test(targetRoleId)
    || sourceRoleId.toLowerCase() === targetRoleId.toLowerCase()) {
    return { status: 400, body: { error: 'Select two distinct valid roles' } };
  }
  let canManageTenantAdmin = !!context.tenantUserId;
  if (!context.tenantUserId) {
    if (!context.roleId) return { status: 403, body: { error: 'Role Management access required' } };
    const { data: actor, error } = await db.from('role')
      .select('excluded_features,is_tenant_admin').eq('id', context.roleId)
      .eq('tenant_id', context.tenantId).maybeSingle();
    if (error) return { status: 500, body: { error: 'Unable to verify Role Management access' } };
    const effectiveExclusions = [
      ...(Array.isArray(actor?.excluded_features) ? actor.excluded_features : []),
      ...(Array.isArray(context.memberExcludedFeatures) ? context.memberExcludedFeatures : []),
    ];
    if (!actor || isResourceExcluded(effectiveExclusions, 'admin.role-management')) {
      return { status: 403, body: { error: 'Role Management access required' } };
    }
    canManageTenantAdmin = actor.is_tenant_admin === true;
  }
  const { data, error } = await db.rpc('copy_role_access_settings', {
    p_tenant_id: context.tenantId,
    p_source_role_id: sourceRoleId,
    p_target_role_id: targetRoleId,
    p_can_manage_tenant_admin: canManageTenantAdmin,
  });
  if (error) {
    const known = {
      '22023': [400, 'Select two distinct valid roles'],
      P0002: [404, 'Role not found in this tenant'],
      '42501': [403, 'System roles cannot be targets; tenant-admin settings require tenant-admin authority'],
    }[error.code];
    return { status: known?.[0] || 500, body: { error: known?.[1] || 'Access settings were not copied. No changes were saved; please retry.' } };
  }
  if (!data?.id) return { status: 500, body: { error: 'Copy returned no role; refresh before retrying' } };
  return { status: 200, body: { role: data } };
}
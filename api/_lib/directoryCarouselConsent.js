export const PRIMARY_CAROUSEL_SETTINGS = Object.freeze({
  'primary-member': 'member_directory_public_carousel_enabled',
  'primary-organization': 'org_directory_public_carousel_enabled',
});

const primaryKeys = new Set(Object.values(PRIMARY_CAROUSEL_SETTINGS));

// Generic entity writes must not bypass the dedicated primary consent service.
// A public dynamic source also requires an administrator for changes to its
// inclusion rules, entity type, or activation, not just the consent checkbox.
export async function authorizeCarouselConsentWrite({
  entity, method, body = {}, id, context, db, hasAdminAccess,
}) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return null;
  if (entity === 'systemsettings') {
    if (primaryKeys.has(body.setting_key)) {
      return { status: 403, error: 'Public carousel permission must be managed through directory settings' };
    }
    if (id && context?.tenantId) {
      const { data, error } = await db.from('system_settings').select('setting_key')
        .eq('tenant_id', context.tenantId).eq('id', id).maybeSingle();
      if (error) return { status: 503, error: 'Unable to validate directory settings' };
      if (primaryKeys.has(data?.setting_key)) {
        return { status: 403, error: 'Public carousel permission must be managed through directory settings' };
      }
    }
  }
  if (entity !== 'dynamicdirectory') return null;
  const supplied = Object.prototype.hasOwnProperty.call(body, 'public_carousel_enabled');
  if (supplied && typeof body.public_carousel_enabled !== 'boolean') {
    return { status: 400, error: 'Public carousel permission must be a boolean' };
  }
  let wasPublic = false;
  if (id && context?.tenantId) {
    // '*' is deliberate: older schemas have no consent column and remain off.
    const { data, error } = await db.from('dynamic_directory').select('*')
      .eq('tenant_id', context.tenantId).eq('id', id).maybeSingle();
    if (error) return { status: 503, error: 'Unable to validate directory settings' };
    wasPublic = data?.public_carousel_enabled === true;
  }
  if (supplied || wasPublic) {
    if (!context?.isAuthenticated) return { status: 401, error: 'Authentication required' };
    if (!await hasAdminAccess(context)) {
      return { status: 403, error: 'Only administrators can manage public carousel permission or public carousel sources' };
    }
  }
  return null;
}

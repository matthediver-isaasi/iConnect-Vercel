import { supabase } from '../_lib/database.js';
import { getSessionTenantUser } from '../_lib/session.js';
import { getTenantContext, hasAdminAccess } from '../_lib/tenantContext.js';
import { clearTenantCache } from '../_lib/tenantResolver.js';
import { isResourceExcluded } from '../_lib/roleVisibility.js';

const REDIRECT_MANAGEMENT_FEATURE = 'admin.redirect-management';
const SETTING_KEY = 'redirect_unknown_pages_to_homepage';
const MAX_UPDATE_ATTEMPTS = 3;

async function authorizeRedirectSettings(req, dependencies) {
  const context = await dependencies.getTenantContext(req);
  if (!context?.isAuthenticated) return { status: 401, error: 'Unauthorized' };
  if (context.tenantMismatch || !context.tenantId) {
    return { status: 403, error: 'Tenant access denied' };
  }

  const tenantUser = await dependencies.getSessionTenantUser(req);
  const tenantId = context.tenantId;
  if (tenantUser) {
    if (!['owner', 'admin', 'super_admin'].includes(tenantUser.role)) {
      return { status: 403, error: 'Redirect management admin access is required' };
    }
    const tenantUserTenantId = tenantUser._sessionTenantId || tenantUser.tenant_id;
    if (!tenantUserTenantId || tenantUserTenantId !== tenantId) {
      return { status: 403, error: 'Tenant access denied' };
    }
  } else if (!(await dependencies.hasAdminAccess(context))) {
    return { status: 403, error: 'Redirect management admin access is required' };
  }

  const exclusions = Array.isArray(context.memberExcludedFeatures)
    ? [...context.memberExcludedFeatures]
    : [];
  if (context.roleId) {
    const { data: role, error } = await dependencies.supabase
      .from('role')
      .select('excluded_features')
      .eq('id', context.roleId)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (error) throw new Error(`Unable to verify redirect management access: ${error.message}`);
    if (Array.isArray(role?.excluded_features)) exclusions.push(...role.excluded_features);
  }

  if (dependencies.isResourceExcluded(exclusions, REDIRECT_MANAGEMENT_FEATURE)) {
    return { status: 403, error: 'Redirect management has been disabled for your role' };
  }

  return { tenantId };
}

async function loadTenant(database, tenantId) {
  const { data, error } = await database
    .from('tenant')
    .select('id, settings, updated_at, slug, domain')
    .eq('id', tenantId)
    .single();
  if (error || !data) throw new Error(error?.message || 'Tenant not found');
  return data;
}

async function updateSettingWithRetry(database, tenantId, enabled) {
  for (let attempt = 0; attempt < MAX_UPDATE_ATTEMPTS; attempt += 1) {
    const tenant = await loadTenant(database, tenantId);
    const settings = tenant.settings && typeof tenant.settings === 'object' && !Array.isArray(tenant.settings)
      ? tenant.settings
      : {};
    const updatedAt = new Date().toISOString();
    let update = database
      .from('tenant')
      .update({
        settings: { ...settings, [SETTING_KEY]: enabled },
        updated_at: updatedAt,
      })
      .eq('id', tenantId);
    update = tenant.updated_at == null
      ? update.is('updated_at', null)
      : update.eq('updated_at', tenant.updated_at);
    const { data, error } = await update
      .select('settings, slug, domain')
      .maybeSingle();
    if (error) throw error;
    if (data) return data;
  }
  throw new Error('Tenant settings changed at the same time. Please try again.');
}

export function createRedirectSettingsHandler(overrides = {}) {
  const dependencies = {
    supabase,
    getSessionTenantUser,
    getTenantContext,
    hasAdminAccess,
    clearTenantCache,
    isResourceExcluded,
    ...overrides,
  };

  return async function redirectSettingsHandler(req, res) {
    res.setHeader('Cache-Control', 'private, no-store, max-age=0');
    if (!['GET', 'PUT'].includes(req.method)) {
      res.setHeader('Allow', 'GET, PUT');
      return res.status(405).json({ error: 'Method not allowed' });
    }
    if (!dependencies.supabase) {
      return res.status(503).json({ error: 'Database not configured' });
    }

    try {
      const authorization = await authorizeRedirectSettings(req, dependencies);
      if (authorization.error) {
        return res.status(authorization.status).json({ error: authorization.error });
      }

      if (req.method === 'GET') {
        const tenant = await loadTenant(dependencies.supabase, authorization.tenantId);
        return res.json({
          redirect_unknown_pages_to_homepage: tenant.settings?.[SETTING_KEY] === true,
        });
      }

      const enabled = req.body?.redirect_unknown_pages_to_homepage;
      if (typeof enabled !== 'boolean') {
        return res.status(400).json({
          error: 'redirect_unknown_pages_to_homepage must be a boolean',
        });
      }

      const tenant = await updateSettingWithRetry(
        dependencies.supabase,
        authorization.tenantId,
        enabled,
      );
      if (tenant.slug) dependencies.clearTenantCache(tenant.slug);
      if (tenant.domain) dependencies.clearTenantCache(tenant.domain);

      return res.json({
        success: true,
        redirect_unknown_pages_to_homepage: tenant.settings?.[SETTING_KEY] === true,
      });
    } catch (error) {
      console.error('[Redirect Settings] Failed:', error);
      return res.status(500).json({ error: error.message || 'Failed to update redirect settings' });
    }
  };
}

export default createRedirectSettingsHandler();
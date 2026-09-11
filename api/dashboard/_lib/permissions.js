import { supabase } from '../../_lib/database.js';
import { getTenantContext } from '../../_lib/tenantContext.js';
import { isResourceExcluded } from '../../_lib/roleVisibility.js';

/**
 * Resolve the current member, their tenant context and the dashboard
 * permissions they hold. Returns null when no authenticated member is found.
 *
 * permissions:
 *   - view              -> can see the dashboard at all
 *   - manageShared      -> can create/edit/delete shared widgets
 *   - managePersonal    -> can create/edit/delete personal widgets
 */
export async function getDashboardActor(req) {
  const ctx = await getTenantContext(req);
  if (!ctx?.isAuthenticated || !ctx.memberId) {
    return null;
  }

  let excludedFeatures = [];
  if (ctx.roleId && supabase) {
    try {
      const { data: role } = await supabase
        .from('role')
        .select('excluded_features')
        .eq('id', ctx.roleId)
        .single();
      excludedFeatures = role?.excluded_features || [];
    } catch (err) {
      console.error('[Dashboard Permissions] Failed to load role:', err);
    }
  }

  const view = !isResourceExcluded(excludedFeatures, 'dashboard.view');
  const manageShared = view && !isResourceExcluded(
    excludedFeatures,
    'dashboard.shared-widgets.manage',
  );
  const managePersonal = view && !isResourceExcluded(
    excludedFeatures,
    'dashboard.personal-widgets.manage',
  );

  return {
    tenantId: ctx.tenantId,
    memberId: ctx.memberId,
    organizationId: ctx.organizationId,
    roleId: ctx.roleId,
    permissions: { view, manageShared, managePersonal },
  };
}

export function tenantFilter(query, tenantId) {
  if (tenantId) {
    return query.eq('tenant_id', tenantId);
  }
  // single-tenant deployments: tenant_id is null on rows; match nulls so
  // shared/personal widgets stay scoped within that single tenant.
  return query.is('tenant_id', null);
}

/**
 * Canvas dashboard blocks opt into the dashboard API explicitly.  This is
 * intentionally narrower than the other embed signals used by public
 * endpoints: a Canvas block must ask for the dashboard's shared-widget
 * contract with ?embed=canvas.
 */
export function isCanvasDashboardEmbed(req) {
  const value = req?.query?.embed;
  if (Array.isArray(value)) {
    return value.some(item => typeof item === 'string' && item.toLowerCase() === 'canvas');
  }
  return typeof value === 'string' && value.toLowerCase() === 'canvas';
}

/**
 * Do not rely solely on the database filter when handling a Canvas
 * reference.  Keeping this check beside tenantFilter means a forged row (or
 * an incorrectly mocked/changed query) cannot turn a personal or
 * cross-tenant widget into an embeddable one.
 */
export function isSharedTenantWidget(widget, actor) {
  if (!widget || widget.scope !== 'shared' || !actor) return false;
  if (actor.tenantId) return widget.tenant_id === actor.tenantId;
  return widget.tenant_id === null || widget.tenant_id === undefined;
}

/**
 * Canvas responses contain tenant data and must never be cached by a browser,
 * CDN, or intermediary.  Set this before authentication/database checks so
 * denied responses are not cached either.
 */
export function setCanvasDashboardNoStore(req, res) {
  if (isCanvasDashboardEmbed(req)) {
    res.setHeader('Cache-Control', 'private, no-store');
  }
}

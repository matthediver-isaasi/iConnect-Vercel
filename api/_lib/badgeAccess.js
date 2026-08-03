// Badge library write authorization (Task #3282).
//
// Badge rows are a tenant-wide library managed on /BadgeManagement, which is
// gated by the `admin.badges` RBAC key. Server-side, writes must be allowed
// for exactly the people who can use that page:
//   - tenant users (admin dashboard sessions) always may write;
//   - members may write only when their role is NOT excluded from
//     `admin.badges` (deny-list model — no role row/exclusion means allowed).
// Reads stay open to authenticated tenant members so future surfaces can
// display badges.
import { hasFeatureAccess } from './tenantContext.js';

export const BADGE_FEATURE_KEY = 'admin.badges';

/**
 * Decide whether the current tenant context may create/update/delete badges.
 *
 * @param {Object} tenantCtx - context from getTenantContext()
 * @param {Object} [deps] - injectable for tests: { hasFeatureAccess }
 * @returns {Promise<{ok: boolean, status?: number, error?: string}>}
 */
export async function checkBadgeWriteAccess(tenantCtx, deps = {}) {
  const checkFeature = deps.hasFeatureAccess || hasFeatureAccess;

  if (!tenantCtx || !tenantCtx.isAuthenticated) {
    return { ok: false, status: 401, error: 'Authentication required' };
  }

  // Tenant users (admin dashboard) always have access.
  if (tenantCtx.tenantUserId) {
    return { ok: true };
  }

  // Members: gate on the admin.badges RBAC key for their role.
  const allowed = await checkFeature(tenantCtx.roleId, BADGE_FEATURE_KEY);
  if (!allowed) {
    return { ok: false, status: 403, error: 'Badge Management access required' };
  }
  return { ok: true };
}

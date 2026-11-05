import { buildRoleAccessOverlay, isResourceExcluded } from './roleVisibility.js';
import { makeFeatureAccessChecker } from './memberFeatureAccess.js';

// Both page and metadata reads use the same authority. The context resolver,
// not request filters or headers, owns the tenant identity.
export async function requireCrmListAccess(db, ctx, feature) {
  if (!ctx?.isAuthenticated) throw Object.assign(new Error('Unauthorized'), { status: 401 });
  if (!ctx.tenantId || ctx.tenantMismatch) throw Object.assign(new Error('Invalid tenant context'), { status: 403 });
  if (ctx.isSuperAdmin || (ctx.tenantUserId && !ctx.memberId)) return;
  if (!ctx.memberId || !ctx.roleId) throw Object.assign(new Error('Forbidden'), { status: 403 });
  const [{ data: role, error }, { data: overlay, error: overlayError }] = await Promise.all([
    db.from('role').select('excluded_features').eq('id', ctx.roleId).eq('tenant_id', ctx.tenantId).single(),
    db.from('role_access_item').select('id, item_key, item_type, parent_id, is_active'),
  ]);
  if (error || !role || overlayError || !Array.isArray(overlay)) throw Object.assign(new Error('Cannot verify CRM permissions'), { status: 503 });
  const exclusions = [...(role.excluded_features || []), ...(ctx.memberExcludedFeatures || [])];
  // Check the canonical map plus the DB overlay without mutating the shared
  // process cache (another request may belong to another tenant).
  const map = buildRoleAccessOverlay(overlay);
  const checker = makeFeatureAccessChecker(exclusions);
  const pending = [feature];
  const seen = new Set();
  while (pending.length) {
    const key = pending.pop();
    if (!key || seen.has(key)) continue;
    if (checker.isFeatureExcluded(key) || isResourceExcluded(exclusions, key)) throw Object.assign(new Error('Forbidden'), { status: 403 });
    seen.add(key);
    pending.push(map?.featureToPage.get(key), map?.resourceToModule.get(key));
  }
}

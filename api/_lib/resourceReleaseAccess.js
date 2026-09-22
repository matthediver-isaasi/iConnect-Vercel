import { applyResourceReleaseFilter, resourceReleaseFilter } from '../../shared/resourceRelease.js';
import { isResourceExcluded } from './roleVisibility.js';

// Management is an explicit read context, never inferred from category access.
// Authority mirrors resource update/delete: tenant admins or active group admins.
// Inject the existing admin verifier rather than importing database singletons.
export async function applyResourceReadReleaseScope({ query, req, ctx, db, hasAdminAccess, now = Date.now() }) {
  if (req.query?.resource_context !== 'management' ||
      !ctx?.isAuthenticated || !ctx.tenantId || ctx.tenantMismatch) {
    return { query: applyResourceReleaseFilter(query, now) };
  }
  const tenantId = ctx.effectiveTenantId || ctx.tenantId;
  query = query.eq('tenant_id', tenantId);
  const excluded = ctx.memberExcludedFeatures || [];
  if ((ctx.tenantUserId || !isResourceExcluded(excluded, 'admin.role-management')) &&
      await hasAdminAccess(ctx)) return { query };
  if (!ctx.memberId) return { query: applyResourceReleaseFilter(query, now) };
  const { data: assignments, error } = await db.from('member_group_assignment')
    .select('group_id, expires_at, is_group_admin').eq('member_id', ctx.memberId);
  if (error) throw error;
  const ids = [...new Set((assignments || []).filter(a =>
    a.is_group_admin === true && a.group_id &&
    (!a.expires_at || Date.parse(a.expires_at) > new Date(now).getTime())
  ).map(a => a.group_id))];
  if (!ids.length) return { query: applyResourceReleaseFilter(query, now) };
  const { data: groups, error: groupError } = await db.from('member_group')
    .select('id, is_active').eq('tenant_id', tenantId).in('id', ids);
  if (groupError) throw groupError;
  const allowed = (groups || []).filter(g => g.is_active !== false)
    .map(g => g.id).filter(id => /^[0-9a-f-]{36}$/i.test(id));
  if (!allowed.length) return { query: applyResourceReleaseFilter(query, now) };
  // Supabase builders are thenables. Wrap them so this async authorization
  // function does not execute the resource query before the caller adds paging.
  return { query: query.or(`${resourceReleaseFilter(now)},member_group_id.in.(${allowed.join(',')})`) };
}
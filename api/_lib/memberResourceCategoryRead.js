// This join table has no tenant_id. Always authorize through its owning member,
// including for tenant admins; an admin role is not a cross-tenant grant.
// Empty embedded projection keeps the existing category response shape.
export const MEMBER_RESOURCE_CATEGORY_SELECT = '*,category_owner:member!inner()';

export function scopeMemberResourceCategoryRead(query, context, isAdmin) {
  const tenantId = context?.effectiveTenantId || context?.tenantId;
  if (!context?.isAuthenticated || !tenantId || (!isAdmin && !context.memberId)) {
    return { error: { status: 403, message: 'Invalid member category access context' } };
  }
  query = query.eq('category_owner.tenant_id', tenantId);
  if (!isAdmin) query = query.eq('member_id', context.memberId);
  return { query };
}
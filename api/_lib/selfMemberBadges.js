export async function loadActiveSelfBadges(database, context) {
  if (!context?.isAuthenticated) {
    return { status: 401, error: 'Authentication required' };
  }
  if (!context.tenantId || !context.memberId) {
    return { status: 403, error: 'Member context required' };
  }

  const { data, error } = await database
    .from('member_badge')
    .select('badge:badge_id!inner(id, name, description, image_url, is_active)')
    .eq('tenant_id', context.tenantId)
    .eq('member_id', context.memberId)
    .is('revoked_at', null)
    .eq('badge.is_active', true);
  if (error) throw error;

  const badges = (data || [])
    .map((row) => row.badge)
    .filter((badge) => badge?.id && badge.is_active !== false);
  return { status: 200, badges };
}
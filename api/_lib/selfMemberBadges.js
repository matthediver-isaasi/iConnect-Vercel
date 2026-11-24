import { resolveMemberBadgeEvents } from './memberBadgeEvents.js';

export async function loadActiveSelfBadges(database, context) {
  if (!context?.isAuthenticated) {
    return { status: 401, error: 'Authentication required' };
  }
  if (!context.tenantId || !context.memberId) {
    return { status: 403, error: 'Member context required' };
  }

  const { data, error } = await database
    .from('member_badge')
    .select('id, badge_id, awarded_at, source, source_ref, badge:badge_id!inner(id, name, description, image_url, is_active)')
    .eq('tenant_id', context.tenantId)
    .eq('member_id', context.memberId)
    .is('revoked_at', null)
    .eq('badge.is_active', true);
  if (error) throw error;

  const rows = (data || []).filter(row => row.badge?.id && row.badge.is_active !== false);
  const events = await resolveMemberBadgeEvents(database, {
    tenantId: context.tenantId, memberId: context.memberId, awards: rows,
  });
  const badges = rows.map(row => ({
    ...row.badge,
    awarded_at: row.awarded_at || null,
    speaker_events: events.get(row.id) || [],
  }));
  return { status: 200, badges };
}
// Task #3285: what was granted (or skipped, and why) for a started event's
// speaker awards. Shown in the event editors after the event starts.
import { supabase } from '../_lib/database.js';
import { getTenantContext, hasAdminAccess } from '../_lib/tenantContext.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!supabase) {
    return res.status(500).json({ error: 'Database not configured' });
  }

  const ctx = await getTenantContext(req);
  if (!ctx?.tenantId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const isAdmin = await hasAdminAccess(ctx);
  if (!isAdmin) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const eventId = req.query.event_id;
  const eventType = req.query.event_type;
  if (!eventId || !['event', 'complex_event'].includes(eventType)) {
    return res.status(400).json({ error: 'event_id and event_type (event|complex_event) are required' });
  }

  try {
    const { data, error } = await supabase
      .from('speaker_award_grant')
      .select('id, speaker_id, speaker_name, member_id, organization_id, status, voucher_id, voucher_value, badge_id, member_badge_id, detail, created_at')
      .eq('tenant_id', ctx.tenantId)
      .eq('event_type', eventType)
      .eq('event_id', eventId)
      .order('created_at', { ascending: true });
    if (error) throw new Error(error.message);

    // Resolve badge names for display.
    const badgeIds = [...new Set((data || []).map(g => g.badge_id).filter(Boolean))];
    const badgeNames = {};
    if (badgeIds.length > 0) {
      const { data: badges } = await supabase
        .from('badge')
        .select('id, name')
        .in('id', badgeIds)
        .eq('tenant_id', ctx.tenantId);
      (badges || []).forEach(b => { badgeNames[b.id] = b.name; });
    }

    return res.status(200).json({
      grants: (data || []).map(g => ({ ...g, badge_name: g.badge_id ? (badgeNames[g.badge_id] || null) : null })),
    });
  } catch (err) {
    console.error('[admin/speaker-award-grants]', err.message);
    return res.status(500).json({ error: 'Failed to load speaker award grants' });
  }
}

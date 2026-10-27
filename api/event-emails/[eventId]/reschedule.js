import { supabase } from '../../_lib/database.js';
import { scheduleRemindersForEvent } from '../../_lib/scheduleReminders.js';
import { getTenantContext, hasAdminAccess } from '../../_lib/tenantContext.js';

export default async function handler(req, res) {
  if (!supabase) {
    return res.status(500).json({ error: 'Database not configured' });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { eventId } = req.query;
  if (!eventId) {
    return res.status(400).json({ error: 'Event ID is required' });
  }

  try {
    const ctx = await getTenantContext(req);
    if (!ctx.isAuthenticated) return res.status(401).json({ error: 'Authentication required' });
    if (!ctx.tenantId || !await hasAdminAccess(ctx)) return res.status(403).json({ error: 'Admin access required' });
    let found = false;
    for (const table of ['event', 'complex_event']) {
      const { data, error } = await supabase.from(table).select('id').eq('id', eventId)
        .eq('tenant_id', ctx.tenantId).maybeSingle();
      if (error) throw error;
      if (data) { found = true; break; }
    }
    if (!found) return res.status(404).json({ error: 'Event not found' });
    const { mode, requeued, bookingsScheduled, bookingsConsidered, schedulingFailures, skipped, error, preserved, cancelled } =
      await scheduleRemindersForEvent(eventId);

    return res.status(200).json({
      mode,
      requeued: requeued || 0,
      bookingsScheduled: bookingsScheduled || 0,
      bookingsConsidered: bookingsConsidered || 0,
      schedulingFailures: schedulingFailures || [],
      skipped: skipped || [],
      error: error || null,
      preserved: preserved || 0,
      cancelled: cancelled || 0,
    });
  } catch (err) {
    console.error('[event-emails/reschedule] Error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
}

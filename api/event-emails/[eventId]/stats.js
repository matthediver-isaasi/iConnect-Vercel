import { supabase } from '../../_lib/database.js';
import { getTenantContext, hasAdminAccess } from '../../_lib/tenantContext.js';
import { loadEventEmailStats, loadEventEmailRecipients, isDeliveryId } from '../../_lib/eventEmailDelivery.js';

// Read-only delivery stats for an event's email setups. Never sends, resends
// or re-queues anything.
export function createStatsHandler({ db = supabase, getContext = getTenantContext, isAdmin = hasAdminAccess } = {}) {
  return async function handler(req, res) {
    if (!db) return res.status(500).json({ error: 'Database not configured' });
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    const { eventId, emailId, page, pageSize } = req.query || {};
    if (!isDeliveryId(eventId)) return res.status(400).json({ error: 'Event ID is required' });
    if (emailId != null && !isDeliveryId(emailId)) return res.status(400).json({ error: 'Invalid email setting' });

    const ctx = await getContext(req);
    if (!ctx?.isAuthenticated) return res.status(401).json({ error: 'Authentication required' });
    if (!ctx.tenantId || !await isAdmin(ctx)) return res.status(403).json({ error: 'Admin access required' });

    try {
      let owned = false;
      for (const table of ['event', 'complex_event']) {
        const { data, error } = await db.from(table).select('id').eq('id', eventId)
          .eq('tenant_id', ctx.tenantId).maybeSingle();
        if (error) throw error;
        if (data) { owned = true; break; }
      }
      if (!owned) return res.status(404).json({ error: 'Event not found' });

      if (emailId) {
        const { data: setting, error } = await db.from('event_email').select('id')
          .eq('id', emailId).eq('event_id', eventId).maybeSingle();
        if (error) throw error;
        if (!setting) return res.status(404).json({ error: 'Email setting not found' });
        const list = await loadEventEmailRecipients(db, ctx.tenantId, eventId, emailId, { page, pageSize });
        return res.status(200).json(list);
      }

      const stats = await loadEventEmailStats(db, ctx.tenantId, eventId);
      return res.status(200).json(stats);
    } catch (err) {
      console.error('[event-emails/stats] Error:', err?.message || err);
      return res.status(500).json({ error: 'Unable to load delivery stats' });
    }
  };
}

export default createStatsHandler();

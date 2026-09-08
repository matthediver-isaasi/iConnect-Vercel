import crypto from 'crypto';
import { supabase } from '../_lib/database.js';
import { getTenantContext, hasAdminAccess } from '../_lib/tenantContext.js';

const TYPES = { simple: 'event', complex: 'complex_event' };

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!supabase) return res.status(503).json({ error: 'Database not configured' });
  const context = await getTenantContext(req);
  if (!context?.tenantId || !context.isAuthenticated) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!(await hasAdminAccess(context))) {
    return res.status(403).json({ error: 'Event administrator permission is required' });
  }
  const eventType = TYPES[String(req.body?.event_type || '')];
  const eventId = String(req.body?.event_id || '');
  const triggerType = String(req.body?.trigger || '');
  const reason = String(req.body?.reason || '').trim();
  const bookingIds = req.body?.booking_ids == null ? null : req.body.booking_ids;
  if (!eventType || !eventId || !['registration', 'attendance'].includes(triggerType)) {
    return res.status(400).json({ error: 'A valid event, event type, and trigger are required' });
  }
  if (!reason || reason.length > 500) {
    return res.status(400).json({ error: 'A replay reason of at most 500 characters is required' });
  }
  if (bookingIds !== null && (!Array.isArray(bookingIds) || bookingIds.length > 1000
    || bookingIds.some(id => !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(id))))) {
    return res.status(400).json({ error: 'booking_ids must contain at most 1000 UUIDs' });
  }
  const replayId = crypto.randomUUID();
  const actor = context.tenantUserId
    ? `tenant_user:${context.tenantUserId}` : `member:${context.memberId}`;
  const { data, error } = await supabase.rpc('enqueue_event_cpd_points_replay', {
    p_tenant_id: context.tenantId,
    p_event_type: eventType,
    p_event_id: eventId,
    p_trigger_type: triggerType,
    p_replay_id: replayId,
    p_booking_ids: bookingIds,
    p_reason: reason,
    p_actor: actor,
  });
  if (error) {
    const validation = /event does not belong|complete replay|replay reason/i.test(error.message || '');
    return res.status(validation ? 400 : 500).json({
      error: validation ? error.message : 'Failed to enqueue CPD points replay',
    });
  }
  return res.status(202).json({ replay_id: replayId, enqueued_count: data || 0 });
}
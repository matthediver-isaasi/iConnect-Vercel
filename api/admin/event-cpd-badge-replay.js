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
  if (!eventType || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(eventId)) {
    return res.status(400).json({ error: 'A valid saved event and event type are required' });
  }
  const replayId = crypto.randomUUID();
  const actor = context.tenantUserId
    ? `tenant_user:${context.tenantUserId}` : `member:${context.memberId}`;
  const { data, error } = await supabase.rpc('enqueue_event_cpd_badge_replay', {
    p_tenant_id: context.tenantId,
    p_event_type: eventType,
    p_event_id: eventId,
    p_replay_id: replayId,
    p_actor: actor,
  });
  if (error) {
    const validation = /event does not belong|complete replay scope/i.test(error.message || '');
    return res.status(validation ? 400 : 500).json({
      error: validation ? error.message : 'Failed to queue CPD badge sync',
    });
  }
  return res.status(202).json({ replay_id: replayId, enqueued_count: data || 0 });
}
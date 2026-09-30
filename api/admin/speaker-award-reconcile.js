// Reconciles assignment-time speaker badges after an event editor save.
// POST { event_type: "event"|"complex_event", event_id, revoke_removed?: bool }
// The plural route also accepts the frontend contract:
// { action: "reconcile"|"remove", revoke_badge?: bool }. Speaker ids are
// deliberately not trusted; current event/agenda/session rows are authoritative.
import { supabase } from '../_lib/database.js';
import { getTenantContext, hasAdminAccess } from '../_lib/tenantContext.js';
import { collectSpeakerIds } from '../cron/grant-speaker-awards.js';
import { reconcileAssignmentSpeakerBadges } from '../_lib/speakerAwards.js';

export function createSpeakerAwardReconcileHandler({
  db = supabase,
  tenantContext = getTenantContext,
  adminAccess = hasAdminAccess,
  reconcile = reconcileAssignmentSpeakerBadges,
  collectIds = collectSpeakerIds,
} = {}) {
  return async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    if (!db) return res.status(500).json({ error: 'Database not configured' });
    const ctx = await tenantContext(req);
    if (!ctx?.tenantId) return res.status(401).json({ error: 'Unauthorized' });
    if (!await adminAccess(ctx)) return res.status(403).json({ error: 'Forbidden' });
    const body = req.body || {};
    const { event_id: eventId, event_type: eventType } = body;
    const action = body.action;
    if (action !== undefined && !['reconcile', 'remove'].includes(action)) {
      return res.status(400).json({ error: 'action must be reconcile or remove' });
    }
    const revokeRemoved = body.revoke_removed === true || (action === 'remove' && body.revoke_badge === true);
    if (!eventId || !['event', 'complex_event'].includes(eventType)) {
      return res.status(400).json({ error: 'event_id and event_type (event|complex_event) are required' });
    }
    if (body.revoke_removed !== undefined && typeof body.revoke_removed !== 'boolean') return res.status(400).json({ error: 'revoke_removed must be a boolean' });
    if (body.revoke_badge !== undefined && typeof body.revoke_badge !== 'boolean') return res.status(400).json({ error: 'revoke_badge must be a boolean' });
    try {
      const table = eventType === 'event' ? 'event' : 'complex_event';
      const { data: event, error: eventError } = await db.from(table)
        .select('id, tenant_id, title, speaker_ids, speaker_award_config, status, event_state')
        .eq('id', eventId).eq('tenant_id', ctx.tenantId).maybeSingle();
      if (eventError) throw new Error(eventError.message);
      if (!event) return res.status(404).json({ error: 'Event not found' });
      const speakerIds = await collectIds(db, eventType, event);
      let speakers = [];
      if (speakerIds.length) {
        const { data, error } = await db.from('speaker').select('id, full_name, email, member_id')
          .eq('tenant_id', ctx.tenantId).in('id', speakerIds);
        if (error) throw new Error(`speaker fetch failed: ${error.message}`);
        speakers = data || [];
      }
      const summary = await reconcile(db, {
        eventType, event, speakers, revokeRemoved,
        actor: { type: 'admin', id: ctx.memberId || null, label: ctx.memberId ? 'Tenant administrator' : 'Tenant administrator' },
      });
      return res.status(200).json({ ok: true, ...summary });
    } catch (err) {
      console.error('[admin/speaker-award-reconcile]', err.message);
      return res.status(500).json({ error: 'Failed to reconcile speaker awards' });
    }
  };
}

export default createSpeakerAwardReconcileHandler();
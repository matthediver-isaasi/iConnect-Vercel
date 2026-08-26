import { supabase } from '../_lib/database.js';
import { getTenantContext, hasAdminAccess } from '../_lib/tenantContext.js';
import {
  syncTeamsAttendanceTarget,
  upsertTeamsAttendanceBinding,
} from '../_lib/teamsAttendanceService.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!supabase) return res.status(503).json({ error: 'Database not configured' });

  const context = await getTenantContext(req);
  if (!context?.tenantId || !context.isAuthenticated) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  if (!await hasAdminAccess(context)) return res.status(403).json({ error: 'Admin access required' });

  const {
    action = 'sync', eventId, sessionId = null, agendaItemId = null,
    connectionId, organiserMicrosoftUserId, onlineMeetingId, joinWebUrl,
  } = req.body || {};
  if (!eventId) return res.status(400).json({ error: 'eventId is required' });

  try {
    if (action === 'bind') {
      if (!connectionId || !organiserMicrosoftUserId || (!onlineMeetingId && !joinWebUrl)) {
        return res.status(400).json({
          error: 'connectionId, organiserMicrosoftUserId, and onlineMeetingId or joinWebUrl are required',
        });
      }
      const binding = await upsertTeamsAttendanceBinding({
        tenantId: context.tenantId, eventId, sessionId, agendaItemId, connectionId,
        organiserMicrosoftUserId, onlineMeetingId, joinWebUrl,
      });
      return res.json({
        success: true,
        binding: {
          id: binding.id, targetType: binding.target_type, targetId: binding.target_id,
          onlineMeetingId: binding.online_meeting_id,
        },
      });
    }
    if (action !== 'sync') return res.status(400).json({ error: 'action must be bind or sync' });
    // A report-level manual sync supplies only eventId. Fan out across every
    // tenant-owned binding for that event so complex sessions and training
    // agenda targets are refreshed alongside simple event targets.
    if (!sessionId && !agendaItemId) {
      const { data: bindings, error: bindingsError } = await supabase
        .from('teams_attendance_binding')
        .select('target_type, target_id')
        .eq('tenant_id', context.tenantId)
        .eq('event_id', eventId)
        .eq('enabled', true);
      if (bindingsError) throw new Error(`Unable to load Teams attendance targets: ${bindingsError.message}`);
      if (!bindings?.length) throw new Error('Teams attendance binding not found');
      const settled = await Promise.allSettled(bindings.map((binding) => syncTeamsAttendanceTarget(context.tenantId, {
        eventId,
        sessionId: binding.target_type === 'complex_event_session' ? binding.target_id : null,
        agendaItemId: binding.target_type === 'agenda_item' ? binding.target_id : null,
      })));
      const results = settled.map((item, index) => item.status === 'fulfilled'
        ? { ...item.value, targetType: bindings[index].target_type, targetId: bindings[index].target_id }
        : { success: false, targetType: bindings[index].target_type, targetId: bindings[index].target_id, error: item.reason?.message || 'Sync failed' });
      const pending = results.some((result) => result.pending);
      const failed = results.filter(result => !result.success && !result.pending);
      const errors = failed.map(result => ({
        targetType: result.targetType,
        targetId: result.targetId,
        code: result.errorCode || null,
        error: result.error || 'Teams attendance sync failed',
      }));
      return res.status(pending ? 202 : 200).json({
        success: failed.length === 0,
        pending,
        participantCount: results.reduce((sum, result) => sum + (result.participantCount || 0), 0),
        matchedCount: results.reduce((sum, result) => sum + (result.matchedCount || 0), 0),
        targetCount: results.length,
        failedCount: failed.length,
        errors,
        partial: failed.length > 0 && results.some(result => result.success),
        results,
      });
    }
    const result = await syncTeamsAttendanceTarget(context.tenantId, {
      eventId, sessionId, agendaItemId,
    });
    return res.status(result.pending ? 202 : 200).json(result);
  } catch (error) {
    const status = error.code === 'connection_boundary' || error.code === 'consent_required'
      ? 403
      : (/not found/i.test(error.message) ? 404 : 400);
    return res.status(status).json({ error: error.message, code: error.code || null });
  }
}
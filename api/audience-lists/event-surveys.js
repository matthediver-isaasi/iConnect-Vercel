import { getTenantContext, hasAdminAccess } from '../_lib/tenantContext.js';
import { supabase } from '../_lib/database.js';
import { audienceRows, assignmentColumns, validateEventSurveyScope, eventSurveyEvidence } from '../_lib/eventSurveyAudience.js';

export default async function handler(req, res, dependencies = {}) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const context = await (dependencies.getTenantContext || getTenantContext)(req);
    if (!context.isAuthenticated || !context.tenantId) return res.status(401).json({ error: 'Authentication required' });
    if (!await (dependencies.hasAdminAccess || hasAdminAccess)(context)) return res.status(403).json({ error: 'Admin access required' });
    const db = dependencies.supabase || supabase;
    const { event_id: eventId, event_type: eventType } = req.query || {};
    if ((eventId || eventType) && (!eventId || !['event', 'complex_event'].includes(eventType))) {
      return res.status(400).json({ error: 'event_id and event_type (event or complex_event) are required together' });
    }
    const assignments = await audienceRows(() => {
      let query = db.from('event_survey_assignment').select(assignmentColumns).eq('tenant_id', context.tenantId);
      if (eventId) query = query.eq('event_type', eventType).eq(eventType === 'complex_event' ? 'complex_event_id' : 'event_id', eventId);
      return query;
    }, 'Event survey assignments');
    if (!eventId) {
      const events = new Map();
      for (const assignment of assignments) {
        const type = assignment.event_type;
        const id = type === 'complex_event' ? assignment.complex_event_id : assignment.event_id;
        if (!id || !['event', 'complex_event'].includes(type) || events.has(`${type}:${id}`)) continue;
        const { data, error } = await db.from(type).select('id, title').eq('tenant_id', context.tenantId).eq('id', id).maybeSingle();
        if (error) throw new Error('Event survey events could not be loaded');
        if (data) events.set(`${type}:${id}`, { id, event_id: id, event_type: type, event_title: data.title, title: data.title });
      }
      return res.json([...events.values()]);
    }
    const result = [];
    for (const assignment of assignments) {
      const { data: form, error } = await db.from('form').select('id, name, form_type, survey_settings')
        .eq('tenant_id', context.tenantId).eq('id', assignment.form_id).maybeSingle();
      if (error) throw new Error('Survey names could not be loaded');
      let reason = null;
      let noResponseReason = null;
      let title = assignment.event_title;
      try {
        if (!form || form.form_type !== 'survey') throw new Error('Survey form is missing or inaccessible');
        const scope = await validateEventSurveyScope(db, context.tenantId, {
          form_id: form.id, survey_assignment_id: assignment.id, event_id: eventId, event_type: eventType, received: true,
        }, form);
        title = scope.event.title;
        await eventSurveyEvidence(db, context.tenantId, scope, { requireComplete: false });
        try {
          await eventSurveyEvidence(db, context.tenantId, scope, { requireComplete: true });
        } catch (err) {
          noResponseReason = err.message;
        }
      } catch (err) {
        reason = err.message;
        noResponseReason = reason;
      }
      result.push({ id: assignment.id, form_id: assignment.form_id, survey_name: form?.name || 'Unavailable survey',
        event_id: eventId, event_type: eventType, event_title: title, status: assignment.status,
        created_date: assignment.created_date, supported: !reason, unsupported_reason: reason,
        no_response_supported: !noResponseReason, no_response_unsupported_reason: noResponseReason });
    }
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
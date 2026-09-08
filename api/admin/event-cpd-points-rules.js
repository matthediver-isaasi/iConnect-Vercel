import { supabase } from '../_lib/database.js';
import { getTenantContext, hasAdminAccess } from '../_lib/tenantContext.js';
import { detectEventCpdAttendanceCapabilities } from '../_lib/eventCpdAttendanceCapabilities.js';

const EVENT_TYPES = new Set(['simple', 'complex']);
const DB_EVENT_TYPE = { simple: 'event', complex: 'complex_event' };
const TRIGGERS = new Set(['registration', 'attendance']);
const DECIMAL_POINTS = /^(?:0|[1-9]\d{0,13})(?:\.\d{1,6})?$/;

async function authorize(req, res) {
  const context = await getTenantContext(req);
  if (!context?.tenantId || !context.isAuthenticated) {
    res.status(401).json({ error: 'Unauthorized' });
    return null;
  }
  if (!(await hasAdminAccess(context))) {
    res.status(403).json({ error: 'Event administrator permission is required' });
    return null;
  }
  return context;
}

async function loadEvent(tenantId, eventType, eventId) {
  const table = eventType === 'complex' ? 'complex_event' : 'event';
  const { data, error } = await supabase.from(table).select('id,pricing_config')
    .eq('id', eventId).eq('tenant_id', tenantId).maybeSingle();
  if (error) throw error;
  return data;
}

export default async function handler(req, res) {
  if (!['GET', 'PUT'].includes(req.method)) {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!supabase) return res.status(500).json({ error: 'Database not configured' });
  const context = await authorize(req, res);
  if (!context) return;
  const eventType = String(req.method === 'GET' ? req.query?.event_type : req.body?.event_type || '');
  const eventId = String(req.method === 'GET' ? req.query?.event_id || '' : req.body?.event_id || '');
  if (!EVENT_TYPES.has(eventType)) {
    return res.status(400).json({ error: 'event_type must be simple or complex' });
  }

  try {
    if (!eventId) return res.status(400).json({ error: 'event_id is required' });
    const event = await loadEvent(context.tenantId, eventType, eventId);
    if (!event) return res.status(404).json({ error: 'Event not found' });
    if (req.method === 'GET') {
      const attendanceCapabilities = await detectEventCpdAttendanceCapabilities(supabase);
      const { data, error } = await supabase.from('event_cpd_points_rule').select('*')
        .eq('tenant_id', context.tenantId).eq('event_id', eventId)
        .eq('event_type', DB_EVENT_TYPE[eventType]).eq('active', true);
      if (error) throw error;
      return res.status(200).json({
        rules: (data || []).map(rule => ({
          ...rule,
          points_value: rule.points_value == null ? null : String(rule.points_value),
          scope: rule.ticket_id ? 'ticket' : 'event',
          ticket_class_id: rule.ticket_id,
          ticket_reference: rule.ticket_id,
          trigger: rule.trigger_type,
          no_award: rule.is_no_award === true,
          points: rule.points_value == null ? null : String(rule.points_value),
        })),
        attendance_capabilities: attendanceCapabilities,
      });
    }

    const rules = Array.isArray(req.body?.rules) ? req.body.rules : null;
    if (!rules || rules.length > 501) {
      return res.status(400).json({ error: 'rules must be an array of at most 501 items' });
    }
    if (rules.filter(rule => rule?.scope === 'event').length > 1) {
      return res.status(400).json({ error: 'Only one event-wide points rule is allowed' });
    }
    let validTicketIds;
    if (eventType === 'complex') {
      const { data, error } = await supabase.from('complex_event_ticket_class').select('id')
        .eq('complex_event_id', eventId).eq('tenant_id', context.tenantId);
      if (error) throw error;
      validTicketIds = new Set((data || []).map(ticket => String(ticket.id)));
    } else {
      validTicketIds = new Set((event.pricing_config?.ticket_classes || [])
        .map(ticket => String(ticket.id)));
    }
    const seenTickets = new Set();
    const rows = rules.map(rule => {
      if (!rule || !['event', 'ticket'].includes(rule.scope)) {
        throw new Error('Each points rule requires a valid scope');
      }
      if (!TRIGGERS.has(rule.trigger)) throw new Error('Each points rule requires a valid trigger');
      const noAward = rule.no_award === true;
      if (rule.scope === 'event' && noAward) {
        throw new Error('The event-wide points rule cannot be a no-award rule');
      }
      const rawPoints = String(rule.points ?? rule.points_value ?? '');
      if (!noAward && !DECIMAL_POINTS.test(rawPoints)) {
        throw new Error('Points must be a non-negative decimal with at most 6 decimal places');
      }
      const reference = rule.scope === 'ticket'
        ? String(rule.ticket_class_id || rule.ticket_reference || '') : null;
      if (rule.scope === 'ticket') {
        if (!reference || !validTicketIds.has(reference)) {
          throw new Error('A points override references a ticket that does not belong to this event');
        }
        if (seenTickets.has(reference)) throw new Error('Only one points override is allowed per ticket');
        seenTickets.add(reference);
      }
      return {
        tenant_id: context.tenantId,
        event_type: DB_EVENT_TYPE[eventType],
        event_id: eventId,
        trigger_type: rule.trigger,
        ticket_id: reference,
        ticket_name_snapshot: rule.scope === 'ticket'
          ? String(rule.ticket_name_snapshot || '').slice(0, 250) || null : null,
        points_value: noAward ? null : rawPoints,
        is_no_award: noAward,
      };
    });
    const { data, error } = await supabase.rpc('replace_event_cpd_points_rules', {
      p_tenant_id: context.tenantId,
      p_event_type: DB_EVENT_TYPE[eventType],
      p_event_id: eventId,
      p_rules: rows,
    });
    if (error) throw error;
    return res.status(200).json({
      rules: (data || []).map(rule => ({
        ...rule,
        points_value: rule.points_value == null ? null : String(rule.points_value),
      })),
    });
  } catch (error) {
    const validation = /^(Each |Only |The event|A points|Points |invalid CPD|at most |event does not|complex event does not|ticket does not|no-award)/i
      .test(error.message || '');
    console.error('[event-cpd-points-rules]', error.message);
    return res.status(validation ? 400 : 500).json({
      error: validation ? error.message : (req.method === 'GET'
        ? 'Failed to load CPD points rules' : 'Failed to save CPD points rules'),
    });
  }
}

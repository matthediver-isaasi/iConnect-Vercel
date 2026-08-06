// Guarded cost-line endpoint for the Event Budget Report.
//
// The report page views/adds/deletes actual cost lines (event_cost_line)
// through this endpoint instead of the generic entity API so that the
// operations are gated by the report's own RBAC key
// (events.event-budget-report) in addition to admin access.
import { supabase } from '../_lib/database.js';
import { checkBudgetReportAccess } from './event-budget-report.js';

async function eventBelongsToTenant(eventId, eventKind, tenantId) {
  const table = eventKind === 'complex' ? 'complex_event' : 'event';
  const { data, error } = await supabase
    .from(table)
    .select('id')
    .eq('id', eventId)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (error) throw error;
  return !!data;
}

export default async function handler(req, res) {
  if (!supabase) {
    return res.status(503).json({ error: 'Supabase not configured' });
  }

  const tenantCtx = await checkBudgetReportAccess(req, res);
  if (!tenantCtx) return;
  const tenantId = tenantCtx.tenantId;

  try {
    if (req.method === 'GET') {
      const { event_id: eventId, event_kind: eventKind } = req.query;
      if (!eventId || !['simple', 'complex'].includes(eventKind)) {
        return res.status(400).json({ error: 'event_id and event_kind (simple|complex) are required' });
      }
      const { data, error } = await supabase
        .from('event_cost_line')
        .select('*')
        .eq('tenant_id', tenantId)
        .eq('event_id', eventId)
        .eq('event_kind', eventKind)
        .order('created_at', { ascending: true });
      if (error) throw error;
      return res.json({ costLines: data || [] });
    }

    if (req.method === 'POST') {
      const { event_id: eventId, event_kind: eventKind, description, cost_type: costType, quantity, unit_cost: unitCost } = req.body || {};
      if (!eventId || !['simple', 'complex'].includes(eventKind)) {
        return res.status(400).json({ error: 'event_id and event_kind (simple|complex) are required' });
      }
      if (!description || !String(description).trim()) {
        return res.status(400).json({ error: 'description is required' });
      }
      if (!(await eventBelongsToTenant(eventId, eventKind, tenantId))) {
        return res.status(404).json({ error: 'Event not found' });
      }
      const { data, error } = await supabase
        .from('event_cost_line')
        .insert({
          tenant_id: tenantId,
          event_id: eventId,
          event_kind: eventKind,
          description: String(description).trim(),
          cost_type: costType ? String(costType).trim() : null,
          quantity: Number(quantity) || 0,
          unit_cost: Number(unitCost) || 0,
        })
        .select()
        .single();
      if (error) throw error;
      return res.status(201).json({ costLine: data });
    }

    if (req.method === 'DELETE') {
      const { id } = req.query;
      if (!id) {
        return res.status(400).json({ error: 'id is required' });
      }
      const { data, error } = await supabase
        .from('event_cost_line')
        .delete()
        .eq('id', id)
        .eq('tenant_id', tenantId)
        .select('id');
      if (error) throw error;
      if (!data || data.length === 0) {
        return res.status(404).json({ error: 'Cost line not found' });
      }
      return res.json({ success: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[Event Budget Report cost lines] error:', err);
    return res.status(500).json({ error: 'Failed to process cost line request' });
  }
}

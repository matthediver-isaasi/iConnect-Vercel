// Batched, lightweight agenda summaries for Training event cards.
// Returns { [event_id]: [{ start_date, end_date, start_time, item_type, sort_order }] }
// — dates + type label only, never Zoom/LMS links or locations (those stay
// gated behind bookings in /api/public/event-agenda).
//
// Visibility: anonymous callers only get agendas for events visible on the
// public list (non-group or public group events, published/tbc). A logged-in
// member of the tenant also gets draft + group training events (the
// member/admin list shows those).

import { supabase } from '../_lib/database.js';
import { resolveTenantFromRequest } from '../_lib/tenantResolver.js';
import { getSessionMember } from '../_lib/session.js';

const MAX_IDS = 100;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!supabase) return res.status(503).json({ error: 'Supabase not configured' });

  const raw = String(req.query.event_ids || '').trim();
  if (!raw) return res.status(400).json({ error: 'event_ids is required' });
  const ids = [...new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))].slice(0, MAX_IDS);
  if (ids.length === 0) return res.status(400).json({ error: 'event_ids is required' });

  try {
    const tenant = await resolveTenantFromRequest(req);
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

    // Is the viewer a member of this tenant? Failures resolve to anonymous.
    let isTenantMember = false;
    try {
      const member = await getSessionMember(req);
      const memberTenantId = member?.tenant_id || member?.organization?.tenant_id || null;
      isTenantMember = !!member && memberTenantId === tenant.id;
    } catch {
      isTenantMember = false;
    }

    let eventQuery = supabase
      .from('event')
      .select('id')
      .in('id', ids)
      .eq('tenant_id', tenant.id)
      .eq('is_training', true)
      .neq('status', 'immediate');
    if (!isTenantMember) {
      eventQuery = eventQuery
        .in('status', ['published', 'tbc'])
        .or('member_group_id.is.null,group_event_public.is.true');
    }
    const { data: visibleEvents, error: eventsError } = await eventQuery;
    if (eventsError) {
      console.error('[EventAgendaSummaries] events query error:', eventsError);
      return res.status(500).json({ error: 'Failed to load events' });
    }

    const visibleIds = (visibleEvents || []).map((e) => e.id);
    const result = {};
    if (visibleIds.length > 0) {
      const { data: lines, error: linesError } = await supabase
        .from('event_agenda_item')
        .select('event_id, start_date, end_date, start_time, item_type, sort_order')
        .in('event_id', visibleIds)
        .eq('tenant_id', tenant.id)
        .order('start_date', { ascending: true })
        .order('start_time', { ascending: true, nullsFirst: true })
        .order('sort_order', { ascending: true });
      if (linesError) {
        console.error('[EventAgendaSummaries] agenda query error:', linesError);
        return res.status(500).json({ error: 'Failed to load agenda' });
      }
      for (const l of lines || []) {
        if (!result[l.event_id]) result[l.event_id] = [];
        result[l.event_id].push({
          start_date: l.start_date,
          end_date: l.end_date || null,
          start_time: l.start_time || null,
          item_type: l.item_type || null,
          sort_order: l.sort_order ?? null,
        });
      }
    }

    return res.status(200).json(result);
  } catch (err) {
    console.error('[EventAgendaSummaries] error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

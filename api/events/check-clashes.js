import { supabase } from '../_lib/database.js';
import { getTenantContext, hasAdminAccess } from '../_lib/tenantContext.js';
import { getCallerGroupEventsAccess } from '../_lib/memberGroupEventsAccess.js';
import { loadAgendaItemTypes, clashIncludedTypeNames } from '../_lib/agendaItemTypes.js';
import { fromZonedTime } from 'date-fns-tz';
import { parseISO } from 'date-fns';

const DEFAULT_TIMEZONE = 'Europe/London';

// Parse a stored or submitted date/time into a real Date.
// Values that carry an explicit UTC offset (or trailing Z) are absolute;
// offset-less values are interpreted in the supplied timezone (mirrors the
// editors, where complex-event session times are stored offset-less).
function toDate(value, tz) {
  if (!value) return null;
  if (value instanceof Date) {
    return isNaN(value.getTime()) ? null : value;
  }
  if (typeof value !== 'string') {
    const d = new Date(value);
    return isNaN(d.getTime()) ? null : d;
  }
  const hasOffset = value.endsWith('Z') || /[+-]\d{2}:?\d{2}$/.test(value);
  let d;
  try {
    d = hasOffset ? parseISO(value) : fromZonedTime(value, tz || DEFAULT_TIMEZONE);
  } catch {
    return null;
  }
  return d && !isNaN(d.getTime()) ? d : null;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!supabase) {
    return res.status(503).json({ error: 'Supabase not configured' });
  }

  let context;
  try {
    context = await getTenantContext(req);
  } catch (err) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  if (!context?.isAuthenticated || !context?.tenantId) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  // Clash results expose other events' titles/times (incl. group-private events).
  // Tenant admins get the full detailed list. Group admins (members carrying the
  // per-assignment is_group_admin flag on an events-enabled group) are warned
  // that a clash exists but get NO identifying details — a redacted count only.
  // Everyone else gets 403; the client helper treats that as "no clashes" so
  // their save is never blocked.
  const isAdmin = await hasAdminAccess(context);
  let redacted = false;
  if (!isAdmin) {
    const access = await getCallerGroupEventsAccess(req);
    const isGroupAdmin = !access?.error && Array.isArray(access?.groups) && access.groups.length > 0;
    if (!isGroupAdmin) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    redacted = true;
  }

  const tenantId = context.tenantId;

  try {
    const { windows, excludeEventId, excludeComplexEventId } = req.body || {};
    const rawWindows = Array.isArray(windows) ? windows : [];

    // Normalise the windows we are checking into absolute ms ranges.
    const ranges = [];
    for (const w of rawWindows) {
      if (!w || !w.start || !w.end) continue;
      const s = toDate(w.start, w.timezone);
      const e = toDate(w.end, w.timezone);
      if (!s || !e) continue;
      const startMs = s.getTime();
      const endMs = e.getTime();
      if (!(endMs > startMs)) continue;
      ranges.push({ startMs, endMs, label: w.label || null });
    }

    if (ranges.length === 0) {
      if (redacted) {
        return res.json({ hasClashes: false, redacted: true, clashCount: 0, clashes: [] });
      }
      return res.json({ hasClashes: false, clashes: [] });
    }

    // Returns the labels of every window the given range overlaps.
    const overlapsAny = (sMs, eMs) => {
      const hits = [];
      for (const r of ranges) {
        if (sMs < r.endMs && eMs > r.startMs) hits.push(r.label);
      }
      return hits;
    };

    const clashes = [];
    const groupIds = new Set();

    // --- Simple events ---
    // Only real, scheduled events count: dates present, not draft, not TBC.
    let eventQuery = supabase
      .from('event')
      .select('id, title, start_date, end_date, timezone, member_group_id, event_state, status, is_complex, is_training')
      .eq('tenant_id', tenantId)
      .not('start_date', 'is', null)
      .not('end_date', 'is', null)
      .neq('status', 'draft')
      .neq('status', 'tbc')
      .neq('event_state', 'draft');
    if (excludeEventId) {
      eventQuery = eventQuery.neq('id', excludeEventId);
    }

    const { data: events, error: evErr } = await eventQuery;
    if (evErr) {
      console.error('[check-clashes] event query failed:', evErr.message);
      return res.status(500).json({ error: 'Failed to check clashes' });
    }

    // --- Training events: one whole-day window per clash-included agenda line ---
    // A Training event's event-level start/end merely spans its agenda, so it
    // must NOT contribute an event-level window (that would make excluded
    // types, e.g. Self study, trigger clashes anyway).
    const trainingEvents = (events || []).filter((ev) => ev.is_training && !ev.is_complex);
    const trainingAgendaByEvent = {};
    if (trainingEvents.length > 0) {
      const { data: agendaRows, error: agErr } = await supabase
        .from('event_agenda_item')
        .select('id, event_id, start_date, start_time, end_date, end_time, description, item_type')
        .eq('tenant_id', tenantId)
        .in('event_id', trainingEvents.map((ev) => ev.id));
      if (agErr) {
        console.error('[check-clashes] agenda query failed:', agErr.message);
        return res.status(500).json({ error: 'Failed to check clashes' });
      }
      for (const row of (agendaRows || [])) {
        (trainingAgendaByEvent[row.event_id] = trainingAgendaByEvent[row.event_id] || []).push(row);
      }
    }
    const agendaTypes = trainingEvents.length > 0 ? await loadAgendaItemTypes(tenantId) : [];
    const includedTypeNames = clashIncludedTypeNames(agendaTypes);

    for (const ev of (events || [])) {
      // Defensive: complex events live in complex_event; never via the event row.
      if (ev.is_complex) continue;
      if (ev.is_training) {
        const lines = trainingAgendaByEvent[ev.id] || [];
        for (const line of lines) {
          const typeName = String(line.item_type || '').trim().toLowerCase();
          if (!includedTypeNames.has(typeName)) continue;
          if (!line.start_date) continue;
          const endDate = line.end_date || line.start_date;
          // Real agenda times when set (Task #3443); date-only rows keep the
          // whole-day window.
          const startTime = String(line.start_time || '').match(/^\d{2}:\d{2}/)?.[0] || '00:00';
          const endTime = String(line.end_time || '').match(/^\d{2}:\d{2}/)?.[0] || '23:59';
          const s = toDate(`${line.start_date}T${startTime}:00`, ev.timezone);
          const e = toDate(`${endDate}T${endTime}:59`, ev.timezone);
          if (!s || !e) continue;
          const hits = overlapsAny(s.getTime(), e.getTime());
          if (hits.length > 0) {
            if (ev.member_group_id) groupIds.add(ev.member_group_id);
            clashes.push({
              id: line.id,
              type: 'training_agenda_line',
              title: `${ev.title || 'Untitled event'} — ${line.item_type || 'Agenda'} (${line.start_date}${endDate !== line.start_date ? ` to ${endDate}` : ''})`,
              start: s.toISOString(),
              end: e.toISOString(),
              timezone: ev.timezone || DEFAULT_TIMEZONE,
              parentId: ev.id,
              parentTitle: ev.title || 'Untitled event',
              member_group_id: ev.member_group_id || null,
              windowLabels: hits.filter(Boolean),
            });
          }
        }
        continue;
      }
      const s = toDate(ev.start_date, ev.timezone);
      const e = toDate(ev.end_date, ev.timezone);
      if (!s || !e) continue;
      const hits = overlapsAny(s.getTime(), e.getTime());
      if (hits.length > 0) {
        if (ev.member_group_id) groupIds.add(ev.member_group_id);
        clashes.push({
          id: ev.id,
          type: 'event',
          title: ev.title || 'Untitled event',
          start: s.toISOString(),
          end: e.toISOString(),
          timezone: ev.timezone || DEFAULT_TIMEZONE,
          member_group_id: ev.member_group_id || null,
          windowLabels: hits.filter(Boolean),
        });
      }
    }

    // --- Complex events: compare per SESSION, not the overall span ---
    // Mirror the simple-event filters: legacy rows may carry the draft signal in
    // `status` rather than `event_state`, so exclude both representations.
    let ceQuery = supabase
      .from('complex_event')
      .select('id, title, timezone, member_group_id, event_state, status')
      .eq('tenant_id', tenantId)
      .neq('event_state', 'draft')
      .neq('status', 'draft')
      .neq('status', 'tbc');
    if (excludeComplexEventId) {
      ceQuery = ceQuery.neq('id', excludeComplexEventId);
    }

    const { data: complexEvents, error: ceErr } = await ceQuery;
    if (ceErr) {
      console.error('[check-clashes] complex_event query failed:', ceErr.message);
      return res.status(500).json({ error: 'Failed to check clashes' });
    }

    const complexById = {};
    for (const ce of (complexEvents || [])) complexById[ce.id] = ce;
    const complexIds = Object.keys(complexById);

    if (complexIds.length > 0) {
      const { data: sessions, error: sErr } = await supabase
        .from('complex_event_session')
        .select('id, title, start_time, end_time, complex_event_id, timezone')
        .eq('tenant_id', tenantId)
        .in('complex_event_id', complexIds)
        .not('start_time', 'is', null)
        .not('end_time', 'is', null);
      if (sErr) {
        console.error('[check-clashes] session query failed:', sErr.message);
        return res.status(500).json({ error: 'Failed to check clashes' });
      }

      for (const ses of (sessions || [])) {
        const parent = complexById[ses.complex_event_id];
        if (!parent) continue;
        const tz = ses.timezone || parent.timezone || DEFAULT_TIMEZONE;
        const s = toDate(ses.start_time, tz);
        const e = toDate(ses.end_time, tz);
        if (!s || !e) continue;
        const hits = overlapsAny(s.getTime(), e.getTime());
        if (hits.length > 0) {
          if (parent.member_group_id) groupIds.add(parent.member_group_id);
          clashes.push({
            id: ses.id,
            type: 'complex_session',
            title: ses.title || 'Untitled session',
            start: s.toISOString(),
            end: e.toISOString(),
            timezone: tz,
            parentId: parent.id,
            parentTitle: parent.title || 'Untitled event',
            member_group_id: parent.member_group_id || null,
            windowLabels: hits.filter(Boolean),
          });
        }
      }
    }

    // Resolve member-group names for any group-scoped clashes.
    const groupNameById = {};
    if (groupIds.size > 0) {
      const { data: groups, error: gErr } = await supabase
        .from('member_group')
        .select('id, name')
        .eq('tenant_id', tenantId)
        .in('id', [...groupIds]);
      if (!gErr) {
        for (const g of (groups || [])) groupNameById[g.id] = g.name;
      }
    }
    for (const c of clashes) {
      if (c.member_group_id) c.groupName = groupNameById[c.member_group_id] || null;
    }

    clashes.sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());

    // Redacted callers (group admins) only learn THAT a clash exists and how
    // many — never any titles, times, or group identities.
    if (redacted) {
      return res.json({
        hasClashes: clashes.length > 0,
        redacted: true,
        clashCount: clashes.length,
        clashes: [],
      });
    }

    return res.json({ hasClashes: clashes.length > 0, clashes });
  } catch (err) {
    console.error('[check-clashes] error:', err?.message || err);
    return res.status(500).json({ error: 'Failed to check clashes' });
  }
}

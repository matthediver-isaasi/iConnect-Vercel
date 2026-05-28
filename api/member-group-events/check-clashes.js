import { supabase } from '../_lib/database.js';
import { getCallerGroupEventsAccess } from '../_lib/memberGroupEventsAccess.js';

/**
 * POST /api/member-group-events/check-clashes
 * Body: { start, end, excludeEventId? }
 * Returns: { clashes: [{ id, kind, title, start, end, timezone, groupName?, parentTitle? }] }
 *
 * Tenant-scoped overlap check covering:
 *  - Other member group events (event rows with member_group_id NOT NULL)
 *  - Tenant single events (event rows with member_group_id IS NULL, is_complex=false)
 *  - Complex event sessions (each complex_event_session row)
 *
 * Excludes draft/cancelled rows. Parent complex_event rows themselves are skipped
 * in favour of their sessions (is_complex=true is filtered out at the event level).
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!supabase) return res.status(503).json({ error: 'Database not configured' });

  const access = await getCallerGroupEventsAccess(req);
  if (access.error) return res.status(access.status).json({ error: access.error });

  // Caller must have create rights on at least one group to run a clash check.
  // This endpoint discloses titles/times of other tenant events, so it must be
  // gated to users who actually schedule events.
  const hasCreateRights = (access.groups || []).some((g) => g.canCreate);
  if (!hasCreateRights) {
    return res.status(403).json({ error: 'Forbidden - event create permission required' });
  }

  const { start, end, excludeEventId } = req.body || {};
  if (!start || !end) {
    return res.status(400).json({ error: 'start and end are required' });
  }
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    return res.status(400).json({ error: 'start/end must be valid timestamps with end > start' });
  }
  const startIso = new Date(startMs).toISOString();
  const endIso = new Date(endMs).toISOString();
  const tenantId = access.tenantContext.tenantId;

  // 1) Overlapping events in the tenant (member group + main-stream single).
  //    Exclude parent complex events (is_complex=true) — we use their sessions instead.
  let eventQuery = supabase
    .from('event')
    .select('id, title, start_date, end_date, timezone, member_group_id, is_complex')
    .eq('tenant_id', tenantId)
    .eq('is_complex', false)
    .neq('status', 'draft')
    .not('event_state', 'in', '(draft,cancelled)')
    .lt('start_date', endIso)
    .gt('end_date', startIso);
  if (excludeEventId) eventQuery = eventQuery.neq('id', excludeEventId);
  const { data: eventRows, error: eventErr } = await eventQuery;
  if (eventErr) {
    console.error('[check-clashes] event lookup failed:', eventErr.message);
    return res.status(500).json({ error: 'Clash check failed' });
  }

  // Resolve group names for any member-group events in the result.
  const groupIds = [...new Set((eventRows || []).map((r) => r.member_group_id).filter(Boolean))];
  let groupNameById = new Map();
  if (groupIds.length > 0) {
    const { data: groups } = await supabase
      .from('member_group')
      .select('id, name')
      .eq('tenant_id', tenantId)
      .in('id', groupIds);
    (groups || []).forEach((g) => groupNameById.set(g.id, g.name));
  }

  // 2) Overlapping complex_event_session rows. Skip sessions whose parent
  //    complex_event is in draft status (not yet on the calendar).
  const { data: sessionRows, error: sessionErr } = await supabase
    .from('complex_event_session')
    .select('id, title, start_time, end_time, complex_event_id')
    .eq('tenant_id', tenantId)
    .not('start_time', 'is', null)
    .not('end_time', 'is', null)
    .lt('start_time', endIso)
    .gt('end_time', startIso);
  if (sessionErr) {
    console.error('[check-clashes] complex_event_session lookup failed:', sessionErr.message);
    return res.status(500).json({ error: 'Clash check failed' });
  }

  const complexEventIds = [...new Set((sessionRows || []).map((s) => s.complex_event_id).filter(Boolean))];
  let complexEventById = new Map();
  if (complexEventIds.length > 0) {
    const { data: complexEvents } = await supabase
      .from('complex_event')
      .select('id, title, timezone, status')
      .eq('tenant_id', tenantId)
      .in('id', complexEventIds);
    (complexEvents || []).forEach((ce) => complexEventById.set(ce.id, ce));
  }

  const clashes = [];

  for (const ev of eventRows || []) {
    if (ev.member_group_id) {
      clashes.push({
        id: ev.id,
        kind: 'member_group_event',
        title: ev.title,
        start: ev.start_date,
        end: ev.end_date,
        timezone: ev.timezone || null,
        groupName: groupNameById.get(ev.member_group_id) || null,
      });
    } else {
      clashes.push({
        id: ev.id,
        kind: 'event',
        title: ev.title,
        start: ev.start_date,
        end: ev.end_date,
        timezone: ev.timezone || null,
      });
    }
  }

  for (const s of sessionRows || []) {
    const parent = s.complex_event_id ? complexEventById.get(s.complex_event_id) : null;
    if (parent && parent.status === 'draft') continue;
    clashes.push({
      id: s.id,
      kind: 'complex_event_session',
      title: s.title,
      start: s.start_time,
      end: s.end_time,
      timezone: parent?.timezone || null,
      parentTitle: parent?.title || null,
    });
  }

  clashes.sort((a, b) => (a.start || '').localeCompare(b.start || ''));

  return res.json({ clashes });
}

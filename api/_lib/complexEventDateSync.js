import { fromZonedTime } from 'date-fns-tz';
import { parseISO } from 'date-fns';

const DEFAULT_TIMEZONE = 'Europe/London';

// Mirrors client toDateTz in CreateComplexEvent.jsx: ISO strings with a UTC
// offset (Z or +/-HH:MM) are parsed as-is; offset-less strings are interpreted
// in the event's timezone.
function toDateTz(dateStr, tz) {
  if (!dateStr) return null;
  if (typeof dateStr !== 'string') {
    const d = new Date(dateStr);
    return isNaN(d.getTime()) ? null : d;
  }
  const hasOffset = /[+-]\d{2}(:\d{2})?$/.test(dateStr) || dateStr.endsWith('Z');
  const d = hasOffset ? parseISO(dateStr) : fromZonedTime(dateStr, tz || DEFAULT_TIMEZONE);
  return d && !isNaN(d.getTime()) ? d : null;
}

/**
 * Recomputes complex_event.start_date / end_date from its sessions.
 *
 * Logic mirrors the client-side recompute in CreateComplexEvent.jsx:
 *   - earliest session start_time -> start_date
 *   - latest session end_time -> end_date
 *
 * Behavior:
 *   - If the event has status 'tbc', dates are left untouched.
 *   - If there are no sessions with usable times, dates are left untouched.
 *   - Errors are logged but never thrown to callers (best-effort).
 *
 * @param {object} supabase - Supabase client.
 * @param {string} complexEventId - Complex event ID.
 * @param {string} tenantId - Tenant ID; required to scope reads/writes and
 *   prevent cross-tenant mutation via a poisoned complex_event_id.
 * @returns {Promise<{updated: boolean, start_date?: string|null, end_date?: string|null, reason?: string}>}
 */
export async function recomputeComplexEventDates(supabase, complexEventId, tenantId) {
  if (!supabase || !complexEventId || !tenantId) {
    return { updated: false, reason: 'missing_args' };
  }

  try {
    const { data: event, error: eventErr } = await supabase
      .from('complex_event')
      .select('id, status, start_date, end_date, timezone')
      .eq('id', complexEventId)
      .eq('tenant_id', tenantId)
      .single();

    if (eventErr || !event) {
      console.error('[complexEventDateSync] event lookup failed:', eventErr?.message || 'not found');
      return { updated: false, reason: 'event_not_found' };
    }

    if (event.status === 'tbc') {
      return { updated: false, reason: 'tbc' };
    }

    const { data: sessions, error: sessErr } = await supabase
      .from('complex_event_session')
      .select('start_time, end_time')
      .eq('complex_event_id', complexEventId)
      .eq('tenant_id', tenantId);

    if (sessErr) {
      console.error('[complexEventDateSync] sessions query failed:', sessErr.message);
      return { updated: false, reason: 'sessions_query_failed' };
    }

    const tz = event.timezone || DEFAULT_TIMEZONE;
    const startTimes = [];
    const endTimes = [];
    for (const s of (sessions || [])) {
      const sd = toDateTz(s.start_time, tz);
      if (sd) startTimes.push(sd);
      const ed = toDateTz(s.end_time, tz);
      if (ed) endTimes.push(ed);
    }

    // Fall back to the other field if one side is missing, so events with
    // partial session data still produce sensible bounds.
    const startPool = startTimes.length > 0 ? startTimes : endTimes;
    const endPool = endTimes.length > 0 ? endTimes : startTimes;

    if (startPool.length === 0 || endPool.length === 0) {
      return { updated: false, reason: 'no_sessions' };
    }

    const earliest = new Date(Math.min(...startPool.map(d => d.getTime()))).toISOString();
    const latest = new Date(Math.max(...endPool.map(d => d.getTime()))).toISOString();

    if (event.start_date === earliest && event.end_date === latest) {
      return { updated: false, reason: 'unchanged', start_date: earliest, end_date: latest };
    }

    const { error: updateErr } = await supabase
      .from('complex_event')
      .update({ start_date: earliest, end_date: latest })
      .eq('id', complexEventId)
      .eq('tenant_id', tenantId);

    if (updateErr) {
      console.error('[complexEventDateSync] update failed:', updateErr.message);
      return { updated: false, reason: 'update_failed' };
    }

    return { updated: true, start_date: earliest, end_date: latest };
  } catch (err) {
    console.error('[complexEventDateSync] unexpected error:', err?.message || err);
    return { updated: false, reason: 'exception' };
  }
}

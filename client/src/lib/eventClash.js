// Build the clash-check windows for a save. Training events (Task #3419)
// contribute one window per agenda line whose type is included in clash
// checks — using the line's real start/end times when set (Task #3443),
// falling back to a whole-day window for date-only lines; everything else
// uses the event-level start/end span.

// Normalise 'HH:MM' / 'HH:MM:SS' to 'HH:MM'; '' when unset. Mirrors the
// server defaults in api/events/check-clashes.js (start 00:00, end 23:59).
function timeOfDay(value) {
  const m = String(value || '').match(/^(\d{2}:\d{2})/);
  return m ? m[1] : '';
}

export function buildClashWindows({ isTraining, agendaLines, agendaItemTypes, eventData, timezone, title }) {
  if (isTraining && Array.isArray(agendaLines) && agendaLines.length > 0) {
    const included = new Set(
      (agendaItemTypes || [])
        .filter((t) => t.includeInClashChecks !== false)
        .map((t) => String(t.name).trim().toLowerCase())
    );
    return agendaLines
      .filter((l) => l.start_date && included.has(String(l.item_type || '').trim().toLowerCase()))
      .map((l) => ({
        start: `${l.start_date}T${timeOfDay(l.start_time) || '00:00'}:00`,
        end: `${l.end_date || l.start_date}T${timeOfDay(l.end_time) || '23:59'}:59`,
        timezone,
        label: title ? `${title} — ${l.item_type || 'Agenda'} ${l.start_date}` : null,
      }));
  }
  if (eventData?.start_date && eventData?.end_date) {
    return [{ start: eventData.start_date, end: eventData.end_date, timezone, label: title }];
  }
  return [];
}

// Tenant-scoped event time-clash check.
// This is an advisory warning aid only — it must NEVER block saving. If the
// request fails for any reason we report "no clashes" so the save proceeds.
export async function checkEventClashes({ windows, excludeEventId = null, excludeComplexEventId = null }) {
  try {
    const resp = await fetch('/api/events/check-clashes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ windows, excludeEventId, excludeComplexEventId }),
    });
    if (!resp.ok) {
      return { hasClashes: false, clashes: [], redacted: false, clashCount: 0, error: true };
    }
    const data = await resp.json();
    const clashes = Array.isArray(data?.clashes) ? data.clashes : [];
    return {
      hasClashes: data?.hasClashes === true,
      clashes,
      // Group admins get a redacted result: a clash count only, no details.
      redacted: data?.redacted === true,
      clashCount: typeof data?.clashCount === 'number' ? data.clashCount : clashes.length,
    };
  } catch (err) {
    console.error('[checkEventClashes] failed:', err);
    return { hasClashes: false, clashes: [], redacted: false, clashCount: 0, error: true };
  }
}

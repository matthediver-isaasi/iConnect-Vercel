export const now = new Date('2026-10-27T12:00:00Z');
export function fixture() {
  return {
    event: [{ id: 'event', tenant_id: 'tenant', is_training: true, timezone: 'Europe/London', title: 'Introduction to Advice', start_date: '2026-10-26T00:00:00Z' }],
    event_email: [{ id: 'email', event_id: 'event', email_type: 'reminder', is_enabled: true, timing_type: '1_day_before', subject: '{{event_date}}', body: '{{event_time}} {{zoom_link}} {{agenda_line_date}} {{agenda_schedule}}' }],
    event_agenda_item: [
      { id: 'moodle', event_id: 'event', start_date: '2026-10-26', item_type: 'Moodle' },
      { id: 'nov3', event_id: 'event', start_date: '2026-11-03', start_time: '09:15:00', item_type: 'Online', zoom_meeting_id: 'zoom3' },
      { id: 'nov5', event_id: 'event', start_date: '2026-11-05', start_time: '09:15:00', item_type: 'Online', zoom_meeting_id: 'zoom5' },
    ],
    booking: [{ id: 'booking', event_id: 'event', attendee_email: 'fixture@example.test', status: 'confirmed' }],
    zoom_meeting: [{ id: 'zoom3', join_url: 'https://example.test/nov3' }, { id: 'zoom5', join_url: 'https://example.test/nov5' }],
    scheduled_email: [],
  };
}

export function fakeClient(tables, { missingTrainingSnapshot = false } = {}) {
  let next = 0;
  return { from(table) {
    let filters = [], payload, insert, lo = 0, hi = Infinity, single = false, missingColumn = false;
    const q = {
      select(columns = '') { missingColumn = missingTrainingSnapshot && columns.includes('training_target_snapshot'); return q; }, order() { return q; },
      eq(k, v) { filters.push(r => r[k] === v); return q; },
      neq(k, v) { filters.push(r => r[k] !== v); return q; },
      is(k, v) { filters.push(r => (r[k] ?? null) === v); return q; },
      in(k, vs) { filters.push(r => vs.includes(r[k])); return q; },
      lte(k, v) { filters.push(r => r[k] <= v); return q; },
      range(a, b) { lo = a; hi = b + 1; return q; },
      limit(n) { hi = n; return q; },
      single() { single = true; return q; }, maybeSingle() { single = true; return q; },
      update(p) { payload = p; return q; },
      insert(p) { insert = p; return q; },
      then(ok, bad) {
        if (missingColumn) return Promise.resolve({ data: null, error: { code: '42703', message: 'column does not exist' } }).then(ok, bad);
        const all = tables[table] ||= [];
        let rows = all.filter(r => filters.every(f => f(r))).slice(lo, hi);
        let error = null;
        if (insert) {
          if (table === 'scheduled_email' && all.some(r => r.booking_id === insert.booking_id &&
            r.event_email_id === insert.event_email_id && (insert.follow_up_target_key != null
              ? r.follow_up_target_key === insert.follow_up_target_key
              : r.follow_up_target_key == null && (r.session_id ?? null) === (insert.session_id ?? null)))) {
            error = { code: '23505', message: 'Duplicate target' }; rows = [];
          } else { const row = { id: `row${next++}`, ...insert }; all.push(row); rows = [row]; }
        }
        if (payload) rows.forEach(r => Object.assign(r, payload));
        return Promise.resolve({ data: single ? rows[0] || null : rows.map(r => ({ ...r })), error }).then(ok, bad);
      },
    };
    return q;
  } };
}

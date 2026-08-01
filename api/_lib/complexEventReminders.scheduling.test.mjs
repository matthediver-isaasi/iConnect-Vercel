import test from 'node:test';
import assert from 'node:assert/strict';
import { scheduleComplexEventReminders } from './complexEventReminders.js';

// Minimal fake of the supabase-js query builder covering the calls the
// scheduler makes: complex_event, complex_event_session,
// complex_event_session_track, complex_event_ticket_class, scheduled_email.
function makeFakeSupabase({ event, sessions, junctions, ticketClasses }) {
  const scheduledRows = [];

  function builder(table) {
    const filters = [];
    const chain = {
      select() { return chain; },
      eq(col, val) { filters.push({ op: 'eq', col, val }); return chain; },
      is(col, val) { filters.push({ op: 'is', col, val }); return chain; },
      in(col, vals) { filters.push({ op: 'in', col, vals }); return chain; },
      order() { return chain; },
      maybeSingle() {
        const rows = resolve();
        return Promise.resolve({ data: rows[0] || null, error: null });
      },
      insert(row) {
        scheduledRows.push(row);
        return Promise.resolve({ error: null });
      },
      then(onFulfilled, onRejected) {
        return Promise.resolve({ data: resolve(), error: null }).then(onFulfilled, onRejected);
      }
    };
    function resolve() {
      let rows;
      if (table === 'complex_event') rows = [event];
      else if (table === 'complex_event_session') rows = sessions;
      else if (table === 'complex_event_session_track') rows = junctions;
      else if (table === 'complex_event_ticket_class') rows = ticketClasses;
      else if (table === 'scheduled_email') rows = scheduledRows;
      else rows = [];
      return rows.filter(r => filters.every(f => {
        if (f.op === 'eq') return r[f.col] === f.val;
        if (f.op === 'is') return r[f.col] === f.val || (f.val === null && r[f.col] == null);
        if (f.op === 'in') return f.vals.includes(r[f.col]);
        return true;
      }));
    }
    return chain;
  }

  return { from: builder, scheduledRows };
}

const farFuture = (day, hour) => `2099-09-0${day}T${String(hour).padStart(2, '0')}:00:00Z`;

function fixture() {
  return makeFakeSupabase({
    event: { id: 'ev1', timezone: 'UTC' },
    sessions: [
      { id: 's1', complex_event_id: 'ev1', title: 'D1 AM', start_time: farFuture(1, 9) },
      { id: 's2', complex_event_id: 'ev1', title: 'D1 PM', start_time: farFuture(1, 14) },
      { id: 's3', complex_event_id: 'ev1', title: 'D2', start_time: farFuture(2, 10) },
      { id: 's4', complex_event_id: 'ev1', title: 'D3', start_time: farFuture(3, 9) }
    ],
    junctions: [],
    ticketClasses: [{ id: 'tc1', complex_event_id: 'ev1', all_tracks: true, linked_track_ids: [] }]
  });
}

const relReminder = { id: 'em1', timing_type: '1_day_before' };
const absReminder = {
  id: 'em2', timing_type: 'custom', custom_unit: 'specific_datetime',
  custom_send_at: '2099-08-01T00:00:00Z'
};

test('3-day event with same-day sessions gets exactly one relative reminder per day', async () => {
  const fake = fixture();
  await scheduleComplexEventReminders({
    supabase: fake, bookingId: 'b1', eventId: 'ev1',
    attendeeEmail: 'a@b.c', ticketClassId: 'tc1',
    reminderEmails: [relReminder, absReminder]
  });

  const rel = fake.scheduledRows.filter(r => r.event_email_id === 'em1');
  const abs = fake.scheduledRows.filter(r => r.event_email_id === 'em2');
  assert.equal(rel.length, 3, 'one relative reminder per day');
  assert.deepEqual(rel.map(r => r.session_id), ['s1', 's3', 's4']);
  // anchored 24h before the earliest session of each day
  assert.equal(rel[0].scheduled_send_time, new Date(Date.parse(farFuture(1, 9)) - 86400000).toISOString());
  assert.equal(abs.length, 1, 'absolute reminder once per booking');
  assert.equal(abs[0].session_id, null);
});

test('re-running scheduling creates no duplicate rows', async () => {
  const fake = fixture();
  const args = {
    supabase: fake, bookingId: 'b1', eventId: 'ev1',
    attendeeEmail: 'a@b.c', ticketClassId: 'tc1',
    reminderEmails: [relReminder, absReminder]
  };
  await scheduleComplexEventReminders(args);
  const countAfterFirst = fake.scheduledRows.length;
  await scheduleComplexEventReminders(args);
  assert.equal(fake.scheduledRows.length, countAfterFirst);
});

test('track filtering restricts days to accessible sessions', async () => {
  const fake = makeFakeSupabase({
    event: { id: 'ev1', timezone: 'UTC' },
    sessions: [
      { id: 's1', complex_event_id: 'ev1', title: 'D1', start_time: farFuture(1, 9) },
      { id: 's2', complex_event_id: 'ev1', title: 'D2', start_time: farFuture(2, 9) }
    ],
    junctions: [
      { complex_event_session_id: 's1', complex_event_track_id: 't1' },
      { complex_event_session_id: 's2', complex_event_track_id: 't2' }
    ],
    ticketClasses: [{ id: 'tc1', complex_event_id: 'ev1', all_tracks: false, linked_track_ids: ['t1'] }]
  });
  await scheduleComplexEventReminders({
    supabase: fake, bookingId: 'b1', eventId: 'ev1',
    attendeeEmail: 'a@b.c', ticketClassId: 'tc1',
    reminderEmails: [relReminder]
  });
  assert.equal(fake.scheduledRows.length, 1);
  assert.equal(fake.scheduledRows[0].session_id, 's1');
});

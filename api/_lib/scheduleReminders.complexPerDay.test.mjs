import test from 'node:test';
import assert from 'node:assert/strict';
import { scheduleComplexEventReminderEmails } from './scheduleReminders.js';

// Fake supabase client covering the calls the bulk rescheduling path makes.
function makeFakeSupabase({ event, sessions, junctions, reminderEmails, bookings, ticketClasses }) {
  const scheduledRows = [];
  let nextId = 1;

  function builder(table) {
    const filters = [];
    let updatePayload = null;
    const chain = {
      select() { return chain; },
      eq(col, val) { filters.push(r => r[col] === val); return chain; },
      neq(col, val) { filters.push(r => r[col] !== val); return chain; },
      is(col, val) { filters.push(r => (val === null ? r[col] == null : r[col] === val)); return chain; },
      in(col, vals) { filters.push(r => vals.includes(r[col])); return chain; },
      order() { return chain; },
      limit() { return chain; },
      maybeSingle() {
        return Promise.resolve({ data: resolve()[0] || null, error: null });
      },
      insert(row) {
        scheduledRows.push({ id: `se${nextId++}`, ...row });
        return Promise.resolve({ error: null });
      },
      update(payload) {
        updatePayload = payload;
        return chain;
      },
      then(onF, onR) {
        if (updatePayload) {
          for (const row of resolve()) Object.assign(row, updatePayload);
          return Promise.resolve({ error: null }).then(onF, onR);
        }
        return Promise.resolve({ data: resolve(), error: null }).then(onF, onR);
      }
    };
    function resolve() {
      let rows;
      if (table === 'complex_event') rows = [event];
      else if (table === 'complex_event_session') rows = sessions;
      else if (table === 'complex_event_session_track') rows = junctions;
      else if (table === 'event_email') rows = reminderEmails;
      else if (table === 'booking') rows = bookings;
      else if (table === 'complex_event_ticket_class') rows = ticketClasses;
      else if (table === 'scheduled_email') rows = scheduledRows;
      else rows = [];
      return rows.filter(r => filters.every(f => f(r)));
    }
    return chain;
  }
  return { from: builder, scheduledRows };
}

const t = (day, hour) => `2099-09-0${day}T${String(hour).padStart(2, '0')}:00:00Z`;

function fixture() {
  return makeFakeSupabase({
    event: { id: 'ev1', timezone: 'UTC' },
    sessions: [
      { id: 's1', complex_event_id: 'ev1', title: 'D1 AM', start_time: t(1, 9) },
      { id: 's2', complex_event_id: 'ev1', title: 'D1 PM', start_time: t(1, 14) },
      { id: 's3', complex_event_id: 'ev1', title: 'D2 A', start_time: t(2, 10) },
      { id: 's4', complex_event_id: 'ev1', title: 'D2 B', start_time: t(2, 15) },
      { id: 's5', complex_event_id: 'ev1', title: 'D3', start_time: t(3, 9) }
    ],
    junctions: [],
    reminderEmails: [
      { id: 'em1', event_id: 'ev1', email_type: 'reminder', is_enabled: true, timing_type: '1_day_before' }
    ],
    bookings: [
      { id: 'b1', event_id: 'ev1', attendee_email: 'a@b.c', ticket_class_id: 'tc1', status: 'confirmed' }
    ],
    ticketClasses: [{ id: 'tc1', complex_event_id: 'ev1', all_tracks: true, linked_track_ids: [] }]
  });
}

test('rescheduling path schedules one relative reminder per day, not per session', async () => {
  const fake = fixture();
  const result = await scheduleComplexEventReminderEmails('ev1', fake);
  assert.equal(result.error, undefined);
  assert.equal(fake.scheduledRows.length, 3, 'one per calendar day for 5 sessions across 3 days');
  assert.deepEqual(fake.scheduledRows.map(r => r.session_id), ['s1', 's3', 's5']);
  assert.equal(result.requeued, 3);
  assert.equal(result.bookingsScheduled, 1);
});

test('re-running after rows exist updates in place — no duplicates', async () => {
  const fake = fixture();
  await scheduleComplexEventReminderEmails('ev1', fake);
  const result2 = await scheduleComplexEventReminderEmails('ev1', fake);
  assert.equal(fake.scheduledRows.length, 3, 'row count unchanged after rescheduling');
  assert.equal(result2.requeued, 3, 'existing rows re-touched (updated), not duplicated');
  assert.ok(fake.scheduledRows.every(r => r.status === 'pending'));
});

test('legacy per-session rows are cancelled; only the day anchor stays pending', async () => {
  const fake = fixture();
  // Seed legacy rows created by the former per-session scheduler:
  // two sessions on day 1 -> two pending rows.
  fake.scheduledRows.push(
    { id: 'legacy1', event_email_id: 'em1', booking_id: 'b1', attendee_email: 'a@b.c', session_id: 's1', status: 'pending' },
    { id: 'legacy2', event_email_id: 'em1', booking_id: 'b1', attendee_email: 'a@b.c', session_id: 's2', status: 'pending' }
  );
  await scheduleComplexEventReminderEmails('ev1', fake);
  const pending = fake.scheduledRows.filter(r => r.status === 'pending');
  assert.deepEqual(pending.map(r => r.session_id).sort(), ['s1', 's3', 's5'], 'one pending row per day, anchored to earliest session');
  const cancelled = fake.scheduledRows.filter(r => r.status === 'cancelled');
  assert.deepEqual(cancelled.map(r => r.id), ['legacy2'], 'non-anchor same-day row cancelled');
});

test('sent rows are never touched by reconciliation', async () => {
  const fake = fixture();
  fake.scheduledRows.push(
    { id: 'sent1', event_email_id: 'em1', booking_id: 'b1', attendee_email: 'a@b.c', session_id: 's2', status: 'sent' }
  );
  await scheduleComplexEventReminderEmails('ev1', fake);
  assert.equal(fake.scheduledRows.find(r => r.id === 'sent1').status, 'sent');
});

test('track-restricted booking only gets reminders for accessible days', async () => {
  const fake = makeFakeSupabase({
    event: { id: 'ev1', timezone: 'UTC' },
    sessions: [
      { id: 's1', complex_event_id: 'ev1', title: 'D1', start_time: t(1, 9) },
      { id: 's2', complex_event_id: 'ev1', title: 'D2', start_time: t(2, 9) }
    ],
    junctions: [
      { complex_event_session_id: 's1', complex_event_track_id: 'tr1' },
      { complex_event_session_id: 's2', complex_event_track_id: 'tr2' }
    ],
    reminderEmails: [
      { id: 'em1', event_id: 'ev1', email_type: 'reminder', is_enabled: true, timing_type: '1_day_before' }
    ],
    bookings: [
      { id: 'b1', event_id: 'ev1', attendee_email: 'a@b.c', ticket_class_id: 'tc1', status: 'confirmed' }
    ],
    ticketClasses: [{ id: 'tc1', complex_event_id: 'ev1', all_tracks: false, linked_track_ids: ['tr1'] }]
  });
  await scheduleComplexEventReminderEmails('ev1', fake);
  assert.equal(fake.scheduledRows.length, 1);
  assert.equal(fake.scheduledRows[0].session_id, 's1');
});

test('absolute reminders remain once per booking with null session_id', async () => {
  const fake = makeFakeSupabase({
    event: { id: 'ev1', timezone: 'UTC' },
    sessions: [
      { id: 's1', complex_event_id: 'ev1', title: 'D1 AM', start_time: t(1, 9) },
      { id: 's2', complex_event_id: 'ev1', title: 'D1 PM', start_time: t(1, 14) }
    ],
    junctions: [],
    reminderEmails: [
      {
        id: 'emA', event_id: 'ev1', email_type: 'reminder', is_enabled: true,
        timing_type: 'custom', custom_unit: 'specific_datetime', custom_send_at: '2099-08-01T00:00:00Z'
      }
    ],
    bookings: [
      { id: 'b1', event_id: 'ev1', attendee_email: 'a@b.c', ticket_class_id: null, status: 'confirmed' }
    ],
    ticketClasses: []
  });
  await scheduleComplexEventReminderEmails('ev1', fake);
  await scheduleComplexEventReminderEmails('ev1', fake);
  assert.equal(fake.scheduledRows.length, 1);
  assert.equal(fake.scheduledRows[0].session_id, null);
});

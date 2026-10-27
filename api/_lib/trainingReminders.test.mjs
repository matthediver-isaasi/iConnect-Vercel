import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fixture, fakeClient, now } from '../../tests/fixtures/training-reminders.mjs';
import { scheduleTrainingEventReminderEmails } from './scheduleReminders.js';
import { trainingReminderTargets, validateTrainingReminder } from './trainingReminderTargets.js';

test('GFI-shaped new booking and explicit requeue share targets, times and history', async () => {
  const data = fixture(), db = fakeClient(data), event = data.event[0];
  let result = await scheduleTrainingEventReminderEmails(event, db, { bookingId: 'booking', now });
  assert.equal(result.requeued, 2);
  assert.deepEqual(data.scheduled_email.map(r => r.scheduled_send_time), ['2026-11-02T09:15:00.000Z', '2026-11-04T09:15:00.000Z']);
  result = await scheduleTrainingEventReminderEmails(event, db, { now });
  assert.equal(result.requeued, 2);
  assert.equal(data.scheduled_email.length, 2);
  data.scheduled_email[0].status = 'sent';
  data.scheduled_email[1].status = 'failed'; // claim/unknown outcome
  result = await scheduleTrainingEventReminderEmails(event, db, { now });
  assert.equal(result.requeued, 0);
  assert.equal(result.preserved, 2);
});

test('late bookings never catch up; same-day entries and ranges stay distinct', async () => {
  const data = fixture();
  data.event_agenda_item.push({ ...data.event_agenda_item[2], id: 'afternoon', start_time: '14:00', end_date: '2026-11-07' });
  const result = trainingReminderTargets(data.event[0], data.event_email[0], data.event_agenda_item, new Date('2026-11-03T12:00Z'));
  assert.deepEqual(result.eligible.map(t => t.sessionId), ['nov5', 'afternoon']);
  const db = fakeClient(data);
  await scheduleTrainingEventReminderEmails(data.event[0], db, { bookingId: 'booking', now: new Date('2026-11-03T12:00Z') });
  assert.equal(data.scheduled_email.length, 2);
});

test('legacy date-only fallback retains each date and DST gaps/overlaps fail closed', () => {
  const data = fixture(), event = { ...data.event[0], start_date: '2026-10-26T10:30Z' };
  const calc = lines => trainingReminderTargets(event, data.event_email[0], lines, now);
  assert.equal(calc([{ id: 'later', start_date: '2026-11-05' }]).eligible[0].anchor.toISOString(), '2026-11-05T10:30:00.000Z');
  for (const start_date of ['2026-03-29', '2026-10-25']) {
    const result = calc([{ id: 'dst', start_date, start_time: '01:30' }]);
    assert.equal(result.targets.length, 0);
    assert.equal(result.skipped.length, 1);
  }
  assert.equal(calc(data.event_agenda_item).eligible.length, 2);
  const dstDay = calc([{ id: 'dstday', start_date: '2026-03-29', start_time: '09:15' }]).targets[0];
  assert.equal(dstDay.scheduledTime.toISOString(), '2026-03-28T08:15:00.000Z', 'day means 24 elapsed hours');
});

test('absolute remains once per booking; disabled/cancelled/obsolete pending targets are cancelled', async () => {
  const data = fixture(), db = fakeClient(data), event = data.event[0];
  data.scheduled_email.push({ id: 'parent', event_email_id: 'email', booking_id: 'booking', session_id: null, status: 'pending' });
  await scheduleTrainingEventReminderEmails(event, db, { now });
  assert.equal(data.scheduled_email[0].status, 'cancelled');
  data.event_email[0].is_enabled = false;
  await scheduleTrainingEventReminderEmails(event, db, { now });
  assert.ok(data.scheduled_email.every(r => r.status === 'cancelled'));
  Object.assign(data.event_email[0], { is_enabled: true, timing_type: 'custom', custom_unit: 'specific_datetime', custom_send_at: '2026-11-01T10:00Z' });
  await scheduleTrainingEventReminderEmails(event, db, { now });
  assert.equal(data.scheduled_email.filter(r => r.status === 'pending').length, 1);
  assert.equal(data.scheduled_email[0].session_id, null);
  data.booking[0].status = 'cancelled';
  await scheduleTrainingEventReminderEmails(event, db, { now });
  assert.ok(data.scheduled_email.every(r => r.status === 'cancelled'));
});

test('delivery refuses changed/deleted/expired targets and disabled configuration', async () => {
  const data = fixture(), db = fakeClient(data);
  await scheduleTrainingEventReminderEmails(data.event[0], db, { now });
  const row = data.scheduled_email[0];
  const check = (at = now) => validateTrainingReminder(data.event[0], data.event_email[0], row, data.event_agenda_item, at);
  assert.ok(check().target);
  assert.match(check(new Date('2026-11-03T09:15Z')).reason, /already started/);
  data.event_agenda_item[1].zoom_meeting_id = 'different';
  assert.match(check().reason, /changed/);
  data.event_agenda_item.splice(1, 1);
  assert.match(check().reason, /removed/);
  data.event_email[0].is_enabled = false;
  assert.match(check().reason, /disabled/);
});

test('all booking pages and concurrent queue attempts preserve unique identity', async () => {
  const data = fixture(), db = fakeClient(data);
  data.booking = Array.from({ length: 501 }, (_, i) => ({ ...data.booking[0], id: `b${i}` }));
  const result = await scheduleTrainingEventReminderEmails(data.event[0], db, { now });
  assert.equal(result.bookingsConsidered, 501);
  assert.equal(result.requeued, 1002);
  const fresh = fixture(), client = fakeClient(fresh);
  await Promise.all([1, 2].map(() => scheduleTrainingEventReminderEmails(fresh.event[0], client, { now })));
  assert.equal(fresh.scheduled_email.length, 2);
});

// Bundle the real preview and cron with only infrastructure replaced; no network,
// attendee records, provider keys or real email delivery are used.
let harness;
async function loadHarness() {
  if (harness) return harness;
  const stubs = {
    'database.js': 'export const supabase = { from: (...args) => globalThis.__trainingTest.db.from(...args) };',
    'emailService.js': 'export const sendEmail = async args => globalThis.__trainingTest.send(args);',
    'transactionalInbox.js': 'export const buildInboxDelivery = async () => null;',
    'campaignEventSurvey.js': 'export const resolveEventEmailSurvey = async (db, config) => config;',
    'checkinService.js': 'export const buildQrImageUrl = () => ""; export const ensureBookingToken = async () => ""; export const ensureComplexSessionTokens = async () => [];',
  };
  const output = await build({
    stdin: { contents: 'export { default as cron } from "./api/cron/send-event-reminders.js"; export { renderEventEmailPreview } from "./api/_lib/eventConfirmationEmail.js";', resolveDir: process.cwd() },
    bundle: true, write: false, platform: 'node', format: 'esm',
    plugins: [{ name: 'isolated-training', setup(b) {
      b.onResolve({ filter: /\.js$/ }, args => {
        const name = args.path.split('/').at(-1);
        if (stubs[name]) return { path: name, namespace: 'stub' };
      });
      b.onLoad({ filter: /.*/, namespace: 'stub' }, args => ({ contents: stubs[args.path], loader: 'js' }));
    } }],
  });
  harness = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`);
  return harness;
}

test('real preview pipeline selects upcoming entry, correct link and full agenda; confirmation unchanged', async () => {
  const { renderEventEmailPreview } = await loadHarness();
  const data = fixture();
  globalThis.__trainingTest = { db: fakeClient(data), send: () => { throw new Error('Preview must never send'); } };
  const input = { eventId: 'event', tenantId: 'tenant', ...data.event_email[0], reminder: data.event_email[0], now };
  const first = await renderEventEmailPreview(input);
  assert.equal(first.reminderContext.selectedId, 'nov3');
  assert.match(first.subject, /3 November 2026.*09:15/);
  assert.match(first.html, /09:15 https:\/\/example.test\/nov3/);
  assert.match(first.html, /26 October 2026/);
  const next = await renderEventEmailPreview({ ...input, sessionId: 'nov5' });
  assert.match(next.subject, /5 November 2026.*09:15/);
  assert.match(next.html, /09:15 https:\/\/example.test\/nov5/);
  const empty = await renderEventEmailPreview({ ...input, now: new Date('2026-11-05T10:00Z') });
  assert.match(empty.reminderContext.emptyReason, /No eligible future/);
  const confirmation = await renderEventEmailPreview({ ...input, reminder: { email_type: 'confirmation' } });
  assert.match(confirmation.subject, /26 October 2026/);
});

test('real cron claims once, renders targeted session, suppresses stale rows and retains unknown outcomes', async () => {
  const { cron } = await loadHarness();
  const data = fixture(), db = fakeClient(data), sends = [];
  await scheduleTrainingEventReminderEmails(data.event[0], db, { now });
  globalThis.__trainingTest = { db, send: async args => { sends.push(args); return { success: true }; } };
  const RealDate = Date;
  const secret = process.env.CRON_SECRET;
  process.env.CRON_SECRET = 'isolated-fixture-only';
  globalThis.Date = class extends RealDate { constructor(...args) { super(...(args.length ? args : ['2026-11-02T09:16Z'])); } static now() { return new RealDate('2026-11-02T09:16Z').getTime(); } };
  const run = async () => {
    let result;
    await cron({ headers: { authorization: 'Bearer isolated-fixture-only' } }, { status() { return this; }, json(v) { result = v; return v; } });
    return result;
  };
  try {
    await Promise.all([run(), run()]);
    assert.equal(sends.length, 1);
    assert.match(sends[0].subject, /3 November 2026.*09:15/);
    assert.match(sends[0].html, /09:15 https:\/\/example.test\/nov3/);
    assert.equal(data.scheduled_email[0].status, 'sent');
    // A separate isolated booking exercises a provider-unknown outcome.
    data.booking.push({ ...data.booking[0], id: 'unknown' });
    data.scheduled_email.push({ ...data.scheduled_email[0], id: 'unknown-row', booking_id: 'unknown', status: 'pending' });
    globalThis.__trainingTest.send = async () => { throw new Error('Provider response lost'); };
    await run();
    assert.equal(data.scheduled_email.find(r => r.id === 'unknown-row').status, 'failed');
    await scheduleTrainingEventReminderEmails(data.event[0], db, { now });
    assert.equal(data.scheduled_email.find(r => r.id === 'unknown-row').status, 'failed');
    data.booking.push({ ...data.booking[0], id: 'stale' });
    data.scheduled_email.push({ ...data.scheduled_email[0], id: 'stale-row', booking_id: 'stale', status: 'pending', training_target_snapshot: 'old' });
    const result = await run();
    assert.equal(result.skipped.length, 1);
    assert.equal(data.scheduled_email.at(-1).status, 'cancelled');
  } finally {
    globalThis.Date = RealDate;
    if (secret === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = secret;
    delete globalThis.__trainingTest;
  }
});

test('unapplied training migration cannot block unrelated event deliveries', async () => {
  const { cron } = await loadHarness();
  const data = fixture(), sends = [];
  data.event.push({ ...data.event[0], id: 'ordinary', is_training: false });
  data.event_email.push({ ...data.event_email[0], id: 'ordinary-email', event_id: 'ordinary' });
  data.booking.push({ ...data.booking[0], id: 'ordinary-booking', event_id: 'ordinary' });
  data.scheduled_email.push(
    { id: 'training', event_email_id: 'email', booking_id: 'booking', status: 'pending', scheduled_send_time: '2000-01-01T00:00:00Z' },
    { id: 'ordinary', event_email_id: 'ordinary-email', booking_id: 'ordinary-booking', status: 'pending', scheduled_send_time: '2000-01-01T00:00:00Z' },
  );
  globalThis.__trainingTest = {
    db: fakeClient(data, { missingTrainingSnapshot: true }),
    send: async args => { sends.push(args); return { success: true }; },
  };
  const secret = process.env.CRON_SECRET;
  process.env.CRON_SECRET = 'isolated-fixture-only';
  let result;
  try {
    await cron({ headers: { authorization: 'Bearer isolated-fixture-only' } }, {
      status() { return this; }, json(v) { result = v; return v; },
    });
    assert.equal(result.sent, 1);
    assert.equal(sends.length, 1);
    assert.equal(data.scheduled_email[0].status, 'failed');
    assert.match(data.scheduled_email[0].error_message, /migration/);
    assert.equal(data.scheduled_email[1].status, 'sent');
  } finally {
    if (secret === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = secret;
    delete globalThis.__trainingTest;
  }
});

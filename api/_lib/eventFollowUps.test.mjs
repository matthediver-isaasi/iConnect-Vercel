import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fakeClient } from '../../tests/fixtures/training-reminders.mjs';
import { followUpTargets, validateFollowUpConfig } from './eventFollowUpTargets.js';
import { scheduleEventFollowUps, validateFollowUpDelivery, accessibleFollowUpEntries } from './eventFollowUps.js';

const now = new Date('2027-01-01T00:00Z');
const config = scope => ({ id: scope, event_id: 'event', email_type: 'follow_up', is_enabled: true,
  follow_up_scope: scope, follow_up_delay: 0, follow_up_unit: 'hours',
  subject: '{{follow_up_scope}} {{follow_up_target}}', body: '{{follow_up_end}} {{agenda_schedule}} {{session_schedule}}' });
const event = { id: 'event', title: 'Programme', tenant_id: 'tenant', timezone: 'Europe/London', is_training: true,
  start_date: '2027-01-02T09:00:00Z', end_date: '2027-01-02T12:00:00Z' };
const entries = [
  { id: 'a', event_id: 'event', start_date: '2027-01-02', start_time: '09:00', end_time: '10:00', description: 'Morning' },
  { id: 'b', event_id: 'event', start_date: '2027-01-02', start_time: '17:00', end_time: '18:00', description: 'Evening' },
];
const booking = { id: 'booking', event_id: 'event', status: 'confirmed', attendee_email: 'attendee@example.test' };
function fixture() { return { event: [{ ...event }], event_email: ['event', 'day', 'session'].map(config),
  event_agenda_item: structuredClone(entries), booking: [{ ...booking }], scheduled_email: [] }; }
const calc = (scope, overrides = {}) => followUpTargets({ event, email: config(scope), entries, accessibleIds: ['a'], now, ...overrides });

test('overall end covers full programme and declared end; day uses inaccessible final session', () => {
  assert.equal(calc('event').targets[0].end.toISOString(), '2027-01-02T18:00:00.000Z');
  assert.equal(calc('event', { event: { ...event, end_date: '2027-01-03T20:00:00Z' } }).targets[0].end.toISOString(), '2027-01-03T20:00:00.000Z');
  assert.equal(calc('day').targets[0].end.toISOString(), '2027-01-02T18:00:00.000Z');
  assert.deepEqual(calc('session').targets.map(t => t.key), ['session:a']);
  assert.equal(calc('event', { entries: [], event: { ...event, is_training: false } }).targets.length, 1);
});

test('zero offsets, future followups after an ended session, and elapsed windows', () => {
  const email = { ...config('session'), follow_up_delay: 2 };
  const result = calc('session', { email, now: new Date('2027-01-02T11:00Z') });
  assert.equal(result.eligible[0].scheduledTime.toISOString(), '2027-01-02T12:00:00.000Z');
  assert.equal(calc('session', { email, now: new Date('2027-01-02T12:00Z') }).eligible.length, 0);
  for (const follow_up_delay of [-1, NaN, Infinity, null, '2']) assert.throws(() => validateFollowUpConfig({ ...email, follow_up_delay }));
});

test('overnight sessions use start day; continuous ranges stay one session and reject daily guesses', () => {
  const overnight = [{ ...entries[0], start_time: '23:00', end_date: '2027-01-03', end_time: '01:00' }];
  assert.equal(calc('day', { entries: overnight }).targets[0].key, 'day:2027-01-02');
  assert.equal(calc('day', { entries: overnight }).targets[0].end.toISOString(), '2027-01-03T01:00:00.000Z');
  const range = [{ ...entries[0], end_date: '2027-01-05' }];
  assert.equal(calc('session', { entries: range }).targets.length, 1);
  assert.equal(calc('day', { entries: range }).targets.length, 0);
  assert.match(calc('day', { entries: range }).skipped[0].reason, /separately timed daily/);
});

test('missing ends, invalid timezones and ambiguous/nonexistent DST wall clocks fail closed', () => {
  for (const scope of ['event', 'day']) assert.equal(calc(scope, { entries: [{ ...entries[0], end_time: null }] }).targets.length, 0);
  assert.equal(calc('event', { event: { ...event, end_date: null } }).targets.length, 0);
  assert.equal(calc('event', { event: { ...event, timezone: 'invalid' } }).targets.length, 0);
  for (const date of ['2027-03-28', '2027-10-31']) {
    assert.equal(calc('session', { entries: [{ ...entries[0], start_date: date, start_time: '00:30', end_time: '01:30' }] }).targets.length, 0);
  }
  const t = calc('session', { email: { ...config('session'), follow_up_delay: 1, follow_up_unit: 'days' },
    entries: [{ ...entries[0], start_date: '2027-03-27' }] }).targets[0];
  assert.equal(t.scheduledTime - t.end, 86400000);
});

test('complex entitlement is fail-closed and overall events still cover partial-programme bookings', () => {
  const e = { ...event, is_complex: true };
  const programme = { entries: [{ id: 'a', complex_event_track_id: 'track' }, { id: 'b' }],
    tickets: [{ id: 'ticket', all_tracks: false, linked_track_ids: ['track'] }],
    tracks: [{ id: 'track' }], junctions: [] };
  assert.deepEqual(accessibleFollowUpEntries(e, booking, programme), []);
  assert.deepEqual(accessibleFollowUpEntries(e, { ...booking, ticket_class_id: 'ticket' }, programme), ['a', 'b']);
  programme.tickets[0].linked_track_ids = ['missing'];
  assert.deepEqual(accessibleFollowUpEntries(e, { ...booking, ticket_class_id: 'ticket' }, programme), []);
  const complexEntries = entries.map(x => ({ id: x.id, start_time: `${x.start_date}T${x.start_time}:00Z`, end_time: `${x.start_date}T${x.end_time}:00Z` }));
  assert.equal(calc('event', { event: e, entries: complexEntries, accessibleIds: [] }).targets.length, 1);
  assert.equal(calc('day', { event: e, entries: complexEntries, accessibleIds: [] }).targets.length, 0);
});

test('new and explicit scheduling coexist, reconcile changes and preserve sent/claimed outcomes', async () => {
  const data = fixture(), db = fakeClient(data);
  const first = await scheduleEventFollowUps(db, 'event', { bookingId: booking.id, now });
  assert.equal(first.error, undefined);
  assert.equal(first.requeued, 4);
  const repeated = await scheduleEventFollowUps(db, 'event', { now });
  assert.equal(repeated.requeued, 4);
  assert.equal(data.scheduled_email.length, 4);
  data.scheduled_email[0].status = 'sent';
  data.scheduled_email[1].status = 'failed';
  data.event_email[2].is_enabled = false;
  const changed = await scheduleEventFollowUps(db, 'event', { now });
  assert.equal(changed.preserved, 2);
  assert.equal(changed.cancelled, 2);
  data.event_email[2].is_enabled = true;
  data.booking[0].status = 'cancelled';
  assert.equal((await scheduleEventFollowUps(db, 'event', { now })).requeued, 0);
});

test('complete pagination and racing schedulers retain stable target identity', async () => {
  const data = fixture(), db = fakeClient(data);
  data.event_email = [config('event')];
  data.booking = Array.from({ length: 1002 }, (_, i) => ({ ...booking, id: `booking${i}` }));
  const results = await Promise.all([scheduleEventFollowUps(db, 'event', { now }), scheduleEventFollowUps(db, 'event', { now })]);
  assert.equal(results[0].bookingsConsidered, 1002);
  assert.equal(data.scheduled_email.length, 1002);
});

test('delivery revalidates booking, end, recipient, target deletion and enablement', async () => {
  for (const change of [
    data => { data.booking[0].status = 'cancelled'; },
    data => { data.booking[0].attendee_email = 'changed@example.test'; },
    data => { data.event[0].end_date = '2027-01-04T18:00Z'; },
    data => { data.event_email[0].is_enabled = false; },
    data => { data.event_agenda_item.pop(); },
  ]) {
    const data = fixture(), db = fakeClient(data);
    await scheduleEventFollowUps(db, 'event', { now });
    const at = new Date('2027-01-03T20:00Z'), row = data.scheduled_email[0];
    assert.ok((await validateFollowUpDelivery(db, row, data.event_email[0], at)).target);
    change(data);
    assert.ok((await validateFollowUpDelivery(db, row, data.event_email[0], at)).reason);
  }
});

test('complex booking table, complete session pagination and changed entitlements revalidate separately from overall event', async () => {
  const data = fixture();
  data.event = [];
  data.event_agenda_item = [];
  data.complex_event = [{ ...event, is_complex: true }];
  data.booking = [];
  data.complex_event_booking = [{ ...booking, ticket_class_id: 'ticket' }];
  data.complex_event_ticket_class = [{ id: 'ticket', complex_event_id: 'event', all_tracks: false, linked_track_ids: ['track'] }];
  data.complex_event_track = [{ id: 'track', complex_event_id: 'event' }];
  data.complex_event_session_track = [];
  data.complex_event_session = Array.from({ length: 1001 }, (_, i) => ({
    id: `session${i}`, complex_event_id: 'event', complex_event_track_id: 'track',
    start_time: '2027-01-02T09:00Z', end_time: i === 1000 ? '2027-01-02T23:00Z' : '2027-01-02T10:00Z',
  }));
  const db = fakeClient(data);
  const result = await scheduleEventFollowUps(db, 'event', { now });
  assert.equal(result.error, undefined);
  assert.equal(result.requeued, 1003);
  assert.equal(data.scheduled_email.find(r => r.follow_up_target_key === 'event').scheduled_send_time, '2027-01-02T23:00:00.000Z');
  assert.ok(data.scheduled_email.every(r => r.follow_up_booking_table === 'complex_event_booking'));
  data.complex_event_ticket_class[0].linked_track_ids = ['invalid'];
  const later = new Date('2027-01-03T00:00Z');
  const overall = data.scheduled_email.find(r => r.event_email_id === 'event');
  assert.ok((await validateFollowUpDelivery(db, overall, data.event_email[0], later)).target);
  const session = data.scheduled_email.find(r => r.event_email_id === 'session');
  assert.ok((await validateFollowUpDelivery(db, session, data.event_email[2], later)).reason);
  const day = data.scheduled_email.find(r => r.event_email_id === 'day');
  assert.ok((await validateFollowUpDelivery(db, day, data.event_email[1], later)).reason);
});

let harness;
async function loadHarness() {
  if (harness) return harness;
  const stubs = {
    'database.js': 'export const supabase = { from: (...args) => globalThis.__followUpTest.db.from(...args) };',
    'emailService.js': 'export const sendEmail = (...args) => globalThis.__followUpTest.send(...args);',
    'tenantContext.js': 'export const getTenantContext = async () => ({isAuthenticated:true,tenantId:"tenant"}); export const hasAdminAccess = async () => true;',
    'transactionalInbox.js': 'export const buildInboxDelivery = async () => null;',
    'campaignEventSurvey.js': 'export const resolveEventEmailSurvey = async (_db, e) => ({subject:e.subject,body:e.body}); export const usesEventSurvey = () => false;',
    'checkinService.js': 'export const buildQrImageUrl = () => ""; export const ensureBookingToken = async () => ""; export const ensureComplexSessionTokens = async () => [];',
  };
  const output = await build({ stdin: { contents: 'export { default as cron } from "./api/cron/send-event-reminders.js"; export {default as preview} from "./api/event-emails/[eventId]/preview.js"; export {default as save} from "./api/event-emails/[eventId].js";', resolveDir: process.cwd() },
    bundle: true, write: false, platform: 'node', format: 'esm', plugins: [{ name: 'isolated-followup', setup(b) {
      b.onResolve({ filter: /\.js$/ }, args => { const name = args.path.split('/').at(-1); if (stubs[name]) return { path: name, namespace: 'stub' }; });
      b.onLoad({ filter: /.*/, namespace: 'stub' }, args => ({ contents: stubs[args.path], loader: 'js' }));
    } }] });
  harness = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`);
  return harness;
}
const response = () => ({ code: 200, setHeader() {}, status(n) { this.code = n; return this; }, json(body) { this.body = body; return body; } });

test('real preview/save/worker share rendering, never send on save, claim once and retain unknown outcomes', async () => {
  const { preview, save, cron } = await loadHarness(), data = fixture(), db = fakeClient(data), sends = [];
  globalThis.__followUpTest = { db, send: async input => { sends.push(input); return { success: true }; } };
  const RealDate = Date, previous = process.env.CRON_SECRET;
  let clock = now.getTime();
  globalThis.Date = class extends RealDate { constructor(...args) { super(...(args.length ? args : [clock])); } static now() { return clock; } };
  process.env.CRON_SECRET = 'fixture';
  try {
    const saved = response();
    await save({ method: 'PUT', query: { eventId: 'event' }, body: { emails: data.event_email } }, saved);
    assert.equal(saved.code, 200);
    assert.equal(data.scheduled_email.length, 0);
    assert.equal(sends.length, 0);
    const rendered = response();
    await preview({ method: 'POST', headers: {}, query: { eventId: 'event' },
      body: { ...data.event_email[0], reminder: data.event_email[0] } }, rendered);
    assert.equal(rendered.code, 200);
    assert.equal(rendered.body.reminderContext.sendAt, '2027-01-02T18:00:00.000Z');
    assert.doesNotMatch(rendered.body.html, /entrance QR|calendar file/);
    await scheduleEventFollowUps(db, 'event', { now });
    clock = new RealDate('2027-01-03T20:00Z').getTime();
    const run = () => cron({ headers: { authorization: 'Bearer fixture' } }, response());
    await Promise.all([run(), run()]);
    assert.equal(sends.length, 4);
    assert.equal(sends[0].html, rendered.body.html);
    assert.equal(sends[0].subject, rendered.body.subject);
    assert.ok(data.scheduled_email.every(r => r.status === 'sent'));
    const unknown = { ...data.scheduled_email[0], id: 'unknown', status: 'pending' };
    data.scheduled_email = [unknown];
    globalThis.__followUpTest.send = async () => { throw new Error('Provider outcome unknown'); };
    await run();
    assert.equal(unknown.status, 'failed');
    await scheduleEventFollowUps(db, 'event', { now });
    assert.equal(unknown.status, 'failed');
  } finally {
    globalThis.Date = RealDate;
    if (previous === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = previous;
    delete globalThis.__followUpTest;
  }
});

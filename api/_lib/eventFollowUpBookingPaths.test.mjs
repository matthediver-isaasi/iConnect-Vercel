import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';
import { fakeClient } from '../../tests/fixtures/training-reminders.mjs';
import { scheduleEventFollowUps } from './eventFollowUps.js';
import { programRegistrationFingerprint, programRegistrationReplay } from './programRegistrationAttempt.js';

function fixture() {
  return {
    event: [{ id: 'event', tenant_id: 'tenant', program_tag: 'programme', timezone: 'UTC',
      start_date: '2099-01-01T09:00Z', end_date: '2099-01-01T18:00Z' }],
    member: [{ id: 'member', tenant_id: 'tenant', email: 'member@example.test' }],
    role: [{ id: 'role', excluded_features: [] }], booking: [], scheduled_email: [],
    event_email: [{ id: 'email', event_id: 'event', email_type: 'follow_up', is_enabled: true,
      follow_up_scope: 'event', follow_up_delay: 0, follow_up_unit: 'hours' }],
  };
}

test('programme-entitlement handler queues only after committed confirmed bookings, not before RPC or on failure', async () => {
  const source = readFileSync('api/functions/[functionName].js', 'utf8');
  const method = source.slice(source.indexOf('  async createBooking(params, req) {'),
    source.indexOf('  async checkDuplicateRegistrations('));
  assert.ok(method.startsWith('  async createBooking'));
  const data = fixture(), db = fakeClient(data);
  let committed = false, failCommit = false, confirmations = 0;
  db.rpc = async (name, args) => {
    assert.equal(name, 'consume_program_entitlement');
    assert.equal(data.scheduled_email.length, 0);
    if (failCommit) return { error: { message: 'transaction failed' } };
    const bookings = args.p_bookings.map((b, i) => ({ ...b, id: `book${i}`, tenant_id: 'tenant' }));
    data.booking.push(...bookings);
    committed = true;
    return { data: { bookings, new_balance: 5 } };
  };
  const deps = {
    supabase: db,
    resolveTenantFromRequest: async () => ({ id: 'tenant' }),
    getSessionMember: async () => ({ id: 'member' }),
    enforceAttendeeJobTitles: async () => {},
    assertSimpleTicketsReleased: () => {},
    assertSimplePrivateTicketsAccessible: async () => {},
    programRegistrationFingerprint, programRegistrationReplay,
    optionalEventRegistrationConsent: async () => null,
    isAttendeeOptionsCollectionEnabled: () => false, EMPTY_OPTION_SELECTIONS: {},
    scheduleEventFollowUps: async (...args) => { assert.equal(committed, true); return scheduleEventFollowUps(...args); },
    sendConfirmationEmailsFromTemplate: async () => { confirmations++; return []; },
  };
  const handler = new Function(...Object.keys(deps), `return ({${method}}).createBooking`)(...Object.values(deps));
  const params = { eventId: 'event', memberEmail: 'member@example.test', registrationMode: 'self',
    registrationAttemptId: '00000000-0000-4000-8000-000000000001',
    attendees: [{ email: 'member@example.test', first_name: 'Test', last_name: 'Attendee' }] };
  const result = await handler(params, {});
  assert.equal(result.success, true);
  assert.equal(data.booking[0].status, 'confirmed');
  assert.equal(data.scheduled_email.length, 1);
  assert.equal(data.scheduled_email[0].status, 'pending');
  assert.equal(confirmations, 1); // existing confirmation path only
  data.scheduled_email = []; data.booking = []; committed = false; failCommit = true;
  await assert.rejects(handler(params, {}), /transaction failed/);
  assert.equal(data.scheduled_email.length, 0);
  assert.equal(confirmations, 1);
});

test('actual admin import handler queues future follow-ups with confirmations disabled and no duplicate imports', async () => {
  const data = fixture(), db = fakeClient(data);
  globalThis.__importFollowUp = { db };
  const stubs = {
    '@supabase/supabase-js': 'export const createClient = () => globalThis.__importFollowUp.db;',
    'session.js': 'export const getSessionMember = async () => ({id:"admin",role_id:"role"});',
    'roleVisibility.js': 'export const isResourceExcluded = () => false;',
    'eventConfirmationEmail.js': 'export const sendConfirmationEmailsFromTemplate = () => { throw new Error("No confirmation requested"); };',
    'groupAdminEventWrite.js': 'export const isGroupAdminForEventRequest = async () => false;',
    'database.js': 'export const supabase = null;',
  };
  const output = await build({ stdin: { contents: 'export {default} from "./api/admin/events/[eventId]/attendees/import.js";', resolveDir: process.cwd() },
    bundle: true, write: false, platform: 'node', format: 'esm',
    define: { 'process.env.SUPABASE_URL': '"https://fixture.invalid"', 'process.env.SUPABASE_SERVICE_KEY': '"fixture-only"' },
    plugins: [{ name: 'import-fixture', setup(b) {
      b.onResolve({ filter: /.*/ }, args => { const key = stubs[args.path] ? args.path : args.path.split('/').at(-1);
        if (stubs[key]) return { path: key, namespace: 'stub' }; });
      b.onLoad({ filter: /.*/, namespace: 'stub' }, args => ({ contents: stubs[args.path], loader: 'js' }));
    } }] });
  try {
    const { default: handler } = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`);
    const run = async () => {
      const res = { code: 200, setHeader() {}, status(code) { this.code = code; return this; }, json(body) { this.body = body; return body; } };
      await handler({ method: 'POST', headers: {}, query: { eventId: 'event' },
        body: { send_confirmations: false, rows: [{ email: 'guest@example.test', first_name: 'Guest', last_name: 'Test' }] } }, res);
      assert.equal(res.code, 200);
      return res.body;
    };
    const first = await run();
    assert.equal(first.success, true);
    assert.equal(first.results.registered.length, 1);
    assert.equal(data.scheduled_email.length, 1);
    assert.equal(data.scheduled_email[0].status, 'pending');
    assert.equal(first.results.emailsSent.length, 0);
    const repeated = await run();
    assert.equal(repeated.results.alreadyRegistered.length, 1);
    assert.equal(data.scheduled_email.length, 1);
  } finally { delete globalThis.__importFollowUp; }
});

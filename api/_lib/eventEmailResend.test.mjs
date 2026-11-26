import test from 'node:test';
import assert from 'node:assert/strict';
import { loadEventEmailRecipients, resendIdentityKey } from './eventEmailDelivery.js';

const TENANT = '44444444-4444-4444-8444-444444444444';
const OTHER_TENANT = '44444444-4444-4444-8444-444444444445';
const EVENT = '55555555-5555-4555-8555-555555555555';
const CONFIRM = '66666666-6666-4666-8666-666666666661';
const REMIND = '66666666-6666-4666-8666-666666666662';
const BOOKING = '77777777-7777-4777-8777-777777777771';
const BOOKING_CANCELLED = '77777777-7777-4777-8777-777777777772';
const SCHED = '88888888-8888-4888-8888-888888888881';
const SCHED_PENDING = '88888888-8888-4888-8888-888888888882';
const SCHED_CANCELLED = '88888888-8888-4888-8888-888888888883';
const id = n => `33333333-3333-4333-8333-${String(n).padStart(12, '0')}`;

// Minimal in-memory PostgREST-like client covering the calls used here.
function fakeDb(data) {
  const writes = [], leases = new Map(), rpcs = [];
  let tokens = 0;
  // Mirrors claim_event_email_resend / release_event_email_resend_claim; the
  // real SQL is exercised in scripts/event-email-delivery.postgres.test.mjs.
  async function rpc(name, args) {
    rpcs.push({ name, args });
    if (name === 'release_event_email_resend_claim') {
      for (const [k, v] of leases) if (v === args.p_token) leases.delete(k);
      return { data: true, error: null };
    }
    if (name !== 'claim_event_email_resend') throw new Error(`unexpected rpc ${name}`);
    if (data.claimUnavailable) return { data: null, error: { message: 'function does not exist' } };
    const r = data.event_email_delivery.find(d => d.id === args.p_delivery_id && d.tenant_id === args.p_tenant_id
      && d.event_id === args.p_event_id && d.event_email_id === args.p_event_email_id);
    if (!r) return { data: { claimed: false, reason: 'not_found' }, error: null };
    const key = `${args.p_event_email_id}|${resendIdentityKey(r)}`;
    if (r.status !== 'failed') return { data: { claimed: false, reason: 'not_failed' }, error: null };
    if (leases.has(key)) return { data: { claimed: false, reason: 'in_progress' }, error: null };
    if (data.event_email_delivery.some(d => d.id !== r.id && d.event_email_id === r.event_email_id && d.created_at > r.created_at
      && ['sending', 'accepted', 'delivered'].includes(d.status) && resendIdentityKey(d) === resendIdentityKey(r))) {
      return { data: { claimed: false, reason: 'already_resent' }, error: null };
    }
    const token = `token-${++tokens}`;
    leases.set(key, token);
    return { data: { claimed: true, token }, error: null };
  }
  function query(table) {
    const filters = [];
    let patch = null, limitN = null, orderBy = null;
    const rows = () => (data[table] || []).filter(r => filters.every(f => f(r)));
    const q = {
      select() { return q; },
      eq(k, v) { filters.push(r => r[k] === v); return q; },
      in(k, v) { filters.push(r => v.includes(r[k])); return q; },
      is(k, v) { filters.push(r => (r[k] ?? null) === v); return q; },
      gt(k, v) { filters.push(r => r[k] > v); return q; },
      order(k, { ascending = true } = {}) { orderBy ??= { k, ascending }; return q; },
      limit(n) { limitN = n; return q; },
      range(from, to) {
        let out = rows();
        if (orderBy) out = [...out].sort((a, b) => (a[orderBy.k] < b[orderBy.k] ? -1 : 1) * (orderBy.ascending ? 1 : -1));
        return Promise.resolve({ data: out.slice(from, to + 1), error: null, count: out.length });
      },
      update(values) { patch = values; return q; },
      insert() { throw new Error('unexpected insert'); },
      async maybeSingle() { const row = rows()[0]; return { data: row ? { ...row } : null, error: null }; },
      then(resolve, reject) {
        try {
          let out = rows();
          if (patch) { out.forEach(r => Object.assign(r, patch)); writes.push({ table, patch, ids: out.map(r => r.id) }); }
          if (limitN != null) out = out.slice(0, limitN);
          resolve({ data: out.map(r => ({ ...r })), error: null });
        } catch (e) { reject(e); }
      },
    };
    return q;
  }
  return { from: query, rpc, writes, leases, rpcs };
}

function fixture() {
  const ledger = (n, extra) => ({ id: id(n), tenant_id: TENANT, event_id: EVENT, recipient_email: 'a@example.invalid',
    created_at: `2027-02-0${Math.min(n, 9)}T00:00:00Z`, send_source: 'confirmation', ...extra });
  return {
    event: [{ id: EVENT, tenant_id: TENANT }],
    complex_event: [],
    event_email: [
      { id: CONFIRM, event_id: EVENT, email_type: 'booking_confirmation', is_enabled: true, subject: 'Thanks' },
      { id: REMIND, event_id: EVENT, email_type: 'reminder', is_enabled: true, subject: 'Soon' },
    ],
    booking: [
      { id: BOOKING, event_id: EVENT, tenant_id: TENANT, status: 'confirmed', attendee_email: 'new@example.invalid', attendee_first_name: 'A' },
      { id: BOOKING_CANCELLED, event_id: EVENT, tenant_id: TENANT, status: 'cancelled', attendee_email: 'c@example.invalid' },
    ],
    scheduled_email: [
      { id: SCHED, event_email_id: REMIND, booking_id: BOOKING, attendee_email: 'a@example.invalid', status: 'sent', scheduled_send_time: '2027-02-01T09:00:00Z' },
      { id: SCHED_PENDING, event_email_id: REMIND, booking_id: BOOKING, attendee_email: 'a@example.invalid', status: 'pending', scheduled_send_time: '2027-02-01T09:00:00Z' },
      { id: SCHED_CANCELLED, event_email_id: REMIND, booking_id: BOOKING_CANCELLED, attendee_email: 'c@example.invalid', status: 'cancelled', error_message: 'Booking cancelled', scheduled_send_time: '2027-02-01T09:00:00Z' },
    ],
    event_email_delivery: [
      ledger(1, { event_email_id: CONFIRM, email_type: 'booking_confirmation', booking_id: BOOKING, status: 'failed', failure_source: 'provider' }),
      ledger(2, { event_email_id: CONFIRM, email_type: 'booking_confirmation', booking_id: BOOKING, status: 'failed', failure_source: 'send' }),
      ledger(3, { event_email_id: CONFIRM, email_type: 'booking_confirmation', booking_id: BOOKING, status: 'delivered' }),
      ledger(4, { event_email_id: CONFIRM, email_type: 'booking_confirmation', booking_id: BOOKING, status: 'accepted' }),
      ledger(5, { event_email_id: CONFIRM, email_type: 'booking_confirmation', booking_id: BOOKING_CANCELLED, status: 'failed', failure_source: 'provider' }),
      ledger(6, { event_email_id: REMIND, email_type: 'reminder', booking_id: BOOKING, scheduled_email_id: SCHED, status: 'failed', failure_source: 'provider' }),
      ledger(7, { event_email_id: REMIND, email_type: 'reminder', booking_id: BOOKING, scheduled_email_id: SCHED_PENDING, status: 'failed', failure_source: 'send' }),
      ledger(8, { event_email_id: REMIND, email_type: 'reminder', booking_id: BOOKING_CANCELLED, scheduled_email_id: SCHED_CANCELLED, status: 'failed', failure_source: 'provider' }),
      ledger(9, { event_email_id: CONFIRM, email_type: 'booking_confirmation', booking_id: null, status: 'failed', failure_source: 'provider', tenant_id: OTHER_TENANT }),
    ],
  };
}

async function harness(data, { admin = true, ctx = { isAuthenticated: true, tenantId: TENANT }, db = fakeDb(data),
  sendConfirmation = async () => [{ success: true }], processScheduled = async () => ({ outcome: 'sent' }) } = {}) {
  const { createResendHandler } = await import('../event-emails/[eventId]/resend.js');
  const confirmations = [], scheduled = [];
  const handler = createResendHandler({
    db, getContext: async () => ctx, isAdmin: async () => admin,
    sendConfirmation: async (...args) => { confirmations.push(args); return sendConfirmation(...args); },
    processScheduled: async (row, opts) => { scheduled.push({ row, opts }); return processScheduled(row, opts); },
  });
  const run = async (body, method = 'POST') => {
    let status, json;
    await handler({ method, query: { eventId: EVENT }, body }, { status(c) { status = c; return this; }, json(v) { json = v; } });
    return { status, body: json };
  };
  return { run, db, confirmations, scheduled };
}

test('resend is admin-only, requires explicit confirmation and bounds the batch', async () => {
  const data = fixture();
  assert.equal((await (await harness(data, { ctx: { isAuthenticated: false } })).run({ emailId: CONFIRM, deliveryIds: [id(1)], confirm: true })).status, 401);
  assert.equal((await (await harness(data, { admin: false })).run({ emailId: CONFIRM, deliveryIds: [id(1)], confirm: true })).status, 403);
  const h = await harness(data);
  assert.equal((await h.run({ emailId: CONFIRM, deliveryIds: [id(1)] })).status, 400, 'confirmation flag required');
  assert.equal((await h.run({ emailId: CONFIRM, deliveryIds: [], confirm: true })).status, 400);
  assert.equal((await h.run({ emailId: CONFIRM, deliveryIds: Array.from({ length: 26 }, (_, i) => id(100 + i)), confirm: true })).status, 400);
  assert.equal((await h.run({ emailId: CONFIRM, deliveryIds: [id(1)], confirm: true }, 'GET')).status, 405);
  assert.equal(h.confirmations.length + h.scheduled.length, 0);
});

test('confirmation resend sends once per booking, uses the selected setting and never resends delivered/accepted rows', async () => {
  const data = fixture();
  const h = await harness(data);
  const res = await h.run({ emailId: CONFIRM, deliveryIds: [id(1), id(2), id(3), id(4), id(5), id(9)], confirm: true });
  assert.equal(res.status, 200);
  const by = Object.fromEntries(res.body.results.map(r => [r.deliveryId, r]));
  // Rows 1 and 2 are superseded by the later accepted/delivered sends for the same booking.
  assert.equal(by[id(1)].reason, 'Already resent');
  assert.equal(by[id(2)].reason, 'Already resent');
  assert.match(by[id(3)].reason, /Delivered/);
  assert.match(by[id(4)].reason, /awaiting confirmation/);
  assert.equal(by[id(5)].reason, 'Booking is cancelled');
  assert.equal(h.db.leases.size, 0, 'claims are released when nothing was sent');
  assert.equal(by[id(9)].reason, 'Send not found', 'other tenant rows are invisible');
  assert.equal(h.confirmations.length, 0);

  // Without the later sends, the two failed rows for one booking produce one resend.
  data.event_email_delivery = data.event_email_delivery.filter(r => ![id(3), id(4)].includes(r.id));
  const h2 = await harness(data);
  const second = await h2.run({ emailId: CONFIRM, deliveryIds: [id(2), id(1)], confirm: true });
  assert.equal(second.body.sent, 1);
  assert.equal(second.body.results[1].reason, 'A resend for this recipient is already in progress');
  assert.equal(h2.confirmations.length, 1);
  const [eventId, booking, attendee, , , tenantId, options] = h2.confirmations[0];
  assert.equal(eventId, EVENT);
  assert.equal(booking.id, BOOKING);
  assert.equal(attendee.email, 'new@example.invalid', 'sends to the current booking address');
  assert.equal(tenantId, TENANT);
  assert.equal(options.source, 'admin_resend');
  assert.deepEqual(options.emailConfigs.map(e => e.id), [CONFIRM]);
});

test('reminder resend re-queues the original scheduled row and sends through the worker claim', async () => {
  const data = fixture();
  const h = await harness(data);
  const res = await h.run({ emailId: REMIND, deliveryIds: [id(6), id(7), id(8)], confirm: true });
  const by = Object.fromEntries(res.body.results.map(r => [r.deliveryId, r]));
  assert.equal(by[id(6)].outcome, 'sent');
  assert.equal(by[id(7)].reason, 'Already queued to send');
  assert.match(by[id(8)].reason, /No longer eligible: Booking cancelled/);
  assert.equal(h.scheduled.length, 1);
  assert.equal(h.scheduled[0].row.id, SCHED);
  assert.equal(h.scheduled[0].opts.source, 'admin_resend');
  assert.equal(h.scheduled[0].row.scheduled_send_time, '2027-02-01T09:00:00Z', 'timing identity unchanged');
  assert.equal(data.scheduled_email.find(r => r.id === SCHED).status, 'pending', 're-queued for the claim');
  assert.deepEqual(h.db.writes.map(w => w.table), ['scheduled_email']);
  // Wrong setting for the row: nothing is sent.
  const wrong = await h.run({ emailId: CONFIRM, deliveryIds: [id(6)], confirm: true });
  assert.equal(wrong.body.results[0].reason, 'Send not found');
});

test('recipient list marks failed rows resendable and superseded rows as resent', async () => {
  const data = fixture();
  data.event_email_delivery = data.event_email_delivery.filter(r => r.id !== id(4));
  const list = await loadEventEmailRecipients(fakeDb(data), TENANT, EVENT, CONFIRM, { page: 1, pageSize: 25 });
  const by = Object.fromEntries(list.recipients.map(r => [r.id, r]));
  assert.equal(by[id(3)].resendable, false);
  assert.equal(by[id(1)].resent, true);
  assert.equal(by[id(1)].resendable, false);
  assert.equal(by[id(5)].resendable, true, 'eligibility beyond the ledger is checked at send time');
  data.event_email_delivery = data.event_email_delivery.filter(r => r.id !== id(3));
  const again = await loadEventEmailRecipients(fakeDb(data), TENANT, EVENT, CONFIRM, { page: 1, pageSize: 25 });
  assert.equal(again.recipients.find(r => r.id === id(2)).resendable, true);
});

test('overlapping requests cannot both resend: the persisted claim is taken before preparation', async () => {
  const data = fixture();
  data.event_email_delivery = data.event_email_delivery.filter(r => ![id(3), id(4)].includes(r.id));
  const db = fakeDb(data);
  let releaseFirst, entered;
  const paused = new Promise(resolve => { releaseFirst = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  let sends = 0;
  const h = await harness(data, { db, sendConfirmation: async () => { sends++; entered(); await paused; return [{ success: true }]; } });
  const first = h.run({ emailId: CONFIRM, deliveryIds: [id(1)], confirm: true });
  await started; // first request is mid-send, before any new ledger row exists
  const second = await h.run({ emailId: CONFIRM, deliveryIds: [id(1)], confirm: true });
  const third = await h.run({ emailId: CONFIRM, deliveryIds: [id(2)], confirm: true });
  assert.equal(second.body.results[0].reason, 'A resend for this recipient is already in progress');
  assert.equal(third.body.results[0].reason, 'A resend for this recipient is already in progress', 'other failed row for the same booking');
  releaseFirst();
  assert.equal((await first).body.sent, 1);
  assert.equal(sends, 1);
  assert.equal(db.leases.size, 1, 'an accepted resend keeps its lease until it expires');
});

test('scheduled resend refuses a row a worker has claimed and never reports a queued row as sent', async () => {
  const { SCHEDULED_EMAIL_CLAIM_MESSAGE } = await import('../cron/send-event-reminders.js');
  const data = fixture();
  const sched = data.scheduled_email.find(r => r.id === SCHED);
  Object.assign(sched, { status: 'failed', error_message: SCHEDULED_EMAIL_CLAIM_MESSAGE });
  const h = await harness(data);
  const busy = await h.run({ emailId: REMIND, deliveryIds: [id(6)], confirm: true });
  assert.match(busy.body.results[0].reason, /in progress or its outcome is unknown/);
  assert.equal(h.scheduled.length, 0);
  assert.equal(sched.status, 'failed', 'claimed row is never re-queued');
  assert.equal(h.db.leases.size, 0);

  // A worker can claim the row between the re-queue and our claim attempt.
  Object.assign(sched, { status: 'failed', error_message: 'Mailbox unavailable' });
  for (const outcome of ['not_claimed', 'claim_error']) {
    const db = fakeDb(data);
    const q = await harness(data, { db, processScheduled: async () => ({ outcome }) });
    const res = await q.run({ emailId: REMIND, deliveryIds: [id(6)], confirm: true });
    assert.equal(res.body.sent, 0);
    assert.equal(res.body.queued, 1);
    assert.equal(db.leases.size, 1, 'lease held while the scheduler owns the send');
    Object.assign(sched, { status: 'failed', error_message: 'Mailbox unavailable' });
  }
  // Re-queue is conditional on the exact observed state.
  const raced = fakeDb(data);
  const original = raced.from;
  raced.from = table => { const q = original(table); if (table === 'scheduled_email') { const update = q.update; q.update = v => { sched.error_message = 'changed by worker'; return update(v); }; } return q; };
  const r = await (await harness(data, { db: raced })).run({ emailId: REMIND, deliveryIds: [id(6)], confirm: true });
  assert.equal(r.body.results[0].reason, 'Changed while resending; reload and try again');
});

test('an unavailable claim function fails closed without sending', async () => {
  const data = fixture();
  data.event_email_delivery = data.event_email_delivery.filter(r => ![id(3), id(4)].includes(r.id));
  data.claimUnavailable = true;
  const h = await harness(data);
  const res = await h.run({ emailId: CONFIRM, deliveryIds: [id(1)], confirm: true });
  assert.equal(res.body.failed, 1);
  assert.match(res.body.results[0].reason, /nothing was sent/);
  assert.equal(h.confirmations.length, 0);
});

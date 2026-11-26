import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  sendTrackedEventEmail, applyEventEmailProviderEvent, eventEmailDeliveryIdFrom,
  loadEventEmailStats, syncEventEmailDeliveries, EVENT_EMAIL_DELIVERY_VARIABLE,
} from './eventEmailDelivery.js';

const DELIVERY = '33333333-3333-4333-8333-333333333333';
const TENANT = '44444444-4444-4444-8444-444444444444';
const EVENT = '55555555-5555-4555-8555-555555555555';
const SETTING = '66666666-6666-4666-8666-666666666666';
const context = { tenantId: TENANT, eventId: EVENT, eventEmailId: SETTING, emailType: 'reminder',
  bookingId: null, recipientEmail: 'fixture@example.invalid', scheduledEmailId: null, source: 'test' };

function ledgerDb({ insertError = null, throwOnInsert = false } = {}) {
  const inserts = [], rpcs = [];
  return {
    inserts, rpcs,
    from(table) {
      return {
        insert(row) {
          if (throwOnInsert) throw new Error('ledger offline');
          inserts.push({ table, row });
          return { select() { return { async single() { return insertError ? { data: null, error: insertError } : { data: { id: DELIVERY }, error: null }; } }; } };
        },
      };
    },
    async rpc(name, args) { rpcs.push({ name, args }); return { data: null, error: null }; },
  };
}

test('accepted send records the ledger row, custom variable and normalized message id', async () => {
  const db = ledgerDb(); const sent = [];
  const result = await sendTrackedEventEmail(db, context, { to: 'fixture@example.invalid', subject: 'S' },
    async payload => { sent.push(payload); return { success: true, messageId: '<abc@mg.example>', domain: 'mg.example' }; });
  assert.equal(result.success, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].eventEmailDelivery, DELIVERY);
  assert.equal(db.inserts[0].row.email_type, 'reminder');
  assert.equal(db.inserts[0].row.event_email_id, SETTING);
  assert.deepEqual(db.rpcs.map(r => r.name), ['record_event_email_send_result']);
  assert.equal(db.rpcs[0].args.p_accepted, true);
  assert.equal(db.rpcs[0].args.p_message_id, 'abc@mg.example');
  assert.equal(db.rpcs[0].args.p_domain, 'mg.example');
});

test('rejected and thrown sends are recorded as failures without retrying', async () => {
  const db = ledgerDb(); let calls = 0;
  const rejected = await sendTrackedEventEmail(db, context, { to: 'x@example.invalid' },
    async () => { calls++; return { success: false, error: 'Domain not found' }; });
  assert.equal(rejected.success, false);
  assert.equal(db.rpcs[0].args.p_accepted, false);
  assert.equal(db.rpcs[0].args.p_reason, 'Domain not found');
  await assert.rejects(sendTrackedEventEmail(db, context, { to: 'x@example.invalid' },
    async () => { calls++; throw new Error('socket timeout'); }), /socket timeout/);
  assert.equal(db.rpcs[1].args.p_accepted, false);
  assert.equal(db.rpcs[1].args.p_reason, 'socket timeout');
  assert.equal(calls, 2);
});

test('ledger failures never block or duplicate the real send', async (t) => {
  t.mock.method(console, 'warn', () => {});
  for (const db of [ledgerDb({ insertError: { message: 'relation missing' } }), ledgerDb({ throwOnInsert: true })]) {
    const sent = [];
    const result = await sendTrackedEventEmail(db, context, { to: 'x@example.invalid' },
      async payload => { sent.push(payload); return { success: true, messageId: 'm' }; });
    assert.equal(result.success, true);
    assert.equal(sent.length, 1);
    assert.equal('eventEmailDelivery' in sent[0], false);
    assert.equal(db.rpcs.length, 0);
  }
  const failingResult = { from: ledgerDb().from, async rpc() { throw new Error('rpc down'); } };
  let calls = 0;
  const result = await sendTrackedEventEmail(failingResult, context, { to: 'x' }, async () => { calls++; return { success: true }; });
  assert.equal(result.success, true);
  assert.equal(calls, 1);
});

test('provider events map to the shared classification and pass the provider event id', async () => {
  const db = ledgerDb();
  const base = { recipient: 'x@example.invalid', 'user-variables': { [EVENT_EMAIL_DELIVERY_VARIABLE]: DELIVERY },
    message: { headers: { 'message-id': '<abc@mg.example>' } }, timestamp: 1800000000 };
  assert.equal(eventEmailDeliveryIdFrom({ 'user-variables': { [EVENT_EMAIL_DELIVERY_VARIABLE]: 'not-a-uuid' } }), null);
  for (const [event, kind] of [
    [{ event: 'delivered', id: 'e1' }, 'delivered'],
    [{ event: 'opened', id: 'e2' }, 'opened'],
    [{ event: 'failed', id: 'e3', severity: 'temporary' }, 'soft_bounce'],
    [{ event: 'failed', id: 'e4', severity: 'permanent', reason: 'bounce', 'delivery-status': { code: 550 } }, 'hard_bounce'],
  ]) {
    await applyEventEmailProviderEvent(db, { ...base, ...event });
    const call = db.rpcs.at(-1);
    assert.equal(call.name, 'apply_event_email_delivery_event');
    assert.equal(call.args.p_kind, kind);
    assert.equal(call.args.p_delivery_id, DELIVERY);
    assert.equal(call.args.p_message_id, 'abc@mg.example');
    assert.equal(call.args.p_provider_event_id, event.id);
    assert.equal(call.args.p_event_at, new Date(1800000000 * 1000).toISOString());
    // The database compares this with the ledger recipient so CC copies never match.
    assert.equal(call.args.p_recipient, 'x@example.invalid');
  }
});

test('stats aggregation converts database counts per email setting', async () => {
  const db = {
    async rpc(name, args) {
      assert.equal(name, 'event_email_delivery_stats');
      assert.deepEqual(args, { p_tenant_id: TENANT, p_event_id: EVENT });
      return { data: [{ event_email_id: SETTING, total: '5', sent: '4', delivered: '2', awaiting: '1', opened: '1', failed: '2', sending: '0', first_tracked_at: 'x', last_sent_at: 'y' }], error: null };
    },
    from(table) {
      assert.equal(table, 'event_email_delivery_tracking');
      return { select() { return { async maybeSingle() { return { data: { started_at: '2027-02-01T00:00:00Z' }, error: null }; } }; } };
    },
  };
  const stats = await loadEventEmailStats(db, TENANT, EVENT);
  assert.equal(stats.trackingStartedAt, '2027-02-01T00:00:00Z');
  assert.deepEqual(stats.emails[SETTING], { total: 5, sent: 4, delivered: 2, awaiting: 1, opened: 1, failed: 2, sending: 0, firstTrackedAt: 'x', lastSentAt: 'y' });
});

test('recovery applies only events for tracked ledger rows and pages until empty', async () => {
  const rpcs = [];
  const db = {
    from() {
      const q = { select() { return q; }, gte() { return q; }, not() { return q; }, order() { return q; },
        async range() { return { data: [{ id: DELIVERY, tenant_id: TENANT, mailgun_domain: 'mg.example', created_at: '2027-02-01T00:00:00Z' }], error: null }; } };
      return q;
    },
    async rpc(name, args) { rpcs.push(args); return { data: { matched: true, applied: true }, error: null }; },
  };
  const fetched = [];
  const tracked = { event: 'delivered', id: 'p1', 'user-variables': { [EVENT_EMAIL_DELIVERY_VARIABLE]: DELIVERY } };
  const other = { event: 'delivered', id: 'p2', 'user-variables': { [EVENT_EMAIL_DELIVERY_VARIABLE]: SETTING } };
  const campaign = { event: 'delivered', id: 'p3', recipient: 'x@example.invalid', 'user-variables': { iconn_campaign_id: SETTING } };
  const summary = await syncEventEmailDeliveries(db, async (domain, params) => {
    fetched.push([domain, params.event]);
    return params.event === 'delivered' ? { items: [tracked, other, campaign], paging: { next: 'next-page' } } : { items: [] };
  }, { fetchNext: async () => ({ items: [], paging: { next: 'again' } }) });
  assert.deepEqual(fetched, [['mg.example', 'delivered'], ['mg.example', 'opened'], ['mg.example', 'failed']]);
  assert.equal(rpcs.length, 1);
  assert.equal(rpcs[0].p_provider_event_id, 'p1');
  assert.equal(summary.applied, 1);
});

async function loadWebhook(database) {
  let source = await readFile(new URL('../webhooks/mailgun.js', import.meta.url), 'utf8');
  source = source.replace(/import \{ supabase \} from '[^']+';/, 'const supabase = globalThis.__eventEmailWebhookDb;');
  source = source.replace(/from '\.\.\/_lib\/([^']+)'/g, (_, file) => `from '${new URL(`./${file}`, import.meta.url).href}'`);
  globalThis.__eventEmailWebhookDb = database;
  const module = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}#${Math.random()}`);
  delete globalThis.__eventEmailWebhookDb;
  return module;
}

test('webhook updates the event email ledger before, and instead of, campaign matching', async (t) => {
  t.mock.method(console, 'log', () => {});
  const tables = [], rpcs = [], evidence = [];
  const db = {
    from(table) {
      tables.push(table);
      if (table !== 'email_event') assert.fail(`event email must not query ${table}`);
      return { async insert(row) { evidence.push(row); return { error: null }; } };
    },
    async rpc(name, args) { rpcs.push({ name, args }); return { data: { matched: true, applied: true, tenant_id: TENANT }, error: null }; },
  };
  const { default: handler } = await loadWebhook(db);
  for (const event of ['delivered', 'opened', 'failed']) {
    let status, body;
    await handler({ method: 'POST', body: { 'event-data': { event, id: `ev-${event}`, severity: 'permanent', recipient: 'fixture@example.invalid',
      'user-variables': { [EVENT_EMAIL_DELIVERY_VARIABLE]: DELIVERY }, message: { headers: { 'message-id': '<m1>' } } } } },
    { status(code) { status = code; return this; }, json(value) { body = value; } });
    assert.equal(status, 200);
    assert.equal(body.eventEmail, true);
  }
  assert.deepEqual(rpcs.map(r => r.args.p_kind), ['delivered', 'opened', 'hard_bounce']);
  assert.ok(tables.every(table => table === 'email_event'));
  assert.ok(evidence.every(row => row.campaign_id === undefined && row.recipient_id === undefined && row.tenant_id === TENANT));
});

test('webhook requests a retry when the ledger update fails', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'error', () => {});
  const db = { from() { assert.fail('no evidence write before ledger succeeds'); }, async rpc() { return { data: null, error: { message: 'down' } }; } };
  const { default: handler } = await loadWebhook(db);
  let status;
  await handler({ method: 'POST', body: { event: 'delivered', id: 'x', recipient: 'x@example.invalid', 'user-variables': { [EVENT_EMAIL_DELIVERY_VARIABLE]: DELIVERY } } },
    { status(code) { status = code; return this; }, json() {} });
  assert.equal(status, 500);
});

test('stats endpoint is admin guarded, tenant scoped and read-only', async () => {
  const { createStatsHandler } = await import('../event-emails/[eventId]/stats.js');
  const calls = [];
  const db = {
    from(table) {
      const filters = {};
      const q = {
        select() { return q; },
        eq(k, v) { filters[k] = v; return q; },
        order() { return q; },
        async maybeSingle() {
          calls.push({ table, filters });
          if (table === 'event') return { data: filters.tenant_id === TENANT ? { id: EVENT } : null, error: null };
          if (table === 'complex_event') return { data: null, error: null };
          if (table === 'event_email') return { data: filters.event_id === EVENT && filters.id === SETTING ? { id: SETTING } : null, error: null };
          if (table === 'event_email_delivery_tracking') return { data: { started_at: '2027-02-01T00:00:00Z' }, error: null };
          return { data: null, error: null };
        },
        async range() { calls.push({ table, filters }); return { data: [{ id: DELIVERY, recipient_email: 'x@example.invalid', status: 'failed', failure_source: 'provider', failure_reason: 'Bounced', open_count: 0 }], error: null, count: 1 }; },
        insert() { assert.fail('stats must not write'); }, update() { assert.fail('stats must not write'); },
      };
      return q;
    },
    async rpc(name) { assert.equal(name, 'event_email_delivery_stats'); return { data: [], error: null }; },
  };
  const run = async (ctx, query, admin = true) => {
    let status, body;
    await createStatsHandler({ db, getContext: async () => ctx, isAdmin: async () => admin })(
      { method: 'GET', query }, { status(code) { status = code; return this; }, json(value) { body = value; } });
    return { status, body };
  };
  assert.equal((await run({ isAuthenticated: false }, { eventId: EVENT })).status, 401);
  assert.equal((await run({ isAuthenticated: true, tenantId: TENANT }, { eventId: EVENT }, false)).status, 403);
  assert.equal((await run({ isAuthenticated: true, tenantId: SETTING }, { eventId: EVENT })).status, 404);
  assert.equal((await run({ isAuthenticated: true, tenantId: TENANT }, { eventId: EVENT, emailId: DELIVERY })).status, 404);
  const stats = await run({ isAuthenticated: true, tenantId: TENANT }, { eventId: EVENT });
  assert.equal(stats.status, 200);
  assert.equal(stats.body.trackingStartedAt, '2027-02-01T00:00:00Z');
  const list = await run({ isAuthenticated: true, tenantId: TENANT }, { eventId: EVENT, emailId: SETTING, page: '1' });
  assert.equal(list.status, 200);
  assert.equal(list.body.recipients[0].status, 'bounced_or_failed');
  assert.equal(list.body.recipients[0].failureReason, 'Bounced');
  const ledgerRead = calls.find(c => c.table === 'event_email_delivery');
  assert.deepEqual(ledgerRead.filters, { tenant_id: TENANT, event_id: EVENT, event_email_id: SETTING });
});

test('sendEmail tags event emails with a dedicated variable and opens-only tracking', async () => {
  const { sendEmail } = await import('./emailService.js');
  const prepare = extra => sendEmail({ to: 'x@example.invalid', tenantId: 'tenant', subject: 'S', html: '<p>B</p>',
    resolveTransactionalPreferences: false, ...extra }, { prepareOnly: true,
    client: { messages: { create: () => assert.fail('no submission') } },
    getTenantEmailConfig: async () => null, getEmailFooter: async () => '', replaceSocialPlaceholdersInFooter: async h => h });
  const tracked = (await prepare({ eventEmailDelivery: DELIVERY })).prepared.messageData;
  assert.equal(tracked['v:iconn_event_email_delivery'], DELIVERY);
  assert.equal(tracked['o:tracking-opens'], 'yes');
  assert.equal(tracked['o:tracking-clicks'], 'no');
  assert.equal(tracked['v:iconn_campaign_id'], undefined);
  const plain = (await prepare({ eventEmailDelivery: 'not-a-uuid' })).prepared.messageData;
  assert.equal(plain['v:iconn_event_email_delivery'], undefined);
  assert.equal(plain['o:tracking-opens'], undefined);
  const forced = (await prepare({ eventEmailDelivery: DELIVERY, enableTracking: true })).prepared.messageData;
  assert.equal(forced['o:tracking-clicks'], 'no');
  const bearer = (await prepare({ eventEmailDelivery: DELIVERY, disableTracking: true })).prepared.messageData;
  assert.equal(bearer['o:tracking-opens'], 'no');
  assert.equal(bearer['o:tracking-clicks'], 'no');
});

test('webhook: a CC recipient event is passed through for recipient matching and never reaches campaign matching', async (t) => {
  t.mock.method(console, 'log', () => {});
  const rpcs = [], evidence = [];
  const db = {
    from(table) { assert.equal(table, 'email_event'); return { async insert(row) { evidence.push(row); return { error: null }; } }; },
    async rpc(name, args) { rpcs.push(args); return { data: { matched: false, reason: 'recipient_mismatch', tenant_id: TENANT }, error: null }; },
  };
  const { default: handler } = await loadWebhook(db);
  let status, body;
  await handler({ method: 'POST', body: { 'event-data': { event: 'failed', severity: 'permanent', id: 'cc-bounce', recipient: 'cc@example.invalid',
    'user-variables': { [EVENT_EMAIL_DELIVERY_VARIABLE]: DELIVERY }, message: { headers: { 'message-id': '<m1>' } } } } },
  { status(code) { status = code; return this; }, json(value) { body = value; } });
  assert.equal(status, 200);
  assert.equal(body.eventEmail, false);
  assert.equal(rpcs[0].p_recipient, 'cc@example.invalid');
  assert.equal(evidence[0].campaign_id, undefined);
});

test('recovery passes the provider recipient so CC copies cannot change the attendee row', async () => {
  const rpcs = [];
  const db = {
    from() {
      const q = { select() { return q; }, gte() { return q; }, not() { return q; }, order() { return q; },
        async range() { return { data: [{ id: DELIVERY, tenant_id: TENANT, mailgun_domain: 'mg.example', created_at: '2027-02-01T00:00:00Z' }], error: null }; } };
      return q;
    },
    async rpc(name, args) { rpcs.push(args); return { data: { matched: args.p_recipient === 'attendee@example.invalid', applied: args.p_recipient === 'attendee@example.invalid' }, error: null }; },
  };
  const vars = { [EVENT_EMAIL_DELIVERY_VARIABLE]: DELIVERY };
  const summary = await syncEventEmailDeliveries(db, async (_domain, params) => params.event === 'opened'
    ? { items: [{ event: 'opened', id: 'o1', recipient: 'cc@example.invalid', 'user-variables': vars },
                { event: 'opened', id: 'o2', recipient: 'attendee@example.invalid', 'user-variables': vars }] }
    : { items: [] });
  assert.deepEqual(rpcs.map(r => r.p_recipient), ['cc@example.invalid', 'attendee@example.invalid']);
  assert.equal(summary.applied, 1);
});

test('funnel confirmations are tracked per send while the receipt journal still governs sending', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const { deliverFunnelConfirmations } = await import('./eventFunnelConfirmations.js');
  const item = { id: '11111111-1111-4111-8111-111111111111', receipt_token: '22222222-2222-4222-8222-222222222222',
    event_id: EVENT, template_id: SETTING, booking_id: 'booking-1', booking: { id: 'booking-1', attendee_email: 'attendee@example.invalid' },
    template: { id: SETTING, email_type: 'booking_confirmation' } };
  let state = 'pending', payload; const inserts = [], ledgerRpcs = [];
  const db = {
    from(table) {
      if (table === 'event_funnel_membership_entitlement') {
        const q = { select: () => q, eq: () => q, order: () => q, then: resolve => resolve({ data: [] }) }; return q;
      }
      assert.equal(table, 'event_email_delivery');
      return { insert(row) { inserts.push(row); return { select() { return { async single() { return { data: { id: DELIVERY }, error: null }; } }; } }; } };
    },
    async rpc(name, args) {
      if (name !== 'event_funnel_confirmation_operation') { ledgerRpcs.push({ name, args }); return { data: true, error: null }; }
      if (args.p_action === 'read') return { data: { status: state === 'pending' ? 'retry' : state, jobs: state === 'pending' ? [item] : [] } };
      if (args.p_action === 'begin') { if (state !== 'pending') return { data: { status: state } }; payload ??= args.p_payload; state = 'writing'; return { data: { status: 'send', payload } }; }
      state = args.p_payload.outcome === 'delivered' ? 'delivered' : 'needs_review';
      return { data: { saved: true } };
    },
  };
  const sent = [];
  const send = async envelope => { sent.push(envelope); return { success: true, messageId: '<funnel-message>', domain: 'mg.example' }; };
  const render = async (_event, booking, _a, _u, _p, tenant, options) => [await options.send({ tenantId: tenant, to: booking.attendee_email, html: 'x' })];
  assert.equal((await deliverFunnelConfirmations({ db, job: { tenant_id: TENANT, order_id: 'order', lease_token: 'lease' }, send, render })).status, 'delivered');
  assert.equal((await deliverFunnelConfirmations({ db, job: { tenant_id: TENANT, order_id: 'order', lease_token: 'lease' }, send, render })).status, 'delivered');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].eventEmailDelivery, DELIVERY);
  assert.deepEqual(sent[0].funnelReceipt, { id: item.id, token: item.receipt_token });
  assert.equal(inserts.length, 1);
  assert.equal(inserts[0].event_email_id, SETTING);
  assert.equal(inserts[0].event_id, EVENT);
  assert.equal(inserts[0].recipient_email, 'attendee@example.invalid');
  assert.equal(inserts[0].send_source, 'event_funnel');
  assert.deepEqual(ledgerRpcs.map(r => [r.name, r.args.p_accepted, r.args.p_message_id]), [['record_event_email_send_result', true, 'funnel-message']]);
});

test('webhook updates both the funnel receipt and the event email ledger, retrying only via idempotent replay', async (t) => {
  t.mock.method(console, 'error', () => {});
  const { createHmac } = await import('node:crypto');
  const key = 'fixture-signing-key';
  const previous = process.env.MAILGUN_WEBHOOK_SIGNING_KEY;
  process.env.MAILGUN_WEBHOOK_SIGNING_KEY = key;
  t.after(() => { if (previous === undefined) delete process.env.MAILGUN_WEBHOOK_SIGNING_KEY; else process.env.MAILGUN_WEBHOOK_SIGNING_KEY = previous; });
  const signature = { timestamp: '1795435200', token: 'fixture-token' };
  signature.signature = createHmac('sha256', key).update(signature.timestamp + signature.token).digest('hex');
  const body = event => ({ signature, 'event-data': { event, id: `funnel-${event}`, timestamp: 1795435200, recipient: 'attendee@example.invalid',
    message: { headers: { 'message-id': '<funnel-message>' } },
    'user-variables': { iconn_funnel_confirmation: '11111111-1111-4111-8111-111111111111', iconn_funnel_receipt: '22222222-2222-4222-8222-222222222222',
      [EVENT_EMAIL_DELIVERY_VARIABLE]: DELIVERY } } });
  let ledgerFails = true; const rpcs = [];
  const db = {
    from() { assert.fail('funnel events never reach campaign matching'); },
    async rpc(name, args) {
      rpcs.push([name, args.p_kind ?? args.p_event]);
      if (name === 'apply_event_email_delivery_event' && ledgerFails) return { data: null, error: { message: 'down' } };
      return { data: name === 'apply_event_email_delivery_event' ? { matched: true, applied: true } : true, error: null };
    },
  };
  const { default: handler } = await loadWebhook(db);
  const call = async event => { let status; await handler({ method: 'POST', body: body(event) }, { status(code) { status = code; return this; }, json() {} }); return status; };
  assert.equal(await call('delivered'), 500);
  ledgerFails = false;
  assert.equal(await call('delivered'), 200);
  assert.equal(await call('opened'), 200);
  assert.deepEqual(rpcs, [
    ['event_funnel_confirmation_receipt', 'delivered'], ['apply_event_email_delivery_event', 'delivered'],
    ['event_funnel_confirmation_receipt', 'delivered'], ['apply_event_email_delivery_event', 'delivered'],
    ['apply_event_email_delivery_event', 'opened'],
  ]);
});

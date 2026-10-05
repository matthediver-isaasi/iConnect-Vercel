// Task #4913: producer -> signed HTTP handler -> DEFAULT classifier and dispatcher.
// Run: node scripts/run-isolated-tests.mjs node --test api/webhooks/stripe-membership.monthly-card.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import Stripe from 'stripe';
import { executeCardAutoRenewal } from '../_lib/stripeCardRenewals.js';
import { handleStripeMembershipWebhook } from './stripe-membership.js';
import { STATUS } from '../_lib/gocardlessState.js';

// Synthetic identities, keys, secrets and provider resources only. The isolated
// runner fails even if production code catches an attempted external access.
const TENANT_ID = 'tenant-4913-synthetic';
const MEMBER_ID = 'member-4913-synthetic';
const SUBSCRIPTION_ID = 'sub_4913_synthetic';
const CUSTOMER_ID = 'cus_4913_synthetic';
const SESSION_ID = 'cs_4913_synthetic';
const NOW = new Date('2027-04-02T00:00:00.000Z');
const SECRETS = {
  live: 'whsec_4913_live_synthetic_only',
  test: 'whsec_4913_test_synthetic_only',
};
const KEYS = {
  live: 'sk_live_4913_synthetic_only',
  test: 'sk_test_4913_synthetic_only',
};
const CREDENTIALS = {
  membership_webhook_secret: SECRETS.live,
  test_membership_webhook_secret: SECRETS.test,
  secret_key: KEYS.live,
  test_secret_key: KEYS.test,
  // Deliberately opposite to one of the tested event modes: feature selection
  // must not override the signed event's livemode.
  stripe_mode_membership: 'live',
};
const ADDRESS = {
  line1: '4913 Synthetic Street',
  city: 'Test City',
  postal_code: 'TE5 1ST',
  country: 'GB',
};
const TABLES = [
  'membership_billing_agreements',
  'membership_payment_plans',
  'member_membership_history',
  'membership_payment_status_history',
  'payment_webhook_events',
];
const clone = (value) => structuredClone(value);

// Small, stateful PostgREST-shaped fixture. Filters, guarded writes and the
// global webhook event uniqueness constraint are real in-memory semantics,
// rather than canned processor outcomes. Unknown tables fail closed.
function memoryDb() {
  const rows = Object.fromEntries(TABLES.map((table) => [table, []]));
  const calls = [];
  let nextId = 0;
  const db = {
    async rpc(name) {
      assert.equal(name, 'membership_successor_elections_enabled');
      return { data: false };
    },
    from(table) {
      assert.ok(TABLES.includes(table), `unexpected database table: ${table}`);
      const call = { table, kind: 'select', filters: [] };
      calls.push(call);
      let payload;
      let settings;
      let result;
      const run = () => {
        if (result) return result;
        const matches = (row) => call.filters.every(([column, value]) => row[column] === value);
        let selected = rows[table].filter(matches);
        if (call.kind === 'update') {
          selected.forEach((row) => Object.assign(row, clone(payload)));
        } else if (call.kind === 'insert' || call.kind === 'upsert') {
          selected = [];
          for (const item of Array.isArray(payload) ? payload : [payload]) {
            const columns = settings?.onConflict?.split(',') || [];
            const prior = columns.length
              ? rows[table].find((row) => columns.every((column) => row[column] === item[column]))
              : null;
            if (prior && settings.ignoreDuplicates) continue;
            if (prior) {
              Object.assign(prior, clone(item));
              selected.push(prior);
            } else {
              const row = { id: `synthetic-row-${++nextId}`, ...clone(item) };
              rows[table].push(row);
              selected.push(row);
            }
          }
        }
        result = { data: clone(selected), error: null };
        return result;
      };
      const query = {
        select(columns = '*') { call.columns = columns; return this; },
        eq(column, value) { call.filters.push([column, value]); return this; },
        is(column, value) { call.filters.push([column, value]); return this; },
        insert(value) { call.kind = 'insert'; payload = value; return this; },
        upsert(value, options) {
          call.kind = 'upsert'; payload = value; settings = options;
          call.settings = clone(options);
          return this;
        },
        update(value) { call.kind = 'update'; payload = value; return this; },
        async maybeSingle() {
          const value = run();
          assert.ok(value.data.length <= 1, `ambiguous maybeSingle on ${table}`);
          return { ...value, data: value.data[0] || null };
        },
        async single() {
          const value = run();
          assert.equal(value.data.length, 1, `single requires one row on ${table}`);
          return { ...value, data: value.data[0] };
        },
        then(resolve, reject) { return Promise.resolve().then(run).then(resolve, reject); },
      };
      return query;
    },
  };
  return { db, rows, calls };
}

function eventFor(id, type, object, mode) {
  return {
    id, object: 'event', api_version: '2025-03-31.basil',
    created: Math.floor(NOW.getTime() / 1000), livemode: mode === 'live',
    type, data: { object: clone(object) },
  };
}

function signedRequest(event, secret) {
  const raw = JSON.stringify(event);
  const req = new EventEmitter();
  req.method = 'POST';
  req.query = { tenant: TENANT_ID };
  req.headers = {
    host: 'membership.example.test',
    'x-forwarded-proto': 'https',
    'stripe-signature': Stripe.webhooks.generateTestHeaderString({
      payload: raw,
      secret: secret || SECRETS[event.livemode ? 'live' : 'test'],
    }),
  };
  setImmediate(() => {
    const bytes = Buffer.from(raw);
    const midpoint = Math.floor(bytes.length / 2);
    req.emit('data', bytes.subarray(0, midpoint));
    req.emit('data', bytes.subarray(midpoint));
    req.emit('end');
  });
  return req;
}

async function harness(mode = 'test') {
  const storage = memoryDb();
  const subscriptions = { live: new Map(), test: new Map() };
  const calls = { creates: [], clients: [], retrievals: [], customerUpdates: [], signatures: [] };
  let retrievalError = false;
  const provider = (environment) => ({
    customers: {
      retrieve: async (id) => {
        assert.equal(id, CUSTOMER_ID);
        return { id, invoice_settings: { default_payment_method: 'pm_4913_synthetic' } };
      },
      update: async (id, params) => {
        assert.equal(id, CUSTOMER_ID);
        calls.customerUpdates.push({ mode: environment, id, params: clone(params) });
        return { id, ...clone(params) };
      },
    },
    paymentMethods: {
      list: async (params) => {
        assert.equal(params.customer, CUSTOMER_ID);
        return { data: [{ id: 'pm_4913_synthetic', type: 'card' }] };
      },
    },
    subscriptions: {
      create: async (params, options) => {
        calls.creates.push({ mode: environment, params: clone(params), options: clone(options) });
        const subscription = {
          id: SUBSCRIPTION_ID, object: 'subscription', status: 'active',
          customer: params.customer, metadata: clone(params.metadata),
          billing_cycle_anchor: Math.floor(NOW.getTime() / 1000),
          cancel_at: params.cancel_at,
          latest_invoice: null,
          items: { data: [{ price: 'price_4913_synthetic', quantity: 1 }] },
        };
        subscriptions[environment].set(subscription.id, subscription);
        return clone(subscription);
      },
      retrieve: async (id) => {
        calls.retrievals.push({ mode: environment, id });
        if (retrievalError) throw new Error('synthetic provider unavailable');
        assert.ok(subscriptions[environment].has(id), `unexpected ${environment} subscription: ${id}`);
        return clone(subscriptions[environment].get(id));
      },
    },
    // Renewal creates a direct finite cancellation boundary. Checkout's real
    // verifier requires this interface but must preserve the earlier boundary.
    subscriptionSchedules: {
      create: async () => assert.fail('must preserve the producer cancellation boundary'),
      retrieve: async () => assert.fail('no schedule was emitted by this renewal'),
      update: async () => assert.fail('must preserve the producer cancellation boundary'),
    },
  });

  // Exercise an ACTUAL monthly-card producer, including default plan creation.
  // Public checkout is a non-injectable handler; renewal exposes in-memory
  // dependencies and emits the identical production subscription discriminator.
  const outcome = await executeCardAutoRenewal({
    tenantId: TENANT_ID,
    memberId: MEMBER_ID,
    previousAgreement: {
      id: 'previous-agreement-4913-synthetic', tenant_id: TENANT_ID, member_id: MEMBER_ID,
      stripe_customer_id: CUSTOMER_ID, environment: mode,
      metadata: { card: { membership_year: '2026/27', start_mode: 'fixed_date' } },
    },
    renewalRow: null,
    deps: {
      db: storage.db,
      now: () => new Date(NOW),
      simulate: async () => ({
        success: true, currency: 'GBP', tierLabel: 'Synthetic tier', annualCost: 300,
        membershipYear: { label: '2027/28', start: '2027-04-01' },
        config: {
          id: 'config-4913-synthetic', pricing_model: 'flat', start_mode: 'fixed_date',
          card_monthly_enabled: true, dd_monthly_amount: 25, dd_instalment_count: 12,
          dd_activation_rule: 'first_payment', dd_invoicing_mode: 'annual', dd_auto_renew: true,
        },
      }),
      getStripe: async (_tenantId, preferredMode) => {
        assert.equal(_tenantId, TENANT_ID);
        assert.equal(preferredMode, mode);
        return { stripe: provider(mode), environment: mode };
      },
      sendEmail: async () => ({ sent: false, reason: 'synthetic fixture: no email delivery' }),
    },
  });
  assert.equal(outcome.renewed, true);
  assert.equal(calls.creates.length, 1);
  const emitted = calls.creates[0].params;
  // Independent assertion: changing the shared constant cannot silently change
  // both the test's input and its expected production wire contract.
  assert.equal(emitted.metadata.kind, 'monthly_card');
  assert.equal(emitted.metadata.tenant_id, TENANT_ID);
  assert.equal(emitted.metadata.member_id, MEMBER_ID);
  assert.equal(emitted.items[0].price_data.unit_amount, 2500);
  assert.equal(emitted.off_session, true);
  assert.equal(emitted.payment_behavior, 'error_if_incomplete');
  assert.equal(storage.rows.membership_payment_plans.length, 1);

  const agreement = storage.rows.membership_billing_agreements[0];
  // A synthetic completed Checkout envelope exercises the handler's checkout
  // branch using metadata ACTUALLY emitted to subscriptions.create above.
  // This is not a claim that the off-session producer opens a Checkout session.
  agreement.stripe_checkout_session_id = SESSION_ID;
  const session = {
    id: SESSION_ID, object: 'checkout.session', mode: 'subscription',
    subscription: SUBSCRIPTION_ID, customer: CUSTOMER_ID,
    metadata: clone(emitted.metadata), customer_details: { address: clone(ADDRESS) },
  };
  // The same resource id in the other mode belongs to a different product.
  // A wrong-mode lookup cannot accidentally satisfy the ownership classifier.
  subscriptions[mode === 'live' ? 'test' : 'live'].set(SUBSCRIPTION_ID, {
    id: SUBSCRIPTION_ID, metadata: { tenant_id: TENANT_ID, kind: 'other_product' },
  });
  class SyntheticStripe {
    static webhooks = {
      constructEvent(raw, signature, secret) {
        calls.signatures.push(secret);
        return Stripe.webhooks.constructEvent(raw, signature, secret);
      },
    };
    constructor(key) {
      calls.clients.push(key);
      const environment = Object.keys(KEYS).find((candidate) => KEYS[candidate] === key);
      assert.ok(environment, 'only synthetic mode-specific keys may be used');
      Object.assign(this, provider(environment));
    }
  }
  const credentials = { ...CREDENTIALS };
  const dependencies = {
    db: storage.db,
    StripeClient: SyntheticStripe,
    getStripeIntegrationCredentials: async (tenantId) => {
      assert.equal(tenantId, TENANT_ID);
      return credentials;
    },
    // Intentionally NO classifyStripeMembershipEventTenant or
    // processStripeCardPlanEvent injection: both defaults must be exercised.
  };
  storage.calls.length = 0;
  return {
    ...storage, dbCalls: storage.calls, calls, mode, agreement, session, emitted, credentials,
    subscription: subscriptions[mode].get(SUBSCRIPTION_ID),
    failRetrieval() { retrievalError = true; },
    invoice(id = 'in_4913_synthetic_1') {
      return {
        id, object: 'invoice', status: 'paid', paid: true, currency: 'gbp',
        amount_paid: emitted.items[0].price_data.unit_amount,
        amount_due: emitted.items[0].price_data.unit_amount, amount_remaining: 0,
        billing_reason: 'subscription_cycle',
        parent: { type: 'subscription_details', subscription_details: {
          subscription: SUBSCRIPTION_ID, metadata: clone(emitted.metadata),
        } },
        lines: { data: [] },
      };
    },
    event(id, type, object) { return eventFor(id, type, object, mode); },
    async deliver(event, secret) {
      const res = {
        statusCode: 200, body: null,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; },
      };
      await handleStripeMembershipWebhook(signedRequest(event, secret), res, dependencies);
      return res;
    },
  };
}

function webhookRow(h, eventId) {
  const row = h.rows.payment_webhook_events.find((item) => item.event_id === eventId);
  assert.ok(row, `missing durable event ${eventId}`);
  assert.equal(row.tenant_id, TENANT_ID);
  assert.equal(row.provider, 'stripe-membership');
  const upserts = h.dbCalls.filter((call) => (
    call.table === 'payment_webhook_events' && call.kind === 'upsert'
  ));
  assert.ok(upserts.length > 0);
  assert.ok(upserts.every((call) => (
    call.settings.onConflict === 'provider,event_id' && call.settings.ignoreDuplicates === true
  )));
  const marks = h.dbCalls.filter((call) => (
    call.table === 'payment_webhook_events' && call.kind === 'update'
  ));
  assert.ok(marks.every((call) => (
    call.filters.some(([column, value]) => column === 'id' && typeof value === 'string')
    && call.filters.some(([column, value]) => column === 'tenant_id' && value === TENANT_ID)
  )));
  return row;
}

function assertProcessed(res) {
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.status, 'processed');
}

function assertModeBound(h) {
  assert.ok(h.calls.clients.length > 0);
  assert.ok(h.calls.clients.every((key) => key === KEYS[h.mode]));
  assert.ok(h.calls.retrievals.every((call) => call.mode === h.mode));
  assert.ok(h.calls.customerUpdates.every((call) => call.mode === h.mode));
  assert.ok(h.calls.signatures.every((secret) => secret === SECRETS[h.mode]));
}

for (const mode of ['live', 'test']) {
  test(`${mode}: producer metadata survives signed checkout, paid instalments, dedupe and deletion through real dispatcher`, async () => {
    const h = await harness(mode);
    const checkout = h.event('evt_4913_checkout', 'checkout.session.completed', h.session);
    const checkoutResult = await h.deliver(checkout);
    assertProcessed(checkoutResult);
    assert.match(checkoutResult.body.detail, /checkout completed: earlier finite-plan boundary preserved; plan already exists/);
    assert.equal(webhookRow(h, checkout.id).processing_status, 'processed');
    assert.equal(h.rows.membership_payment_plans.length, 1);
    assert.equal(h.rows.membership_payment_plans[0].instalments_paid, 0);
    assert.deepEqual(h.agreement.metadata.stripe_billing_address.line1, ADDRESS.line1);
    assert.equal(h.calls.customerUpdates.length, 1);

    const invoice = h.event('evt_4913_paid', 'invoice.paid', h.invoice());
    const paid = await h.deliver(invoice);
    assertProcessed(paid);
    assert.match(paid.body.detail, /instalment 1\/12 paid/);
    const plan = h.rows.membership_payment_plans[0];
    const history = h.rows.member_membership_history[0];
    assert.equal(plan.instalments_paid, 1);
    assert.deepEqual(plan.metadata.paid_invoice_ids, [invoice.data.object.id]);
    assert.equal(plan.status, STATUS.ACTIVE);
    assert.equal(h.agreement.status, STATUS.ACTIVE);
    assert.equal(history.status, 'active');
    assert.equal(history.payment_status, 'partial');
    assert.equal(webhookRow(h, invoice.id).processing_status, 'processed');
    assert.deepEqual(webhookRow(h, invoice.id).payload, invoice);

    const beforeDuplicate = clone(h.rows);
    const duplicate = await h.deliver(invoice);
    assert.equal(duplicate.body.status, 'duplicate');
    assert.deepEqual(h.rows, beforeDuplicate);
    const sameInvoice = h.event('evt_4913_same_invoice', 'invoice.payment_succeeded', h.invoice());
    const sameResult = await h.deliver(sameInvoice);
    assertProcessed(sameResult);
    assert.match(sameResult.body.detail, /already counted/);
    assert.equal(plan.instalments_paid, 1);
    const second = h.event('evt_4913_second', 'invoice.payment_succeeded', h.invoice('in_4913_synthetic_2'));
    assertProcessed(await h.deliver(second));
    assert.equal(plan.instalments_paid, 2);
    assert.deepEqual(plan.metadata.paid_invoice_ids, ['in_4913_synthetic_1', 'in_4913_synthetic_2']);
    // Deliberately stop short of completion: no workflow/accounting/email
    // singleton or external provider is needed for real instalment progression.
    assert.equal(history.payment_status, 'partial');

    const deleted = h.event('evt_4913_deleted', 'customer.subscription.deleted', h.subscription);
    assertProcessed(await h.deliver(deleted));
    assert.equal(plan.status, STATUS.PAYMENT_PLAN_CANCELLED);
    assert.equal(webhookRow(h, deleted.id).processing_status, 'processed');
    assert.ok(h.rows.membership_payment_status_history.some((row) => (
      row.entity_id === plan.id && row.to_status === STATUS.PAYMENT_PLAN_CANCELLED
      && row.event_id === deleted.id
    )));
    assert.equal((await h.deliver(deleted)).body.status, 'duplicate');
    assertModeBound(h);
  });

  test(`${mode}: out-of-order owned invoice stays pending, real checkout creates plan, same signed event retries successfully`, async () => {
    const h = await harness(mode);
    // Model the webhook arriving during producer/local initialization's gap.
    h.rows.membership_payment_plans.length = 0;
    const paid = h.event('evt_4913_out_of_order', 'invoice.paid', h.invoice());
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await h.deliver(paid);
      assert.equal(result.statusCode, 500);
      assert.equal(result.body.status, 'unmatched');
      assert.equal(result.body.retry, true);
      assert.match(result.body.detail, /ours — awaiting checkout event/);
      assert.equal(webhookRow(h, paid.id).processing_status, 'pending');
      assert.equal(h.rows.payment_webhook_events.length, 1);
      assert.equal(h.rows.member_membership_history[0].payment_status, 'unpaid');
    }
    const pendingId = webhookRow(h, paid.id).id;
    const checkout = h.event('evt_4913_order_repair', 'checkout.session.completed', h.session);
    const result = await h.deliver(checkout);
    assertProcessed(result);
    assert.match(result.body.detail, /plan created for subscription/);
    assert.equal(h.rows.membership_payment_plans.length, 1);
    assert.equal(h.rows.membership_payment_plans[0].instalments_paid, 0);
    assertProcessed(await h.deliver(paid));
    assert.equal(webhookRow(h, paid.id).id, pendingId);
    assert.equal(webhookRow(h, paid.id).processing_status, 'processed');
    assert.equal(webhookRow(h, paid.id).processing_error, null);
    assert.equal(h.rows.membership_payment_plans[0].instalments_paid, 1);
    assert.equal(h.rows.member_membership_history[0].payment_status, 'partial');
    assert.equal((await h.deliver(paid)).body.status, 'duplicate');
    assertModeBound(h);
  });

  test(`${mode}: checkout without its local agreement is retryable rather than terminally skipped`, async () => {
    const h = await harness(mode);
    const agreements = h.rows.membership_billing_agreements.splice(0);
    h.rows.membership_payment_plans.length = 0;
    const checkout = h.event('evt_4913_missing_agreement', 'checkout.session.completed', h.session);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await h.deliver(checkout);
      assert.equal(result.statusCode, 500);
      assert.equal(result.body.status, 'unmatched');
      assert.equal(result.body.retry, true);
      assert.match(result.body.detail, /no agreement for checkout session/);
      assert.equal(webhookRow(h, checkout.id).processing_status, 'pending');
      assert.equal(h.rows.payment_webhook_events.length, 1);
      assert.equal(h.calls.retrievals.length, 0);
    }
    h.rows.membership_billing_agreements.push(...agreements);
    assertProcessed(await h.deliver(checkout));
    assert.equal(webhookRow(h, checkout.id).processing_status, 'processed');
    assert.equal(h.rows.membership_payment_plans.length, 1);
    assertModeBound(h);
  });
}

test('foreign tenant, other product, nonexistent alias and no-tenant events cannot reach durable storage or real processing', async (t) => {
  for (const mode of ['live', 'test']) {
    for (const type of ['checkout.session.completed', 'customer.subscription.deleted', 'invoice.paid']) {
      for (const variant of ['foreign', 'other-product', 'never-emitted-alias', 'no-tenant']) {
        await t.test(`${mode} ${type} ${variant}`, async () => {
          const h = await harness(mode);
          const metadata = clone(h.emitted.metadata);
          if (variant === 'foreign') metadata.tenant_id = 'tenant-foreign-synthetic';
          if (variant === 'other-product') metadata.kind = 'other_product';
          if (variant === 'never-emitted-alias') metadata.kind = 'monthly_card_plan';
          if (variant === 'no-tenant') delete metadata.tenant_id;
          let object;
          if (type === 'invoice.paid') {
            // Invoice metadata remains own-looking. Only the authoritative,
            // mode-bound subscription may decide tenant/product ownership.
            h.subscription.metadata = metadata;
            object = h.invoice();
          } else {
            object = clone(type === 'checkout.session.completed' ? h.session : h.subscription);
            object.metadata = metadata;
          }
          const before = clone(h.rows);
          const result = await h.deliver(h.event('evt_4913_rejected', type, object));
          if (variant === 'no-tenant') {
            assert.equal(result.statusCode, 422);
            assert.deepEqual(result.body, { error: 'Stripe event has no tenant identity.' });
          } else {
            assert.equal(result.statusCode, 200);
            assert.deepEqual(result.body, { received: true, status: 'skipped' });
          }
          assert.deepEqual(h.rows, before);
          assert.deepEqual(h.dbCalls, [], 'rejected ownership must not even query payload storage');
          assert.equal(h.calls.creates.length, 1);
          assert.equal(h.calls.customerUpdates.length, 0);
          assert.equal(h.calls.retrievals.length, type === 'invoice.paid' ? 1 : 0);
          assertModeBound(h);
        });
      }
    }
  }
});

test('producer-labelled invoices without subscription identity fail closed before storage', async () => {
  const h = await harness();
  const invoice = h.invoice();
  delete invoice.parent.subscription_details.subscription;
  const before = clone(h.rows);
  const result = await h.deliver(h.event('evt_4913_no_subscription', 'invoice.paid', invoice));
  assert.equal(result.statusCode, 422);
  assert.deepEqual(result.body, { error: 'Stripe membership invoice has no subscription identity.' });
  assert.deepEqual(h.rows, before);
  assert.deepEqual(h.dbCalls, []);
  assert.equal(h.calls.retrievals.length, 0);
});

test('signed owned failed invoice without a local plan retains the real dispatcher retry contract', async () => {
  const h = await harness();
  h.rows.membership_payment_plans.length = 0;
  const invoice = h.invoice();
  invoice.status = 'open';
  invoice.paid = false;
  invoice.amount_paid = 0;
  const event = h.event('evt_4913_failed_no_plan', 'invoice.payment_failed', invoice);
  const result = await h.deliver(event);
  assert.equal(result.statusCode, 500);
  assert.equal(result.body.status, 'unmatched');
  assert.equal(result.body.retry, true);
  assert.equal(webhookRow(h, event.id).processing_status, 'pending');
  assert.match(webhookRow(h, event.id).processing_error, /ours — awaiting checkout event/);
  assert.equal(h.rows.member_membership_history[0].payment_status, 'unpaid');
  assertModeBound(h);
});

test('mode-specific keys and signature secrets never fall back to the opposite account', async (t) => {
  for (const mode of ['live', 'test']) {
    for (const type of ['checkout.session.completed', 'invoice.paid', 'customer.subscription.deleted']) {
      await t.test(`${mode} ${type}: absent same-mode key`, async () => {
        const h = await harness(mode);
        delete h.credentials[mode === 'live' ? 'secret_key' : 'test_secret_key'];
        const object = type === 'invoice.paid' ? h.invoice()
          : type === 'checkout.session.completed' ? h.session : h.subscription;
        const before = clone(h.rows);
        const result = await h.deliver(h.event('evt_4913_no_key', type, object));
        assert.equal(result.statusCode, 503);
        assert.equal(result.body.status, 'pending');
        assert.match(result.body.error, /API key.*(unavailable|not configured)/);
        assert.deepEqual(h.calls.clients, []);
        assert.deepEqual(h.calls.retrievals, []);
        assert.deepEqual(h.rows, before);
        assert.deepEqual(h.dbCalls, []);
      });
    }
    await t.test(`${mode}: opposite-mode signature`, async () => {
      const h = await harness(mode);
      const before = clone(h.rows);
      const result = await h.deliver(
        h.event('evt_4913_wrong_secret', 'checkout.session.completed', h.session),
        SECRETS[mode === 'live' ? 'test' : 'live'],
      );
      assert.equal(result.statusCode, 400);
      assert.deepEqual(result.body, { error: 'Invalid webhook signature' });
      assert.deepEqual(h.calls.clients, []);
      assert.deepEqual(h.calls.retrievals, []);
      assert.deepEqual(h.rows, before);
      assert.deepEqual(h.dbCalls, []);
    });
    await t.test(`${mode}: unavailable authoritative subscription`, async () => {
      const h = await harness(mode);
      h.failRetrieval();
      const before = clone(h.rows);
      const result = await h.deliver(h.event('evt_4913_provider_down', 'invoice.paid', h.invoice()));
      assert.equal(result.statusCode, 503);
      assert.deepEqual(result.body, {
        error: 'Stripe subscription ownership could not be verified.', status: 'pending',
      });
      assert.deepEqual(h.rows, before);
      assert.deepEqual(h.dbCalls, []);
      assert.equal(h.calls.retrievals.length, 1);
      assertModeBound(h);
    });
  }
});
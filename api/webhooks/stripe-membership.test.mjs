import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import Stripe from 'stripe';
import { handleStripeMembershipWebhook } from './stripe-membership.js';
import { classifyStripeMembershipEventTenant } from '../_lib/stripeMembershipWebhookConfig.js';

// All identities, API keys and HMAC secrets below are synthetic. The isolated
// runner also fails on any attempted network/provider/database access.
const TENANT_ID = 'tenant-1';
const SECRETS = {
  live: 'whsec_membership_live_regression_only',
  test: 'whsec_membership_test_regression_only',
};
const API_KEYS = {
  live: 'sk_live_membership_regression_only',
  test: 'sk_test_membership_regression_only',
};
const CREDENTIALS = {
  membership_webhook_secret: SECRETS.live,
  test_membership_webhook_secret: SECRETS.test,
  secret_key: API_KEYS.live,
  test_secret_key: API_KEYS.test,
};
const MEMBERSHIP_METADATA = {
  kind: 'monthly_card',
  tenant_id: TENANT_ID,
  membership_year: '2026',
  member_id: 'member-1',
};
const INVOICE_TYPES = [
  'invoice.paid',
  'invoice.payment_succeeded',
  'invoice.payment_failed',
  'invoice.voided',
  'invoice.marked_uncollectible',
];

function eventFor(type, object = {}, livemode = true) {
  return {
    id: 'evt_membership_regression',
    object: 'event',
    api_version: '2025-03-31.basil',
    created: 1767225600,
    livemode,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    type,
    data: { object },
  };
}

function invoiceEvent(type = 'invoice.paid', livemode = true) {
  return eventFor(type, {
    id: 'in_membership_regression',
    object: 'invoice',
    metadata: { ...MEMBERSHIP_METADATA },
    parent: { type: 'subscription_details', subscription_details: {
      subscription: 'sub_membership_regression',
      metadata: { ...MEMBERSHIP_METADATA },
    } },
  }, livemode);
}

function requestFor(event, options = {}) {
  const raw = options.raw ?? JSON.stringify(event);
  const signature = Object.hasOwn(options, 'signature')
    ? options.signature
    : Stripe.webhooks.generateTestHeaderString({
      payload: options.signedRaw ?? raw,
      secret: options.signingSecret ?? SECRETS[event?.livemode === false ? 'test' : 'live'],
    });
  const req = new EventEmitter();
  req.method = 'POST';
  req.query = { tenant: TENANT_ID };
  req.headers = {
    host: 'membership.example.test',
    'x-forwarded-proto': 'https',
    ...(signature === undefined ? {} : { 'stripe-signature': signature }),
  };
  setImmediate(() => {
    // Exercise the handler's raw-body assembly rather than supplying req.body.
    const buffer = Buffer.from(raw);
    const midpoint = Math.floor(buffer.length / 2);
    req.emit('data', buffer.subarray(0, midpoint));
    req.emit('data', buffer.subarray(midpoint));
    req.emit('end');
  });
  return req;
}

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

function harness(options = {}) {
  const calls = {
    credentials: [],
    signatures: [],
    clients: [],
    classifications: [],
    retrievals: [],
    db: [],
    processors: [],
    order: [],
  };
  const existing = options.existing ?? null;
  const db = {
    from(table) {
      calls.order.push('storage');
      const operation = { table, filters: [] };
      calls.db.push(operation);
      assert.equal(table, 'payment_webhook_events');
      assert.equal(options.storage, true, 'pre-storage rejection must not access the DB');
      const builder = {
        upsert(payload, settings) {
          operation.kind = 'upsert';
          operation.payload = payload;
          operation.settings = settings;
          return this;
        },
        select(columns) {
          operation.columns = columns;
          if (operation.kind === 'upsert') {
            return Promise.resolve({
              data: options.duplicate ? [] : [{ id: 'webhook-row-1' }],
              error: options.insertError ? { message: 'synthetic storage failure' } : null,
            });
          }
          operation.kind = 'lookup';
          return this;
        },
        update(payload) {
          operation.kind = 'update';
          operation.payload = payload;
          return this;
        },
        eq(column, value) {
          operation.filters.push([column, value]);
          return this;
        },
        async maybeSingle() {
          assert.equal(operation.kind, 'lookup');
          return { data: existing, error: null };
        },
        then(resolve, reject) {
          assert.equal(operation.kind, 'update');
          return Promise.resolve({
            error: options.updateError ? { message: 'synthetic update failure' } : null,
          }).then(resolve, reject);
        },
      };
      return builder;
    },
  };

  class FakeStripe {
    // Keep signature verification real; only the API constructor/retrieval is fake.
    static webhooks = {
      constructEvent(raw, signature, secret) {
        calls.order.push('signature');
        calls.signatures.push({ raw: raw.toString('utf8'), signature, secret });
        return Stripe.webhooks.constructEvent(raw, signature, secret);
      },
    };

    constructor(key) {
      calls.order.push('client');
      calls.clients.push(key);
      assert.ok(Object.values(API_KEYS).includes(key), 'must select a synthetic mode-bound API key');
      if (options.constructorError) throw new Error('synthetic client initialization failure');
      this.apiKey = key;
      this.subscriptions = {
        retrieve: async (id) => {
          calls.order.push('retrieve');
          calls.retrievals.push({ id, key });
          assert.equal(options.retrieve, true, 'this event must not retrieve a subscription');
          if (options.retrievalError) throw new Error('sensitive synthetic provider error');
          return options.subscription ?? {
            id,
            object: 'subscription',
            metadata: { ...MEMBERSHIP_METADATA },
          };
        },
      };
    }
  }

  const dependencies = {
    db,
    StripeClient: FakeStripe,
    getStripeIntegrationCredentials: async (tenantId) => {
      calls.credentials.push(tenantId);
      if (options.credentialsError) throw new Error('synthetic credential lookup failure');
      return Object.hasOwn(options, 'credentials') ? options.credentials : { ...CREDENTIALS };
    },
    classifyStripeMembershipEventTenant: async (event, args) => {
      calls.order.push('classification');
      calls.classifications.push({ event, args });
      return classifyStripeMembershipEventTenant(event, args);
    },
    processStripeCardPlanEvent: async (event, args) => {
      calls.order.push('processor');
      calls.processors.push({ event, args, stripe: await args.getStripe() });
      assert.equal(options.processor, true, 'this event must not invoke membership processing');
      if (options.processorError) throw new Error('synthetic processing failure');
      return options.outcome ?? { handled: true, detail: 'synthetic invoice reconciled' };
    },
  };
  return {
    calls,
    db,
    async deliver(event, requestOptions) {
      const res = response();
      await handleStripeMembershipWebhook(requestFor(event, requestOptions), res, dependencies);
      return res;
    },
  };
}

function assertNoWork(calls, { retrievals = 0, classifications = 1 } = {}) {
  assert.equal(calls.retrievals.length, retrievals);
  assert.equal(calls.classifications.length, classifications);
  assert.equal(calls.db.length, 0);
  assert.equal(calls.processors.length, 0);
}

function assertSkipped(res) {
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { received: true, status: 'skipped' });
}

function assertStored(h, event) {
  const upsert = h.calls.db.find((operation) => operation.kind === 'upsert');
  assert.deepEqual(upsert.settings, { onConflict: 'provider,event_id', ignoreDuplicates: true });
  assert.equal(upsert.columns, 'id');
  assert.deepEqual(upsert.payload, {
    provider: 'stripe-membership',
    event_id: event.id,
    resource_type: event.data.object.object,
    action: event.type,
    resource_id: event.data.object.id,
    tenant_id: TENANT_ID,
    payload: event,
    processing_status: 'pending',
  });
  assert.ok(h.calls.order.indexOf('classification') < h.calls.order.indexOf('storage'));
}

function assertMarked(h, status, error = null, rowId = 'webhook-row-1') {
  const updates = h.calls.db.filter((operation) => operation.kind === 'update');
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0].filters, [['id', rowId], ['tenant_id', TENANT_ID]]);
  assert.equal(updates[0].payload.processing_status, status);
  assert.equal(updates[0].payload.processing_error, error);
  assert.ok(Number.isFinite(Date.parse(updates[0].payload.processed_at)));
}

test('handler skips an irrelevant account-wide event before any payload DB call', async () => {
  const h = harness();
  const res = await h.deliver(eventFor('payment_intent.succeeded', {
    id: 'pi_booking',
    object: 'payment_intent',
    metadata: { booking_id: 'booking-1' },
  }));
  assertSkipped(res);
  assertNoWork(h.calls);
});

test('signed unused account-wide types skip before ownership, storage and processing in either mode', async (t) => {
  const unusedTypes = [
    ['customer.created', 'customer'],
    ['customer.updated', 'customer'],
    ['payment_intent.created', 'payment_intent'],
    ['payment_intent.requires_action', 'payment_intent'],
    ['customer.subscription.created', 'subscription'],
    ['customer.subscription.updated', 'subscription'],
    ['invoice.created', 'invoice'],
    ['invoice.finalized', 'invoice'],
    ['invoice.future_notification', 'invoice'],
    ['future_product.notification_created', 'future_product'],
  ];
  for (const [type, object] of unusedTypes) {
    for (const livemode of [true, false]) {
      for (const membershipMetadata of [false, true]) {
        await t.test(`${type}: ${livemode ? 'live' : 'test'}, membership metadata=${membershipMetadata}`, async () => {
          const metadata = membershipMetadata ? { ...MEMBERSHIP_METADATA } : {};
          const event = eventFor(type, {
            id: 'synthetic_resource',
            object,
            metadata,
            mode: 'subscription',
            subscription: 'sub_must_not_be_retrieved',
            subscription_details: { subscription: 'sub_must_not_be_retrieved', metadata },
            parent: { subscription_details: { subscription: 'sub_must_not_be_retrieved', metadata } },
            lines: { data: [{ metadata }] },
          }, livemode);
          const h = harness();
          assertSkipped(await h.deliver(event));
          assertNoWork(h.calls);
          const mode = livemode ? 'live' : 'test';
          assert.deepEqual(h.calls.credentials, [TENANT_ID]);
          assert.equal(h.calls.signatures.length, 1);
          assert.equal(h.calls.signatures[0].secret, SECRETS[mode]);
          assert.deepEqual(h.calls.clients, [API_KEYS[mode]]);
          assert.deepEqual(h.calls.order, ['signature', 'client', 'classification']);
        });
      }
    }
  }
});

test('missing, invalid and cross-mode signatures cannot reach classification even for unused types', async (t) => {
  for (const type of ['customer.created', 'invoice.paid']) {
    for (const livemode of [true, false]) {
      for (const [name, requestOptions] of [
        ['missing', { signature: undefined }],
        ['invalid', { signature: 'not-a-stripe-signature' }],
        ['wrong secret', { signingSecret: 'whsec_untrusted_regression_only' }],
        ['opposite mode', { signingSecret: SECRETS[livemode ? 'test' : 'live'] }],
      ]) {
        await t.test(`${type}: ${livemode ? 'live' : 'test'}, ${name}`, async () => {
          const h = harness();
          const res = await h.deliver(invoiceEvent(type, livemode), requestOptions);
          assert.equal(res.statusCode, 400);
          assert.deepEqual(res.body, { error: 'Invalid webhook signature' });
          assert.equal(h.calls.signatures.length, 1);
          assert.deepEqual(h.calls.clients, []);
          assertNoWork(h.calls, { classifications: 0 });
        });
      }
    }
  }
});

test('tampering with the raw bytes after signing is rejected before classification', async (t) => {
  for (const livemode of [true, false]) {
    await t.test(livemode ? 'live' : 'test', async () => {
      const event = invoiceEvent('invoice.paid', livemode);
      const signedRaw = JSON.stringify(event);
      const h = harness();
      // Parsed content is identical; only the exact signed bytes differ.
      const res = await h.deliver(event, { signedRaw, raw: `${signedRaw}\n` });
      assert.equal(res.statusCode, 400);
      assert.deepEqual(res.body, { error: 'Invalid webhook signature' });
      assert.equal(h.calls.signatures.length, 1);
      assertNoWork(h.calls, { classifications: 0 });
    });
  }
});

test('malformed JSON or missing/non-boolean mode fails before signature verification', async (t) => {
  for (const raw of ['{', '{"livemode":true,', 'not JSON']) {
    await t.test(`malformed JSON: ${raw}`, async () => {
      const h = harness();
      const res = await h.deliver(null, { raw });
      assert.equal(res.statusCode, 400);
      assert.deepEqual(res.body, { error: 'Invalid webhook payload' });
      assert.equal(h.calls.signatures.length, 0);
      assertNoWork(h.calls, { classifications: 0 });
    });
  }
  for (const mode of [undefined, null, 'true', 'false', 0, 1, {}, []]) {
    await t.test(`invalid mode: ${JSON.stringify(mode)}`, async () => {
      const event = invoiceEvent();
      if (mode === undefined) delete event.livemode;
      else event.livemode = mode;
      const h = harness();
      const res = await h.deliver(event);
      assert.equal(res.statusCode, 400);
      assert.deepEqual(res.body, { error: 'Webhook event mode is missing' });
      assert.equal(h.calls.signatures.length, 0);
      assert.deepEqual(h.calls.clients, []);
      assertNoWork(h.calls, { classifications: 0 });
    });
  }
  for (const value of [null, [], 'event', 123]) {
    await t.test(`invalid event envelope: ${JSON.stringify(value)}`, async () => {
      const h = harness();
      const res = await h.deliver(value);
      assert.equal(res.statusCode, 400);
      assert.deepEqual(res.body, { error: 'Webhook event mode is missing' });
      assert.equal(h.calls.signatures.length, 0);
      assertNoWork(h.calls, { classifications: 0 });
    });
  }
});

test('signed missing, non-string and invalid dotted types fail closed without payload persistence', async (t) => {
  const invalidTypes = [
    undefined, null, 17, {}, [], '', 'invoice', ' invoice.paid', 'invoice.paid ',
    'Invoice.paid', 'invoice..paid', '.invoice.paid', 'invoice.paid.', 'invoice/paid',
    'invoice.paid\n', 'invoice.1paid',
  ];
  for (const type of invalidTypes) {
    for (const livemode of [true, false]) {
      await t.test(`${JSON.stringify(type)}: ${livemode ? 'live' : 'test'}`, async () => {
        const event = invoiceEvent(type, livemode);
        // invoiceEvent's default parameter must not mask a missing event type.
        if (type === undefined) delete event.type;
        const h = harness();
        const res = await h.deliver(event);
        assert.equal(res.statusCode, 422);
        assert.deepEqual(res.body, { error: 'Stripe event type is missing or invalid.' });
        assert.equal(h.calls.signatures.length, 1);
        assertNoWork(h.calls);
      });
    }
  }
});

test('unavailable credentials and absent mode-specific secrets never classify or store', async (t) => {
  for (const [name, options] of [
    ['credential lookup throws', { credentialsError: true }],
    ['credentials missing', { credentials: null }],
    ['neither signing secret configured', { credentials: { secret_key: API_KEYS.live } }],
  ]) {
    await t.test(name, async () => {
      const h = harness(options);
      const res = await h.deliver(invoiceEvent());
      assert.equal(res.statusCode, 503);
      assert.deepEqual(res.body, { error: 'Webhook not configured' });
      assert.equal(h.calls.signatures.length, 0);
      assertNoWork(h.calls, { classifications: 0 });
    });
  }
  for (const livemode of [true, false]) {
    await t.test(`${livemode ? 'live' : 'test'} signing secret missing`, async () => {
      const credentials = { ...CREDENTIALS };
      delete credentials[livemode ? 'membership_webhook_secret' : 'test_membership_webhook_secret'];
      const h = harness({ credentials });
      const res = await h.deliver(invoiceEvent('invoice.paid', livemode));
      assert.equal(res.statusCode, 503);
      assert.deepEqual(res.body, { error: `Webhook not configured for ${livemode ? 'live' : 'test'} mode` });
      assert.equal(h.calls.signatures.length, 0);
      assertNoWork(h.calls, { classifications: 0 });
    });
  }
});

test('unused signed events do not require an API key even with membership-looking metadata', async (t) => {
  for (const livemode of [true, false]) {
    await t.test(livemode ? 'live' : 'test', async () => {
      const credentials = { ...CREDENTIALS };
      delete credentials[livemode ? 'secret_key' : 'test_secret_key'];
      const h = harness({ credentials });
      assertSkipped(await h.deliver(invoiceEvent('invoice.future_notification', livemode)));
      assert.deepEqual(h.calls.clients, []);
      assertNoWork(h.calls);
    });
  }
});

test('supported events with missing ownership return 422 before storage', async (t) => {
  const fixtures = [
    ['membership invoice without subscription', eventFor('invoice.paid', {
      id: 'in_no_subscription', object: 'invoice', metadata: { ...MEMBERSHIP_METADATA },
    }), {}, 'Stripe membership invoice has no subscription identity.'],
    ['authoritative subscription without tenant', invoiceEvent(), {
      retrieve: true, subscription: { metadata: { kind: 'monthly_card' } },
    }, 'Stripe event has no tenant identity.'],
    ['membership checkout without tenant', eventFor('checkout.session.completed', {
      object: 'checkout.session', mode: 'subscription', metadata: { kind: 'monthly_card' },
    }), {}, 'Stripe event has no tenant identity.'],
    ['deleted membership subscription without tenant', eventFor('customer.subscription.deleted', {
      object: 'subscription', metadata: { kind: 'monthly_card' },
    }), {}, 'Stripe event has no tenant identity.'],
  ];
  for (const [name, event, options, error] of fixtures) {
    await t.test(name, async () => {
      const h = harness(options);
      const res = await h.deliver(event);
      assert.equal(res.statusCode, 422);
      assert.deepEqual(res.body, { error });
      assertNoWork(h.calls, { retrievals: options.retrieve ? 1 : 0 });
    });
  }
});

test('supported ownership verification failures return retryable 503 without storage', async (t) => {
  await t.test('provider retrieval failure is sanitized', async () => {
    const h = harness({ retrieve: true, retrievalError: true });
    const res = await h.deliver(invoiceEvent());
    assert.equal(res.statusCode, 503);
    assert.deepEqual(res.body, {
      error: 'Stripe subscription ownership could not be verified.', status: 'pending',
    });
    assertNoWork(h.calls, { retrievals: 1 });
  });
  for (const livemode of [true, false]) {
    const mode = livemode ? 'live' : 'test';
    await t.test(`${mode} API key missing never falls back to the opposite mode`, async () => {
      const credentials = { ...CREDENTIALS };
      delete credentials[livemode ? 'secret_key' : 'test_secret_key'];
      const h = harness({ credentials });
      const res = await h.deliver(invoiceEvent('invoice.paid', livemode));
      assert.equal(res.statusCode, 503);
      assert.deepEqual(res.body, {
        error: 'The Stripe API key for this event mode is unavailable.', status: 'pending',
      });
      assert.deepEqual(h.calls.clients, []);
      assertNoWork(h.calls);
    });
    await t.test(`${mode} own direct ownership still requires the same-mode API key`, async () => {
      const credentials = { ...CREDENTIALS };
      delete credentials[livemode ? 'secret_key' : 'test_secret_key'];
      const h = harness({ credentials });
      const res = await h.deliver(eventFor('customer.subscription.deleted', {
        id: 'sub_membership_regression', object: 'subscription', metadata: { ...MEMBERSHIP_METADATA },
      }, livemode));
      assert.equal(res.statusCode, 503);
      assert.deepEqual(res.body, { error: `Stripe API key is not configured for ${mode} mode`, status: 'pending' });
      assert.deepEqual(h.calls.clients, []);
      assertNoWork(h.calls);
    });
    await t.test(`${mode} client initialization failure`, async () => {
      const h = harness({ constructorError: true });
      const res = await h.deliver(invoiceEvent('invoice.paid', livemode));
      assert.equal(res.statusCode, 503);
      assert.deepEqual(res.body, { error: `Stripe API key could not be used for ${mode} mode`, status: 'pending' });
      assertNoWork(h.calls, { classifications: 0 });
    });
  }
});

test('foreign ownership and unrelated supported products are acknowledged without storage', async (t) => {
  for (const type of ['payment_intent.succeeded', 'checkout.session.completed', 'customer.subscription.deleted']) {
    await t.test(`foreign direct metadata: ${type}`, async () => {
      const h = harness();
      assertSkipped(await h.deliver(eventFor(type, {
        object: type === 'payment_intent.succeeded' ? 'payment_intent'
          : type === 'checkout.session.completed' ? 'checkout.session' : 'subscription',
        mode: 'subscription',
        metadata: { ...MEMBERSHIP_METADATA, tenant_id: 'tenant-foreign' },
      })));
      assertNoWork(h.calls);
    });
  }
  for (const [name, metadata] of [
    ['foreign authoritative ownership overrides own-looking invoice metadata', { ...MEMBERSHIP_METADATA, tenant_id: 'tenant-foreign' }],
    ['other subscription product overrides own-looking invoice metadata', { tenant_id: TENANT_ID, kind: 'other_product' }],
  ]) {
    await t.test(name, async () => {
      const h = harness({ retrieve: true, subscription: { metadata } });
      assertSkipped(await h.deliver(invoiceEvent()));
      assertNoWork(h.calls, { retrievals: 1 });
    });
  }
  await t.test('one-off invoice without membership metadata', async () => {
    const h = harness();
    assertSkipped(await h.deliver(eventFor('invoice.paid', { id: 'in_one_off', object: 'invoice' })));
    assertNoWork(h.calls);
  });
});

test('all supported invoice outcomes still reach the injected processor after mode-bound ownership and storage', async (t) => {
  for (const type of INVOICE_TYPES) {
    for (const livemode of [true, false]) {
      await t.test(`${type}: ${livemode ? 'live' : 'test'}`, async () => {
        const h = harness({ retrieve: true, storage: true, processor: true });
        const event = invoiceEvent(type, livemode);
        const res = await h.deliver(event);
        assert.equal(res.statusCode, 200);
        assert.deepEqual(res.body, { received: true, status: 'processed', detail: 'synthetic invoice reconciled' });
        assert.deepEqual(h.calls.retrievals, [{ id: 'sub_membership_regression', key: API_KEYS[livemode ? 'live' : 'test'] }]);
        assert.equal(h.calls.processors.length, 1);
        const invocation = h.calls.processors[0];
        assert.deepEqual(invocation.event, event);
        assert.equal(invocation.args.db, h.db);
        assert.equal(invocation.args.expectedTenantId, TENANT_ID);
        assert.equal(invocation.args.baseUrl, 'https://membership.example.test');
        assert.equal(invocation.stripe, h.calls.classifications[0].args.stripe);
        assert.equal(invocation.stripe.apiKey, API_KEYS[livemode ? 'live' : 'test']);
        assertStored(h, event);
        assertMarked(h, 'processed');
        assert.deepEqual(h.calls.order, ['signature', 'client', 'classification', 'retrieve', 'storage', 'processor', 'storage']);
      });
    }
  }
});

test('supported invoices preserve current and legacy subscription identity shapes', async (t) => {
  for (const [name, shape] of [
    ['legacy subscription string', { subscription: 'sub_membership_regression' }],
    ['legacy expanded subscription', { subscription: { id: 'sub_membership_regression', object: 'subscription' } }],
    ['subscription_details string', { subscription_details: { subscription: 'sub_membership_regression' } }],
    ['current expanded parent subscription', { parent: { subscription_details: { subscription: { id: 'sub_membership_regression' } } } }],
  ]) {
    await t.test(name, async () => {
      const event = invoiceEvent();
      delete event.data.object.parent;
      Object.assign(event.data.object, shape);
      const h = harness({ retrieve: true, storage: true, processor: true });
      const res = await h.deliver(event);
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.status, 'processed');
      assert.equal(h.calls.retrievals[0].id, 'sub_membership_regression');
      assertStored(h, event);
      assertMarked(h, 'processed');
    });
  }
});

test('injected invoice processor outcomes preserve success, skipped and retry semantics', async (t) => {
  for (const [name, options, code, body, status, error] of [
    ['retryable unmatched', { outcome: { handled: false, retryable: true, detail: 'agreement not ready' } },
      500, { received: true, status: 'unmatched', detail: 'agreement not ready', retry: true },
      'pending', 'agreement not ready'],
    ['non-retryable unhandled', { outcome: { handled: false, detail: 'not a matching agreement' } },
      200, { received: true, status: 'skipped', detail: 'not a matching agreement' },
      'skipped', 'not a matching agreement'],
    ['processor throws', { processorError: true },
      500, { received: true, status: 'failed', error: 'synthetic processing failure' },
      'pending', 'synthetic processing failure'],
  ]) {
    await t.test(name, async () => {
      const event = invoiceEvent();
      const h = harness({ retrieve: true, storage: true, processor: true, ...options });
      const res = await h.deliver(event);
      assert.equal(res.statusCode, code);
      assert.deepEqual(res.body, body);
      assert.equal(h.calls.processors.length, 1);
      assertStored(h, event);
      assertMarked(h, status, error);
    });
  }
});

test('failed durable insertion returns 500 without invoking the processor or marking the event', async () => {
  const event = invoiceEvent();
  const h = harness({ retrieve: true, storage: true, insertError: true });
  const res = await h.deliver(event);
  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body, { error: 'Failed to log event' });
  assert.equal(h.calls.processors.length, 0);
  assert.equal(h.calls.db.length, 1);
  assertStored(h, event);
});

test('event status update errors retain the existing handler acknowledgment behavior', async () => {
  const h = harness({ retrieve: true, storage: true, processor: true, updateError: true });
  const res = await h.deliver(invoiceEvent());
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { received: true, status: 'processed', detail: 'synthetic invoice reconciled' });
  assertMarked(h, 'processed');
});

test('dedupe reprocesses recoverable rows but acknowledges processed/skipped rows without processing', async (t) => {
  for (const processing_status of ['pending', 'failed', 'processed', 'skipped']) {
    await t.test(processing_status, async () => {
      const recoverable = processing_status === 'pending' || processing_status === 'failed';
      const h = harness({
        retrieve: true, storage: true, duplicate: true, processor: recoverable,
        existing: { id: 'existing-webhook-row', processing_status },
      });
      const event = invoiceEvent();
      const res = await h.deliver(event);
      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.body, recoverable
        ? { received: true, status: 'processed', detail: 'synthetic invoice reconciled' }
        : { received: true, status: 'duplicate' });
      assertStored(h, event);
      const lookup = h.calls.db.find((operation) => operation.kind === 'lookup');
      assert.equal(lookup.columns, 'id, processing_status');
      assert.deepEqual(lookup.filters, [
        ['provider', 'stripe-membership'], ['event_id', event.id], ['tenant_id', TENANT_ID],
      ]);
      assert.equal(h.calls.processors.length, recoverable ? 1 : 0);
      if (recoverable) assertMarked(h, 'processed', null, 'existing-webhook-row');
      else assert.equal(h.calls.db.filter((operation) => operation.kind === 'update').length, 0);
    });
  }
});

test('a duplicate pending event remains retryable when the processor still cannot match it', async () => {
  const h = harness({
    retrieve: true, storage: true, duplicate: true, processor: true,
    existing: { id: 'pending-webhook-row', processing_status: 'pending' },
    outcome: { handled: false, retryable: true, detail: 'agreement not ready' },
  });
  const res = await h.deliver(invoiceEvent());
  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body, { received: true, status: 'unmatched', detail: 'agreement not ready', retry: true });
  assert.equal(h.calls.processors.length, 1);
  assertMarked(h, 'pending', 'agreement not ready', 'pending-webhook-row');
});

test('global event-id conflict without a tenant-owned row returns 409 and never processes or mutates it', async () => {
  const h = harness({ retrieve: true, storage: true, duplicate: true });
  const event = invoiceEvent();
  const res = await h.deliver(event);
  assert.equal(res.statusCode, 409);
  assert.deepEqual(res.body, { error: 'Webhook event ownership conflict' });
  assert.equal(h.calls.processors.length, 0);
  assert.equal(h.calls.db.length, 2);
  assertStored(h, event);
  const lookup = h.calls.db.find((operation) => operation.kind === 'lookup');
  assert.deepEqual(lookup.filters, [
    ['provider', 'stripe-membership'], ['event_id', event.id], ['tenant_id', TENANT_ID],
  ]);
  assert.equal(h.calls.db.filter((operation) => operation.kind === 'update').length, 0);
});
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  STRIPE_MEMBERSHIP_WEBHOOK_EVENTS,
  buildStripeMembershipWebhookUrl,
  checkStripeMembershipWebhookConfiguration,
  classifyStripeMembershipEventTenant,
  selectStripeEventModeCredentials,
} from './stripeMembershipWebhookConfig.js';

const url = 'https://tenant.example.com/api/webhooks/stripe-membership?tenant=tenant-1';

function stripeWithPages(pages) {
  let call = 0;
  return {
    webhookEndpoints: {
      async list() {
        const page = pages[call];
        call += 1;
        if (page instanceof Error) throw page;
        return page;
      },
    },
  };
}

function endpoint(overrides = {}) {
  return {
    id: 'we_1',
    url,
    livemode: true,
    status: 'enabled',
    enabled_events: [...STRIPE_MEMBERSHIP_WEBHOOK_EVENTS],
    ...overrides,
  };
}

test('builds only a trusted HTTPS tenant webhook URL', () => {
  assert.equal(
    buildStripeMembershipWebhookUrl('https://tenant.example.com', 'a tenant'),
    'https://tenant.example.com/api/webhooks/stripe-membership?tenant=a+tenant',
  );
  assert.throws(() => buildStripeMembershipWebhookUrl('http://localhost:3000', 'tenant-1'));
  assert.throws(() => buildStripeMembershipWebhookUrl('http://tenant.example.com', 'tenant-1'));
  assert.throws(() => buildStripeMembershipWebhookUrl('https://workspace.replit.dev', 'tenant-1'));
  assert.throws(() => buildStripeMembershipWebhookUrl('https://[::1]', 'tenant-1'));
  assert.throws(() => buildStripeMembershipWebhookUrl('https://10.0.0.8', 'tenant-1'));
  assert.equal(
    buildStripeMembershipWebhookUrl('https://tenant.staging.example.com', 'tenant-1'),
    'https://tenant.staging.example.com/api/webhooks/stripe-membership?tenant=tenant-1',
  );
});

test('reports a matching enabled live endpoint as configured', async () => {
  const result = await checkStripeMembershipWebhookConfiguration({
    stripe: stripeWithPages([{ data: [endpoint()], has_more: false }]),
    mode: 'live',
    url,
    secretConfigured: true,
  });
  assert.equal(result.status, 'configured');
  assert.deepEqual(result.missing_events, []);
  assert.deepEqual(result.checks, {
    api_key_configured: true,
    endpoint_found: true,
    endpoint_enabled: true,
    events_complete: true,
  });
  assert.match(result.message, /configured for this mode/);
  assert.doesNotMatch(result.message, /delivered|secret matches/i);
});

test('requires exact URL, requested mode, enabled status, and event permissions', async () => {
  const candidates = [
    endpoint({ url: `${url}&extra=1` }),
    endpoint({ livemode: false }),
    endpoint({
      id: 'we_disabled',
      status: 'disabled',
      enabled_events: ['payment_intent.succeeded'],
    }),
  ];
  const result = await checkStripeMembershipWebhookConfiguration({
    stripe: stripeWithPages([{ data: candidates, has_more: false }]),
    mode: 'live',
    url,
    secretConfigured: true,
  });
  assert.equal(result.status, 'incomplete');
  assert.equal(result.checks.endpoint_found, true);
  assert.equal(result.checks.endpoint_enabled, false);
  assert.equal(result.checks.events_complete, false);
  assert.deepEqual(
    result.missing_events,
    STRIPE_MEMBERSHIP_WEBHOOK_EVENTS.filter((event) => event !== 'payment_intent.succeeded'),
  );
});

test('accepts wildcard event permission and validates test mode', async () => {
  const result = await checkStripeMembershipWebhookConfiguration({
    stripe: stripeWithPages([{
      data: [endpoint({ livemode: false, enabled_events: ['*'] })],
      has_more: false,
    }]),
    mode: 'test',
    url,
    secretConfigured: true,
  });
  assert.equal(result.status, 'configured');
  assert.equal(result.checks.events_complete, true);
});

test('reports missing API key and Stripe API errors without claiming configuration', async () => {
  const noKey = await checkStripeMembershipWebhookConfiguration({
    stripe: null,
    mode: 'test',
    url,
    secretConfigured: false,
  });
  assert.equal(noKey.status, 'incomplete');
  assert.equal(noKey.checks.api_key_configured, false);

  const failed = await checkStripeMembershipWebhookConfiguration({
    stripe: stripeWithPages([new Error('provider detail must not leak')]),
    mode: 'live',
    url,
    secretConfigured: true,
  });
  assert.equal(failed.status, 'unavailable');
  assert.equal(failed.message.includes('provider detail'), false);
});

test('fails explicitly when the bounded page limit cannot exhaust results', async () => {
  const result = await checkStripeMembershipWebhookConfiguration({
    stripe: stripeWithPages([
      { data: [endpoint({ id: 'we_1', url: 'https://other.example/a' })], has_more: true },
      { data: [endpoint({ id: 'we_2', url: 'https://other.example/b' })], has_more: true },
    ]),
    mode: 'live',
    url,
    secretConfigured: true,
    maxPages: 2,
  });
  assert.equal(result.status, 'unavailable');
  assert.match(result.message, /more than 200/);
});

test('standard events include both terminal invoice outcomes', () => {
  assert.equal(STRIPE_MEMBERSHIP_WEBHOOK_EVENTS.length, 8);
  assert.equal(STRIPE_MEMBERSHIP_WEBHOOK_EVENTS.includes('invoice.voided'), true);
  assert.equal(STRIPE_MEMBERSHIP_WEBHOOK_EVENTS.includes('invoice.marked_uncollectible'), true);
});

test('event mode credentials never fall back to the opposite mode', () => {
  const credentials = {
    membership_webhook_secret: 'whsec_live',
    test_membership_webhook_secret: 'whsec_test',
    secret_key: 'sk_live',
    test_secret_key: 'sk_test',
  };
  assert.deepEqual(selectStripeEventModeCredentials({ livemode: true }, credentials), {
    mode: 'live',
    signingSecret: 'whsec_live',
    apiKey: 'sk_live',
  });
  assert.deepEqual(selectStripeEventModeCredentials({ livemode: false }, {
    membership_webhook_secret: 'whsec_live',
    secret_key: 'sk_live',
  }), {
    mode: 'test',
    signingSecret: null,
    apiKey: null,
  });
});

test('tenant classifier skips known foreign events and accepts own direct metadata', async () => {
  const own = await classifyStripeMembershipEventTenant({
    type: 'payment_intent.succeeded',
    data: { object: { metadata: {
      tenant_id: 'tenant-1',
      membership_year: '2026',
      member_id: 'member-1',
    } } },
  }, { expectedTenantId: 'tenant-1' });
  assert.deepEqual(own, { status: 'own' });

  const foreign = await classifyStripeMembershipEventTenant({
    type: 'checkout.session.completed',
    data: { object: {
      mode: 'subscription',
      metadata: { tenant_id: 'tenant-2', kind: 'monthly_card_plan' },
    } },
  }, { expectedTenantId: 'tenant-1' });
  assert.deepEqual(foreign, { status: 'foreign' });
});

test('invoice classifier retrieves authoritative subscription for current and legacy shapes', async () => {
  const retrieved = [];
  const stripe = {
    subscriptions: {
      async retrieve(id) {
        retrieved.push(id);
        return {
          metadata: {
            tenant_id: id === 'sub_own' ? 'tenant-1' : 'tenant-2',
            kind: 'monthly_card_plan',
          },
        };
      },
    },
  };
  const own = await classifyStripeMembershipEventTenant({
    type: 'invoice.paid',
    data: { object: {
      parent: { subscription_details: {
        subscription: 'sub_own',
        metadata: { tenant_id: 'untrusted-foreign' },
      } },
    } },
  }, { expectedTenantId: 'tenant-1', stripe });
  const foreign = await classifyStripeMembershipEventTenant({
    type: 'invoice.voided',
    data: { object: { subscription: 'sub_foreign' } },
  }, { expectedTenantId: 'tenant-1', stripe });
  assert.deepEqual(own, { status: 'own' });
  assert.deepEqual(foreign, { status: 'foreign' });
  assert.deepEqual(retrieved, ['sub_own', 'sub_foreign']);
});

test('unknown subscription ownership fails closed without provider details', async () => {
  const missing = await classifyStripeMembershipEventTenant({
    type: 'customer.subscription.deleted',
    data: { object: { metadata: { kind: 'monthly_card_plan' } } },
  }, { expectedTenantId: 'tenant-1' });
  assert.equal(missing.status, 'unknown');

  const unavailable = await classifyStripeMembershipEventTenant({
    type: 'invoice.payment_failed',
    data: { object: { subscription: 'sub_unknown' } },
  }, {
    expectedTenantId: 'tenant-1',
    stripe: { subscriptions: { retrieve: async () => { throw new Error('sensitive'); } } },
  });
  assert.deepEqual(unavailable, {
    status: 'unavailable',
    message: 'Stripe subscription ownership could not be verified.',
  });
});

test('account-wide unrelated payment, checkout, subscription and one-off invoices are irrelevant', async () => {
  const fixtures = [
    {
      type: 'payment_intent.succeeded',
      data: { object: { metadata: { booking_id: 'booking-1', tenant_id: 'tenant-1' } } },
    },
    {
      type: 'checkout.session.completed',
      data: { object: { mode: 'payment', metadata: { tenant_id: 'tenant-1' } } },
    },
    {
      type: 'customer.subscription.deleted',
      data: { object: { metadata: { kind: 'other_product' } } },
    },
    {
      type: 'invoice.paid',
      data: { object: { id: 'in_one_off' } },
    },
  ];
  for (const event of fixtures) {
    assert.deepEqual(
      await classifyStripeMembershipEventTenant(event, { expectedTenantId: 'tenant-1' }),
      { status: 'irrelevant' },
    );
  }
});

test('other-product subscription invoice is irrelevant after authoritative retrieval', async () => {
  const result = await classifyStripeMembershipEventTenant({
    type: 'invoice.paid',
    data: { object: { subscription: 'sub_other' } },
  }, {
    expectedTenantId: 'tenant-1',
    stripe: {
      subscriptions: {
        retrieve: async () => ({ metadata: { kind: 'other_product' } }),
      },
    },
  });
  assert.deepEqual(result, { status: 'irrelevant' });
});

test('explicit card-plan invoice without subscription fails closed as relevant unknown', async () => {
  const result = await classifyStripeMembershipEventTenant({
    type: 'invoice.marked_uncollectible',
    data: { object: {
      lines: { data: [{ metadata: { catch_up_intent_key: 'intent-1' } }] },
    } },
  }, { expectedTenantId: 'tenant-1' });
  assert.equal(result.status, 'unknown');
  assert.match(result.message, /membership invoice/);
});
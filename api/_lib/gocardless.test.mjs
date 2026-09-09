// GoCardless service module tests — signature verification + idempotency keys.
// Run: node --test api/_lib/gocardless.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { verifyWebhookSignature, buildIdempotencyKey, getGocardlessEnvironment, createGocardlessClient } from './gocardless.js';

const SECRET = 'test_webhook_secret_123';
function sign(body, secret = SECRET) {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

test('verifyWebhookSignature accepts a valid signature (string body)', () => {
  const body = JSON.stringify({ events: [{ id: 'EV123' }] });
  assert.equal(verifyWebhookSignature(body, sign(body), SECRET), true);
});

test('verifyWebhookSignature accepts a valid signature (Buffer body)', () => {
  const body = Buffer.from(JSON.stringify({ events: [] }));
  assert.equal(verifyWebhookSignature(body, sign(body), SECRET), true);
});

test('verifyWebhookSignature rejects a tampered body', () => {
  const body = JSON.stringify({ events: [{ id: 'EV123' }] });
  const sig = sign(body);
  assert.equal(verifyWebhookSignature(body + ' ', sig, SECRET), false);
});

test('verifyWebhookSignature rejects a signature from the wrong secret', () => {
  const body = '{"events":[]}';
  assert.equal(verifyWebhookSignature(body, sign(body, 'other_secret'), SECRET), false);
});

test('verifyWebhookSignature rejects wrong-length / malformed signatures without throwing', () => {
  const body = '{"events":[]}';
  assert.equal(verifyWebhookSignature(body, 'short', SECRET), false);
  assert.equal(verifyWebhookSignature(body, '', SECRET), false);
  assert.equal(verifyWebhookSignature(body, null, SECRET), false);
});

test('verifyWebhookSignature fails closed when secret missing', () => {
  const body = '{"events":[]}';
  assert.equal(verifyWebhookSignature(body, sign(body), undefined), false);
  assert.equal(verifyWebhookSignature(body, sign(body), ''), false);
});

test('verifyWebhookSignature fails closed on null body', () => {
  assert.equal(verifyWebhookSignature(null, 'abc', SECRET), false);
});

test('buildIdempotencyKey is deterministic and order-sensitive', () => {
  const a = buildIdempotencyKey('subscription', 'tenant-1', 'plan-1');
  const b = buildIdempotencyKey('subscription', 'tenant-1', 'plan-1');
  const c = buildIdempotencyKey('tenant-1', 'subscription', 'plan-1');
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^[a-f0-9]{64}$/);
});

test('buildIdempotencyKey rejects empty parts', () => {
  assert.throws(() => buildIdempotencyKey());
  assert.throws(() => buildIdempotencyKey('a', null, 'b'));
  assert.throws(() => buildIdempotencyKey('a', ''));
});

test('getGocardlessEnvironment defaults to sandbox', () => {
  const prev = process.env.GOCARDLESS_ENVIRONMENT;
  delete process.env.GOCARDLESS_ENVIRONMENT;
  assert.equal(getGocardlessEnvironment(), 'sandbox');
  process.env.GOCARDLESS_ENVIRONMENT = 'live';
  assert.equal(getGocardlessEnvironment(), 'live');
  process.env.GOCARDLESS_ENVIRONMENT = 'nonsense';
  assert.equal(getGocardlessEnvironment(), 'sandbox');
  if (prev === undefined) delete process.env.GOCARDLESS_ENVIRONMENT;
  else process.env.GOCARDLESS_ENVIRONMENT = prev;
});

test('listMandatesPage applies creditor pinning by default and returns cursor metadata', async () => {
  const previousFetch = global.fetch;
  global.fetch = async (url) => {
    const parsed = new URL(url);
    assert.equal(parsed.pathname, '/mandates');
    assert.equal(parsed.searchParams.get('after'), 'MD-prev');
    assert.equal(parsed.searchParams.get('creditor'), 'CR-owned');
    assert.equal(parsed.searchParams.get('limit'), '500');
    return new Response(JSON.stringify({
      mandates: [{ id: 'MD-next' }],
      meta: { cursors: { after: 'MD-next' } },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const client = createGocardlessClient({
      source: 'tenant', tenantId: 'tenant-1', environment: 'sandbox',
      accessToken: 'sandbox_test', creditorId: 'CR-owned',
    });
    assert.deepEqual(await client.listMandatesPage({ after: 'MD-prev' }), {
      mandates: [{ id: 'MD-next' }], after: 'MD-next', cursorMetadataPresent: true,
    });
  } finally {
    global.fetch = previousFetch;
  }
});

test('account-wide mandate discovery omits an optional configured creditor', async () => {
  const previousFetch = global.fetch;
  global.fetch = async (url) => {
    const parsed = new URL(url);
    assert.equal(parsed.pathname, '/mandates');
    assert.equal(parsed.searchParams.has('creditor'), false);
    return new Response(JSON.stringify({
      mandates: [],
      meta: { cursors: { after: null } },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const client = createGocardlessClient({
      source: 'tenant', tenantId: 'tenant-1', environment: 'sandbox',
      accessToken: 'sandbox_test', creditorId: 'CR-owned',
    });
    assert.deepEqual(await client.listMandatesPage({ accountWide: true }), {
      mandates: [], after: null, cursorMetadataPresent: true,
    });
  } finally {
    global.fetch = previousFetch;
  }
});

test('createBillingRequest sends a monthly first payment alongside the mandate request', async () => {
  const previousFetch = global.fetch;
  global.fetch = async (url, options) => {
    assert.equal(new URL(url).pathname, '/billing_requests');
    const body = JSON.parse(options.body);
    assert.deepEqual(body.billing_requests.mandate_request, { scheme: 'bacs', currency: 'GBP' });
    assert.deepEqual(body.billing_requests.payment_request, {
      amount: 1250,
      currency: 'GBP',
      description: 'First of 6 monthly payments; 5 further monthly collections of GBP 12.50.',
    });
    return new Response(JSON.stringify({ billing_requests: { id: 'BRQ-monthly' } }), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  try {
    const client = createGocardlessClient({
      source: 'tenant',
      tenantId: 'tenant-1',
      environment: 'sandbox',
      accessToken: 'sandbox_test',
    });
    const result = await client.createBillingRequest({
      idempotencyKey: 'monthly-membership',
      currency: 'GBP',
      paymentAmountMinor: 1250,
      paymentDescription: 'First of 6 monthly payments; 5 further monthly collections of GBP 12.50.',
    });
    assert.equal(result.id, 'BRQ-monthly');
  } finally {
    global.fetch = previousFetch;
  }
});

test('createBillingRequest sends a Bacs mandate without a one-off payment', async () => {
  const previousFetch = global.fetch;
  global.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.deepEqual(body.billing_requests.mandate_request, { scheme: 'bacs', currency: 'GBP' });
    assert.equal(body.billing_requests.payment_request, undefined);
    assert.equal(body.billing_requests.subscription_request, undefined);
    return new Response(JSON.stringify({ billing_requests: { id: 'BRQ-mandate-only' } }), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  try {
    const client = createGocardlessClient({
      source: 'tenant',
      tenantId: 'tenant-1',
      environment: 'sandbox',
      accessToken: 'sandbox_test',
    });
    const result = await client.createBillingRequest({
      idempotencyKey: 'monthly-membership-mandate-only',
      currency: 'GBP',
      metadata: { kind: 'monthly_direct_debit' },
    });
    assert.equal(result.id, 'BRQ-mandate-only');
  } finally {
    global.fetch = previousFetch;
  }
});

test('createBillingRequest rejects metadata above the GoCardless three-property limit', async () => {
  const client = createGocardlessClient({
    source: 'tenant',
    tenantId: 'tenant-1',
    environment: 'sandbox',
    accessToken: 'sandbox_test',
  });
  await assert.rejects(
    client.createBillingRequest({
      idempotencyKey: 'too-much-metadata',
      metadata: { one: '1', two: '2', three: '3', four: '4' },
    }),
    /at most 3 properties/,
  );
});

test('cancelBillingRequest retires a stale consent journey', async () => {
  const previousFetch = global.fetch;
  global.fetch = async (url, options) => {
    assert.equal(new URL(url).pathname, '/billing_requests/BRQ-stale/actions/cancel');
    assert.equal(options.method, 'POST');
    assert.deepEqual(JSON.parse(options.body), {});
    return new Response(JSON.stringify({
      billing_requests: { id: 'BRQ-stale', status: 'cancelled' },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  try {
    const client = createGocardlessClient({
      source: 'tenant',
      tenantId: 'tenant-1',
      environment: 'sandbox',
      accessToken: 'sandbox_test',
    });
    const result = await client.cancelBillingRequest('BRQ-stale');
    assert.equal(result.status, 'cancelled');
  } finally {
    global.fetch = previousFetch;
  }
});

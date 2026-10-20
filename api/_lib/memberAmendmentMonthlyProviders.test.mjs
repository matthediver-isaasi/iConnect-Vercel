import test from 'node:test';
import assert from 'node:assert/strict';
import { createGocardlessClient } from './gocardless.js';

test('production GoCardless adapter issues amount-only PUT and preserves pagination cursor', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url: String(url), options });
    return new Response(JSON.stringify(options.method === 'PUT'
      ? { subscriptions: { id: 'SB-test', amount: 1234 } }
      : { payments: [{ id: 'PM-test' }], meta: { cursors: { after: 'next-cursor' } } }),
    { status: 200, headers: { 'content-type': 'application/json' } });
  });
  const client = createGocardlessClient({
    accessToken: 'isolated-test-only', environment: 'sandbox', source: 'tenant', tenantId: 'tenant-test',
  });
  const updated = await client.updateSubscriptionAmount('SB-test', {
    amountMinor: 1234, idempotencyKey: 'monthly-operation-test',
  });
  assert.equal(updated.id, 'SB-test');
  assert.equal(calls[0].options.method, 'PUT');
  assert.match(calls[0].url, /\/subscriptions\/SB-test$/);
  assert.deepEqual(JSON.parse(calls[0].options.body), { subscriptions: { amount: 1234 } });
  assert.equal(calls[0].options.headers['Idempotency-Key'], 'monthly-operation-test');
  const page = await client.listPaymentsPage({ mandateId: 'MD-test', after: 'previous-cursor' });
  assert.deepEqual(page, { payments: [{ id: 'PM-test' }], after: 'next-cursor' });
  const query = new URL(calls[1].url).searchParams;
  assert.equal(query.get('mandate'), 'MD-test');
  assert.equal(query.get('after'), 'previous-cursor');
});

test('production amount adapter rejects fractional amounts/missing operation key before any request', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw new Error('unexpected request'); });
  const client = createGocardlessClient({ accessToken: 'isolated-test-only', environment: 'sandbox' });
  await assert.rejects(client.updateSubscriptionAmount('SB-test', { amountMinor: 1.2, idempotencyKey: 'test' }));
  await assert.rejects(client.updateSubscriptionAmount('SB-test', { amountMinor: 100 }));
  assert.equal(calls, 0);
});

test('production paginated read rejects malformed provider response rather than returning empty history', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ meta: {} }), { status: 200 }));
  const client = createGocardlessClient({ accessToken: 'isolated-test-only', environment: 'sandbox' });
  await assert.rejects(client.listPaymentsPage({ mandateId: 'MD-test' }), /Invalid GoCardless payment page/);
});

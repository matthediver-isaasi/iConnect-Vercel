import test from 'node:test';
import assert from 'node:assert/strict';
import { customerFulfilmentToken, deliverCustomerFulfilment, registerCustomerDelegate } from './salesCustomerFulfilment.js';
import { createSalesTicketRegistrationHandler } from '../public/sales-ticket-registration.js';

process.env.SESSION_SECRET = 'isolated-fulfilment-test-secret-not-production';
const row = { id: '11111111-1111-4111-8111-111111111111', tenant_id: 'tenant', sale_id: 'sale',
  customer_email: 'accepted@example.test', status: 'pending' };
test('bearer is deterministic per sale/tenant and never shared with another tenant', () => {
  assert.equal(customerFulfilmentToken(row), customerFulfilmentToken(row));
  assert.notEqual(customerFulfilmentToken(row), customerFulfilmentToken({ ...row, tenant_id: 'other' }));
  assert.notEqual(customerFulfilmentToken(row), customerFulfilmentToken({ ...row, sale_id: 'other' }));
});
test('durable claim suppresses concurrent/repeated sends; rejected delivery retries the same link and frozen customer', async () => {
  let state = 'pending'; const messages = [];
  const db = {
    rpc: async (name, args) => {
      if (name === 'claim_sales_customer_fulfilment') {
        if (state !== 'pending') return { data: null };
        state = 'sending'; return { data: row };
      }
      state = args.p_outcome; return { data: true };
    },
    from: () => {
      const q = { select: () => q, eq: () => q, single: async () => ({ data: { slug: 'trusted' } }) }; return q;
    },
  };
  const send = async message => {
    messages.push(message);
    assert.equal(await deliverCustomerFulfilment(db, row, { send }), 'skipped');
    return messages.length === 1 ? { success: false, ambiguousEffect: false } : { success: true, messageId: 'test-message' };
  };
  assert.equal(await deliverCustomerFulfilment(db, row, { send }), 'pending');
  assert.equal(await deliverCustomerFulfilment(db, row, { send }), 'sent');
  assert.equal(await deliverCustomerFulfilment(db, row, { send }), 'skipped');
  assert.equal(messages.length, 2);
  assert.equal(messages[0].to, 'accepted@example.test');
  assert.equal(messages[0].text, messages[1].text);
  assert.match(messages[0].text, /https:\/\/trusted.iconn.app\/sales-ticket-registration#token=/);
});
test('unknown provider outcomes are held for review rather than blindly resent', async () => {
  let final;
  const db = { rpc: async (name, args) => name.startsWith('claim')
    ? { data: row } : (final = args.p_outcome, { data: true }),
  from: () => { const q = { select: () => q, eq: () => q, single: async () => ({ data: { slug: 'safe' } }) }; return q; } };
  await deliverCustomerFulfilment(db, row, { send: async () => { throw new Error('timeout'); } });
  assert.equal(final, 'attention');
});
test('capacity and cross-sale failures from transactional reservation cannot create registration URLs', async () => {
  for (const code of ['23514', 'P0002']) {
    let calls = 0;
    const db = { rpc: async (name, args) => {
      calls++; assert.equal(name, 'reserve_sales_customer_delegate');
      assert.equal(args.p_tenant, row.tenant_id);
      return { error: { code, message: 'allocation has no remaining places' } };
    } };
    await assert.rejects(registerCustomerDelegate(db, row, customerFulfilmentToken(row), {
      allocationId: row.id, email: 'delegate@example.test', firstName: 'A', lastName: 'B', idempotencyKey: 'once',
    }), error => error.status === (code === '23514' ? 409 : 404));
    assert.equal(calls, 1);
  }
});
test('public context requires POST, tenant-bound fresh hash; errors contain no stored data', async () => {
  const calls = [];
  const handler = createSalesTicketRegistrationHandler({
    db: { rpc: async (name, args) => {
      calls.push(args); return { error: { code: 'P0002', message: 'secret stored customer data' } };
    } },
    resolveTenantFromRequest: async () => ({ id: 'different-tenant' }),
  });
  const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(s) { this.code = s; return this; },
    json(body) { this.body = body; return this; } };
  await handler({ method: 'GET' }, res);
  assert.equal(res.code, 405); assert.equal(calls.length, 0);
  await handler({ method: 'POST', body: { action: 'context', token: customerFulfilmentToken(row) } }, res);
  assert.equal(res.code, 410);
  assert.equal(res.body.code, 'invalid_token');
  assert.equal(calls[0].p_tenant, 'different-tenant');
  assert.match(calls[0].p_hash, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(res.body), /secret|email/);
  assert.equal(res.headers['Cache-Control'], 'no-store');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { historicalInvoiceNumber, recordHistoricalInvoice } from './salesHistoricalInvoices.js';
import { createSalesQuotesHandler } from '../sales/quotes/[...path].js';

const id = '123e4567-e89b-12d3-a456-426614174000';
test('invoice numbers are required, bounded and preserve provider formatting', () => {
  assert.equal(historicalInvoiceNumber('  INV / 2025-001  '), 'INV / 2025-001');
  for (const value of [null, 123, '', ' ', 'x'.repeat(101), 'INV\n42']) {
    assert.throws(() => historicalInvoiceNumber(value), /invoice number/);
  }
});
test('manual recording sends tenant and actor to one atomic operation, not a provider', async () => {
  const calls = [];
  const db = { rpc: async (...args) => { calls.push(args); return { error: null }; } };
  assert.deepEqual(await recordHistoricalInvoice(db, { tenantId: id, actorId: 'admin', actorType: 'admin' },
    id, { versionId: id, groupId: id, invoiceNumber: ' INV-12 ', expectedGroup: { id } }), { recorded: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'record_sales_stage_historical_invoice');
  assert.equal(calls[0][1].p_number, 'INV-12');
  assert.equal(calls[0][1].p_tenant, id);
  await assert.rejects(recordHistoricalInvoice(db, {}, id, { invoiceNumber: 'INV-12' }), /saved proposal/);
});
test('ownership conflicts are visible without retrying financial effects', async () => {
  await assert.rejects(recordHistoricalInvoice({ rpc: async () => ({ error: { code: 'PT409', message: 'Already processing' } }) },
    { tenantId: id }, id, { versionId: id, groupId: id, invoiceNumber: 'INV-12', expectedGroup: { id } }),
  error => error.status === 409 && error.message === 'Already processing');
});
test('historical invoice route rejects unauthenticated callers', async () => {
  const handler = createSalesQuotesHandler({ db: {}, getTenantContext: async () => null });
  const response = { status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  await handler({ method: 'POST', url: `/api/sales/quotes/${id}/historical-invoices`, body: {} }, response);
  assert.ok([401, 403].includes(response.statusCode));
});
test('Sales viewers cannot record invoices without Manage Accounting; actor and tenant are server-owned', async () => {
  const calls = [];
  let permitted = false;
  const handler = createSalesQuotesHandler({
    db: { rpc: async (...args) => { calls.push(args); return { error: null }; } },
    getTenantContext: async () => ({ isAuthenticated: true, tenantId: id, memberId: 'server-member', roleId: id }),
    hasFeatureAccess: async (_role, capability) => capability === 'sales.view' || permitted,
  });
  const response = () => ({ setHeader() {}, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });
  const req = { method: 'POST', url: `/api/sales/quotes/${id}/historical-invoices`,
    body: { versionId: id, groupId: id, invoiceNumber: 'INV-42', expectedGroup: { id }, tenantId: 'spoof', actorId: 'spoof' } };
  const denied = response();
  await handler(req, denied);
  assert.equal(denied.statusCode, 403);
  assert.equal(calls.length, 0);
  permitted = true;
  const allowed = response();
  await handler(req, allowed);
  assert.equal(allowed.statusCode, 200);
  assert.equal(calls[0][1].p_tenant, id);
  assert.equal(calls[0][1].p_actor, 'server-member');
});

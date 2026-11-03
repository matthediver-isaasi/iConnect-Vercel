import test from 'node:test';
import assert from 'node:assert/strict';
import { enrichPayoutContacts } from './stripePayoutContacts.js';
import { reconcilePayout, payoutCsv, payoutContactLabel } from '../../shared/stripePayoutReport.mjs';
import { createStripePayoutReportHandler } from '../admin/stripe-payout-report/index.js';
import { signPayoutScope } from './stripePayoutScope.js';

const id = '11111111-1111-1111-1111-111111111111';
const second = '22222222-2222-2222-2222-222222222222';
const row = { provider: 'xero', id, number: 'INV-1', paymentId: 'pi_test', source: 'booking', reference: 'B1' };
const tx = { id: 'txn_test', paymentIntentId: 'pi_test', currency: 'gbp', gross: 100, fee: 3, net: 97 };
const payout = { amount: 97, currency: 'gbp' };
function fixture(overrides = {}) {
  const calls = [];
  return { calls, deps: {
    token: async tenant => { assert.equal(tenant, 'tenant-one'); return { accessToken: 'fixture', tenantId: 'xero-one' }; },
    fetch: async (url, init) => {
      calls.push(url);
      assert.equal(init.method, 'GET');
      assert.equal(init.headers['xero-tenant-id'], 'xero-one');
      const invoiceId = url.split('/').at(-1);
      return { ok: true, json: async () => ({ Invoices: [{ InvoiceID: invoiceId, Type: 'ACCREC',
        InvoiceNumber: invoiceId === id ? 'INV-1' : 'INV-2', Contact: { Name: invoiceId === id ? '=Name, "One"\nLimited' : 'Two' } }] }) };
    }, ...overrides,
  } };
}
test('exact tenant invoice reads deduplicate and preserve multiple names, refunds, totals and CSV', async () => {
  const f = fixture();
  const evidence = await enrichPayoutContacts([row, { ...row }, { ...row, id: second, number: 'INV-2' }], 'tenant-one', f.deps);
  assert.equal(f.calls.length, 2);
  const report = reconcilePayout(payout, [tx, { ...tx, id: 'txn_refund', refundId: 're_test', gross: -100, fee: 0, net: -100 }], evidence, true);
  assert.equal(report.rows.length, 2);
  assert.equal(report.rows[0].invoices.length, 2);
  assert.equal(report.totals.gbp.net, -3);
  assert.equal(report.rows[1].invoices[0].contactName, '=Name, "One"\nLimited');
  const csv = payoutCsv(report);
  assert.match(csv, /Xero customer\/contact names by invoice/);
  assert.ok(csv.includes('INV-1 [' + id + ']: =Name, ""One""\nLimited'));
  assert.ok(csv.includes('INV-2 [' + second + ']: Two'));
});
test('invalid, conflicting and non-Xero evidence never starts a lookup', async () => {
  const f = fixture({ token: () => { throw Error('must not be called'); } });
  const result = await enrichPayoutContacts([row, { ...row, number: 'DIFFERENT' },
    { ...row, provider: 'quickbooks' }, { ...row, id: 'not-a-uuid' }, { ...row, conflict: true }], 'tenant-one', f.deps);
  assert.equal(f.calls.length, 0);
  assert.ok(result.every(r => r.contactName === null));
});
test('connection, provider, response identity and number failures are optional display evidence', async () => {
  for (const overrides of [
    { token: async () => { throw Error('no connection'); } },
    { fetch: async () => { throw Error('timeout'); } },
    { fetch: async () => ({ ok: false }) },
    { fetch: async () => ({ ok: true, json: async () => ({ Invoices: [{ InvoiceID: second, Contact: { Name: 'Wrong' } }] }) }) },
  ]) {
    const f = fixture(overrides);
    const evidence = await enrichPayoutContacts([row], 'tenant-one', f.deps);
    assert.equal(evidence[0].contactName, null);
    assert.match(payoutContactLabel(evidence[0]), /Unavailable/);
    const report = reconcilePayout(payout, [tx], evidence, true);
    assert.equal(report.complete, true);
    assert.equal(report.balanced, true);
    assert.equal(report.rows[0].status, 'Matched');
  }
});
test('later-page conflicts suppress previously obtained contact names', async () => {
  const f = fixture();
  const evidence = await enrichPayoutContacts([row], 'tenant-one', f.deps);
  const report = reconcilePayout(payout, [tx], [...evidence, { ...row, number: 'CONFLICT' }], true);
  assert.equal(report.rows[0].status, 'Ambiguous');
  assert.equal(report.rows[0].invoices[0].contactName, null);
  assert.ok(!payoutCsv(report).includes('=Name'));
});

test('bounded reads use at most twenty distinct IDs and concurrency two', async () => {
  let active = 0, peak = 0, calls = 0;
  const f = fixture({ fetch: async () => {
    calls++; active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 2));
    active--;
    return { ok: false };
  } });
  const rows = Array.from({ length: 25 }, (_, n) => ({ ...row,
    id: `${String(n).padStart(8, '0')}-1111-1111-1111-111111111111`, number: `INV-${n}` }));
  const result = await enrichPayoutContacts(rows, 'tenant-one', f.deps);
  assert.equal(result.length, 25);
  assert.equal(calls, 20);
  assert.equal(peak, 2);
});

test('signed API evidence enriches only tenant-owned rows and rejects foreign/tampered capabilities', async () => {
  const f = fixture();
  const db = { from: () => {
    const q = { select: () => q, eq: () => q, in: () => q, order: () => q, range: () => q,
      abortSignal: async () => ({ data: [
        { id: 'b1', tenant_id: 'tenant-one', stripe_payment_intent_id: 'pi_test', xero_invoice_id: id, xero_invoice_number: 'INV-1' },
        { id: 'b2', tenant_id: 'tenant-foreign', stripe_payment_intent_id: 'pi_test', xero_invoice_id: second, xero_invoice_number: 'INV-2' },
      ] }) };
    return q;
  } };
  const handler = createStripePayoutReportHandler({
    getContext: async () => ({ isAuthenticated: true, tenantId: 'tenant-one', roleId: 'finance' }),
    checkAdmin: async () => true, checkFeature: async () => true,
    credentials: async () => ({ secret_key: 'fixture-key', is_enabled: true }), db, xero: f.deps,
  });
  const scope = signPayoutScope('fixture-key', { tenantId: 'tenant-one', mode: 'live', ids: ['pi_test'] });
  for (const [token, status] of [[scope, 200], [scope + 'x', 502],
    [signPayoutScope('fixture-key', { tenantId: 'tenant-foreign', mode: 'live', ids: ['pi_test'] }), 502]]) {
    const res = { code: 200, setHeader() {}, status(code) { this.code = code; return this; },
      json(body) { this.body = body; return this; } };
    await handler({ method: 'GET', query: { mode: 'live', action: 'evidence', source: 'booking', scope: token } }, res);
    assert.equal(res.code, status);
    if (status === 200) {
      assert.equal(res.body.rows.length, 1);
      assert.equal(res.body.rows[0].contactStatus, 'available');
      assert.ok(!JSON.stringify(res.body).includes('fixture-key'));
    }
  }
  assert.equal(f.calls.length, 1);
});

test('different contact responses withhold the name without altering match status', () => {
  const report = reconcilePayout(payout, [tx], [
    { ...row, contactStatus: 'available', contactName: 'First' },
    { ...row, contactStatus: 'available', contactName: 'Second' },
  ], true);
  assert.equal(report.rows[0].status, 'Matched');
  assert.equal(report.rows[0].invoices[0].contactName, null);
  assert.match(payoutContactLabel(report.rows[0].invoices[0]), /conflicting contact/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcilePayout, invoiceEvidence, payoutCsv, payoutMoney, PAYOUT_SOURCES } from '../../shared/stripePayoutReport.mjs';
import { readPayoutPage, readEvidencePage } from './stripePayoutReads.js';
import { createStripePayoutReportHandler } from '../admin/stripe-payout-report/index.js';
import { loadCompletePayout } from '../../client/src/lib/stripePayoutLoader.mjs';
import { signPayoutScope, verifyPayoutScope } from './stripePayoutScope.js';

const payout = { id: 'po_example', amount: 9700, currency: 'gbp', status: 'paid', arrivalDate: '2026-10-31' };
const tx = { id: 'txn_example', type: 'charge', currency: 'gbp', gross: 10000, fee: 300, net: 9700,
  paymentIntentId: 'pi_example', chargeId: 'ch_example' };
const evidence = (overrides = {}) => invoiceEvidence({ id: 'booking1', tenant_id: 'tenant1',
  stripe_payment_intent_id: 'pi_example', xero_invoice_id: 'invoice1', xero_invoice_number: 'INV-001', ...overrides }, 'booking');

test('shared group payments and multiple invoices never multiply totals', () => {
  const r = reconcilePayout(payout, [tx], [evidence(), evidence({ id: 'booking2' }),
    evidence({ id: 'booking3', xero_invoice_id: 'invoice2', xero_invoice_number: 'INV-002' })], true);
  assert.equal(r.totals.gbp.net, 9700);
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].invoices.length, 2);
  assert.equal(r.rows[0].status, 'Matched');
  assert.equal(r.balanced, true);
});
test('refunds, fees, unknown adjustments and currencies remain visible', () => {
  const refund = { ...tx, id: 'txn_refund', type: 'refund', refundId: 're_example', gross: -1000, fee: 0, net: -1000 };
  const adjustment = { ...tx, id: 'txn_adj', type: 'adjustment', gross: 100, fee: 0, net: 100, paymentIntentId: null };
  const r = reconcilePayout(payout, [tx, refund, adjustment, { ...adjustment, id: 'txn_jpy', currency: 'jpy' }], [evidence()], true);
  assert.equal(r.rows.length, 4);
  assert.equal(r.variance, -900);
  assert.equal(r.balanced, false);
  assert.match(r.rows[1].reason, /not evidence of a credit note/);
  assert.equal(r.rows[2].status, 'Unsupported source');
  assert.equal(payoutMoney(101, 'jpy'), 'JPY 101');
  assert.equal(payoutMoney(101, 'kwd'), 'KWD 0.101');
});
test('invoice match and balanced state are independent; missing, conflicts and other providers', () => {
  assert.equal(reconcilePayout(payout, [tx], [], true).rows[0].status, 'Unmatched');
  assert.equal(reconcilePayout(payout, [tx], [], true).balanced, true);
  assert.equal(reconcilePayout(payout, [tx], [evidence({ xero_invoice_id: null })], true).rows[0].status, 'Missing invoice');
  const other = evidence({ accounting_provider: 'quickbooks', accounting_invoice_id: 'qb1', xero_invoice_id: null });
  assert.equal(reconcilePayout(payout, [tx], [other], true).rows[0].status, 'Other accounting provider');
  assert.equal(other.url, null);
  const conflict = reconcilePayout(payout, [tx], [evidence(), evidence({ xero_invoice_number: 'DIFFERENT' })], true);
  assert.equal(conflict.rows[0].status, 'Ambiguous');
  assert.equal(conflict.rows[0].invoices[0].url, null);
  assert.throws(() => reconcilePayout(payout, [tx, tx], [], true), /Duplicate/);
});
test('form membership follows only exact stored history identity and payment', () => {
  const history = { ...evidence(), source: 'member_membership_history', sourceId: 'history1' };
  const form = invoiceEvidence({ id: 'form1', payment_reference: 'pi_example',
    payment_meta: { membership_result: { table: 'member_membership_history', history_id: 'history1' } } }, 'form_submission');
  assert.equal(reconcilePayout(payout, [tx], [history, form], true).rows[0].status, 'Matched');
  assert.equal(reconcilePayout(payout, [tx], [{ ...history, sourceId: 'wrong' }, form], true).rows[0].status, 'Missing invoice');
});
test('CSV blocks incomplete data, protects formulas, preserves totals and identifiers', () => {
  assert.throws(() => payoutCsv(reconcilePayout(payout, [tx], [], false)), /Complete retrieval/);
  const csv = payoutCsv(reconcilePayout(payout, [tx], [evidence({ booking_reference: '=HYPERLINK("bad")' })], true));
  assert.ok(csv.includes('txn_example'));
  assert.ok(csv.includes(',9700,'));
  assert.ok(!csv.includes('"=HYPERLINK'));
  const hostile = payoutCsv(reconcilePayout({ ...payout, status: '=bad' }, [tx], [], true));
  assert.ok(hostile.includes("\"'=bad\""));
});
test('CSV refunds, negative fees, totals and variance stay numeric while negative-looking text is protected', () => {
  const refund = { ...tx, id: 'txn_refund', type: 'refund', refundId: 're_example',
    gross: -10000, fee: -300, net: -9700 };
  const report = reconcilePayout(payout, [refund], [
    evidence({ xero_invoice_number: '-INVOICE-TEXT' }),
  ], true);
  const csv = payoutCsv(report);
  const lines = csv.split('\r\n');
  const detail = lines.find(line => line.startsWith('"txn_refund",'));
  assert.match(detail, /,-10000,-300,-9700,/);
  assert.match(lines[1], /,-19400,/);
  assert.ok(lines.includes('"gbp",-10000,-300,-9700'));
  assert.ok(!csv.includes("'-10000"));
  assert.ok(!csv.includes("'-300"));
  assert.ok(!csv.includes("'-9700"));
  // Arbitrary strings are not trusted merely because they look numeric.
  const hostile = payoutCsv({ ...report, payout: { ...payout, status: '-123' } });
  assert.ok(hostile.includes("\"'-123\""));
  // The numeric CSV columns remain directly usable in spreadsheet sums.
  const fields = detail.split(',');
  assert.equal(Number(fields[5]) - Number(fields[6]), Number(fields[7]));
});
test('provider read pagination, refund source and live/test checks use no write methods', async () => {
  let params;
  const stripe = {
    payouts: { retrieve: async id => ({ ...payout, id, automatic: true, livemode: true, arrival_date: 1 }) },
    balanceTransactions: { list: async p => { params = p; return { data: [
      { id: 'txn1', source: { id: 're1', object: 'refund', charge: 'ch1' }, amount: -100, fee: 0, net: -100, currency: 'gbp' },
    ], has_more: true }; } },
    charges: { retrieve: async id => ({ id, object: 'charge', payment_intent: 'pi1', invoice: 'in1', created: 1 }) },
  };
  const r = await readPayoutPage(stripe, payout.id, 'txn0', 'live');
  assert.equal(params.payout, payout.id);
  assert.equal(params.starting_after, 'txn0');
  assert.equal(r.next, 'txn1');
  assert.equal(r.rows[0].paymentIntentId, 'pi1');
  await assert.rejects(() => readPayoutPage(stripe, payout.id, '', 'test'), /environment/);
  stripe.payouts.retrieve = async id => ({ id, automatic: false, livemode: true });
  assert.equal((await readPayoutPage(stripe, payout.id, '', 'live')).unsupported, true);
});
test('database joins tenant-scope exact IDs, continue through short pages, reject errors', async () => {
  const calls = [];
  const db = { from: table => {
    const q = { select: () => q, eq: (...args) => { calls.push(args); return q; }, in: (...args) => { calls.push(args); return q; },
      order: () => q, range: () => q, abortSignal: async () => ({ data: [
        { id: 'b1', tenant_id: 'tenant1', stripe_payment_intent_id: 'pi_example' },
        { id: 'b2', tenant_id: 'tenant2', stripe_payment_intent_id: 'pi_example' },
      ] }) };
    return q;
  } };
  const r = await readEvidencePage(db, 'tenant1', 'booking', ['pi_example'], 0, 'live');
  assert.deepEqual(calls[0], ['tenant_id', 'tenant1']);
  assert.equal(r.rows.length, 1);
  assert.equal(r.next, 2);
});
test('handler denies anonymous, non-admin, excluded finance and mismatched tenant before credentials', async () => {
  for (const [ctx, admin, feature, expected] of [
    [{}, true, true, 401],
    [{ isAuthenticated: true, tenantId: 'tenant1', tenantMismatch: true }, true, true, 409],
    [{ isAuthenticated: true, tenantId: 'tenant1', roleId: 'r' }, false, true, 403],
    [{ isAuthenticated: true, tenantId: 'tenant1', roleId: 'r' }, true, false, 403],
  ]) {
    const handler = createStripePayoutReportHandler({ getContext: async () => ctx, checkAdmin: async () => admin,
      checkFeature: async () => feature, credentials: () => { throw new Error('must not read'); } });
    const res = { setHeader() {}, status(n) { this.code = n; return this; }, json(body) { this.body = body; return this; } };
    await handler({ method: 'GET', query: { mode: 'live' } }, res);
    assert.equal(res.code, expected);
  }
});
test('complete loader paginates both provider and capped joins; failed pages never reconcile', async () => {
  const calls = [];
  const request = async url => {
    const q = new URL(url, 'https://example.invalid').searchParams;
    calls.push(q);
    let body;
    if (q.get('action') === 'evidence') {
      body = q.get('source') === 'booking' && q.get('offset') === '0' ? { rows: [evidence()], next: 1 } : { rows: [], next: null };
    } else body = { payout, rows: q.get('cursor') ? [{ ...tx, id: 'txn2', gross: 0, fee: 0, net: 0 }]
      : [tx], next: q.get('cursor') ? null : tx.id };
    return { ok: true, json: async () => body };
  };
  const result = await loadCompletePayout(payout.id, 'live', { request });
  assert.equal(result.rows.length, 2);
  assert.equal(result.complete, true);
  assert.ok(calls.some(q => q.get('offset') === '1'));
  assert.equal(new Set(calls.filter(q => q.has('source')).map(q => q.get('source'))).size, PAYOUT_SOURCES.length);
  await assert.rejects(() => loadCompletePayout(payout.id, 'live', {
    request: async () => ({ ok: false, json: async () => ({ error: 'Provider failure' }) }),
  }), /Provider failure/);
});

test('evidence capabilities reject other tenants, modes, credential changes and tampering', () => {
  const token = signPayoutScope('fixture-key', { tenantId: 'tenant1', mode: 'live', ids: ['pi_example'] });
  assert.deepEqual(verifyPayoutScope('fixture-key', token, 'tenant1', 'live').ids, ['pi_example']);
  for (const args of [
    ['fixture-key', token, 'tenant2', 'live'], ['fixture-key', token, 'tenant1', 'test'],
    ['changed-key', token, 'tenant1', 'live'], ['fixture-key', token + 'x', 'tenant1', 'live'],
  ]) assert.throws(() => verifyPayoutScope(...args));
});
test('recurring links require exact Stripe invoice evidence, not a subscription guess', () => {
  const installment = invoiceEvidence({ id: 'i1', external_payment_id: 'in_exact',
    accounting_provider: 'xero', accounting_invoice_id: 'x1', accounting_invoice_number: 'INV-I1' }, 'membership_instalment_invoices');
  assert.equal(reconcilePayout(payout, [{ ...tx, stripeInvoiceId: 'in_exact' }], [installment], true).rows[0].status, 'Matched');
  assert.equal(reconcilePayout(payout, [tx], [installment], true).rows[0].status, 'Unmatched');
});
test('API uses selected tenant credentials only, handles missing history, and rejects writes', async () => {
  const modes = [];
  const ctx = { isAuthenticated: true, tenantId: 'tenant1', roleId: 'finance' };
  const deps = { getContext: async () => ctx, checkAdmin: async () => true, checkFeature: async () => true,
    credentials: async tenant => { assert.equal(tenant, 'tenant1'); return {
      is_enabled: true, secret_key: 'fixture-live', test_secret_key: 'fixture-test', stripe_mode_events: 'test' }; },
    stripe: { payouts: { retrieve: async id => {
      modes.push(id);
      if (id === 'po_foreign') throw new Error('Not found');
      return { id, automatic: false, livemode: true };
    } } } };
  const run = async (query, method = 'GET') => {
    const res = { code: 200, setHeader() {}, status(n) { this.code = n; return this; }, json(body) { this.body = body; return this; } };
    await createStripePayoutReportHandler(deps)({ query, method }, res); return res;
  };
  assert.equal((await run({ mode: 'live', payout: 'po_example' })).body.unsupported, true);
  assert.equal((await run({ mode: 'test', payout: 'po_example' })).code, 502);
  assert.equal((await run({ mode: 'live', payout: 'po_foreign' })).code, 502);
  assert.equal((await run({ mode: 'live' }, 'POST')).code, 405);
  assert.equal((await run({ mode: 'live', action: 'evidence', source: 'booking', ids: 'pi_example' })).code, 502);
});

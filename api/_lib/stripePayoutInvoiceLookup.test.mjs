import test from 'node:test';
import assert from 'node:assert/strict';
import { readPayoutPage } from './stripePayoutReads.js';
import { invoiceEvidence, reconcilePayout } from '../../shared/stripePayoutReport.mjs';

const payment = { status: 'paid', livemode: true, invoice: 'in_exact',
  payment: { type: 'payment_intent', payment_intent: 'pi_exact' } };
function fixture(data = [payment], extra = {}) {
  const calls = [];
  const charge = { object: 'charge', id: 'py_exact', payment_intent: 'pi_exact', created: 1 };
  const stripe = {
    payouts: { retrieve: async () => ({ id: 'po_exact', livemode: true, automatic: true, amount: 563, currency: 'gbp' }) },
    balanceTransactions: { list: async () => ({ data: [
      { id: 'txn_exact', amount: 592, fee: 29, net: 563, currency: 'gbp', type: 'payment', source: charge },
    ], has_more: false }) },
    invoicePayments: { list: async args => { calls.push(args); return { data, has_more: false, ...extra }; } },
  };
  return { stripe, calls, charge };
}
test('modern monthly payment resolves exact invoice and matches stored accounting evidence', async () => {
  const { stripe, calls } = fixture();
  const page = await readPayoutPage(stripe, 'po_exact', null, 'live');
  assert.deepEqual(calls, [{ payment: { type: 'payment_intent', payment_intent: 'pi_exact' }, status: 'paid', limit: 100 }]);
  const evidence = invoiceEvidence({ id: 'local', external_payment_id: 'in_exact',
    accounting_provider: 'xero', accounting_invoice_id: 'xero_exact', accounting_invoice_number: 'INV-TEST' },
  'membership_instalment_invoices');
  const report = reconcilePayout(page.payout, page.rows, [evidence], true);
  assert.equal(report.rows[0].status, 'Matched');
  assert.equal(report.rows[0].invoices[0].number, 'INV-TEST');
  assert.equal(report.balanced, true);
});
test('ordinary payments with no invoice remain unmatched; legacy invoice avoids extra lookup', async () => {
  const f = fixture([]);
  assert.equal((await readPayoutPage(f.stripe, 'po_exact', null, 'live')).rows[0].stripeInvoiceId, null);
  f.charge.invoice = { id: 'in_legacy' };
  assert.equal((await readPayoutPage(f.stripe, 'po_exact', null, 'live')).rows[0].stripeInvoiceId, 'in_legacy');
  assert.equal(f.calls.length, 1);
});
test('lookup errors, partial pages, wrong payments, environments and ambiguous invoices fail closed', async () => {
  for (const [data, extra] of [
    [[payment], { has_more: true }],
    [[{ ...payment, livemode: false }], {}],
    [[{ ...payment, status: 'open' }], {}],
    [[{ ...payment, payment: { type: 'payment_intent', payment_intent: 'pi_other' } }], {}],
    [[{ ...payment, invoice: null }], {}],
    [[payment, { ...payment, invoice: 'in_other' }], {}],
    [null, {}],
  ]) {
    const { stripe } = fixture(data, extra);
    await assert.rejects(readPayoutPage(stripe, 'po_exact', null, 'live'));
  }
  const { stripe } = fixture();
  stripe.invoicePayments.list = async () => { throw new Error('Rate limited'); };
  await assert.rejects(readPayoutPage(stripe, 'po_exact', null, 'live'), /Rate limited/);
});
test('refunds resolve original invoice and share request-local lookup without claiming a credit note', async () => {
  const f = fixture();
  const list = f.stripe.balanceTransactions.list;
  f.stripe.balanceTransactions.list = async () => {
    const page = await list();
    page.data.push({ ...page.data[0], id: 'txn_refund', amount: -592, fee: 0, net: -592,
      source: { id: 're_exact', object: 'refund', charge: f.charge } });
    return page;
  };
  const page = await readPayoutPage(f.stripe, 'po_exact', null, 'live');
  assert.equal(f.calls.length, 1);
  assert.equal(page.rows[1].stripeInvoiceId, 'in_exact');
  assert.match(reconcilePayout(page.payout, page.rows, [], true).rows[1].reason, /not evidence of a credit note/);
});

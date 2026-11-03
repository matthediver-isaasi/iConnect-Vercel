import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyQuotePayment, assertQuoteAccountingSource, prepareQuoteAccounting, linkQuoteAccounting, sweepQuoteAccounting } from './quoteMembershipAccounting.js';

const pi = { id: 'pi_exact', status: 'succeeded', livemode: true, amount_received: 15600, currency: 'gbp',
  metadata: { source: 'form-membership-payment', member_id: 'member', tenant_id: 'tenant', membership_quote_id: 'quote' } };
const history = { id: 'history', tenant_id: 'tenant', member_id: 'member', payment_status: 'paid',
  membership_payment_quote_id: 'quote', stripe_payment_intent_id: 'pi_exact', total_with_vat: 156, currency: 'GBP' };
const row = { tenant_id: 'tenant', source_id: 'history', provider: 'xero',
  snapshot: { evidence: { payment: pi }, payment: { date: '2026-10-11', bankCode: 'BANK' } } };
function database(overrides = {}) {
  const writes = [];
  return { writes, from(table) {
    const q = { select() { return q; }, eq() { return q; }, is() { return q; },
      update(patch) { writes.push(patch); return q; },
      async maybeSingle() { return { data: table === 'member_membership_history'
        ? { ...history, ...overrides } : { id: 'quote', stripe_payment_intent_id: 'pi_exact' } }; },
      then(resolve) { resolve({ data: [{ id: 'history' }] }); } };
    return q;
  } };
}
test('only exact successful live quote-backed paid memberships qualify', () => {
  verifyQuotePayment(history, pi);
  for (const patch of [{ tenant_id: 'other' }, { member_id: 'other' }, { total_with_vat: 155 },
    { currency: 'EUR' }, { payment_status: 'unpaid' }, { membership_payment_quote_id: 'other' },
    { billing_agreement_id: 'monthly' }, { stripe_payment_intent_id: 'pi_other' }]) {
    assert.throws(() => verifyQuotePayment({ ...history, ...patch }, pi));
  }
  for (const patch of [{ status: 'processing' }, { livemode: false }, { amount_received: 0 },
    { metadata: { ...pi.metadata, organization_id: 'org' } }]) {
    assert.throws(() => verifyQuotePayment(history, { ...pi, ...patch }));
  }
});
test('linked invoices cannot be replaced and settlement must be verified before clearing warning', async () => {
  await assert.rejects(assertQuoteAccountingSource({ db: database({ xero_invoice_id: 'foreign' }), row }));
  const db = database();
  await assert.rejects(linkQuoteAccounting({ db, row }));
  assert.equal(db.writes.length, 0);
  const completed = { ...row, invoice_result: { id: 'invoice', invoiceNumber: 'INV-1' },
    payment_status: 'done', payment_result: { id: 'payment', payment_recorded: true } };
  assert.equal((await linkQuoteAccounting({ db, row: completed })).linked, true);
  assert.equal(db.writes[0].accounting_sync_status, null);
  assert.equal(db.writes[0].xero_invoice_number, 'INV-1');
  assert.equal('payment_status' in db.writes[0], false);
});
const prepare = async () => ({ ...structuredClone(row.snapshot), invoice: { envelope: {
  expected: { contactId: 'contact', currency: 'GBP', totalMinor: 15600 },
  payload: { LineItems: [{ TaxType: 'ZERO', UnitAmount: 156, Quantity: 1 }] },
} } });
test('preparation checks existing invoices before authorising creation and freezes Stripe payment allocation', async () => {
  const calls = [];
  const transport = { fetch: async url => {
    calls.push(url);
    return { ok: true, json: async () => url.includes('/TaxRates')
      ? { TaxRates: [{ TaxType: 'ZERO', Status: 'ACTIVE', EffectiveRate: 0 }] } : url.includes('/Invoices')
      ? { Invoices: [] } : { Accounts: [{ AccountID: 'bank', Code: 'BANK', Type: 'BANK', Status: 'ACTIVE', CurrencyCode: 'GBP' }] } };
  } };
  const result = await prepareQuoteAccounting({ db: database(), row, transport }, { prepare });
  assert.equal(calls.length, 3);
  assert.equal(result.payment.envelope.payload.Invoice.InvoiceID, '$invoice');
  assert.equal(result.payment.envelope.payload.Amount, 156);
  assert.equal(result.payment.envelope.payload.Date, '2026-10-11');
  assert.equal(result.payment.envelope.expected.accountId, 'bank');
});
test('possible existing invoices, incomplete discovery and rate limits never permit creation', async () => {
  for (const data of [{}, { Invoices: [{ Status: 'PAID', Total: 156, CurrencyCode: 'GBP', DateString: '2026-10-12' }] }]) {
    await assert.rejects(prepareQuoteAccounting({ db: database(), row,
      transport: { fetch: async url => ({ ok: true, json: async () => url.includes('/TaxRates')
        ? { TaxRates: [{ TaxType: 'ZERO', Status: 'ACTIVE', EffectiveRate: 0 }] } : data }) } }, { prepare }));
  }
  const limited = Object.assign(new Error('rate limited'), { status: 429, retryAfter: '39497' });
  await assert.rejects(prepareQuoteAccounting({ db: database(), row,
    transport: { fetch: async () => { throw limited; } } }, { prepare }),
  e => e === limited && e.retryAfter === '39497');
});
test('changed or unavailable tax rates cannot add VAT to the purchased amount', async () => {
  for (const effective of [20, null]) {
    await assert.rejects(prepareQuoteAccounting({ db: database(), row,
      transport: { fetch: async () => ({ ok: true, json: async () =>
        ({ TaxRates: [{ TaxType: 'ZERO', Status: 'ACTIVE', EffectiveRate: effective }] }) }) } }, { prepare }),
    /PURCHASED_TAX_MISMATCH/);
  }
});
test('discovery rotates past blocked records and refuses an unknown candidate count', async () => {
  const ranges = [];
  let count = 3;
  const db = { from() {
    let head;
    const q = { select(_cols, options) { head = options?.head; return q; },
      eq() { return q; }, is() { return q; }, not() { return q; }, order(key) { assert.equal(key, 'id'); return q; },
      range(a, b) { ranges.push([a, b]); return q; },
      then(resolve) { resolve(head ? { count } : { data: [] }); } };
    return q;
  } };
  const original = Date.now;
  try {
    for (let minute = 0; minute < 3; minute++) {
      Date.now = () => minute * 60000;
      assert.deepEqual(await sweepQuoteAccounting(db), []);
    }
    assert.deepEqual(ranges, [[0, 19], [1, 20], [2, 21]]);
    count = null;
    await assert.rejects(sweepQuoteAccounting(db), /DISCOVERY_UNAVAILABLE/);
  } finally { Date.now = original; }
});

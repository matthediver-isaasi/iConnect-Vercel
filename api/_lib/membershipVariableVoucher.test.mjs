import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMembershipVoucherQuote } from './membershipVoucherQuote.js';
import { fundedMonthlySnapshot } from './membershipVoucherMonthly.js';
import { settleVariableVoucherCollection, variableVoucherInvoicePrice } from './membershipVariableVoucher.js';

const token = { id: 'token', tenant_id: 'tenant', member_id: 'member', status: 'pending',
  currency: 'GBP', final_cost: null, expires_at: '2099-01-01', membership_year: '2026' };
const snapshot = { payment_mode: 'direct_debit', currency: 'GBP', plan_total: null,
  monthly_amount_minor: 1000, instalment_count: 12, invoicing_mode: 'per_instalment',
  commitment: { term_key: 'term' }, collection_policy: { version: 1, pricing_policy: 'dynamic' } };
const discovery = { enabled: true, vouchers: [{ id: 'v', member_id: 'member', ownerType: 'member',
  value: 120.01, expires_at: '2099-01-01' }] };

test('variable quote accepts unknown total and reserves credit without quoting a fixed liability', () => {
  const quote = buildMembershipVoucherQuote(token, discovery, ['v'], new Date(), snapshot);
  assert.equal(quote.grossMinor, null);
  assert.equal(quote.cashMinor, null);
  assert.equal(quote.creditMinor, 12001);
  assert.equal(quote.creditSchedule.length, 12);
  assert.equal(quote.creditSchedule[0].allocatedCreditMinor, 1001);
  assert.equal(quote.creditSchedule[11].allocatedCreditMinor, 1000);
  const funding = { variableCredit: true, payableMinor: null, remainingMinor: null,
    currency: 'GBP', voucherMinor: quote.creditMinor, creditSchedule: quote.creditSchedule, allocations: quote.allocations };
  const funded = fundedMonthlySnapshot(snapshot, funding, 'settlement');
  assert.equal(funded.monthly_amount_minor, 1000, 'current gross illustration is not reduced or frozen');
  assert.equal(funded.plan_total, null);
  assert.equal(funded.billing_request_payment, null);
  assert.equal(funded.voucher_funding.term_key, 'term');
  assert.throws(() => fundedMonthlySnapshot(snapshot, { ...funding, remainingMinor: 0 }, 's'), /does not match/);
  assert.throws(() => fundedMonthlySnapshot(snapshot, { ...funding, creditSchedule: [] }, 's'), /schedule changed/);
});

test('variable quote fails closed for annual invoices, card plans and untrusted periods', () => {
  for (const change of [{ payment_mode: 'stripe_monthly' }, { invoicing_mode: 'annual' }, { commitment: {} }]) {
    assert.throws(() => buildMembershipVoucherQuote(token, discovery, ['v'], new Date(), { ...snapshot, ...change }), /requires/);
  }
  assert.throws(() => buildMembershipVoucherQuote(token, discovery, ['v']), /unavailable/);
});

test('settlement delegates evidence verification to protected SQL and never invents provider evidence', async () => {
  const calls = [];
  const db = { async rpc(name, args) { calls.push([name, args]); return { data: { id: 'receipt' } }; } };
  assert.equal((await settleVariableVoucherCollection(db, 'reservation', 'tenant')).id, 'receipt');
  assert.deepEqual(calls, [['membership_variable_voucher_settle_collection',
    { p_tenant_id: 'tenant', p_reservation_id: 'reservation' }]]);
  await assert.rejects(settleVariableVoucherCollection({ rpc: async () => ({ error: { message: 'not confirmed' } }) }, 'r', 't'), /not confirmed/);
});

test('actual gross invoice uses authoritative collection tax, not historical tax', async () => {
  const db={from(){const q={select(){return q;},eq(){return q;},async maybeSingle(){
    return {data:{setting_value:JSON.stringify({rates:[{taxType:'STANDARD',effectiveRate:20}]})}};
  }};return q;}};
  const result=await variableVoucherInvoicePrice(db,'tenant',{monthly_amount_minor:1200,vat_rate:{taxType:'STANDARD'}});
  assert.equal(result.invoice_net_minor,1000);
  assert.equal(result.invoice_vat_rate_percent,20);
  await assert.rejects(variableVoucherInvoicePrice(db,'tenant',{monthly_amount_minor:1200,vat_rate:'UNKNOWN'}),/tax rate requires/);
});

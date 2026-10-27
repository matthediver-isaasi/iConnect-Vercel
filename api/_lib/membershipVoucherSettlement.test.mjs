import test from 'node:test';
import assert from 'node:assert/strict';
import { assertMembershipVoucherPayment, startMembershipVoucherPayment,
  completeMembershipVoucherSettlement, releaseMembershipVoucherSettlement } from './membershipVoucherSettlement.js';
import { accountMembershipVoucherSettlement } from './membershipVoucherAccounting.js';

const token = { id: 'token', tenant_id: 'tenant', member_id: 'member', membership_year: '2026', currency: 'GBP' };
const allocation = { id: 'allocation', amountMinor: 7000, ownerType: 'member', displayName: 'Learning Credit' };
const settlement = { id: 'settlement', tenant_id: 'tenant', fee_token_id: 'token', state: 'provider_pending',
  provider_payment_id: 'pi_cash', provider_attempted_at: new Date().toISOString(), history_record_id: 'history',
  funding: { payableMinor: 10000, voucherMinor: 7000, remainingMinor: 3000, currency: 'GBP', allocations: [allocation] } };
const pi = { id: 'pi_cash', status: 'succeeded', amount: 3000, currency: 'gbp',
  metadata: { tenant_id: 'tenant', token_id: 'token', member_id: 'member', membership_year: '2026',
    membership_voucher_settlement_id: 'settlement' } };
function dbFor(current = settlement, history = {}) {
  const calls = [];
  return {
    calls,
    async rpc(name, args) {
      if(name==='member_credit_funding_proofs')return {data:[]};
      calls.push({ name, args });
      if (name === 'membership_voucher_pin_accounting') return { data: { ...current, accounting_binding: args.p_binding } };
      return { data: { ...current, state: 'committed', history_record_id: 'history' } };
    },
    from(table) {
      let updated;
      const q = { then(resolve) {
        calls.push({ table, updated });
        return Promise.resolve({ data: table === 'xero_token' ? { id: 'connection', tenant_id: 'company' }
          : table === 'membership_voucher_settlement' ? current
          : table === 'member_membership_history' ? { id: 'history', ...history } : {} }).then(resolve);
      } };
      for (const method of ['select', 'eq', 'neq', 'is', 'single', 'maybeSingle']) q[method] = () => q;
      q.update = values => { updated = values; return q; };
      return q;
    },
  };
}
test('partial payment accepts only net cash bound to token, owner, purchase and currency', () => {
  assert.doesNotThrow(() => assertMembershipVoucherPayment(token, settlement, pi));
  for (const change of [{ amount: 10000 }, { currency: 'usd' }, { status: 'processing' }, { id: 'pi_wrong' },
    { metadata: { ...pi.metadata, member_id: 'another' } },
    { metadata: { ...pi.metadata, membership_voucher_settlement_id: 'another' } }]) {
    assert.throws(() => assertMembershipVoucherPayment(token, settlement, { ...pi, ...change }));
  }
});
test('full credit completes atomically without a payment provider or fictional PI', async () => {
  const full = { ...settlement, state: 'reserved', provider_payment_id: null,
    funding: { ...settlement.funding, voucherMinor: 10000, remainingMinor: 0 } };
  const db = dbFor(full);
  const result = await startMembershipVoucherPayment(db, token, full, {
    getStripe() { throw new Error('Must not contact provider'); }, account: async () => {},
  });
  assert.equal(result.success, true);
  assert.equal(db.calls[0].name, 'membership_voucher_complete');
  assert.equal(db.calls[0].args.p_payment_id, null);
  assert.equal(db.calls[0].args.p_cash_minor, 0);
});
test('accounting failure retains committed funding and surfaces explicit retry warning', async () => {
  const db = dbFor();
  const result = await completeMembershipVoucherSettlement(db, token, settlement, pi, {
    account: async () => { throw new Error('Clearing account missing'); },
  });
  assert.equal(result.success, true);
  assert.match(result.accountingSyncError, /Clearing account/);
  assert.ok(db.calls.some(call => call.updated?.accounting_status === 'failed'));
  assert.ok(!db.calls.some(call => call.name === 'membership_voucher_release'));
});
test('uncertain provider outcome does not release credit', async () => {
  const db = dbFor();
  await assert.rejects(releaseMembershipVoucherSettlement(db, token,
    { ...settlement, provider_payment_id: null }, {}), /uncertain/);
  await assert.rejects(releaseMembershipVoucherSettlement(db, token, settlement, {
    paymentIntents: { retrieve: async () => ({ ...pi, status: 'processing' }) },
  }), /processing/);
  assert.equal(db.calls.length, 0);
});
test('confirmed provider cancellation releases only original durable purchase', async () => {
  const db = dbFor();
  await releaseMembershipVoucherSettlement(db, token, settlement, {
    paymentIntents: { retrieve: async () => ({ ...pi, status: 'requires_payment_method' }),
      cancel: async () => ({ ...pi, status: 'canceled' }) },
  });
  assert.deepEqual(db.calls[0], { name: 'membership_voucher_release', args: {
    p_tenant_id: 'tenant', p_token_id: 'token', p_payment_id: 'pi_cash', p_outcome: 'cancelled',
  } });
});
test('payment retries retrieve existing intent rather than create another', async () => {
  const db = dbFor();
  let created = false;
  const result = await startMembershipVoucherPayment(db, token, settlement, { getStripe: async () => ({
    paymentIntents: { retrieve: async () => ({ ...pi, status: 'requires_payment_method', client_secret: 'secret' }),
      create: async () => { created = true; } },
  }) });
  assert.equal(result.paymentIntentId, 'pi_cash');
  assert.equal(created, false);
});
test('existing invoice gets separate explicit voucher funding and net cash, never gross Stripe payment', async () => {
  const db = dbFor(settlement, { accounting_provider: 'xero', accounting_invoice_id: 'invoice', final_cost: 100, total_with_vat: 100 });
  const payments = [];
  await accountMembershipVoucherSettlement(db, token, { ...settlement, state: 'committed' }, pi, {
    facade: { getAccountingProviderByName: () => ({
      createMembershipInvoice: () => { throw new Error('Must not create a second invoice'); },
      fetchInvoiceStatus: async () => ({ totalAmt: 100, voided: false }),
      applyStripePaymentToInvoice: async args => { payments.push(args); return { payment_recorded: true }; },
    }) },
  });
  assert.equal(payments.length, 2);
  assert.equal(payments[0].amount, 70);
  assert.equal(payments[0].stripePaymentIntentId, undefined);
  assert.equal(payments[0].bankAccountSettingKey, 'xero_voucher_clearing_account_code');
  assert.equal(payments[0].strictBankAccount, true);
  assert.match(payments[0].paymentReference, /Learning Credit \(Personal\)/);
  assert.equal(payments[1].amount, 30);
  assert.equal(payments[1].stripePaymentIntentId, 'pi_cash');
});
